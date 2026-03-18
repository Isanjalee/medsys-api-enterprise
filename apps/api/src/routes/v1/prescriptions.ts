import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  appointments,
  dispenseRecords,
  encounters,
  inventoryItems,
  inventoryMovements,
  prescriptionItems,
  prescriptions
} from "@medsys/db";
import { dispensePrescriptionSchema, idParamSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const prescriptionsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Prescriptions", "PrescriptionsController", {
    "GET /": {
      operationId: "PrescriptionsController_findAll",
      summary: "List prescriptions"
    },
    "GET /queue/pending-dispense": {
      operationId: "PrescriptionsController_pendingDispenseQueue",
      summary: "List prescriptions pending dispense"
    },
    "GET /:id": {
      operationId: "PrescriptionsController_findOne",
      summary: "Get prescription with items and dispense records"
    },
    "POST /:id/dispense": {
      operationId: "PrescriptionsController_dispense",
      summary: "Dispense prescription and deduct stock atomically",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["assistantId", "dispensedAt", "items"],
        properties: {
          assistantId: { type: "integer", minimum: 1 },
          dispensedAt: { type: "string", format: "date-time" },
          status: {
            type: "string",
            enum: ["completed", "partially_completed", "cancelled"]
          },
          notes: { type: "string", nullable: true },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["inventoryItemId", "quantity"],
              properties: {
                inventoryItemId: { type: "integer", minimum: 1 },
                quantity: { type: "number", minimum: 0.01 }
              }
            }
          }
        }
      },
      bodyExample: {
        assistantId: 3,
        dispensedAt: "2026-03-05T11:00:00Z",
        status: "completed",
        notes: "Dispensed fully",
        items: [{ inventoryItemId: 1, quantity: 9 }]
      }
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorizePermissions(["prescription.read"]) }, async (request) => {
    const actor = request.actor!;
    return app.readDb
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, actor.organizationId), isNull(prescriptions.deletedAt)))
      .orderBy(desc(prescriptions.createdAt));
  });

  app.get(
    "/queue/pending-dispense",
    { preHandler: app.authorizePermissions(["prescription.dispense"]) },
    async (request) => {
      const actor = request.actor!;

      const rows = await app.readDb
        .select({
          prescriptionId: prescriptions.id,
          encounterId: encounters.id,
          appointmentId: appointments.id,
          appointmentStatus: appointments.status,
          createdAt: prescriptions.createdAt,
          dispenseId: dispenseRecords.id
        })
        .from(prescriptions)
        .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
        .innerJoin(appointments, eq(appointments.id, encounters.appointmentId))
        .leftJoin(dispenseRecords, eq(dispenseRecords.prescriptionId, prescriptions.id))
        .where(
          and(
            eq(prescriptions.organizationId, actor.organizationId),
            inArray(appointments.status, ["in_consultation", "completed"]),
            isNull(dispenseRecords.id)
          )
        )
        .orderBy(desc(prescriptions.createdAt));

      return rows.map(({ dispenseId: _dispenseId, ...row }) => row);
    }
  );

  app.get("/:id", { preHandler: app.authorizePermissions(["prescription.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    
    const [prescriptionRows, items, dispenses] = await Promise.all([
      app.readDb
        .select()
        .from(prescriptions)
        .where(
          and(
            eq(prescriptions.id, id),
            eq(prescriptions.organizationId, actor.organizationId),
            isNull(prescriptions.deletedAt)
          )
        )
        .limit(1),
      app.readDb
        .select()
        .from(prescriptionItems)
        .where(
          and(
            eq(prescriptionItems.prescriptionId, id),
            eq(prescriptionItems.organizationId, actor.organizationId),
            isNull(prescriptionItems.deletedAt)
          )
        ),
      app.readDb
        .select()
        .from(dispenseRecords)
        .where(and(eq(dispenseRecords.prescriptionId, id), eq(dispenseRecords.organizationId, actor.organizationId)))
    ]);

    assertOrThrow(prescriptionRows.length === 1, 404, "Prescription not found");

    return { prescription: prescriptionRows[0], items, dispenses };
  });

  app.post(
    "/:id/dispense",
    {
      preHandler: [
        app.authorizePermissions(["prescription.dispense"]),
        app.enforceSensitiveRateLimit("prescription.dispense")
      ]
    },
    async (request, reply) => {
      const actor = request.actor!;
      const params = parseOrThrowValidation(idParamSchema, request.params);
      const payload = parseOrThrowValidation(dispensePrescriptionSchema, {
        ...(request.body as Record<string, unknown>),
        prescriptionId: params.id
      });

      const result = await app.db.transaction(async (tx) => {
        const prescriptionRows = await tx
          .select({ id: prescriptions.id })
          .from(prescriptions)
          .where(and(eq(prescriptions.id, payload.prescriptionId), eq(prescriptions.organizationId, actor.organizationId)))
          .limit(1);
        assertOrThrow(prescriptionRows.length === 1, 404, "Prescription not found");

        const already = await tx
          .select({ id: dispenseRecords.id })
          .from(dispenseRecords)
          .where(
            and(
              eq(dispenseRecords.prescriptionId, payload.prescriptionId),
              eq(dispenseRecords.organizationId, actor.organizationId)
            )
          )
          .limit(1);
        assertOrThrow(already.length === 0, 409, "Prescription already dispensed");

        const dispenseRow = await tx
          .insert(dispenseRecords)
          .values({
            organizationId: actor.organizationId,
            prescriptionId: payload.prescriptionId,
            assistantId: payload.assistantId,
            dispensedAt: new Date(payload.dispensedAt),
            status: payload.status,
            notes: payload.notes ?? null
          })
          .returning();

        for (const item of payload.items) {
          const inventoryRows = await tx
            .select({ id: inventoryItems.id, stock: inventoryItems.stock })
            .from(inventoryItems)
            .where(
              and(
                eq(inventoryItems.id, item.inventoryItemId),
                eq(inventoryItems.organizationId, actor.organizationId),
                isNull(inventoryItems.deletedAt)
              )
            )
            .limit(1);
          assertOrThrow(inventoryRows.length === 1, 404, `Inventory item ${item.inventoryItemId} not found`);
          const currentStock = Number(inventoryRows[0].stock);
          assertOrThrow(currentStock >= item.quantity, 409, "Insufficient stock");

          await tx
            .update(inventoryItems)
            .set({
              stock: sql`${inventoryItems.stock} - ${item.quantity}`,
              updatedAt: new Date()
            })
            .where(eq(inventoryItems.id, item.inventoryItemId));

          await tx.insert(inventoryMovements).values({
            organizationId: actor.organizationId,
            inventoryItemId: item.inventoryItemId,
            movementType: "out",
            quantity: item.quantity.toString(),
            referenceType: "prescription",
            referenceId: payload.prescriptionId,
            createdById: payload.assistantId
          });
        }

        return dispenseRow[0];
      });

      await writeAuditLog(request, {
        entityType: "dispense",
        action: "create",
        entityId: result.id,
        payload: {
          prescriptionId: payload.prescriptionId,
          itemCount: payload.items.length
        }
      });

      return reply.code(201).send(result);
    }
  );
};

export default prescriptionsRoutes;
