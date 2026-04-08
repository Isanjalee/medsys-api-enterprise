import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { tasks } from "@medsys/db";
import {
  completeTaskSchema,
  createTaskSchema,
  idParamSchema,
  listTasksQuerySchema,
  updateTaskSchema
} from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { createTaskEvent, getTaskById, listTaskEvents, listTasks } from "../../lib/tasks/task-service.js";

const createTaskBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "taskType", "sourceType", "assignedRole"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 180 },
    description: { type: "string", nullable: true },
    taskType: { type: "string", minLength: 1, maxLength: 40 },
    sourceType: { type: "string", enum: ["appointment", "consultation", "prescription", "dispense", "inventory_alert", "followup"] },
    sourceId: { type: "integer", minimum: 1, nullable: true },
    assignedRole: { type: "string", enum: ["owner", "doctor", "assistant"] },
    assignedUserId: { type: "integer", minimum: 1, nullable: true },
    priority: { type: "string", enum: ["low", "normal", "high", "critical"], nullable: true },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], nullable: true },
    visitMode: { type: "string", enum: ["appointment", "walk_in"], nullable: true },
    doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
    dueAt: { type: "string", format: "date-time", nullable: true },
    metadata: { type: "object", additionalProperties: true, nullable: true }
  }
} as const;

const updateTaskBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 180 },
    description: { type: "string", nullable: true },
    assignedRole: { type: "string", enum: ["owner", "doctor", "assistant"] },
    assignedUserId: { type: "integer", minimum: 1, nullable: true },
    priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
    visitMode: { type: "string", enum: ["appointment", "walk_in"], nullable: true },
    doctorWorkflowMode: { type: "string", enum: ["self_service", "clinic_supported"], nullable: true },
    dueAt: { type: "string", format: "date-time", nullable: true },
    metadata: { type: "object", additionalProperties: true }
  }
} as const;

const completeTaskBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: { type: "string", nullable: true }
  }
} as const;

type ParsedTaskListQuery = {
  role?: "owner" | "doctor" | "assistant";
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "normal" | "high" | "critical";
  visitMode?: "appointment" | "walk_in";
  doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
  assignedUserId?: number | null;
  sourceType?: "appointment" | "consultation" | "prescription" | "dispense" | "inventory_alert" | "followup";
  limit: number;
};

const resolveTaskFilters = (
  actor: {
    role: "owner" | "doctor" | "assistant";
    userId: number;
  },
  query: ParsedTaskListQuery
) => {
  if (actor.role !== "owner" && query.assignedUserId && query.assignedUserId !== actor.userId) {
    throw validationError([
      {
        field: "assignedUserId",
        message: "Only owner users can request another user's tasks."
      }
    ]);
  }

  if (actor.role !== "owner" && query.role && query.role !== actor.role) {
    throw validationError([
      {
        field: "role",
        message: "Only owner users can request another role task list."
      }
    ]);
  }

  return {
    role: actor.role === "owner" ? (query.role ?? undefined) : actor.role,
    status: query.status,
    priority: query.priority,
    visitMode: query.visitMode ?? null,
    doctorWorkflowMode: query.doctorWorkflowMode ?? null,
    assignedUserId: actor.role === "owner" ? (query.assignedUserId ?? null) : actor.userId,
    sourceType: query.sourceType,
    limit: query.limit
  };
};

const taskRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Tasks", "TasksController", {
    "GET /": {
      operationId: "TasksController_findAll",
      summary: "List operational tasks"
    },
    "POST /": {
      operationId: "TasksController_create",
      summary: "Create operational task",
      bodySchema: createTaskBodySchema
    },
    "PATCH /:id": {
      operationId: "TasksController_update",
      summary: "Update operational task",
      bodySchema: updateTaskBodySchema
    },
    "POST /:id/complete": {
      operationId: "TasksController_complete",
      summary: "Complete operational task",
      bodySchema: completeTaskBodySchema
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorizePermissions(["task.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(listTasksQuerySchema, request.query ?? {});
    const items = await listTasks({
      db: app.readDb,
      organizationId: actor.organizationId,
      filters: resolveTaskFilters(
        { role: actor.role as "owner" | "doctor" | "assistant", userId: actor.userId },
        {
          ...query,
          limit: query.limit ?? 50
        }
      )
    });

    return { items };
  });

  app.post(
    "/",
    { preHandler: app.authorizePermissions(["task.write"]), schema: { body: createTaskBodySchema } },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(createTaskSchema, request.body);
      const inserted = await app.db
        .insert(tasks)
        .values({
          organizationId: actor.organizationId,
          title: payload.title,
          description: payload.description ?? null,
          taskType: payload.taskType,
          sourceType: payload.sourceType,
          sourceId: payload.sourceId ?? null,
          assignedRole: payload.assignedRole,
          assignedUserId: payload.assignedUserId ?? null,
          priority: payload.priority,
          status: payload.status,
          visitMode: payload.visitMode ?? null,
          doctorWorkflowMode: payload.doctorWorkflowMode ?? null,
          dueAt: payload.dueAt ? new Date(payload.dueAt) : null,
          metadata: payload.metadata ?? {},
          updatedAt: new Date()
        })
        .returning({ id: tasks.id });

      const taskId = inserted[0]?.id;
      assertOrThrow(Boolean(taskId), 500, "Task was not created");

      await createTaskEvent({
        db: app.db,
        taskId: taskId as number,
        actorUserId: actor.userId,
        eventType: "created",
        payload: {
          assignedRole: payload.assignedRole,
          assignedUserId: payload.assignedUserId ?? null,
          status: payload.status
        }
      });

      await writeAuditLog(request, {
        entityType: "task",
        action: "create",
        entityId: taskId as number
      });

      const task = await getTaskById({
        db: app.readDb,
        organizationId: actor.organizationId,
        taskId: taskId as number
      });

      return reply.code(201).send({ task });
    }
  );

  app.patch(
    "/:id",
    { preHandler: app.authorizePermissions(["task.write"]), schema: { body: updateTaskBodySchema } },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const payload = parseOrThrowValidation(updateTaskSchema, request.body);

      const existingRows = await app.readDb
        .select({ id: tasks.id, organizationId: tasks.organizationId, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existingRows.length === 1, 404, "Task not found");

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (payload.title !== undefined) patch.title = payload.title;
      if (payload.description !== undefined) patch.description = payload.description;
      if (payload.assignedRole !== undefined) patch.assignedRole = payload.assignedRole;
      if (payload.assignedUserId !== undefined) patch.assignedUserId = payload.assignedUserId;
      if (payload.priority !== undefined) patch.priority = payload.priority;
      if (payload.status !== undefined) {
        patch.status = payload.status;
        patch.completedAt = payload.status === "completed" ? new Date() : null;
      }
      if (payload.visitMode !== undefined) patch.visitMode = payload.visitMode;
      if (payload.doctorWorkflowMode !== undefined) patch.doctorWorkflowMode = payload.doctorWorkflowMode;
      if (payload.dueAt !== undefined) patch.dueAt = payload.dueAt ? new Date(payload.dueAt) : null;
      if (payload.metadata !== undefined) patch.metadata = payload.metadata;

      await app.db.update(tasks).set(patch).where(and(eq(tasks.id, id), eq(tasks.organizationId, actor.organizationId)));

      await createTaskEvent({
        db: app.db,
        taskId: id,
        actorUserId: actor.userId,
        eventType: "updated",
        payload
      });

      await writeAuditLog(request, {
        entityType: "task",
        action: "update",
        entityId: id
      });

      const task = await getTaskById({
        db: app.readDb,
        organizationId: actor.organizationId,
        taskId: id
      });
      const events = await listTaskEvents({ db: app.readDb, taskId: id });

      return { task, events };
    }
  );

  app.post(
    "/:id/complete",
    { preHandler: app.authorizePermissions(["task.write"]), schema: { body: completeTaskBodySchema } },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const payload = parseOrThrowValidation(completeTaskSchema, request.body ?? {});

      const existingRows = await app.readDb
        .select({ id: tasks.id, assignedUserId: tasks.assignedUserId, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existingRows.length === 1, 404, "Task not found");

      const existing = existingRows[0];
      if (actor.role !== "owner" && existing.assignedUserId && existing.assignedUserId !== actor.userId) {
        throw validationError([
          {
            field: "id",
            message: "Only the assigned user or owner can complete this task."
          }
        ]);
      }

      await app.db
        .update(tasks)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date()
        })
        .where(and(eq(tasks.id, id), eq(tasks.organizationId, actor.organizationId)));

      await createTaskEvent({
        db: app.db,
        taskId: id,
        actorUserId: actor.userId,
        eventType: "completed",
        payload: {
          note: payload.note ?? null
        }
      });

      await writeAuditLog(request, {
        entityType: "task",
        action: "complete",
        entityId: id
      });

      const task = await getTaskById({
        db: app.readDb,
        organizationId: actor.organizationId,
        taskId: id
      });
      const events = await listTaskEvents({ db: app.readDb, taskId: id });

      return { task, events };
    }
  );
};

export default taskRoutes;
