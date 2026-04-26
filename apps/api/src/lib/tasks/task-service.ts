import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { taskEvents, tasks, users } from "@medsys/db";

type DbClient = any;

export type TaskFilters = {
  role?: "owner" | "doctor" | "assistant";
  status?: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "normal" | "high" | "critical";
  visitMode?: "appointment" | "walk_in" | null;
  doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
  assignedUserId?: number | null;
  sourceType?: "appointment" | "consultation" | "prescription" | "dispense" | "inventory_alert" | "followup";
  limit: number;
  offset: number;
};

export const serializeTask = (row: any) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  taskType: row.taskType,
  sourceType: row.sourceType,
  sourceId: row.sourceId,
  assignedRole: row.assignedRole,
  assignedUserId: row.assignedUserId,
  assignedUserName:
    row.assignedUserFirstName && row.assignedUserLastName
      ? `${row.assignedUserFirstName} ${row.assignedUserLastName}`
      : null,
  priority: row.priority,
  status: row.status,
  visitMode: row.visitMode,
  doctorWorkflowMode: row.doctorWorkflowMode,
  dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null,
  metadata: row.metadata ?? {},
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
  completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null
});

export const listTasks = async ({
  db,
  organizationId,
  filters
}: {
  db: DbClient;
  organizationId: string;
  filters: TaskFilters;
}) => {
  const conditions: SQL<unknown>[] = [eq(tasks.organizationId, organizationId)];
  if (filters.role) conditions.push(eq(tasks.assignedRole, filters.role));
  if (filters.status) conditions.push(eq(tasks.status, filters.status));
  if (filters.priority) conditions.push(eq(tasks.priority, filters.priority));
  if (filters.visitMode) conditions.push(eq(tasks.visitMode, filters.visitMode));
  if (filters.doctorWorkflowMode) conditions.push(eq(tasks.doctorWorkflowMode, filters.doctorWorkflowMode));
  if (filters.assignedUserId) conditions.push(eq(tasks.assignedUserId, filters.assignedUserId));
  if (filters.sourceType) conditions.push(eq(tasks.sourceType, filters.sourceType));

  const whereClause = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        taskType: tasks.taskType,
        sourceType: tasks.sourceType,
        sourceId: tasks.sourceId,
        assignedRole: tasks.assignedRole,
        assignedUserId: tasks.assignedUserId,
        assignedUserFirstName: users.firstName,
        assignedUserLastName: users.lastName,
        priority: tasks.priority,
        status: tasks.status,
        visitMode: tasks.visitMode,
        doctorWorkflowMode: tasks.doctorWorkflowMode,
        dueAt: tasks.dueAt,
        metadata: tasks.metadata,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        completedAt: tasks.completedAt
      })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assignedUserId))
      .where(whereClause)
      .orderBy(desc(tasks.createdAt))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ count: sql<number>`count(*)` }).from(tasks).where(whereClause)
  ]);

  return {
    items: rows.map(serializeTask),
    total: Number(totalRows[0]?.count ?? 0)
  };
};

export const getTaskById = async ({
  db,
  organizationId,
  taskId
}: {
  db: DbClient;
  organizationId: string;
  taskId: number;
}) => {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      taskType: tasks.taskType,
      sourceType: tasks.sourceType,
      sourceId: tasks.sourceId,
      assignedRole: tasks.assignedRole,
      assignedUserId: tasks.assignedUserId,
      assignedUserFirstName: users.firstName,
      assignedUserLastName: users.lastName,
      priority: tasks.priority,
      status: tasks.status,
      visitMode: tasks.visitMode,
      doctorWorkflowMode: tasks.doctorWorkflowMode,
      dueAt: tasks.dueAt,
      metadata: tasks.metadata,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      completedAt: tasks.completedAt
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedUserId))
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
    .limit(1);

  return rows[0] ? serializeTask(rows[0]) : null;
};

export const listTaskEvents = async ({
  db,
  taskId
}: {
  db: DbClient;
  taskId: number;
}) => {
  const rows = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt));

  return rows.map((row: any) => ({
    id: row.id,
    taskId: row.taskId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    payload: row.payload ?? {},
    createdAt: new Date(row.createdAt).toISOString()
  }));
};

export const createTaskEvent = async ({
  db,
  taskId,
  actorUserId,
  eventType,
  payload
}: {
  db: DbClient;
  taskId: number;
  actorUserId: number | null;
  eventType: string;
  payload: Record<string, unknown>;
}) => {
  const inserted = await db
    .insert(taskEvents)
    .values({
      taskId,
      actorUserId,
      eventType,
      payload
    })
    .returning();

  return inserted[0] ?? null;
};
