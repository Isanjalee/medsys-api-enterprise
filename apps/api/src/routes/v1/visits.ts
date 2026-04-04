import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { appointments, patients } from "@medsys/db";
import { startVisitSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const appointmentQueueCacheKey = (organizationId: string): string => `${organizationId}:waiting`;
const activeVisitStatuses = ["waiting", "in_consultation"] as const;

const startVisitBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["patientId"],
  properties: {
    patientId: { type: "integer", minimum: 1 },
    doctorId: { type: "integer", minimum: 1, nullable: true },
    assistantId: { type: "integer", minimum: 1, nullable: true },
    scheduledAt: { type: "string", format: "date-time" },
    reason: { type: "string", nullable: true },
    priority: { type: "string", enum: ["low", "normal", "high", "critical"] }
  },
  example: {
    patientId: 25,
    reason: "Walk-in consultation",
    priority: "normal"
  }
} as const;

const visitsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Visits", "VisitsController", {
    "POST /start": {
      operationId: "VisitsController_start",
      summary: "Reuse an active visit or create a new walk-in visit",
      bodySchema: startVisitBodySchema,
      bodyExample: startVisitBodySchema.example
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.post(
    "/start",
    {
      preHandler: app.authorizePermissions(["appointment.create"]),
      schema: {
        tags: ["Visits"],
        operationId: "VisitsController_start",
        summary: "Reuse an active visit or create a new walk-in visit",
        body: startVisitBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(startVisitSchema, request.body);
      const queueCacheKey = appointmentQueueCacheKey(actor.organizationId);

      const resolvedDoctorId =
        payload.doctorId !== undefined ? payload.doctorId : actor.role === "doctor" ? actor.userId : null;
      const resolvedAssistantId =
        payload.assistantId !== undefined ? payload.assistantId : actor.role === "assistant" ? actor.userId : null;

      const outcome = await app.db.transaction(async (tx) => {
        const now = new Date();
        const patientRows = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.id, payload.patientId),
              eq(patients.organizationId, actor.organizationId),
              isNull(patients.deletedAt)
            )
          )
          .limit(1);
        assertOrThrow(patientRows.length === 1, 404, "Patient not found");

        const activeRows = await tx
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.organizationId, actor.organizationId),
              eq(appointments.patientId, payload.patientId),
              inArray(appointments.status, [...activeVisitStatuses]),
              isNull(appointments.deletedAt)
            )
          )
          .orderBy(desc(appointments.scheduledAt), desc(appointments.id))
          .limit(1);

        if (activeRows.length === 1) {
          const existing = activeRows[0];
          const patch: Record<string, unknown> = { updatedAt: new Date() };

          if (existing.status === "waiting") {
            patch.status = "in_consultation";
            if (!existing.inConsultationAt) {
              patch.inConsultationAt = now;
            }
          }
          if (existing.doctorId === null && resolvedDoctorId !== null) {
            patch.doctorId = resolvedDoctorId;
          }
          if (existing.assistantId === null && resolvedAssistantId !== null) {
            patch.assistantId = resolvedAssistantId;
          }

          const updated =
            Object.keys(patch).length > 1
              ? await tx
                  .update(appointments)
                  .set(patch)
                  .where(and(eq(appointments.id, existing.id), eq(appointments.organizationId, actor.organizationId)))
                  .returning()
              : [existing];

          return { visit: updated[0], reused: true as const };
        }

        const inserted = await tx
          .insert(appointments)
          .values({
            organizationId: actor.organizationId,
            patientId: payload.patientId,
            doctorId: resolvedDoctorId,
            assistantId: resolvedAssistantId,
            scheduledAt: new Date(payload.scheduledAt ?? new Date().toISOString()),
            status: "in_consultation",
            registeredAt: now,
            waitingAt: null,
            inConsultationAt: now,
            completedAt: null,
            reason: payload.reason ?? null,
            priority: payload.priority
          })
          .returning();

        return { visit: inserted[0], reused: false as const };
      });

      await writeAuditLog(request, {
        entityType: "appointment",
        action: "start_visit",
        entityId: outcome.visit.id,
        payload: {
          reused: outcome.reused
        }
      });
      await app.cacheService.invalidate("appointmentQueue", queueCacheKey);

      return reply.code(outcome.reused ? 200 : 201).send(outcome);
    }
  );
};

export default visitsRoutes;
