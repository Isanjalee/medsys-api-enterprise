import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  appointments,
  dispenseRecords,
  encounterDiagnoses,
  encounters,
  inventoryItems,
  inventoryMovements,
  patients,
  prescriptionItems,
  prescriptions
} from "@medsys/db";
import { dispensePrescriptionSchema, idParamSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const dispenseRequestBodySchema = {
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
  },
  example: {
    assistantId: 3,
    dispensedAt: "2026-03-05T11:00:00Z",
    status: "completed",
    notes: "Dispensed fully",
    items: [{ inventoryItemId: 1, quantity: 9 }]
  }
} as const;

const messageErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" }
  }
} as const;

const pendingDispenseQueueResponseSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "prescriptionId",
      "appointmentId",
      "encounterId",
      "patientId",
      "patientName",
      "patient_code",
      "nic",
      "diagnosis",
      "items",
      "createdAt"
    ],
    properties: {
      id: { type: "integer" },
      prescriptionId: { type: "integer" },
      appointmentId: { type: "integer" },
      encounterId: { type: "integer" },
      patientId: { type: "integer" },
      patientName: { type: "string", nullable: true },
      patient_code: { type: "string", nullable: true },
      nic: { type: "string", nullable: true },
      diagnosis: { type: "string", nullable: true },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["drugName", "dose", "frequency", "duration", "quantity", "source", "inventoryItemId"],
          properties: {
            drugName: { type: "string" },
            dose: { type: "string" },
            frequency: { type: "string" },
            duration: { type: "string", nullable: true },
            quantity: { type: "string" },
            source: { type: "string", enum: ["clinical"] },
            inventoryItemId: { type: "integer", nullable: true }
          }
        }
      },
      createdAt: { type: "string", format: "date-time" }
    }
  },
  example: [
    {
      id: 101,
      prescriptionId: 101,
      appointmentId: 123,
      encounterId: 55,
      patientId: 55,
      patientName: "Kasun Samarakoon",
      patient_code: "P-000000024",
      nic: "200001150555",
      diagnosis: "Hypertensive heart disease without heart failure",
      items: [
        {
          drugName: "Paracetamol",
          dose: "500mg",
          frequency: "TID",
          duration: "3 days",
          quantity: "6",
          source: "clinical",
          inventoryItemId: null
        }
      ],
      createdAt: "2026-03-24T15:20:00.000Z"
    }
  ]
} as const;

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
      bodySchema: dispenseRequestBodySchema,
      bodyExample: dispenseRequestBodySchema.example
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
    {
      preHandler: app.authorizePermissions(["prescription.dispense"]),
      schema: {
        tags: ["Prescriptions"],
        operationId: "PrescriptionsController_pendingDispenseQueue",
        summary: "List prescriptions pending dispense",
        response: {
          200: pendingDispenseQueueResponseSchema,
          403: {
            ...messageErrorResponseSchema,
            example: { message: "Forbidden" }
          },
          500: {
            ...messageErrorResponseSchema,
            example: { message: "Internal server error" }
          }
        }
      }
    },
    async (request) => {
      const actor = request.actor!;

      const rows = await app.readDb
        .select({
          id: prescriptions.id,
          encounterId: encounters.id,
          appointmentId: appointments.id,
          patientId: patients.id,
          patientName: patients.fullName,
          patientCode: patients.patientCode,
          nic: patients.nic,
          appointmentStatus: appointments.status,
          createdAt: prescriptions.createdAt,
          dispenseId: dispenseRecords.id
        })
        .from(prescriptions)
        .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
        .innerJoin(appointments, eq(appointments.id, encounters.appointmentId))
        .innerJoin(patients, eq(patients.id, prescriptions.patientId))
        .leftJoin(dispenseRecords, eq(dispenseRecords.prescriptionId, prescriptions.id))
        .where(
          and(
            eq(prescriptions.organizationId, actor.organizationId),
            inArray(appointments.status, ["in_consultation", "completed"]),
            isNull(dispenseRecords.id)
          )
        )
        .orderBy(desc(prescriptions.createdAt));

      const prescriptionIds = rows.map((row) => row.id);
      const [diagnosisRows, itemRows] =
        prescriptionIds.length === 0
          ? [[], []] as const
          : await Promise.all([
              app.readDb
                .select({
                  prescriptionId: prescriptions.id,
                  diagnosisName: encounterDiagnoses.diagnosisName
                })
                .from(prescriptions)
                .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
                .innerJoin(encounterDiagnoses, eq(encounterDiagnoses.encounterId, encounters.id))
                .where(
                  and(
                    inArray(prescriptions.id, prescriptionIds),
                    eq(prescriptions.organizationId, actor.organizationId),
                    eq(encounterDiagnoses.organizationId, actor.organizationId)
                  )
                ),
              app.readDb
                .select({
                  prescriptionId: prescriptionItems.prescriptionId,
                  drugName: prescriptionItems.drugName,
                  dose: prescriptionItems.dose,
                  frequency: prescriptionItems.frequency,
                  duration: prescriptionItems.duration,
                  quantity: prescriptionItems.quantity,
                  source: prescriptionItems.source
                })
                .from(prescriptionItems)
                .where(
                  and(
                    inArray(prescriptionItems.prescriptionId, prescriptionIds),
                    eq(prescriptionItems.organizationId, actor.organizationId),
                    isNull(prescriptionItems.deletedAt)
                  )
                )
            ]);

      const diagnosesByPrescription = new Map<number, string[]>();
      for (const row of diagnosisRows) {
        const current = diagnosesByPrescription.get(row.prescriptionId) ?? [];
        current.push(row.diagnosisName);
        diagnosesByPrescription.set(row.prescriptionId, current);
      }

      const itemsByPrescription = new Map<
        number,
        Array<{
          drugName: string;
          dose: string;
          frequency: string;
          duration: string | null;
          quantity: string;
          source: "clinical" | "outside";
          inventoryItemId: number | null;
        }>
      >();

      for (const row of itemRows) {
        if (row.source !== "clinical") {
          continue;
        }

        const current = itemsByPrescription.get(row.prescriptionId) ?? [];
        current.push({
          drugName: row.drugName,
          dose: row.dose,
          frequency: row.frequency,
          duration: row.duration,
          quantity: row.quantity,
          source: row.source,
          inventoryItemId: null
        });
        itemsByPrescription.set(row.prescriptionId, current);
      }

      return rows
        .map(({ dispenseId: _dispenseId, appointmentStatus: _appointmentStatus, ...row }) => ({
          id: row.id,
          prescriptionId: row.id,
          appointmentId: row.appointmentId,
          encounterId: row.encounterId,
          patientId: row.patientId,
          patientName: row.patientName,
          patient_code: row.patientCode,
          nic: row.nic,
          diagnosis: (diagnosesByPrescription.get(row.id) ?? []).join(", ") || null,
          items: itemsByPrescription.get(row.id) ?? [],
          createdAt: row.createdAt
        }))
        .filter((row) => row.items.length > 0);
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
      ],
      schema: {
        tags: ["Prescriptions"],
        operationId: "PrescriptionsController_dispense",
        summary: "Dispense prescription and deduct stock atomically",
        body: dispenseRequestBodySchema,
        response: {
          201: {
            type: "object",
            additionalProperties: true,
            example: {
              id: 44,
              prescriptionId: 101,
              assistantId: 10,
              dispensedAt: "2026-03-24T15:56:27.809Z",
              status: "completed",
              notes: "Dispensed from assistant queue"
            }
          },
          400: {
            ...messageErrorResponseSchema,
            example: { message: "Please select the stock items to dispense before completing this prescription." }
          },
          404: {
            ...messageErrorResponseSchema,
            example: { message: "Inventory item 1 not found" }
          },
          409: {
            ...messageErrorResponseSchema,
            example: { message: "Prescription already dispensed" }
          },
          429: {
            ...messageErrorResponseSchema,
            example: { message: "Sensitive action rate limit exceeded" }
          },
          500: {
            ...messageErrorResponseSchema,
            example: { message: "Internal server error" }
          }
        }
      }
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

        const encounterRows = await tx
          .select({ appointmentId: encounters.appointmentId })
          .from(encounters)
          .innerJoin(prescriptions, eq(prescriptions.encounterId, encounters.id))
          .where(
            and(
              eq(prescriptions.id, payload.prescriptionId),
              eq(prescriptions.organizationId, actor.organizationId),
              eq(encounters.organizationId, actor.organizationId)
            )
          )
          .limit(1);

        if (encounterRows.length === 1) {
          await tx
            .update(appointments)
            .set({
              status: "completed",
              updatedAt: new Date()
            })
            .where(
              and(
                eq(appointments.id, encounterRows[0].appointmentId),
                eq(appointments.organizationId, actor.organizationId)
              )
            );
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
