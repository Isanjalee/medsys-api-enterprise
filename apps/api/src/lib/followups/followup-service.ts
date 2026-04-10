import { and, desc, eq, gte, lte } from "drizzle-orm";
import { appointments, encounters, patientFollowups, patients, users } from "@medsys/db";

type FollowupFilters = {
  patientId?: number | null;
  doctorId?: number | null;
  status?: "pending" | "completed" | "missed" | "cancelled";
  dueFrom?: string | null;
  dueTo?: string | null;
  visitMode?: "appointment" | "walk_in" | null;
  doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
  limit: number;
};

const serializeFollowup = (row: {
  id: number;
  patientId: number;
  encounterId: number | null;
  doctorId: number | null;
  followupType: string;
  dueDate: string;
  status: string;
  visitMode: string | null;
  doctorWorkflowMode: "self_service" | "clinic_supported" | null;
  note: string | null;
  createdByUserId: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
  patientFirstName: string;
  patientLastName: string;
  doctorFirstName: string | null;
  doctorLastName: string | null;
}) => ({
  id: row.id,
  patientId: row.patientId,
  patientName: `${row.patientFirstName} ${row.patientLastName}`,
  encounterId: row.encounterId,
  doctorId: row.doctorId,
  doctorName:
    row.doctorFirstName && row.doctorLastName ? `${row.doctorFirstName} ${row.doctorLastName}` : null,
  followupType: row.followupType,
  dueDate: row.dueDate,
  status: row.status,
  visitMode: row.visitMode,
  doctorWorkflowMode: row.doctorWorkflowMode,
  note: row.note,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt
});

export const listFollowups = async ({
  db,
  organizationId,
  filters
}: {
  db: any;
  organizationId: string;
  filters: FollowupFilters;
}) => {
  const conditions = [eq(patientFollowups.organizationId, organizationId)];

  if (filters.patientId) conditions.push(eq(patientFollowups.patientId, filters.patientId));
  if (filters.doctorId) conditions.push(eq(patientFollowups.doctorId, filters.doctorId));
  if (filters.status) conditions.push(eq(patientFollowups.status, filters.status));
  if (filters.visitMode) conditions.push(eq(patientFollowups.visitMode, filters.visitMode));
  if (filters.doctorWorkflowMode) {
    conditions.push(eq(patientFollowups.doctorWorkflowMode, filters.doctorWorkflowMode));
  }
  if (filters.dueFrom) conditions.push(gte(patientFollowups.dueDate, filters.dueFrom));
  if (filters.dueTo) conditions.push(lte(patientFollowups.dueDate, filters.dueTo));

  const rows = await db
    .select({
      id: patientFollowups.id,
      patientId: patientFollowups.patientId,
      encounterId: patientFollowups.encounterId,
      doctorId: patientFollowups.doctorId,
      followupType: patientFollowups.followupType,
      dueDate: patientFollowups.dueDate,
      status: patientFollowups.status,
      visitMode: patientFollowups.visitMode,
      doctorWorkflowMode: patientFollowups.doctorWorkflowMode,
      note: patientFollowups.note,
      createdByUserId: patientFollowups.createdByUserId,
      createdAt: patientFollowups.createdAt,
      updatedAt: patientFollowups.updatedAt,
      completedAt: patientFollowups.completedAt,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      doctorFirstName: users.firstName,
      doctorLastName: users.lastName
    })
    .from(patientFollowups)
    .innerJoin(patients, eq(patients.id, patientFollowups.patientId))
    .leftJoin(users, eq(users.id, patientFollowups.doctorId))
    .where(and(...conditions))
    .orderBy(patientFollowups.dueDate, desc(patientFollowups.createdAt))
    .limit(filters.limit);

  return rows.map(serializeFollowup);
};

export const getFollowupById = async ({
  db,
  organizationId,
  id
}: {
  db: any;
  organizationId: string;
  id: number;
}) => {
  const rows = await db
    .select({
      id: patientFollowups.id,
      patientId: patientFollowups.patientId,
      encounterId: patientFollowups.encounterId,
      doctorId: patientFollowups.doctorId,
      followupType: patientFollowups.followupType,
      dueDate: patientFollowups.dueDate,
      status: patientFollowups.status,
      visitMode: patientFollowups.visitMode,
      doctorWorkflowMode: patientFollowups.doctorWorkflowMode,
      note: patientFollowups.note,
      createdByUserId: patientFollowups.createdByUserId,
      createdAt: patientFollowups.createdAt,
      updatedAt: patientFollowups.updatedAt,
      completedAt: patientFollowups.completedAt,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      doctorFirstName: users.firstName,
      doctorLastName: users.lastName
    })
    .from(patientFollowups)
    .innerJoin(patients, eq(patients.id, patientFollowups.patientId))
    .leftJoin(users, eq(users.id, patientFollowups.doctorId))
    .where(and(eq(patientFollowups.id, id), eq(patientFollowups.organizationId, organizationId)))
    .limit(1);

  return rows[0] ? serializeFollowup(rows[0]) : null;
};

export const syncEncounterFollowup = async ({
  db,
  organizationId,
  encounterId,
  patientId,
  doctorId,
  nextVisitDate,
  createdByUserId
}: {
  db: any;
  organizationId: string;
  encounterId: number;
  patientId: number;
  doctorId: number;
  nextVisitDate: string | null;
  createdByUserId: number | null;
}) => {
  const encounterRows = await db
    .select({
      encounterId: encounters.id,
      visitMode: appointments.visitMode,
      doctorWorkflowMode: users.doctorWorkflowMode
    })
    .from(encounters)
    .innerJoin(
      appointments,
      and(eq(appointments.id, encounters.appointmentId), eq(appointments.scheduledAt, encounters.appointmentScheduledAt))
    )
    .leftJoin(users, eq(users.id, encounters.doctorId))
    .where(and(eq(encounters.id, encounterId), eq(encounters.organizationId, organizationId)))
    .limit(1);

  if (encounterRows.length === 0) {
    return null;
  }

  const encounterMeta = encounterRows[0];
  const existingRows = await db
    .select({ id: patientFollowups.id, status: patientFollowups.status })
    .from(patientFollowups)
    .where(and(eq(patientFollowups.organizationId, organizationId), eq(patientFollowups.encounterId, encounterId)))
    .limit(1);

  if (!nextVisitDate) {
    if (existingRows.length === 1 && existingRows[0].status === "pending") {
      await db
        .update(patientFollowups)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
          completedAt: null
        })
        .where(eq(patientFollowups.id, existingRows[0].id));
    }
    return existingRows[0]?.id ?? null;
  }

  if (existingRows.length === 1) {
    await db
      .update(patientFollowups)
      .set({
        doctorId,
        followupType: "review",
        dueDate: nextVisitDate,
        status: existingRows[0].status === "completed" ? "completed" : "pending",
        visitMode: encounterMeta.visitMode,
        doctorWorkflowMode: encounterMeta.doctorWorkflowMode ?? null,
        updatedAt: new Date(),
        completedAt: existingRows[0].status === "completed" ? new Date() : null
      })
      .where(eq(patientFollowups.id, existingRows[0].id));
    return existingRows[0].id;
  }

  const inserted = await db
    .insert(patientFollowups)
    .values({
      organizationId,
      patientId,
      encounterId,
      doctorId,
      followupType: "review",
      dueDate: nextVisitDate,
      status: "pending",
      visitMode: encounterMeta.visitMode,
      doctorWorkflowMode: encounterMeta.doctorWorkflowMode ?? null,
      note: null,
      createdByUserId,
      updatedAt: new Date()
    })
    .returning({ id: patientFollowups.id });

  return inserted[0]?.id ?? null;
};
