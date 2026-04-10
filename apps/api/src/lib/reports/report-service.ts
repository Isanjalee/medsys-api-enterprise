import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  appointments,
  encounterDiagnoses,
  dispenseRecords,
  encounters,
  inventoryItems,
  inventoryMovements,
  patients,
  patientFollowups,
  prescriptionItems,
  prescriptions,
  testOrders,
  users
} from "@medsys/db";

type ReportRange = {
  preset: "7d" | "30d" | "custom";
  start: Date;
  end: Date;
};

type ReportFilters = {
  doctorId?: number | null;
  assistantId?: number | null;
  visitMode?: "appointment" | "walk_in";
  doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
};

type ReportContext = {
  db: any;
  organizationId: string;
  range: ReportRange;
  filters: ReportFilters;
  generatedAt: Date;
};

type AppointmentStatusRow = {
  id: number;
  status: string;
  priority: string;
  scheduledAt: Date;
  visitMode: "appointment" | "walk_in";
};

type EncounterRow = {
  id: number;
  checkedAt: Date;
  doctorId: number;
  closedAt: Date | null;
};

type DoctorPerformanceRow = {
  doctorId: number;
  encounterId: number;
  checkedAt: Date;
  closedAt: Date | null;
  nextVisitDate: string | null;
  doctorFirstName: string;
  doctorLastName: string;
};

type AssistantAppointmentRow = {
  assistantId: number | null;
  appointmentId: number;
  firstName: string | null;
  lastName: string | null;
};

type AssistantDispenseRow = {
  assistantId: number;
  dispenseId: number;
  firstName: string;
  lastName: string;
};

type InventoryMovementRow = {
  inventoryItemId: number;
  quantity: string | number;
  movementType: string;
  createdAt: Date;
  referenceType: string | null;
  referenceId: number | null;
};

type InventoryItemUsageRow = {
  id: number;
  name: string;
  stock: string | number;
  reorderLevel: string | number;
};

type PatientFollowupRow = {
  id: number;
  patientId: number;
  doctorId: number | null;
  dueDate: string;
  createdAt: Date;
  status: string;
};

const buildResponse = (
  generatedAt: Date,
  range: ReportRange,
  filters: ReportFilters,
  summary: object,
  charts: object,
  tables: object,
  comparisons: object = {},
  insights: string[] = []
) => ({
  generatedAt: generatedAt.toISOString(),
  range: {
    preset: range.preset,
    dateFrom: range.start.toISOString(),
    dateTo: range.end.toISOString()
  },
  filters: {
    doctorId: filters.doctorId ?? null,
    assistantId: filters.assistantId ?? null,
    visitMode: filters.visitMode ?? null,
    doctorWorkflowMode: filters.doctorWorkflowMode ?? null
  },
  summary,
  charts,
  tables,
  comparisons,
  insights
});

const resolvePreviousRange = (range: ReportRange): ReportRange => {
  const durationMs = range.end.getTime() - range.start.getTime();
  const previousEnd = new Date(range.start.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - durationMs);
  return {
    preset: range.preset,
    start: previousStart,
    end: previousEnd
  };
};

const calculateChangePercent = (current: number, previous: number) => {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

const pushAppointmentModeFilters = (conditions: any[], filters: ReportFilters) => {
  if (filters.visitMode) {
    conditions.push(eq(appointments.visitMode, filters.visitMode));
  }
  if (filters.doctorWorkflowMode) {
    conditions.push(
      sql`exists (
        select 1 from users workflow_user
        where workflow_user.id = ${appointments.doctorId}
          and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}
      )`
    );
  }
};

const pushEncounterModeFilters = (conditions: any[], filters: ReportFilters) => {
  if (filters.visitMode) {
    conditions.push(
      sql`exists (
        select 1 from appointments report_appointments
        where report_appointments.id = ${encounters.appointmentId}
          and report_appointments.organization_id = ${encounters.organizationId}
          and report_appointments.visit_mode = ${filters.visitMode}
      )`
    );
  }
  if (filters.doctorWorkflowMode) {
    conditions.push(
      sql`exists (
        select 1 from users workflow_user
        where workflow_user.id = ${encounters.doctorId}
          and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}
      )`
    );
  }
};

const averageConsultationMinutes = (rows: Array<{ checkedAt: Date; closedAt: Date | null }>) => {
  const completedRows = rows.filter((row) => row.closedAt instanceof Date && row.closedAt.getTime() >= row.checkedAt.getTime());
  if (!completedRows.length) {
    return null;
  }

  const totalMinutes = completedRows.reduce(
    (sum, row) => sum + (row.closedAt!.getTime() - row.checkedAt.getTime()) / (1000 * 60),
    0
  );

  return Number((totalMinutes / completedRows.length).toFixed(1));
};

export const buildClinicOverviewReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const previousRange = resolvePreviousRange(range);
  const appointmentConditions = [
    eq(appointments.organizationId, organizationId),
    gte(appointments.scheduledAt, range.start),
    lte(appointments.scheduledAt, range.end),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(appointmentConditions, filters);

  const encounterConditions = [
    eq(encounters.organizationId, organizationId),
    gte(encounters.checkedAt, range.start),
    lte(encounters.checkedAt, range.end),
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(encounterConditions, filters);

  const prescriptionConditions = [
    eq(prescriptions.organizationId, organizationId),
    gte(prescriptions.createdAt, range.start),
    lte(prescriptions.createdAt, range.end),
    isNull(prescriptions.deletedAt)
  ];
  if (filters.visitMode || filters.doctorWorkflowMode) {
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
          ${filters.visitMode ? sql`and report_appointments.visit_mode = ${filters.visitMode}` : sql``}
          ${filters.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}` : sql``}
      )`
    );
  }

  const previousAppointmentConditions = [
    eq(appointments.organizationId, organizationId),
    gte(appointments.scheduledAt, previousRange.start),
    lte(appointments.scheduledAt, previousRange.end),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(previousAppointmentConditions, filters);

  const previousEncounterConditions = [
    eq(encounters.organizationId, organizationId),
    gte(encounters.checkedAt, previousRange.start),
    lte(encounters.checkedAt, previousRange.end),
    isNull(encounters.deletedAt)
  ];
  pushEncounterModeFilters(previousEncounterConditions, filters);

  const [patientCount, appointmentRows, encounterRows, prescriptionCount, testsOrderedCountRows, lowStockCount, previousAppointmentsCountRows, previousEncountersCountRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(patients)
      .where(and(eq(patients.organizationId, organizationId), isNull(patients.deletedAt))),
    db
      .select({
        id: appointments.id,
        status: appointments.status,
        priority: appointments.priority,
        scheduledAt: appointments.scheduledAt,
        visitMode: appointments.visitMode
      })
      .from(appointments)
      .where(and(...appointmentConditions)),
    db
      .select({
        id: encounters.id,
        checkedAt: encounters.checkedAt,
        doctorId: encounters.doctorId,
        closedAt: encounters.closedAt
      })
      .from(encounters)
      .where(and(...encounterConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(prescriptions)
      .where(and(...prescriptionConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(testOrders)
      .innerJoin(encounters, eq(encounters.id, testOrders.encounterId))
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
      .from(appointments)
      .where(and(...previousAppointmentConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...previousEncounterConditions))
  ]);

  const typedAppointmentRows = appointmentRows as AppointmentStatusRow[];
  const typedEncounterRows = encounterRows as EncounterRow[];
  const waitingCount = typedAppointmentRows.filter((row) => row.status === "waiting").length;
  const walkInCount = typedAppointmentRows.filter((row) => row.visitMode === "walk_in").length;
  const appointmentModeCount = typedAppointmentRows.filter((row) => row.visitMode === "appointment").length;
  const consultationAverageMinutes = averageConsultationMinutes(typedEncounterRows);
  const previousAppointmentsCount = Number(previousAppointmentsCountRows[0]?.count ?? 0);
  const previousEncountersCount = Number(previousEncountersCountRows[0]?.count ?? 0);
  const appointmentsChangePercent = calculateChangePercent(typedAppointmentRows.length, previousAppointmentsCount);
  const encountersChangePercent = calculateChangePercent(typedEncounterRows.length, previousEncountersCount);

  const appointmentsByStatus = typedAppointmentRows.reduce((acc: Record<string, number>, row: AppointmentStatusRow) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const appointmentsByHour = typedAppointmentRows.reduce((acc: Record<string, number>, row: AppointmentStatusRow) => {
    const hourLabel = `${String(row.scheduledAt.getUTCHours()).padStart(2, "0")}:00`;
    acc[hourLabel] = (acc[hourLabel] ?? 0) + 1;
    return acc;
  }, {});
  const doctorLoadRows = await db
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
    .orderBy(sql<number>`count(*) desc`);
  const peakHourEntry = Object.entries(appointmentsByHour).sort((left, right) => right[1] - left[1])[0] ?? null;
  const insights = [
    `Appointments changed by ${appointmentsChangePercent}% compared to the previous matching period.`,
    `Encounters changed by ${encountersChangePercent}% compared to the previous matching period.`
  ];
  if (peakHourEntry) {
    insights.push(`Peak hour in this range was ${peakHourEntry[0]}.`);
  }
  if (waitingCount > 0) {
    insights.push(`${waitingCount} patient${waitingCount === 1 ? "" : "s"} are currently waiting in the selected view.`);
  }

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalPatients: Number(patientCount[0]?.count ?? 0),
      appointmentsInRange: typedAppointmentRows.length,
      encountersInRange: typedEncounterRows.length,
      prescriptionsInRange: Number(prescriptionCount[0]?.count ?? 0),
      testsOrderedInRange: Number(testsOrderedCountRows[0]?.count ?? 0),
      lowStockItems: Number(lowStockCount[0]?.count ?? 0),
      waitingCount,
      walkInCount,
      appointmentModeCount,
      averageConsultationMinutes: consultationAverageMinutes
    },
    {
      appointmentStatusDistribution: Object.entries(appointmentsByStatus).map(([label, count]) => ({ label, count })),
      visitModeBreakdown: [
        { label: "walk_in", count: walkInCount },
        { label: "appointment", count: appointmentModeCount }
      ],
      peakHourDistribution: Object.entries(appointmentsByHour)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, count]) => ({ label, count })),
      doctorWorkloadDistribution: (doctorLoadRows as Array<{ doctorId: number; firstName: string; lastName: string; count: number }>).map(
        (row) => ({
          label: `${row.firstName} ${row.lastName}`,
          count: Number(row.count)
        })
      )
    },
    {
      recentAppointments: typedAppointmentRows
        .sort((left: AppointmentStatusRow, right: AppointmentStatusRow) => right.scheduledAt.getTime() - left.scheduledAt.getTime())
        .slice(0, 10)
    },
    {
      previousAppointmentsCount,
      previousEncountersCount,
      appointmentsChangePercent,
      encountersChangePercent,
      peakHour: peakHourEntry?.[0] ?? null
    },
    insights
  );
};

export const buildDoctorPerformanceReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const previousRange = resolvePreviousRange(range);
  const conditions = [
    eq(encounters.organizationId, organizationId),
    gte(encounters.checkedAt, range.start),
    lte(encounters.checkedAt, range.end),
    isNull(encounters.deletedAt)
  ];
  if (filters.doctorId) {
    conditions.push(eq(encounters.doctorId, filters.doctorId));
  }
  pushEncounterModeFilters(conditions, filters);
  const previousConditions = [
    eq(encounters.organizationId, organizationId),
    gte(encounters.checkedAt, previousRange.start),
    lte(encounters.checkedAt, previousRange.end),
    isNull(encounters.deletedAt)
  ];
  if (filters.doctorId) {
    previousConditions.push(eq(encounters.doctorId, filters.doctorId));
  }
  pushEncounterModeFilters(previousConditions, filters);

  const rows = await db
    .select({
      doctorId: encounters.doctorId,
      encounterId: encounters.id,
      checkedAt: encounters.checkedAt,
      closedAt: encounters.closedAt,
      nextVisitDate: encounters.nextVisitDate,
      doctorFirstName: users.firstName,
      doctorLastName: users.lastName
    })
    .from(encounters)
    .innerJoin(users, eq(users.id, encounters.doctorId))
    .where(and(...conditions));

  const typedRows = rows as DoctorPerformanceRow[];
  const [prescriptionCountRows, followupCountRows, diagnosisRows, testsOrderedCount, previousEncounterCountRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(prescriptions)
      .where(
        and(
          eq(prescriptions.organizationId, organizationId),
          sql`exists (
            select 1
            from encounters report_encounters
            where report_encounters.id = ${prescriptions.encounterId}
              and report_encounters.organization_id = ${prescriptions.organizationId}
              and report_encounters.checked_at >= ${range.start}
              and report_encounters.checked_at <= ${range.end}
              and report_encounters.deleted_at is null
              ${filters.doctorId ? sql`and report_encounters.doctor_id = ${filters.doctorId}` : sql``}
              ${filters.visitMode ? sql`and exists (
                select 1 from appointments report_appointments
                where report_appointments.id = report_encounters.appointment_id
                  and report_appointments.organization_id = report_encounters.organization_id
                  and report_appointments.visit_mode = ${filters.visitMode}
              )` : sql``}
              ${filters.doctorWorkflowMode ? sql`and exists (
                select 1 from users workflow_user
                where workflow_user.id = report_encounters.doctor_id
                  and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}
              )` : sql``}
          )`
        )
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(patientFollowups)
      .where(
        and(
          eq(patientFollowups.organizationId, organizationId),
          eq(patientFollowups.status, "pending"),
          ...(filters.doctorId ? [eq(patientFollowups.doctorId, filters.doctorId)] : []),
          ...(filters.visitMode ? [eq(patientFollowups.visitMode, filters.visitMode)] : []),
          ...(filters.doctorWorkflowMode ? [eq(patientFollowups.doctorWorkflowMode, filters.doctorWorkflowMode)] : []),
          gte(patientFollowups.createdAt, range.start),
          lte(patientFollowups.createdAt, range.end)
        )
      ),
    db
      .select({
        diagnosisName: encounterDiagnoses.diagnosisName,
        count: sql<number>`count(*)`
      })
      .from(encounterDiagnoses)
      .innerJoin(encounters, eq(encounters.id, encounterDiagnoses.encounterId))
      .where(and(...conditions))
      .groupBy(encounterDiagnoses.diagnosisName)
      .orderBy(sql<number>`count(*) desc`),
    db
      .select({ count: sql<number>`count(*)` })
      .from(testOrders)
      .innerJoin(encounters, eq(encounters.id, testOrders.encounterId))
      .where(and(...conditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(encounters)
      .where(and(...previousConditions))
  ]);

  const grouped = new Map<
    number,
    { doctorId: number; doctorName: string; encounters: number; averageMinutes: number | null; followupsScheduled: number }
  >();
  for (const row of typedRows) {
    const current = grouped.get(row.doctorId) ?? {
      doctorId: row.doctorId,
      doctorName: `${row.doctorFirstName} ${row.doctorLastName}`,
      encounters: 0,
      averageMinutes: null,
      followupsScheduled: 0
    };
    current.encounters += 1;
    grouped.set(row.doctorId, current);
  }
  for (const [doctorId, value] of grouped.entries()) {
    const doctorRows = typedRows.filter((row) => row.doctorId === doctorId);
    value.averageMinutes = averageConsultationMinutes(doctorRows);
    value.followupsScheduled = doctorRows.filter((row) => Boolean(row.nextVisitDate)).length;
  }

  const averageMinutes = averageConsultationMinutes(typedRows);
  const followupsScheduled = Number(followupCountRows[0]?.count ?? 0);
  const prescriptionsIssued = Number(prescriptionCountRows[0]?.count ?? 0);
  const testsOrdered = Number(testsOrderedCount[0]?.count ?? 0);
  const previousEncounterCount = Number(previousEncounterCountRows[0]?.count ?? 0);
  const encounterChangePercent = calculateChangePercent(typedRows.length, previousEncounterCount);
  const insights = [
    `Encounters changed by ${encounterChangePercent}% compared to the previous matching period.`,
    `${followupsScheduled} follow-up${followupsScheduled === 1 ? "" : "s"} were scheduled in this range.`
  ];

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalDoctors: grouped.size,
      totalEncounters: typedRows.length,
      averageConsultationMinutes: averageMinutes,
      prescriptionsIssued,
      testsOrdered,
      followupsScheduled,
      followupRate: typedRows.length === 0 ? 0 : Number(((followupsScheduled / typedRows.length) * 100).toFixed(1))
    },
    {
      encountersByDoctor: Array.from(grouped.values()).map((item) => ({
        label: item.doctorName,
        count: item.encounters
      })),
      diagnosisDistribution: (diagnosisRows as Array<{ diagnosisName: string; count: number }>).slice(0, 10).map((row) => ({
        label: row.diagnosisName,
        count: Number(row.count)
      }))
    },
    {
      doctors: Array.from(grouped.values()).sort((left, right) => right.encounters - left.encounters)
    },
    {
      previousEncounterCount,
      encounterChangePercent
    },
    insights
  );
};

export const buildAssistantPerformanceReport = async ({
  db,
  organizationId,
  range,
  filters,
  generatedAt
}: ReportContext) => {
  const previousRange = resolvePreviousRange(range);
  const appointmentConditions = [
    eq(appointments.organizationId, organizationId),
    gte(appointments.scheduledAt, range.start),
    lte(appointments.scheduledAt, range.end),
    isNull(appointments.deletedAt)
  ];
  if (filters.assistantId) {
    appointmentConditions.push(eq(appointments.assistantId, filters.assistantId));
  }
  pushAppointmentModeFilters(appointmentConditions, filters);
  const waitingQueueConditions = [
    eq(appointments.organizationId, organizationId),
    eq(appointments.status, "waiting"),
    isNull(appointments.deletedAt)
  ];
  pushAppointmentModeFilters(waitingQueueConditions, filters);
  const delayedQueueConditions = [
    ...waitingQueueConditions,
    sql`${appointments.waitingAt} IS NOT NULL`,
    sql`${appointments.waitingAt} <= ${new Date(generatedAt.getTime() - 25 * 60 * 1000).toISOString()}`
  ];
  const previousAppointmentConditions = [
    eq(appointments.organizationId, organizationId),
    gte(appointments.scheduledAt, previousRange.start),
    lte(appointments.scheduledAt, previousRange.end),
    isNull(appointments.deletedAt)
  ];
  if (filters.assistantId) {
    previousAppointmentConditions.push(eq(appointments.assistantId, filters.assistantId));
  }
  pushAppointmentModeFilters(previousAppointmentConditions, filters);

  const dispenseConditions = [
    eq(dispenseRecords.organizationId, organizationId),
    gte(dispenseRecords.dispensedAt, range.start),
    lte(dispenseRecords.dispensedAt, range.end)
  ];
  if (filters.assistantId) {
    dispenseConditions.push(eq(dispenseRecords.assistantId, filters.assistantId));
  }
  if (filters.doctorWorkflowMode || filters.visitMode) {
    dispenseConditions.push(
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
          ${filters.visitMode ? sql`and report_appointments.visit_mode = ${filters.visitMode}` : sql``}
          ${filters.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}` : sql``}
      )`
    );
  }

  const [appointmentRows, dispenseRows, waitingQueueCountRows, delayedQueueCountRows, previousAppointmentCountRows] = await Promise.all([
    db
      .select({
        assistantId: appointments.assistantId,
        appointmentId: appointments.id,
        firstName: users.firstName,
        lastName: users.lastName
      })
      .from(appointments)
      .leftJoin(users, eq(users.id, appointments.assistantId))
      .where(and(...appointmentConditions)),
    db
      .select({
        assistantId: dispenseRecords.assistantId,
        dispenseId: dispenseRecords.id,
        firstName: users.firstName,
        lastName: users.lastName
      })
      .from(dispenseRecords)
      .innerJoin(users, eq(users.id, dispenseRecords.assistantId))
      .where(and(...dispenseConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...waitingQueueConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...delayedQueueConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(appointments)
      .where(and(...previousAppointmentConditions))
  ]);

  const typedAppointmentRows = appointmentRows as AssistantAppointmentRow[];
  const typedDispenseRows = dispenseRows as AssistantDispenseRow[];
  const waitingQueueNow = Number(waitingQueueCountRows[0]?.count ?? 0);
  const delayedQueueCount = Number(delayedQueueCountRows[0]?.count ?? 0);
  const previousAppointmentCount = Number(previousAppointmentCountRows[0]?.count ?? 0);
  const appointmentChangePercent = calculateChangePercent(typedAppointmentRows.length, previousAppointmentCount);

  const grouped = new Map<number, { assistantId: number; assistantName: string; scheduled: number; dispensed: number }>();
  for (const row of typedAppointmentRows) {
    if (!row.assistantId) continue;
    const current = grouped.get(row.assistantId) ?? {
      assistantId: row.assistantId,
      assistantName: row.firstName && row.lastName ? `${row.firstName} ${row.lastName}` : `Assistant ${row.assistantId}`,
      scheduled: 0,
      dispensed: 0
    };
    current.scheduled += 1;
    grouped.set(row.assistantId, current);
  }
  for (const row of typedDispenseRows) {
    const current = grouped.get(row.assistantId) ?? {
      assistantId: row.assistantId,
      assistantName: `${row.firstName} ${row.lastName}`,
      scheduled: 0,
      dispensed: 0
    };
    current.dispensed += 1;
    grouped.set(row.assistantId, current);
  }
  const insights = [
    `Scheduled appointments changed by ${appointmentChangePercent}% compared to the previous matching period.`,
    `${delayedQueueCount} patient${delayedQueueCount === 1 ? "" : "s"} are waiting longer than 25 minutes.`
  ];

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalAssistants: grouped.size,
      totalScheduledAppointments: typedAppointmentRows.length,
      totalDispenseRecords: typedDispenseRows.length,
      waitingQueueNow,
      delayedQueueCount
    },
    {
      throughputByAssistant: Array.from(grouped.values()).map((item) => ({
        label: item.assistantName,
        scheduled: item.scheduled,
        dispensed: item.dispensed,
        throughput: item.scheduled + item.dispensed
      }))
    },
    {
      assistants: Array.from(grouped.values()).sort((left, right) => right.dispensed - left.dispensed)
    },
    {
      previousAppointmentCount,
      appointmentChangePercent
    },
    insights
  );
};

export const buildInventoryUsageReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const previousRange = resolvePreviousRange(range);
  const movementConditions = [
    eq(inventoryMovements.organizationId, organizationId),
    gte(inventoryMovements.createdAt, range.start),
    lte(inventoryMovements.createdAt, range.end)
  ];
  if (filters.visitMode || filters.doctorWorkflowMode) {
    movementConditions.push(
      sql`exists (
        select 1
        from prescriptions report_prescriptions
        join encounters report_encounters on report_encounters.id = report_prescriptions.encounter_id
        join appointments report_appointments
          on report_appointments.id = report_encounters.appointment_id
         and report_appointments.scheduled_at = report_encounters.appointment_scheduled_at
        join users workflow_user on workflow_user.id = report_prescriptions.doctor_id
        where inventory_movements.reference_type = 'prescription'
          and report_prescriptions.id = inventory_movements.reference_id
          and report_prescriptions.organization_id = ${inventoryMovements.organizationId}
          ${filters.visitMode ? sql`and report_appointments.visit_mode = ${filters.visitMode}` : sql``}
          ${filters.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}` : sql``}
      )`
    );
  }
  const previousMovementConditions = [
    eq(inventoryMovements.organizationId, organizationId),
    gte(inventoryMovements.createdAt, previousRange.start),
    lte(inventoryMovements.createdAt, previousRange.end)
  ];
  if (filters.visitMode || filters.doctorWorkflowMode) {
    previousMovementConditions.push(
      sql`exists (
        select 1
        from prescriptions report_prescriptions
        join encounters report_encounters on report_encounters.id = report_prescriptions.encounter_id
        join appointments report_appointments
          on report_appointments.id = report_encounters.appointment_id
         and report_appointments.scheduled_at = report_encounters.appointment_scheduled_at
        join users workflow_user on workflow_user.id = report_prescriptions.doctor_id
        where inventory_movements.reference_type = 'prescription'
          and report_prescriptions.id = inventory_movements.reference_id
          and report_prescriptions.organization_id = ${inventoryMovements.organizationId}
          ${filters.visitMode ? sql`and report_appointments.visit_mode = ${filters.visitMode}` : sql``}
          ${filters.doctorWorkflowMode ? sql`and workflow_user.doctor_workflow_mode = ${filters.doctorWorkflowMode}` : sql``}
      )`
    );
  }

  const [movementRows, itemRows, previousMovementCountRows] = await Promise.all([
    db
      .select({
        inventoryItemId: inventoryMovements.inventoryItemId,
        quantity: inventoryMovements.quantity,
        movementType: inventoryMovements.movementType,
        createdAt: inventoryMovements.createdAt,
        referenceType: inventoryMovements.referenceType,
        referenceId: inventoryMovements.referenceId
      })
      .from(inventoryMovements)
      .where(and(...movementConditions)),
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        stock: inventoryItems.stock,
        reorderLevel: inventoryItems.reorderLevel
      })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.organizationId, organizationId), isNull(inventoryItems.deletedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(inventoryMovements)
      .where(and(...previousMovementConditions))
  ]);

  const typedMovementRows = movementRows as InventoryMovementRow[];
  const typedItemRows = itemRows as InventoryItemUsageRow[];
  const nameById = new Map<number, InventoryItemUsageRow>(typedItemRows.map((item: InventoryItemUsageRow) => [item.id, item]));
  const outgoing = typedMovementRows.filter((row: InventoryMovementRow) => row.movementType === "out");
  const previousMovementCount = Number(previousMovementCountRows[0]?.count ?? 0);
  const movementChangePercent = calculateChangePercent(typedMovementRows.length, previousMovementCount);
  const grouped = new Map<number, { inventoryItemId: number; name: string; totalOutgoing: number; currentStock: number }>();
  for (const row of outgoing) {
    const item = nameById.get(row.inventoryItemId);
    const current = grouped.get(row.inventoryItemId) ?? {
      inventoryItemId: row.inventoryItemId,
      name: item?.name ?? `Item ${row.inventoryItemId}`,
      totalOutgoing: 0,
      currentStock: Number(item?.stock ?? 0)
    };
    current.totalOutgoing += Number(row.quantity);
    grouped.set(row.inventoryItemId, current);
  }

  const lowStockItems = typedItemRows.filter((item: InventoryItemUsageRow) => Number(item.stock) <= Number(item.reorderLevel));
  const insights = [
    `Inventory movement count changed by ${movementChangePercent}% compared to the previous matching period.`,
    `${lowStockItems.length} item${lowStockItems.length === 1 ? "" : "s"} are currently at or below reorder level.`
  ];

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      movementCount: typedMovementRows.length,
      outgoingCount: outgoing.length,
      lowStockCount: lowStockItems.length
    },
    {
      topConsumedItems: Array.from(grouped.values())
        .sort((left, right) => right.totalOutgoing - left.totalOutgoing)
        .slice(0, 10)
        .map((item) => ({ label: item.name, count: item.totalOutgoing }))
    },
    {
      lowStockItems: lowStockItems.slice(0, 20),
      topConsumedItems: Array.from(grouped.values()).sort((left, right) => right.totalOutgoing - left.totalOutgoing).slice(0, 20)
    },
    {
      previousMovementCount,
      movementChangePercent
    },
    insights
  );
};

export const buildPatientFollowupReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const previousRange = resolvePreviousRange(range);
  const conditions = [eq(patientFollowups.organizationId, organizationId)];
  if (filters.doctorId) {
    conditions.push(eq(patientFollowups.doctorId, filters.doctorId));
  }
  if (filters.visitMode) {
    conditions.push(eq(patientFollowups.visitMode, filters.visitMode));
  }
  if (filters.doctorWorkflowMode) {
    conditions.push(eq(patientFollowups.doctorWorkflowMode, filters.doctorWorkflowMode));
  }

  const previousConditions = [
    eq(patientFollowups.organizationId, organizationId),
    gte(patientFollowups.createdAt, previousRange.start),
    lte(patientFollowups.createdAt, previousRange.end)
  ];
  if (filters.doctorId) {
    previousConditions.push(eq(patientFollowups.doctorId, filters.doctorId));
  }
  if (filters.visitMode) {
    previousConditions.push(eq(patientFollowups.visitMode, filters.visitMode));
  }
  if (filters.doctorWorkflowMode) {
    previousConditions.push(eq(patientFollowups.doctorWorkflowMode, filters.doctorWorkflowMode));
  }

  const [rows, previousCreatedCountRows] = await Promise.all([
    db
      .select({
        id: patientFollowups.id,
        patientId: patientFollowups.patientId,
        doctorId: patientFollowups.doctorId,
        dueDate: patientFollowups.dueDate,
        createdAt: patientFollowups.createdAt,
        status: patientFollowups.status
      })
      .from(patientFollowups)
      .where(and(...conditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(patientFollowups)
      .where(and(...previousConditions))
  ]);

  const typedRows = rows as PatientFollowupRow[];
  const todayIso = generatedAt.toISOString().slice(0, 10);
  const dueSoonCutoff = new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const repeatPatientCount = new Set(
    typedRows
      .map((row) => row.patientId)
      .filter((patientId, index, source) => source.indexOf(patientId) !== index)
  ).size;

  const overdue = typedRows.filter((row: PatientFollowupRow) => row.dueDate < todayIso);
  const dueSoon = typedRows.filter(
    (row: PatientFollowupRow) => row.dueDate >= todayIso && row.dueDate <= dueSoonCutoff
  );
  const inRange = typedRows.filter((row: PatientFollowupRow) => row.createdAt >= range.start && row.createdAt <= range.end);
  const previousCreatedCount = Number(previousCreatedCountRows[0]?.count ?? 0);
  const createdChangePercent = calculateChangePercent(inRange.length, previousCreatedCount);
  const insights = [
    `${overdue.length} follow-up${overdue.length === 1 ? "" : "s"} are overdue in the selected view.`,
    `${dueSoon.length} follow-up${dueSoon.length === 1 ? "" : "s"} are due within the next 7 days.`,
    `New follow-up records changed by ${createdChangePercent}% compared to the previous matching period.`
  ];

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalFollowupsTracked: typedRows.length,
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length,
      createdInRangeCount: inRange.length,
      repeatPatientsWithFollowups: repeatPatientCount
    },
    {
      followupBuckets: [
        { label: "overdue", count: overdue.length },
        { label: "due_soon", count: dueSoon.length },
        { label: "in_range_created", count: inRange.length }
      ]
    },
    {
      overdue: overdue.slice(0, 20),
      dueSoon: dueSoon.slice(0, 20)
    },
    {
      previousCreatedCount,
      createdChangePercent
    },
    insights
  );
};
