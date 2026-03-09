import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { appointments, patients } from "@medsys/db";
import { createAppointmentSchema, idParamSchema, listAppointmentsQuerySchema, updateAppointmentSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const appointmentRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Appointments", "AppointmentsController", {
    "GET /": {
      operationId: "AppointmentsController_findAll",
      summary: "List appointments"
    },
    "POST /": {
      operationId: "AppointmentsController_create",
      summary: "Create appointment",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["patientId", "scheduledAt"],
        properties: {
          patientId: { type: "integer", minimum: 1 },
          doctorId: { type: "integer", minimum: 1, nullable: true },
          assistantId: { type: "integer", minimum: 1, nullable: true },
          scheduledAt: { type: "string", format: "date-time" },
          status: {
            type: "string",
            enum: ["waiting", "in_consultation", "completed", "cancelled"]
          },
          reason: { type: "string", nullable: true },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] }
        }
      },
      bodyExample: {
        patientId: 1,
        doctorId: 2,
        assistantId: 3,
        scheduledAt: "2026-03-05T10:00:00Z",
        status: "waiting",
        reason: "Fever and cough",
        priority: "normal"
      }
    },
    "GET /:id": {
      operationId: "AppointmentsController_findOne",
      summary: "Get appointment by id"
    },
    "PATCH /:id": {
      operationId: "AppointmentsController_update",
      summary: "Update appointment",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["waiting", "in_consultation", "completed", "cancelled"]
          },
          doctorId: { type: "integer", minimum: 1, nullable: true },
          assistantId: { type: "integer", minimum: 1, nullable: true },
          scheduledAt: { type: "string", format: "date-time" },
          reason: { type: "string", nullable: true },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] }
        }
      },
      bodyExample: {
        status: "in_consultation",
        doctorId: 2,
        assistantId: 3,
        priority: "high",
        reason: "Escalated to doctor"
      }
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorizePermissions(["appointment.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(listAppointmentsQuerySchema, request.query ?? {});
    const validatedStatus = query.status ?? null;

    const baseCondition = and(
      eq(appointments.organizationId, actor.organizationId),
      isNull(appointments.deletedAt)
    );
    if (!validatedStatus) {
      return app.readDb.select().from(appointments).where(baseCondition).orderBy(desc(appointments.scheduledAt));
    }

    return app.readDb
      .select()
      .from(appointments)
      .where(and(baseCondition, eq(appointments.status, validatedStatus)))
      .orderBy(desc(appointments.scheduledAt));
  });

  app.post("/", { preHandler: app.authorizePermissions(["appointment.create"]) }, async (request, reply) => {
    const actor = request.actor!;
    const payload = parseOrThrowValidation(createAppointmentSchema.strict(), request.body);
    const patientExists = await app.readDb
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, payload.patientId), eq(patients.organizationId, actor.organizationId)))
      .limit(1);
    assertOrThrow(patientExists.length === 1, 404, "Patient not found");

    const inserted = await app.db
      .insert(appointments)
      .values({
        organizationId: actor.organizationId,
        patientId: payload.patientId,
        doctorId: payload.doctorId ?? null,
        assistantId: payload.assistantId ?? null,
        scheduledAt: new Date(payload.scheduledAt),
        status: payload.status ?? "waiting",
        reason: payload.reason ?? null,
        priority: payload.priority ?? "normal"
      })
      .returning();

    await writeAuditLog(request, {
      entityType: "appointment",
      action: "create",
      entityId: inserted[0].id
    });
    return reply.code(201).send(inserted[0]);
  });

  app.get("/:id", { preHandler: app.authorizePermissions(["appointment.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const rows = await app.readDb
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.id, id),
          eq(appointments.organizationId, actor.organizationId),
          isNull(appointments.deletedAt)
        )
      )
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Appointment not found");
    return rows[0];
  });

  app.patch("/:id", { preHandler: app.authorizePermissions(["appointment.update"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(updateAppointmentSchema, request.body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status !== undefined) {
      patch.status = body.status;
    }
    if (body.doctorId !== undefined) {
      patch.doctorId = body.doctorId;
    }
    if (body.assistantId !== undefined) {
      patch.assistantId = body.assistantId;
    }
    if (body.scheduledAt !== undefined) {
      patch.scheduledAt = new Date(body.scheduledAt);
    }
    if (body.reason !== undefined) {
      patch.reason = body.reason;
    }
    if (body.priority !== undefined) {
      patch.priority = body.priority;
    }

    const updated = await app.db
      .update(appointments)
      .set(patch)
      .where(and(eq(appointments.id, id), eq(appointments.organizationId, actor.organizationId)))
      .returning();

    assertOrThrow(updated.length === 1, 404, "Appointment not found");
    await writeAuditLog(request, {
      entityType: "appointment",
      action: "update",
      entityId: id
    });
    return updated[0];
  });
};

export default appointmentRoutes;
