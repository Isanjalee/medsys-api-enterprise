import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  appointments,
  dispenseRecords,
  encounters,
  inventoryItems,
  inventoryMovements,
  patients,
  prescriptionItems,
  prescriptions,
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
};

type EncounterRow = {
  id: number;
  checkedAt: Date;
  doctorId: number;
};

type DoctorPerformanceRow = {
  doctorId: number;
  encounterId: number;
  checkedAt: Date;
  closedAt: Date | null;
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
};

type InventoryItemUsageRow = {
  id: number;
  name: string;
  stock: string | number;
  reorderLevel: string | number;
};

type PatientFollowupRow = {
  encounterId: number;
  patientId: number;
  doctorId: number;
  nextVisitDate: string;
  checkedAt: Date;
};

const buildResponse = (generatedAt: Date, range: ReportRange, filters: ReportFilters, summary: object, charts: object, tables: object) => ({
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
  tables
});

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

export const buildClinicOverviewReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
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

  const [patientCount, appointmentRows, encounterRows, prescriptionCount, lowStockCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(patients)
      .where(and(eq(patients.organizationId, organizationId), isNull(patients.deletedAt))),
    db
      .select({
        id: appointments.id,
        status: appointments.status,
        priority: appointments.priority,
        scheduledAt: appointments.scheduledAt
      })
      .from(appointments)
      .where(and(...appointmentConditions)),
    db
      .select({
        id: encounters.id,
        checkedAt: encounters.checkedAt,
        doctorId: encounters.doctorId
      })
      .from(encounters)
      .where(and(...encounterConditions)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(prescriptions)
      .where(and(...prescriptionConditions)),
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

  const typedAppointmentRows = appointmentRows as AppointmentStatusRow[];
  const typedEncounterRows = encounterRows as EncounterRow[];

  const appointmentsByStatus = typedAppointmentRows.reduce((acc: Record<string, number>, row: AppointmentStatusRow) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalPatients: Number(patientCount[0]?.count ?? 0),
      appointmentsInRange: typedAppointmentRows.length,
      encountersInRange: typedEncounterRows.length,
      prescriptionsInRange: Number(prescriptionCount[0]?.count ?? 0),
      lowStockItems: Number(lowStockCount[0]?.count ?? 0)
    },
    {
      appointmentStatusDistribution: Object.entries(appointmentsByStatus).map(([label, count]) => ({ label, count }))
    },
    {
      recentAppointments: typedAppointmentRows
        .sort((left: AppointmentStatusRow, right: AppointmentStatusRow) => right.scheduledAt.getTime() - left.scheduledAt.getTime())
        .slice(0, 10)
    }
  );
};

export const buildDoctorPerformanceReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
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

  const rows = await db
    .select({
      doctorId: encounters.doctorId,
      encounterId: encounters.id,
      checkedAt: encounters.checkedAt,
      closedAt: encounters.closedAt,
      doctorFirstName: users.firstName,
      doctorLastName: users.lastName
    })
    .from(encounters)
    .innerJoin(users, eq(users.id, encounters.doctorId))
    .where(and(...conditions));

  const typedRows = rows as DoctorPerformanceRow[];
  const grouped = new Map<number, { doctorId: number; doctorName: string; encounters: number; averageMinutes: number | null }>();
  for (const row of typedRows) {
    const current = grouped.get(row.doctorId) ?? {
      doctorId: row.doctorId,
      doctorName: `${row.doctorFirstName} ${row.doctorLastName}`,
      encounters: 0,
      averageMinutes: null
    };
    current.encounters += 1;
    grouped.set(row.doctorId, current);
  }

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalDoctors: grouped.size,
      totalEncounters: typedRows.length
    },
    {
      encountersByDoctor: Array.from(grouped.values()).map((item) => ({
        label: item.doctorName,
        count: item.encounters
      }))
    },
    {
      doctors: Array.from(grouped.values()).sort((left, right) => right.encounters - left.encounters)
    }
  );
};

export const buildAssistantPerformanceReport = async ({
  db,
  organizationId,
  range,
  filters,
  generatedAt
}: ReportContext) => {
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

  const [appointmentRows, dispenseRows] = await Promise.all([
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
      .where(and(...dispenseConditions))
  ]);

  const typedAppointmentRows = appointmentRows as AssistantAppointmentRow[];
  const typedDispenseRows = dispenseRows as AssistantDispenseRow[];

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

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalAssistants: grouped.size,
      totalScheduledAppointments: typedAppointmentRows.length,
      totalDispenseRecords: typedDispenseRows.length
    },
    {
      throughputByAssistant: Array.from(grouped.values()).map((item) => ({
        label: item.assistantName,
        scheduled: item.scheduled,
        dispensed: item.dispensed
      }))
    },
    {
      assistants: Array.from(grouped.values()).sort((left, right) => right.dispensed - left.dispensed)
    }
  );
};

export const buildInventoryUsageReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const [movementRows, itemRows] = await Promise.all([
    db
      .select({
        inventoryItemId: inventoryMovements.inventoryItemId,
        quantity: inventoryMovements.quantity,
        movementType: inventoryMovements.movementType,
        createdAt: inventoryMovements.createdAt
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          gte(inventoryMovements.createdAt, range.start),
          lte(inventoryMovements.createdAt, range.end)
        )
      ),
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        stock: inventoryItems.stock,
        reorderLevel: inventoryItems.reorderLevel
      })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.organizationId, organizationId), isNull(inventoryItems.deletedAt)))
  ]);

  const typedMovementRows = movementRows as InventoryMovementRow[];
  const typedItemRows = itemRows as InventoryItemUsageRow[];
  const nameById = new Map<number, InventoryItemUsageRow>(typedItemRows.map((item: InventoryItemUsageRow) => [item.id, item]));
  const outgoing = typedMovementRows.filter((row: InventoryMovementRow) => row.movementType === "out");
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
    }
  );
};

export const buildPatientFollowupReport = async ({ db, organizationId, range, filters, generatedAt }: ReportContext) => {
  const conditions = [
    eq(encounters.organizationId, organizationId),
    isNull(encounters.deletedAt),
    sql`${encounters.nextVisitDate} IS NOT NULL`
  ];
  if (filters.doctorId) {
    conditions.push(eq(encounters.doctorId, filters.doctorId));
  }
  pushEncounterModeFilters(conditions, filters);

  const rows = await db
    .select({
      encounterId: encounters.id,
      patientId: encounters.patientId,
      doctorId: encounters.doctorId,
      nextVisitDate: encounters.nextVisitDate,
      checkedAt: encounters.checkedAt
    })
    .from(encounters)
    .where(and(...conditions));

  const typedRows = rows as PatientFollowupRow[];
  const todayIso = generatedAt.toISOString().slice(0, 10);
  const dueSoonCutoff = new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const overdue = typedRows.filter((row: PatientFollowupRow) => row.nextVisitDate < todayIso);
  const dueSoon = typedRows.filter(
    (row: PatientFollowupRow) => row.nextVisitDate >= todayIso && row.nextVisitDate <= dueSoonCutoff
  );
  const inRange = typedRows.filter((row: PatientFollowupRow) => row.checkedAt >= range.start && row.checkedAt <= range.end);

  return buildResponse(
    generatedAt,
    range,
    filters,
    {
      totalFollowupsTracked: typedRows.length,
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length
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
    }
  );
};
