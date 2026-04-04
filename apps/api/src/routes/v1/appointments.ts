import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { appointments, patients } from "@medsys/db";
import { createAppointmentSchema, idParamSchema, listAppointmentsQuerySchema, updateAppointmentSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const appointmentQueueCacheKey = (organizationId: string): string => `${organizationId}:waiting`;

const withQueuePosition = <T extends Record<string, unknown>>(rows: T[]): Array<T & { queuePosition: number }> =>
  rows.map((row, index) => ({
    ...row,
    queuePosition: index + 1
  }));

const createAppointmentBodySchema = {
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
  },
  example: {
    patientId: 1,
    doctorId: 2,
    assistantId: 3,
    scheduledAt: "2026-03-05T10:00:00Z",
    status: "waiting",
    reason: "Fever and cough",
    priority: "normal"
  }
} as const;

const appointmentRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Appointments", "AppointmentsController", {
    "GET /": {
      operationId: "AppointmentsController_findAll",
      summary: "List appointments"
    },
    "POST /": {
      operationId: "AppointmentsController_create",
      summary: "Create appointment",
      bodySchema: createAppointmentBodySchema,
      bodyExample: createAppointmentBodySchema.example
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
    const queueCacheKey = appointmentQueueCacheKey(actor.organizationId);

    const baseCondition = and(
      eq(appointments.organizationId, actor.organizationId),
      isNull(appointments.deletedAt)
    );

    const selectFields = {
      id: appointments.id,
      patientId: appointments.patientId,
      patientName: patients.fullName,
      patientCode: patients.patientCode,
      doctorId: appointments.doctorId,
      assistantId: appointments.assistantId,
      scheduledAt: appointments.scheduledAt,
      status: appointments.status,
      reason: appointments.reason,
      priority: appointments.priority,
      createdAt: appointments.createdAt
    };

    if (validatedStatus === "waiting") {
      const cached = await app.cacheService.getJson<Array<Record<string, unknown>>>("appointmentQueue", queueCacheKey);
      if (cached) {
        return cached;
      }

      const rows = await app.readDb
        .select(selectFields)
        .from(appointments)
        .innerJoin(patients, eq(appointments.patientId, patients.id))
        .where(and(baseCondition, eq(appointments.status, validatedStatus)))
        .orderBy(asc(appointments.scheduledAt), asc(appointments.id));
      const queueRows = withQueuePosition(rows);
      await app.cacheService.setJson(
        "appointmentQueue",
        queueCacheKey,
        queueRows,
        app.env.APPOINTMENT_QUEUE_CACHE_TTL_SECONDS
      );
      return queueRows;
    }

    const queryBuilder = app.readDb
      .select(selectFields)
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .where(validatedStatus ? and(baseCondition, eq(appointments.status, validatedStatus)) : baseCondition)
      .orderBy(desc(appointments.scheduledAt));

    return queryBuilder;
  });

  app.post(
    "/",
    {
      preHandler: app.authorizePermissions(["appointment.create"]),
      schema: {
        tags: ["Appointments"],
        operationId: "AppointmentsController_create",
        summary: "Create appointment",
        body: createAppointmentBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const queueCacheKey = appointmentQueueCacheKey(actor.organizationId);
      const payload = parseOrThrowValidation(createAppointmentSchema.strict(), request.body);
    const now = new Date();
    const initialStatus = payload.status ?? "waiting";
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
        status: initialStatus,
        registeredAt: now,
        waitingAt: initialStatus === "waiting" ? now : null,
        inConsultationAt: initialStatus === "in_consultation" ? now : null,
        completedAt: initialStatus === "completed" ? now : null,
        reason: payload.reason ?? null,
        priority: payload.priority ?? "normal"
      })
      .returning();

    await writeAuditLog(request, {
      entityType: "appointment",
      action: "create",
      entityId: inserted[0].id
    });
    await app.cacheService.invalidate("appointmentQueue", queueCacheKey);
      return reply.code(201).send(inserted[0]);
    }
  );

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
    const queueCacheKey = appointmentQueueCacheKey(actor.organizationId);
    const existingRows = await app.readDb
      .select({
        id: appointments.id,
        status: appointments.status,
        waitingAt: appointments.waitingAt,
        inConsultationAt: appointments.inConsultationAt,
        completedAt: appointments.completedAt
      })
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.organizationId, actor.organizationId), isNull(appointments.deletedAt)))
      .limit(1);
    assertOrThrow(existingRows.length === 1, 404, "Appointment not found");
    const existing = existingRows[0];

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status !== undefined) {
      patch.status = body.status;
      if (body.status === "waiting" && !existing.waitingAt) {
        patch.waitingAt = new Date();
      }
      if (body.status === "in_consultation" && !existing.inConsultationAt) {
        patch.inConsultationAt = new Date();
      }
      if (body.status === "completed" && !existing.completedAt) {
        patch.completedAt = new Date();
      }
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

    await writeAuditLog(request, {
      entityType: "appointment",
      action: "update",
      entityId: id
    });
    await app.cacheService.invalidate("appointmentQueue", queueCacheKey);
    return updated[0];
  });
};

export default appointmentRoutes;
