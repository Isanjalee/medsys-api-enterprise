import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  appointments,
  encounterDiagnoses,
  encounters,
  prescriptionItems,
  prescriptions,
  testOrders
} from "@medsys/db";
import { createEncounterBundleSchema, idParamSchema } from "@medsys/validation";
import { assertOrThrow } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const encounterRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Encounters", "EncountersController", {
    "GET /": {
      operationId: "EncountersController_findAll",
      summary: "List encounters"
    },
    "POST /": {
      operationId: "EncountersController_createBundle",
      summary: "Create encounter with diagnoses/tests/prescription atomically",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["appointmentId", "patientId", "doctorId", "checkedAt"],
        properties: {
          appointmentId: { type: "integer", minimum: 1 },
          patientId: { type: "integer", minimum: 1 },
          doctorId: { type: "integer", minimum: 1 },
          checkedAt: { type: "string", format: "date-time" },
          notes: { type: "string", nullable: true },
          nextVisitDate: { type: "string", format: "date", nullable: true },
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["diagnosisName"],
              properties: {
                diagnosisName: { type: "string" },
                icd10Code: { type: "string", nullable: true }
              }
            }
          },
          tests: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["testName"],
              properties: {
                testName: { type: "string" },
                status: {
                  type: "string",
                  enum: ["ordered", "in_progress", "completed", "cancelled"]
                }
              }
            }
          },
          prescription: {
            type: "object",
            nullable: true,
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["drugName", "dose", "frequency", "quantity", "source"],
                  properties: {
                    drugName: { type: "string" },
                    dose: { type: "string" },
                    frequency: { type: "string" },
                    duration: { type: "string", nullable: true },
                    quantity: { type: "number", minimum: 0.01 },
                    source: { type: "string", enum: ["clinical", "outside"] }
                  }
                }
              }
            }
          }
        }
      },
      bodyExample: {
        appointmentId: 10,
        patientId: 1,
        doctorId: 2,
        checkedAt: "2026-03-05T10:30:00Z",
        notes: "Viral fever suspected",
        nextVisitDate: "2026-03-12",
        diagnoses: [{ diagnosisName: "Acute viral fever", icd10Code: "B34.9" }],
        tests: [{ testName: "CBC", status: "ordered" }],
        prescription: {
          items: [
            {
              drugName: "Paracetamol",
              dose: "500mg",
              frequency: "TID",
              duration: "3 days",
              quantity: 9,
              source: "clinical"
            }
          ]
        }
      }
    },
    "GET /:id/diagnoses": {
      operationId: "EncountersController_listDiagnoses",
      summary: "List encounter diagnoses"
    },
    "GET /:id/tests": {
      operationId: "EncountersController_listTests",
      summary: "List encounter tests"
    },
    "GET /:id": {
      operationId: "EncountersController_findOne",
      summary: "Get encounter full detail"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    return app.readDb
      .select()
      .from(encounters)
      .where(and(eq(encounters.organizationId, actor.organizationId), isNull(encounters.deletedAt)))
      .orderBy(desc(encounters.checkedAt));
  });

  app.post("/", { preHandler: app.authorize(["owner", "doctor"]) }, async (request, reply) => {
    const actor = request.actor!;
    const payload = createEncounterBundleSchema.parse(request.body);

    const outcome = await app.db.transaction(async (tx) => {
      const appointmentRows = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.id, payload.appointmentId),
            eq(appointments.organizationId, actor.organizationId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);
      assertOrThrow(appointmentRows.length === 1, 404, "Appointment not found");
      assertOrThrow(
        ["waiting", "in_consultation"].includes(appointmentRows[0].status),
        409,
        "Appointment already completed"
      );

      const encounterRows = await tx
        .insert(encounters)
        .values({
          organizationId: actor.organizationId,
          appointmentId: payload.appointmentId,
          patientId: payload.patientId,
          doctorId: payload.doctorId,
          checkedAt: new Date(payload.checkedAt),
          notes: payload.notes ?? null,
          nextVisitDate: payload.nextVisitDate ?? null,
          status: "completed"
        })
        .returning();
      const encounter = encounterRows[0];

      if (payload.diagnoses.length > 0) {
        await tx.insert(encounterDiagnoses).values(
          payload.diagnoses.map((diagnosis) => ({
            organizationId: actor.organizationId,
            encounterId: encounter.id,
            icd10Code: diagnosis.icd10Code ?? null,
            diagnosisName: diagnosis.diagnosisName
          }))
        );
      }

      if (payload.tests.length > 0) {
        await tx.insert(testOrders).values(
          payload.tests.map((test) => ({
            organizationId: actor.organizationId,
            encounterId: encounter.id,
            testName: test.testName,
            status: test.status
          }))
        );
      }

      let prescriptionId: number | null = null;
      if (payload.prescription) {
        const prescriptionRows = await tx
          .insert(prescriptions)
          .values({
            organizationId: actor.organizationId,
            encounterId: encounter.id,
            patientId: payload.patientId,
            doctorId: payload.doctorId
          })
          .returning();
        prescriptionId = prescriptionRows[0].id;

        await tx.insert(prescriptionItems).values(
          payload.prescription.items.map((item) => ({
            organizationId: actor.organizationId,
            prescriptionId: prescriptionId as number,
            drugName: item.drugName,
            dose: item.dose,
            frequency: item.frequency,
            duration: item.duration ?? null,
            quantity: item.quantity.toString(),
            source: item.source
          }))
        );
      }

      await tx
        .update(appointments)
        .set({ status: "completed", updatedAt: new Date() })
        .where(and(eq(appointments.id, payload.appointmentId), eq(appointments.organizationId, actor.organizationId)));

      return { encounterId: encounter.id, prescriptionId };
    });

    await writeAuditLog(request, {
      entityType: "encounter",
      action: "create_bundle",
      entityId: outcome.encounterId,
      payload: {
        appointmentId: payload.appointmentId,
        hasPrescription: Boolean(outcome.prescriptionId)
      }
    });

    return reply.code(201).send(outcome);
  });

  app.get(
    "/:id/diagnoses",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);

      const foundEncounter = await app.readDb
        .select({ id: encounters.id })
        .from(encounters)
        .where(and(eq(encounters.id, id), eq(encounters.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(foundEncounter.length === 1, 404, "Encounter not found");

      return app.readDb
        .select()
        .from(encounterDiagnoses)
        .where(and(eq(encounterDiagnoses.encounterId, id), eq(encounterDiagnoses.organizationId, actor.organizationId)));
    }
  );

  app.get("/:id/tests", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    return app.readDb
      .select()
      .from(testOrders)
      .where(and(eq(testOrders.encounterId, id), eq(testOrders.organizationId, actor.organizationId)));
  });

  app.get("/:id", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);

    const found = await app.readDb
      .select()
      .from(encounters)
      .where(and(eq(encounters.id, id), eq(encounters.organizationId, actor.organizationId)))
      .limit(1);
    assertOrThrow(found.length === 1, 404, "Encounter not found");

    const diagnosisRows = await app.readDb
      .select()
      .from(encounterDiagnoses)
      .where(and(eq(encounterDiagnoses.encounterId, id), eq(encounterDiagnoses.organizationId, actor.organizationId)));

    const testRows = await app.readDb
      .select()
      .from(testOrders)
      .where(and(eq(testOrders.encounterId, id), eq(testOrders.organizationId, actor.organizationId)));

    const prescriptionRows = await app.readDb
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.encounterId, id), eq(prescriptions.organizationId, actor.organizationId)));

    const prescriptionIds = prescriptionRows.map((row) => row.id);
    const items =
      prescriptionIds.length === 0
        ? []
        : await app.readDb
            .select()
            .from(prescriptionItems)
            .where(
              and(
                inArray(prescriptionItems.prescriptionId, prescriptionIds),
                eq(prescriptionItems.organizationId, actor.organizationId)
              )
            );

    return {
      encounter: found[0],
      diagnoses: diagnosisRows,
      tests: testRows,
      prescriptions: prescriptionRows,
      prescriptionItems: items
    };
  });
};

export default encounterRoutes;
