import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  appointments,
  dailySummarySnapshots,
  dispenseRecords,
  encounters,
  inventoryItems,
  patients,
  prescriptions,
  users
} from "@medsys/db";

type DbClient = any;

export type DailySummaryRole = "doctor" | "assistant" | "owner";

export type DailySummaryScope = {
  role: DailySummaryRole;
  doctorId: number | null;
  assistantId: number | null;
  actorUserId: number | null;
  visitMode: "appointment" | "walk_in" | null;
  doctorWorkflowMode: "self_service" | "clinic_supported" | null;
};

type DailySummaryParams = {
  db: DbClient;
  organizationId: string;
  scope: DailySummaryScope;
  summaryDate: string;
  generatedAt: Date;
};

type DailySummaryResponse = {
  roleContext: DailySummaryRole;
  summaryDate: string;
  generatedAt: string;
  filterContext: {
    visitMode: "appointment" | "walk_in" | null;
    doctorWorkflowMode: "self_service" | "clinic_supported" | null;
  };
  summary: Record<string, unknown>;
  insights: string[];
};

const startOfDayUtc = (date: string) => new Date(`${date}T00:00:00.000Z`);
const endOfDayUtc = (date: string) => new Date(`${date}T23:59:59.999Z`);

const pushAppointmentModeFilters = (conditions: any[], scope: DailySummaryScope) => {
  if (scope.visitMode) {
    conditions.push(eq(appointments.visitMode, scope.visitMode));
  }
  if (scope.doctorWorkflowMode) {
    conditions.push(
      sql`exists (
        select 1 from users workflow_user
        where workflow_user.id = ${appointments.doctorId}
          and workflow_user.doctor_workflow_mode = ${scope.doctorWorkflowMode}
      )`
    );
  }
};

const pushEncounterModeFilters = (conditions: any[], scope: DailySummaryScope) => {
  if (scope.visitMode) {
    conditions.push(
      sql`exists (
        select 1 from appointments report_appointments
        where report_appointments.id = ${encounters.appointmentId}
          and report_appointments.organization_id = ${encounters.organizationId}
          and report_appointments.visit_mode = ${scope.visitMode}
      )`
    );
  }
  if (scope.doctorWorkflowMode) {
    conditions.push(
      sql`exists (
        select 1 from users workflow_user
        where workflow_user.id = ${encounters.doctorId}
          and workflow_user.doctor_workflow_mode = ${scope.doctorWorkflowMode}
      )`
    );
  }
};

const buildDoctorSummary = async ({
  db,
  organizationId,
  summaryDate,
  generatedAt,
  scope
}: DailySummaryParams): Promise<DailySummaryResponse> => {
  const dayStart = startOfDayUtc(summaryDate);
  const dayEnd = endOfDayUtc(summaryDate);
  const doctorId = scope.doctorId!;
  const encounterConditions = [
    eq(encounters.organizationId, organizationId),
    eq(encounters.doctorId, doctorId),
    gte(encounters.checkedAt, dayStart),
    lte(encounters.checkedAt, dayEnd),
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(encounterConditions, scope);

  const waitingConditions = [
    eq(appointments.organizationId, organizationId),
    eq(appointments.status, "waiting"),
    eq(appointments.doctorId, doctorId),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(waitingConditions, scope);

  const prescriptionConditions = [
    eq(prescriptions.organizationId, organizationId),
    eq(prescriptions.doctorId, doctorId),
    gte(prescriptions.createdAt, dayStart),
    lte(prescriptions.createdAt, dayEnd),
    isNull(prescriptions.deletedAt)
  ];
  if (scope.visitMode || scope.doctorWorkflowMode) {
    prescriptionConditions.push(
      sql`exists (
        select 1
        from encounters report_encounters
        join appointments report_appointments
          on report_appointments.id = report_encounters.appointment_id
         and report_appointments.scheduled_at = report_encounters.appointment_scheduled_at
        join users workflow_user
          on workflow_user.id = report_encounters.doctor_id
        where report_encounters.id = ${prescriptions.encounterId}
          and report_encounters.organization_id = ${prescriptions.organizationId}
          ${scope.visitMode ? sql`and report_appointments.visit_mode = ${scope.visitMode}` : sql``}
          ${scope.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${scope.doctorWorkflowMode}` : sql``}
      )`
    );
  }

  const followupConditions = [
    eq(encounters.organizationId, organizationId),
    eq(encounters.doctorId, doctorId),
    sql`${encounters.nextVisitDate} IS NOT NULL`,
    sql`${encounters.nextVisitDate} <= ${(new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10)}`,
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(followupConditions, scope);

  const [encounterCount, waitingCount, prescriptionCount, followupDueSoonCount, lowStockCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...encounterConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...waitingConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(prescriptions)
      .where(and(...prescriptionConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...followupConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.organizationId, organizationId),
          isNull(inventoryItems.deletedAt),
          sql`${inventoryItems.stock} <= ${inventoryItems.reorderLevel}`
        )
      )
  ]);

  const patientsSeenToday = Number(encounterCount[0]?.count ?? 0);
  const patientsWaitingNow = Number(waitingCount[0]?.count ?? 0);
  const prescriptionsIssuedToday = Number(prescriptionCount[0]?.count ?? 0);
  const followupsDueSoon = Number(followupDueSoonCount[0]?.count ?? 0);
  const lowStockItems = Number(lowStockCount[0]?.count ?? 0);

  const insights = [
    `You saw ${patientsSeenToday} patient${patientsSeenToday === 1 ? "" : "s"} on ${summaryDate}.`,
    `${patientsWaitingNow} patient${patientsWaitingNow === 1 ? " is" : "s are"} waiting under your queue right now.`,
    `${followupsDueSoon} follow-up${followupsDueSoon === 1 ? "" : "s"} are due within the next 7 days.`
  ];

  if (lowStockItems > 0) {
    insights.push(`${lowStockItems} inventory item${lowStockItems === 1 ? "" : "s"} are at or below minimum stock.`);
  }

  return {
    roleContext: "doctor",
    summaryDate,
    generatedAt: generatedAt.toISOString(),
    filterContext: {
      visitMode: scope.visitMode,
      doctorWorkflowMode: scope.doctorWorkflowMode
    },
    summary: {
      patientsSeenToday,
      patientsWaitingNow,
      prescriptionsIssuedToday,
      followupsDueSoon,
      lowStockItems
    },
    insights
  };
};

const buildAssistantSummary = async ({
  db,
  organizationId,
  summaryDate,
  generatedAt,
  scope
}: DailySummaryParams): Promise<DailySummaryResponse> => {
  const dayStart = startOfDayUtc(summaryDate);
  const dayEnd = endOfDayUtc(summaryDate);
  const assistantId = scope.assistantId!;
  const appointmentConditions = [
    eq(appointments.organizationId, organizationId),
    eq(appointments.assistantId, assistantId),
    gte(appointments.registeredAt, dayStart),
    lte(appointments.registeredAt, dayEnd),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(appointmentConditions, scope);

  const queueConditions = [
    eq(appointments.organizationId, organizationId),
    eq(appointments.status, "waiting"),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(queueConditions, scope);

  const delayedQueueConditions = [
    eq(appointments.organizationId, organizationId),
    eq(appointments.status, "waiting"),
    sql`${appointments.waitingAt} IS NOT NULL`,
    sql`${appointments.waitingAt} <= ${new Date(generatedAt.getTime() - 25 * 60 * 1000).toISOString()}`,
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(delayedQueueConditions, scope);

  const [registeredTodayCount, queueWaitingCount, dispenseCount, delayedQueueCount, doctorLoadRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...appointmentConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...queueConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(dispenseRecords)
      .where(
        and(
          eq(dispenseRecords.organizationId, organizationId),
          eq(dispenseRecords.assistantId, assistantId),
          gte(dispenseRecords.dispensedAt, dayStart),
          lte(dispenseRecords.dispensedAt, dayEnd),
          ...(scope.visitMode || scope.doctorWorkflowMode
            ? [
                sql`exists (
                  select 1
                  from prescriptions report_prescriptions
                  join encounters report_encounters on report_encounters.id = report_prescriptions.encounter_id
                  join appointments report_appointments
                    on report_appointments.id = report_encounters.appointment_id
                   and report_appointments.scheduled_at = report_encounters.appointment_scheduled_at
                  join users workflow_user on workflow_user.id = report_prescriptions.doctor_id
                  where report_prescriptions.id = ${dispenseRecords.prescriptionId}
                    and report_prescriptions.organization_id = ${dispenseRecords.organizationId}
                    ${scope.visitMode ? sql`and report_appointments.visit_mode = ${scope.visitMode}` : sql``}
                    ${scope.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${scope.doctorWorkflowMode}` : sql``}
                )`
              ]
            : [])
        )
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...delayedQueueConditions)),
    db
      .select({
        doctorId: appointments.doctorId,
        firstName: users.firstName,
        lastName: users.lastName,
        count: sql<number>`count(*)`
      })
      .from(appointments)
      .leftJoin(users, eq(users.id, appointments.doctorId))
      .where(and(...queueConditions))
      .groupBy(appointments.doctorId, users.firstName, users.lastName)
      .orderBy(desc(sql<number>`count(*)`))
  ]);

  const registeredToday = Number(registeredTodayCount[0]?.count ?? 0);
  const waitingQueueNow = Number(queueWaitingCount[0]?.count ?? 0);
  const dispensedToday = Number(dispenseCount[0]?.count ?? 0);
  const delayedQueueCountValue = Number(delayedQueueCount[0]?.count ?? 0);
  const highestLoadDoctor = (doctorLoadRows as Array<{ firstName: string | null; lastName: string | null; count: number }>)[0];

  const insights = [
    `${registeredToday} registration${registeredToday === 1 ? "" : "s"} were handled today.`,
    `${dispensedToday} dispense record${dispensedToday === 1 ? "" : "s"} were completed today.`,
    `${delayedQueueCountValue} patient${delayedQueueCountValue === 1 ? "" : "s"} have been waiting longer than 25 minutes.`
  ];

  if (highestLoadDoctor) {
    const doctorName =
      highestLoadDoctor.firstName && highestLoadDoctor.lastName
        ? `${highestLoadDoctor.firstName} ${highestLoadDoctor.lastName}`
        : "One doctor";
    insights.push(`${doctorName} currently has the heaviest waiting queue.`);
  }

  return {
    roleContext: "assistant",
    summaryDate,
    generatedAt: generatedAt.toISOString(),
    filterContext: {
      visitMode: scope.visitMode,
      doctorWorkflowMode: scope.doctorWorkflowMode
    },
    summary: {
      registeredToday,
      waitingQueueNow,
      dispensedToday,
      delayedQueueCount: delayedQueueCountValue
    },
    insights
  };
};

const buildOwnerSummary = async ({
  db,
  organizationId,
  summaryDate,
  generatedAt,
  scope
}: DailySummaryParams): Promise<DailySummaryResponse> => {
  const dayStart = startOfDayUtc(summaryDate);
  const dayEnd = endOfDayUtc(summaryDate);
  const appointmentConditions = [
    eq(appointments.organizationId, organizationId),
    gte(appointments.scheduledAt, dayStart),
    lte(appointments.scheduledAt, dayEnd),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(appointmentConditions, scope);

  const encounterConditions = [
    eq(encounters.organizationId, organizationId),
    gte(encounters.checkedAt, dayStart),
    lte(encounters.checkedAt, dayEnd),
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(encounterConditions, scope);

  const followupConditions = [
    eq(encounters.organizationId, organizationId),
    sql`${encounters.nextVisitDate} IS NOT NULL`,
    sql`${encounters.nextVisitDate} <= ${(new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10)}`,
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(followupConditions, scope);

  const [
    totalPatientsCount,
    appointmentsTodayCount,
    encountersTodayCount,
    lowStockCount,
    followupsDueSoonCount,
    doctorLoadRows
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(patients)
      .where(and(eq(patients.organizationId, organizationId), isNull(patients.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...appointmentConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...encounterConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.organizationId, organizationId),
          isNull(inventoryItems.deletedAt),
          sql`${inventoryItems.stock} <= ${inventoryItems.reorderLevel}`
        )
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...followupConditions)),
    db
      .select({
        doctorId: encounters.doctorId,
        firstName: users.firstName,
        lastName: users.lastName,
        count: sql<number>`count(*)`
      })
      .from(encounters)
      .innerJoin(users, eq(users.id, encounters.doctorId))
      .where(and(...encounterConditions))
      .groupBy(encounters.doctorId, users.firstName, users.lastName)
      .orderBy(desc(sql<number>`count(*)`))
  ]);

  const totalPatients = Number(totalPatientsCount[0]?.count ?? 0);
  const appointmentsToday = Number(appointmentsTodayCount[0]?.count ?? 0);
  const encountersToday = Number(encountersTodayCount[0]?.count ?? 0);
  const lowStockItems = Number(lowStockCount[0]?.count ?? 0);
  const followupsDueSoon = Number(followupsDueSoonCount[0]?.count ?? 0);
  const busiestDoctor = (doctorLoadRows as Array<{ firstName: string; lastName: string; count: number }>)[0];

  const insights = [
    `${appointmentsToday} appointment${appointmentsToday === 1 ? "" : "s"} were scheduled on ${summaryDate}.`,
    `${encountersToday} encounter${encountersToday === 1 ? "" : "s"} were completed across the clinic today.`,
    `${followupsDueSoon} follow-up${followupsDueSoon === 1 ? "" : "s"} are due within the next 7 days.`
  ];

  if (busiestDoctor) {
    insights.push(
      `${busiestDoctor.firstName} ${busiestDoctor.lastName} handled the highest encounter load today with ${Number(
        busiestDoctor.count
      )} encounter${Number(busiestDoctor.count) === 1 ? "" : "s"}.`
    );
  }
  if (lowStockItems > 0) {
    insights.push(`${lowStockItems} inventory item${lowStockItems === 1 ? "" : "s"} need stock review now.`);
  }

  return {
    roleContext: "owner",
    summaryDate,
    generatedAt: generatedAt.toISOString(),
    filterContext: {
      visitMode: scope.visitMode,
      doctorWorkflowMode: scope.doctorWorkflowMode
    },
    summary: {
      totalPatients,
      appointmentsToday,
      encountersToday,
      lowStockItems,
      followupsDueSoon
    },
    insights
  };
};

export const buildDailySummary = async (params: DailySummaryParams): Promise<DailySummaryResponse> => {
  if (params.scope.role === "doctor") {
    return buildDoctorSummary(params);
  }
  if (params.scope.role === "assistant") {
    return buildAssistantSummary(params);
  }
  return buildOwnerSummary(params);
};

export const storeDailySummarySnapshot = async ({
  db,
  organizationId,
  scope,
  summaryDate,
  payload
}: {
  db: DbClient;
  organizationId: string;
  scope: DailySummaryScope;
  summaryDate: string;
  payload: DailySummaryResponse;
}) => {
  const inserted = await db
    .insert(dailySummarySnapshots)
    .values({
      organizationId,
      roleContext: scope.role,
      actorUserId: scope.actorUserId,
      summaryDate,
      summaryType: "daily",
      payload
    })
    .returning({ id: dailySummarySnapshots.id, createdAt: dailySummarySnapshots.createdAt });

  return inserted[0] ?? null;
};

export const listDailySummaryHistory = async ({
  db,
  organizationId,
  scope,
  summaryDate,
  limit
}: {
  db: DbClient;
  organizationId: string;
  scope: DailySummaryScope;
  summaryDate?: string | null;
  limit: number;
}) => {
  const conditions = [eq(dailySummarySnapshots.organizationId, organizationId), eq(dailySummarySnapshots.roleContext, scope.role)];

  if (scope.actorUserId !== null) {
    conditions.push(eq(dailySummarySnapshots.actorUserId, scope.actorUserId));
  }
  if (summaryDate) {
    conditions.push(eq(dailySummarySnapshots.summaryDate, summaryDate));
  }
  if (scope.visitMode) {
    conditions.push(sql`${dailySummarySnapshots.payload} -> 'filterContext' ->> 'visitMode' = ${scope.visitMode}`);
  }
  if (scope.doctorWorkflowMode) {
    conditions.push(
      sql`${dailySummarySnapshots.payload} -> 'filterContext' ->> 'doctorWorkflowMode' = ${scope.doctorWorkflowMode}`
    );
  }

  const rows = await db
    .select({
      id: dailySummarySnapshots.id,
      roleContext: dailySummarySnapshots.roleContext,
      actorUserId: dailySummarySnapshots.actorUserId,
      summaryDate: dailySummarySnapshots.summaryDate,
      summaryType: dailySummarySnapshots.summaryType,
      payload: dailySummarySnapshots.payload,
      createdAt: dailySummarySnapshots.createdAt
    })
    .from(dailySummarySnapshots)
    .where(and(...conditions))
    .orderBy(desc(dailySummarySnapshots.summaryDate), desc(dailySummarySnapshots.createdAt))
    .limit(limit);

  return rows.map((row: any) => ({
    id: row.id,
    roleContext: row.roleContext,
    actorUserId: row.actorUserId,
    summaryDate: row.summaryDate,
    summaryType: row.summaryType,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    payload: row.payload
  }));
};
