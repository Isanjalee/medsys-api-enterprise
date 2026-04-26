import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { appointments, encounters, patientFollowups, patients, users } from "@medsys/db";
import {
  createFollowupSchema,
  idParamSchema,
  listFollowupsQuerySchema,
  updateFollowupSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { getFollowupById, listFollowups } from "../../lib/followups/followup-service.js";

const createFollowupBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["patientId", "followupType", "dueDate"],
  properties: {
    patientId: { type: "integer", minimum: 1 },
    encounterId: { type: "integer", minimum: 1, nullable: true },
    doctorId: { type: "integer", minimum: 1, nullable: true },
    followupType: { type: "string", minLength: 1, maxLength: 40 },
    dueDate: { type: "string", format: "date" },
    status: { type: "string", enum: ["pending", "completed", "missed", "cancelled"], nullable: true },
    visitMode: { type: "string", enum: ["appointment", "walk_in"], nullable: true },
    doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
    note: { type: "string", nullable: true }
  }
} as const;

const updateFollowupBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    doctorId: { type: "integer", minimum: 1, nullable: true },
    followupType: { type: "string", minLength: 1, maxLength: 40 },
    dueDate: { type: "string", format: "date" },
    status: { type: "string", enum: ["pending", "completed", "missed", "cancelled"] },
    visitMode: { type: "string", enum: ["appointment", "walk_in"], nullable: true },
    doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
    note: { type: "string", nullable: true }
  }
} as const;

type ParsedFollowupListQuery = {
  patientId?: number | null;
  doctorId?: number | null;
  status?: "pending" | "completed" | "missed" | "cancelled";
  dueFrom?: string | null;
  dueTo?: string | null;
  visitMode?: "appointment" | "walk_in";
  doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
  limit: number;
  offset: number;
};

const resolveFollowupListFilters = (
  actor: { role: "owner" | "doctor" | "assistant"; userId: number },
  query: ParsedFollowupListQuery
) => {
  if (actor.role === "doctor" && query.doctorId && query.doctorId !== actor.userId) {
    throw validationError([
      {
        field: "doctorId",
        message: "Doctor users can only request their own follow-ups.",
        code: "DOCTOR_SCOPE_VIOLATION"
      }
    ]);
  }

  return {
    patientId: query.patientId ?? null,
    doctorId: actor.role === "doctor" ? actor.userId : (query.doctorId ?? null),
    status: query.status,
    dueFrom: query.dueFrom ?? null,
    dueTo: query.dueTo ?? null,
    visitMode: query.visitMode ?? null,
    doctorWorkflowMode: query.doctorWorkflowMode ?? null,
    limit: query.limit ?? 50,
    offset: query.offset ?? 0
  };
};

const followupRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Followups", "FollowupsController", {
    "GET /": {
      operationId: "FollowupsController_findAll",
      summary: "List patient follow-up records"
    },
    "POST /": {
      operationId: "FollowupsController_create",
      summary: "Create patient follow-up record",
      bodySchema: createFollowupBodySchema
    },
    "PATCH /:id": {
      operationId: "FollowupsController_update",
      summary: "Update patient follow-up record",
      bodySchema: updateFollowupBodySchema
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorizePermissions(["encounter.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(listFollowupsQuerySchema, request.query ?? {});
    const result = await listFollowups({
      db: app.readDb,
      organizationId: actor.organizationId,
      filters: resolveFollowupListFilters(
        { role: actor.role as "owner" | "doctor" | "assistant", userId: actor.userId },
        {
          patientId: query.patientId ?? null,
          doctorId: query.doctorId ?? null,
          status: query.status,
          dueFrom: query.dueFrom ?? null,
          dueTo: query.dueTo ?? null,
          visitMode: query.visitMode,
          doctorWorkflowMode: query.doctorWorkflowMode ?? null,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0
        }
      )
    });

    return {
      items: result.items,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      total: result.total
    };
  });

  app.post(
    "/",
    { preHandler: app.authorizePermissions(["encounter.write"]), schema: { body: createFollowupBodySchema } },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(createFollowupSchema, request.body);

      const patientRows = await app.readDb
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.id, payload.patientId), eq(patients.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(patientRows.length === 1, 404, "Patient not found");

      let resolvedDoctorId = actor.role === "doctor" ? actor.userId : (payload.doctorId ?? null);
      let resolvedVisitMode = payload.visitMode ?? null;
      let resolvedDoctorWorkflowMode = payload.doctorWorkflowMode ?? null;

      if (payload.encounterId) {
        const encounterRows = await app.readDb
          .select({
            id: encounters.id,
            patientId: encounters.patientId,
            doctorId: encounters.doctorId,
            appointmentId: encounters.appointmentId,
            appointmentScheduledAt: encounters.appointmentScheduledAt,
            visitMode: appointments.visitMode,
            doctorWorkflowMode: users.doctorWorkflowMode
          })
          .from(encounters)
          .innerJoin(
            appointments,
            and(eq(appointments.id, encounters.appointmentId), eq(appointments.scheduledAt, encounters.appointmentScheduledAt))
          )
          .leftJoin(users, eq(users.id, encounters.doctorId))
          .where(and(eq(encounters.id, payload.encounterId), eq(encounters.organizationId, actor.organizationId)))
          .limit(1);

        assertOrThrow(encounterRows.length === 1, 404, "Encounter not found");
        const encounter = encounterRows[0];
        if (encounter.patientId !== payload.patientId) {
          throw validationError([
            {
              field: "patientId",
              message: "patientId must match the encounter patient.",
              code: "ENCOUNTER_PATIENT_MISMATCH"
            }
          ]);
        }

        resolvedDoctorId = actor.role === "doctor" ? actor.userId : (payload.doctorId ?? encounter.doctorId ?? null);
        resolvedVisitMode = payload.visitMode ?? ((encounter.visitMode as "appointment" | "walk_in" | null) ?? null);
        resolvedDoctorWorkflowMode = payload.doctorWorkflowMode ?? encounter.doctorWorkflowMode ?? null;
      }

      if (resolvedDoctorId !== null) {
        const doctorRows = await app.readDb
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, resolvedDoctorId), eq(users.organizationId, actor.organizationId)))
          .limit(1);
        assertOrThrow(doctorRows.length === 1, 404, "Doctor not found");
      }

      const inserted = await app.db
        .insert(patientFollowups)
        .values({
          organizationId: actor.organizationId,
          patientId: payload.patientId,
          encounterId: payload.encounterId ?? null,
          doctorId: resolvedDoctorId,
          followupType: payload.followupType,
          dueDate: payload.dueDate,
          status: payload.status,
          visitMode: resolvedVisitMode,
          doctorWorkflowMode: resolvedDoctorWorkflowMode,
          note: payload.note ?? null,
          createdByUserId: actor.userId,
          updatedAt: new Date(),
          completedAt: payload.status === "completed" ? new Date() : null
        })
        .returning({ id: patientFollowups.id });

      const followupId = inserted[0]?.id;
      assertOrThrow(Boolean(followupId), 500, "Follow-up was not created");

      await writeAuditLog(request, {
        entityType: "patient_followup",
        action: "create",
        entityId: followupId as number
      });

      const followup = await getFollowupById({
        db: app.readDb,
        organizationId: actor.organizationId,
        id: followupId as number
      });

      return reply.code(201).send({ followup });
    }
  );

  app.patch(
    "/:id",
    { preHandler: app.authorizePermissions(["encounter.write"]), schema: { body: updateFollowupBodySchema } },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const payload = parseOrThrowValidation(updateFollowupSchema, request.body);

      const existingRows = await app.readDb
        .select({
          id: patientFollowups.id,
          doctorId: patientFollowups.doctorId
        })
        .from(patientFollowups)
        .where(and(eq(patientFollowups.id, id), eq(patientFollowups.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existingRows.length === 1, 404, "Follow-up not found");

      if (actor.role === "doctor" && existingRows[0].doctorId && existingRows[0].doctorId !== actor.userId) {
        throw validationError([
          {
            field: "id",
            message: "Doctor users can only update their own follow-ups.",
            code: "DOCTOR_SCOPE_VIOLATION"
          }
        ]);
      }

      const patch: Record<string, unknown> = {
        updatedAt: new Date()
      };
      if (payload.doctorId !== undefined) patch.doctorId = actor.role === "doctor" ? actor.userId : payload.doctorId;
      if (payload.followupType !== undefined) patch.followupType = payload.followupType;
      if (payload.dueDate !== undefined) patch.dueDate = payload.dueDate;
      if (payload.status !== undefined) {
        patch.status = payload.status;
        patch.completedAt = payload.status === "completed" ? new Date() : null;
      }
      if (payload.visitMode !== undefined) patch.visitMode = payload.visitMode;
      if (payload.doctorWorkflowMode !== undefined) patch.doctorWorkflowMode = payload.doctorWorkflowMode;
      if (payload.note !== undefined) patch.note = payload.note;

      await app.db.update(patientFollowups).set(patch).where(and(eq(patientFollowups.id, id), eq(patientFollowups.organizationId, actor.organizationId)));

      await writeAuditLog(request, {
        entityType: "patient_followup",
        action: "update",
        entityId: id
      });

      const followup = await getFollowupById({
        db: app.readDb,
        organizationId: actor.organizationId,
        id
      });

      return { followup };
    }
  );
};

export default followupRoutes;
