import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte
} from "drizzle-orm";
import {
  appointments,
  dispenseRecords,
  encounterDiagnoses,
  encounters,
  families,
  inventoryItems,
  patientAllergies,
  patientConditions,
  patients,
  patientVitals,
  prescriptionItems,
  prescriptions,
  testOrders,
  users,
  type buildDbClient
} from "@medsys/db";

type DbClient = ReturnType<typeof buildDbClient>["db"];

type DashboardRole = "doctor" | "assistant" | "owner";
type DashboardRangePreset = "1d" | "7d" | "30d" | "custom";
type OperationMode = "walk_in" | "appointment" | "hybrid";

type DashboardActor = {
  role: DashboardRole;
  activeRole: DashboardRole | null;
  roles: DashboardRole[];
  userId: number | null;
};

type DashboardScope = {
  role: DashboardRole;
  doctorId: number | null;
  assistantId: number | null;
};

type DashboardInput = {
  db: DbClient;
  organizationId: string;
  actor: DashboardActor;
  scope: DashboardScope;
  operationMode: OperationMode;
  range: {
    preset: DashboardRangePreset;
    start: Date;
    end: Date;
  };
  generatedAt: Date;
  workflowProfile: { mode: string };
};

type AppointmentRow = {
  id: number;
  patientId: number;
  doctorId: number | null;
  assistantId: number | null;
  scheduledAt: Date;
  status: string;
  reason: string | null;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
};

type EncounterRow = {
  id: number;
  appointmentId: number;
  patientId: number;
  doctorId: number;
  checkedAt: Date;
  notes: string | null;
  nextVisitDate: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PatientRow = {
  id: number;
  firstName: string;
  lastName: string;
  age: number;
  gender: "male" | "female" | "other";
  familyId: number | null;
  guardianPatientId: number | null;
  guardianName: string | null;
  guardianNic: string | null;
  guardianPhone: string | null;
  createdAt: Date;
};

type PrescriptionRow = {
  id: number;
  patientId: number;
  doctorId: number;
  encounterId: number;
  createdAt: Date;
};

type PrescriptionItemRow = {
  prescriptionId: number;
  drugName: string;
  source: "clinical" | "outside";
  quantity: string;
};

type DispenseRow = {
  id: number;
  prescriptionId: number;
  assistantId: number;
  dispensedAt: Date;
};

type DiagnosisRow = {
  encounterId: number;
  diagnosisName: string;
};

type TestRow = {
  encounterId: number;
  testName: string;
  status: string;
};

type VitalRow = {
  encounterId: number | null;
  patientId: number;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  temperatureC: string | null;
  spo2: number | null;
};

type InventoryRow = {
  id: number;
  name: string;
  stock: string;
  reorderLevel: string;
};

const WALK_IN_REASON = "Walk-in consultation";
const LONG_WAIT_THRESHOLD_MINUTES = 25;

const toNumber = (value: string | number | null | undefined): number => Number(value ?? 0);
const percentage = (value: number, total: number): number => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0);
const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
};
const minutesBetween = (start: Date, end: Date): number => Math.max(0, (end.getTime() - start.getTime()) / 60000);
const startOfUtcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));
const endOfUtcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 23, 59, 59, 999));
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const hourLabel = (hour: number): string => `${hour.toString().padStart(2, "0")}:00`;

const classifyLinkage = (patient: PatientRow): "family_linked" | "guardian_linked" | "standalone" => {
  const hasGuardian = Boolean(patient.guardianPatientId || patient.guardianName || patient.guardianNic || patient.guardianPhone);
  if (hasGuardian) {
    return "guardian_linked";
  }
  if (patient.familyId) {
    return "family_linked";
  }
  return "standalone";
};

const ageGroupLabel = (age: number): string => {
  if (age < 18) {
    return "0-17";
  }
  if (age < 30) {
    return "18-29";
  }
  if (age < 45) {
    return "30-44";
  }
  if (age < 60) {
    return "45-59";
  }
  return "60+";
};

const waitBucketLabel = (minutes: number): string => {
  if (minutes < 15) {
    return "<15m";
  }
  if (minutes < 30) {
    return "15-29m";
  }
  if (minutes < 60) {
    return "30-59m";
  }
  return "60m+";
};

const buildTopList = (
  values: string[],
  limit = 5
): Array<{ label: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value.trim()) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
};

const buildCategoryCounts = (
  values: string[],
  categories: string[]
): Array<{ label: string; count: number }> => {
  const counts = new Map(categories.map((category) => [category, 0]));
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return categories.map((label) => ({ label, count: counts.get(label) ?? 0 }));
};

const buildHourSeries = (dates: Date[]): Array<{ hour: number; label: string; count: number }> => {
  const counts = Array.from({ length: 24 }, (_, hour) => ({ hour, label: hourLabel(hour), count: 0 }));
  for (const value of dates) {
    counts[value.getUTCHours()]!.count += 1;
  }
  return counts;
};

const buildDaySeries = (dates: Date[], start: Date, end: Date): Array<{ date: string; count: number }> => {
  const series: Array<{ date: string; count: number }> = [];
  for (let cursor = startOfUtcDay(start); cursor <= end; cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
    series.push({ date: cursor.toISOString().slice(0, 10), count: 0 });
  }

  const lookup = new Map(series.map((row) => [row.date, row]));
  for (const value of dates) {
    const key = value.toISOString().slice(0, 10);
    const row = lookup.get(key);
    if (row) {
      row.count += 1;
    }
  }
  return series;
};

const mapById = <T extends { id: number }>(rows: T[]): Map<number, T> => new Map(rows.map((row) => [row.id, row]));

const isAbnormalVital = (vital: VitalRow): boolean => {
  const temperature = vital.temperatureC ? Number(vital.temperatureC) : null;
  return Boolean(
    (vital.bpSystolic !== null && vital.bpSystolic >= 140) ||
      (vital.bpDiastolic !== null && vital.bpDiastolic >= 90) ||
      (vital.heartRate !== null && (vital.heartRate < 50 || vital.heartRate > 110)) ||
      (temperature !== null && (temperature >= 37.8 || temperature < 35)) ||
      (vital.spo2 !== null && vital.spo2 < 94)
  );
};

const matchInventoryItem = (items: InventoryRow[], drugName: string): InventoryRow | null => {
  const normalized = drugName.trim().toLowerCase();
  return items.find((item) => item.name.trim().toLowerCase() === normalized) ?? null;
};

const buildBaseRoleContext = (input: DashboardInput) => ({
  resolvedRole: input.scope.role,
  actorRole: input.actor.role,
  activeRole: input.actor.activeRole,
  roles: input.actor.roles,
  doctorId: input.scope.doctorId,
  assistantId: input.scope.assistantId,
  workflowProfile: input.workflowProfile,
  operationMode: input.operationMode
});

const buildBaseRange = (input: DashboardInput) => ({
  preset: input.range.preset,
  dateFrom: input.range.start.toISOString(),
  dateTo: input.range.end.toISOString()
});

const applyOwnerOperationMode = <
  T extends {
    summary: Record<string, unknown>;
    charts: Record<string, unknown>;
    insights: Array<{ id: string; level: string; message: string }>;
    tables: Record<string, unknown>;
    alerts: Array<{ id: string; severity: string; message: string }>;
  }
>(
  payload: T,
  operationMode: OperationMode
) => {
  const modePolicy = {
    operationMode,
    showAppointmentMetrics: operationMode !== "walk_in",
    showWalkInMetrics: operationMode !== "appointment"
  };

  if (operationMode === "hybrid") {
    return { ...payload, modePolicy };
  }

  const summary = { ...payload.summary };
  const charts = { ...payload.charts };
  const tables = { ...payload.tables };
  const insights = [...payload.insights];

  if (operationMode === "walk_in") {
    const organizationGrowth =
      summary.organizationGrowth && typeof summary.organizationGrowth === "object"
        ? { ...(summary.organizationGrowth as Record<string, unknown>) }
        : null;
    if (organizationGrowth) {
      delete organizationGrowth.appointmentVolume;
      summary.organizationGrowth = organizationGrowth;
    }

    const operationalPerformance =
      summary.operationalPerformance && typeof summary.operationalPerformance === "object"
        ? { ...(summary.operationalPerformance as Record<string, unknown>) }
        : null;
    if (operationalPerformance) {
      delete operationalPerformance.cancellationRate;
      summary.operationalPerformance = operationalPerformance;
    }

    delete charts.appointmentStatusDistribution;
    delete tables.appointmentStatusDistribution;
  }

  if (operationMode === "appointment") {
    const operationalPerformance =
      summary.operationalPerformance && typeof summary.operationalPerformance === "object"
        ? { ...(summary.operationalPerformance as Record<string, unknown>) }
        : null;
    if (operationalPerformance) {
      delete operationalPerformance.walkInRate;
      summary.operationalPerformance = operationalPerformance;
    }

    const quality =
      summary.quality && typeof summary.quality === "object"
        ? { ...(summary.quality as Record<string, unknown>) }
        : null;
    if (quality) {
      delete quality.guardianLinkageCoverageForMinors;
      summary.quality = quality;
    }

    const index = insights.findIndex((item) => item.id === "walkin-trend");
    if (index >= 0) {
      insights.splice(index, 1);
    }
  }

  return {
    ...payload,
    summary,
    charts,
    tables,
    insights,
    modePolicy
  };
};

const fetchAppointments = async (
  db: DbClient,
  organizationId: string,
  extraConditions: any[]
): Promise<AppointmentRow[]> =>
  db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      doctorId: appointments.doctorId,
      assistantId: appointments.assistantId,
      scheduledAt: appointments.scheduledAt,
      status: appointments.status,
      reason: appointments.reason,
      priority: appointments.priority,
      createdAt: appointments.createdAt,
      updatedAt: appointments.updatedAt
    })
    .from(appointments)
    .where(and(eq(appointments.organizationId, organizationId), isNull(appointments.deletedAt), ...extraConditions));

const fetchEncounters = async (
  db: DbClient,
  organizationId: string,
  extraConditions: any[]
): Promise<EncounterRow[]> =>
  db
    .select({
      id: encounters.id,
      appointmentId: encounters.appointmentId,
      patientId: encounters.patientId,
      doctorId: encounters.doctorId,
      checkedAt: encounters.checkedAt,
      notes: encounters.notes,
      nextVisitDate: encounters.nextVisitDate,
      createdAt: encounters.createdAt,
      updatedAt: encounters.updatedAt
    })
    .from(encounters)
    .where(and(eq(encounters.organizationId, organizationId), isNull(encounters.deletedAt), ...extraConditions));

const fetchPatients = async (db: DbClient, organizationId: string, patientIds: number[]): Promise<PatientRow[]> => {
  if (patientIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      age: patients.age,
      gender: patients.gender,
      familyId: patients.familyId,
      guardianPatientId: patients.guardianPatientId,
      guardianName: patients.guardianName,
      guardianNic: patients.guardianNic,
      guardianPhone: patients.guardianPhone,
      createdAt: patients.createdAt
    })
    .from(patients)
    .where(and(eq(patients.organizationId, organizationId), inArray(patients.id, patientIds), isNull(patients.deletedAt)));
};

const fetchDashboardData = async (input: DashboardInput) => {
  const scopeConditions: unknown[] = [];
  if (input.scope.role === "doctor" && input.scope.doctorId) {
    scopeConditions.push(eq(appointments.doctorId, input.scope.doctorId));
  }
  if (input.scope.role === "assistant" && input.scope.assistantId) {
    scopeConditions.push(eq(appointments.assistantId, input.scope.assistantId));
  }

  const appointmentRows = await fetchAppointments(input.db, input.organizationId, [
    ...scopeConditions,
    gte(appointments.scheduledAt, input.range.start),
    lte(appointments.scheduledAt, input.range.end)
  ]);

  const currentQueueRows = await fetchAppointments(input.db, input.organizationId, [
    ...scopeConditions,
    inArray(appointments.status, ["waiting", "in_consultation"])
  ]);

  const encounterConditions: unknown[] = [
    gte(encounters.checkedAt, input.range.start),
    lte(encounters.checkedAt, input.range.end)
  ];
  if (input.scope.role === "doctor" && input.scope.doctorId) {
    encounterConditions.push(eq(encounters.doctorId, input.scope.doctorId));
  }

  const encounterRows = await fetchEncounters(input.db, input.organizationId, encounterConditions);
  const encounterIds = encounterRows.map((row) => row.id);
  const patientIds = unique([...appointmentRows.map((row) => row.patientId), ...encounterRows.map((row) => row.patientId)]);
  const [patientRows, diagnosisRows, testRows, prescriptionRows, inventoryRows, allergyRows, totalPatientCountRows, totalFamilyCountRows] =
    await Promise.all([
      fetchPatients(input.db, input.organizationId, patientIds),
      encounterIds.length === 0
        ? Promise.resolve([] as DiagnosisRow[])
        : input.db
            .select({
              encounterId: encounterDiagnoses.encounterId,
              diagnosisName: encounterDiagnoses.diagnosisName
            })
            .from(encounterDiagnoses)
            .where(and(eq(encounterDiagnoses.organizationId, input.organizationId), inArray(encounterDiagnoses.encounterId, encounterIds))),
      encounterIds.length === 0
        ? Promise.resolve([] as TestRow[])
        : input.db
            .select({
              encounterId: testOrders.encounterId,
              testName: testOrders.testName,
              status: testOrders.status
            })
            .from(testOrders)
            .where(and(eq(testOrders.organizationId, input.organizationId), inArray(testOrders.encounterId, encounterIds))),
      input.db
        .select({
          id: prescriptions.id,
          patientId: prescriptions.patientId,
          doctorId: prescriptions.doctorId,
          encounterId: prescriptions.encounterId,
          createdAt: prescriptions.createdAt
        })
        .from(prescriptions)
        .where(
          and(
            eq(prescriptions.organizationId, input.organizationId),
            isNull(prescriptions.deletedAt),
            gte(prescriptions.createdAt, input.range.start),
            lte(prescriptions.createdAt, input.range.end),
            ...(input.scope.role === "doctor" && input.scope.doctorId
              ? [eq(prescriptions.doctorId, input.scope.doctorId)]
              : [])
          )
        ),
      input.db
        .select({
          id: inventoryItems.id,
          name: inventoryItems.name,
          stock: inventoryItems.stock,
          reorderLevel: inventoryItems.reorderLevel
        })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.organizationId, input.organizationId), isNull(inventoryItems.deletedAt), eq(inventoryItems.isActive, true))),
      patientIds.length === 0
        ? Promise.resolve([] as Array<{ patientId: number; severity: string | null }>)
        : input.db
            .select({
              patientId: patientAllergies.patientId,
              severity: patientAllergies.severity
            })
            .from(patientAllergies)
            .where(
              and(
                eq(patientAllergies.organizationId, input.organizationId),
                inArray(patientAllergies.patientId, patientIds),
                eq(patientAllergies.isActive, true),
                isNull(patientAllergies.deletedAt)
              )
            ),
      input.db
        .select({ count: count() })
        .from(patients)
        .where(and(eq(patients.organizationId, input.organizationId), isNull(patients.deletedAt))),
      input.db
        .select({ count: count() })
        .from(families)
        .where(and(eq(families.organizationId, input.organizationId), isNull(families.deletedAt)))
    ]);

  const prescriptionIds = prescriptionRows.map((row) => row.id);
  const [prescriptionItemRows, dispenseRows, vitalRows, priorEncounterRows, allConditionRows] = await Promise.all([
    prescriptionIds.length === 0
      ? Promise.resolve([] as PrescriptionItemRow[])
      : input.db
          .select({
            prescriptionId: prescriptionItems.prescriptionId,
            drugName: prescriptionItems.drugName,
            source: prescriptionItems.source,
            quantity: prescriptionItems.quantity
          })
          .from(prescriptionItems)
          .where(
            and(
              eq(prescriptionItems.organizationId, input.organizationId),
              inArray(prescriptionItems.prescriptionId, prescriptionIds),
              isNull(prescriptionItems.deletedAt)
            )
          ),
    prescriptionIds.length === 0
      ? Promise.resolve([] as DispenseRow[])
      : input.db
          .select({
            id: dispenseRecords.id,
            prescriptionId: dispenseRecords.prescriptionId,
            assistantId: dispenseRecords.assistantId,
            dispensedAt: dispenseRecords.dispensedAt
          })
          .from(dispenseRecords)
          .where(
            and(
              eq(dispenseRecords.organizationId, input.organizationId),
              inArray(dispenseRecords.prescriptionId, prescriptionIds),
              ...(input.scope.role === "assistant" && input.scope.assistantId
                ? [eq(dispenseRecords.assistantId, input.scope.assistantId)]
                : [])
            )
          ),
    encounterIds.length === 0
      ? Promise.resolve([] as VitalRow[])
      : input.db
          .select({
            encounterId: patientVitals.encounterId,
            patientId: patientVitals.patientId,
            bpSystolic: patientVitals.bpSystolic,
            bpDiastolic: patientVitals.bpDiastolic,
            heartRate: patientVitals.heartRate,
            temperatureC: patientVitals.temperatureC,
            spo2: patientVitals.spo2
          })
          .from(patientVitals)
          .where(
            and(
              eq(patientVitals.organizationId, input.organizationId),
              inArray(patientVitals.encounterId, encounterIds),
              isNull(patientVitals.deletedAt)
            )
          ),
    patientIds.length === 0
      ? Promise.resolve([] as Array<{ patientId: number; checkedAt: Date }>)
      : input.db
          .select({
            patientId: encounters.patientId,
            checkedAt: encounters.checkedAt
          })
          .from(encounters)
          .where(
            and(
              eq(encounters.organizationId, input.organizationId),
              inArray(encounters.patientId, patientIds),
              isNull(encounters.deletedAt)
            )
          )
          .orderBy(desc(encounters.checkedAt)),
    patientIds.length === 0
      ? Promise.resolve([] as Array<{ patientId: number }>)
      : input.db
          .select({ patientId: patientConditions.patientId })
          .from(patientConditions)
          .where(
            and(
              eq(patientConditions.organizationId, input.organizationId),
              inArray(patientConditions.patientId, patientIds),
              eq(patientConditions.status, "active"),
              isNull(patientConditions.deletedAt)
            )
          )
  ]);

  return {
    appointmentRows,
    currentQueueRows,
    encounterRows,
    patientRows,
    diagnosisRows,
    testRows,
    prescriptionRows,
    prescriptionItemRows,
    dispenseRows,
    vitalRows,
    inventoryRows,
    allergyRows,
    priorEncounterRows,
    allConditionRows,
    totalPatientCount: Number(totalPatientCountRows[0]?.count ?? 0),
    totalFamilyCount: Number(totalFamilyCountRows[0]?.count ?? 0)
  };
};

const buildDoctorDashboard = async (input: DashboardInput) => {
  const data = await fetchDashboardData(input);
  const patientById = mapById(data.patientRows);
  const todayStart = startOfUtcDay(input.generatedAt);
  const todayEnd = endOfUtcDay(input.generatedAt);
  const todaysAppointments = data.appointmentRows.filter(
    (row) => row.scheduledAt >= todayStart && row.scheduledAt <= todayEnd
  );
  const todaysEncounters = data.encounterRows.filter((row) => row.checkedAt >= todayStart && row.checkedAt <= todayEnd);
  const todayEncounterPatientIds = unique(todaysEncounters.map((row) => row.patientId));
  const newPatientIds = todayEncounterPatientIds.filter((patientId) => {
    const prior = data.priorEncounterRows
      .filter((row) => row.patientId === patientId)
      .map((row) => row.checkedAt)
      .sort((left, right) => left.getTime() - right.getTime());
    return prior.length > 0 && prior[0]! >= todayStart;
  });
  const returningPatientIds = todayEncounterPatientIds.filter((patientId) => !newPatientIds.includes(patientId));
  const distinctPatients = unique(data.encounterRows.map((row) => row.patientId))
    .map((patientId) => patientById.get(patientId))
    .filter((row): row is PatientRow => Boolean(row));
  const waitMinutes = data.currentQueueRows.map((row) => minutesBetween(row.createdAt, input.generatedAt));
  const consultMinutes = data.encounterRows
    .map((row) => {
      const appointment = data.appointmentRows.find((item) => item.id === row.appointmentId);
      if (!appointment || appointment.status !== "completed") {
        return null;
      }
      return minutesBetween(row.checkedAt, appointment.updatedAt);
    })
    .filter((value): value is number => value !== null);
  const longWaitRows = data.currentQueueRows.filter((row) => minutesBetween(row.createdAt, input.generatedAt) >= LONG_WAIT_THRESHOLD_MINUTES);
  const encounterIdsWithVitals = new Set(data.vitalRows.map((row) => row.encounterId).filter((value): value is number => value !== null));
  const encounterIdsWithDiagnoses = new Set(data.diagnosisRows.map((row) => row.encounterId));
  const encounterIdsWithPrescriptions = new Set(data.prescriptionRows.map((row) => row.encounterId));
  const abnormalPatientIds = new Set(data.vitalRows.filter(isAbnormalVital).map((row) => row.patientId));
  const allergyPatientIds = new Set(data.allergyRows.map((row) => row.patientId));
  const highRiskPatientIds = new Set([
    ...[...abnormalPatientIds],
    ...data.allergyRows.filter((row) => row.severity === "high").map((row) => row.patientId),
    ...data.allConditionRows.map((row) => row.patientId)
  ]);
  const prescriptionItemsByPrescriptionId = new Map<number, PrescriptionItemRow[]>();
  for (const row of data.prescriptionItemRows) {
    const current = prescriptionItemsByPrescriptionId.get(row.prescriptionId) ?? [];
    current.push(row);
    prescriptionItemsByPrescriptionId.set(row.prescriptionId, current);
  }
  const clinicalPrescriptionIds = data.prescriptionRows
    .filter((row) => (prescriptionItemsByPrescriptionId.get(row.id) ?? []).some((item) => item.source === "clinical"))
    .map((row) => row.id);
  const outsidePrescriptionIds = data.prescriptionRows
    .filter((row) => (prescriptionItemsByPrescriptionId.get(row.id) ?? []).some((item) => item.source === "outside"))
    .map((row) => row.id);
  const directDispenseCount = data.dispenseRows.filter((row) => row.assistantId === input.scope.doctorId).length;
  const clinicalDrugNames = data.prescriptionItemRows.filter((row) => row.source === "clinical").map((row) => row.drugName);
  const lowStockRelevantItems = buildTopList(clinicalDrugNames, 10)
    .map((row) => {
      const inventoryItem = matchInventoryItem(data.inventoryRows, row.label);
      if (!inventoryItem) {
        return null;
      }
      const stock = toNumber(inventoryItem.stock);
      const reorderLevel = toNumber(inventoryItem.reorderLevel);
      if (stock > reorderLevel) {
        return null;
      }
      return {
        label: row.label,
        count: row.count,
        stock,
        reorderLevel
      };
    })
    .filter((row): row is { label: string; count: number; stock: number; reorderLevel: number } => Boolean(row));
  const unmatchedPrescriptionItems = buildTopList(clinicalDrugNames, 20).filter(
    (row) => !matchInventoryItem(data.inventoryRows, row.label)
  );

  const summary = {
    queue: {
      patientsWaitingNow: data.currentQueueRows.filter((row) => row.status === "waiting").length,
      inConsultationCount: data.currentQueueRows.filter((row) => row.status === "in_consultation").length,
      delayedPatients: longWaitRows.length
    },
    visits: {
      walkInsToday: todaysAppointments.filter((row) => row.reason === WALK_IN_REASON).length,
      appointmentsToday: todaysAppointments.filter((row) => row.reason !== WALK_IN_REASON).length,
      completedToday: todaysAppointments.filter((row) => row.status === "completed").length,
      averageWaitMinutes: average(waitMinutes),
      averageConsultMinutesEstimate: average(consultMinutes),
      queueToCompletionRate: percentage(
        todaysAppointments.filter((row) => row.status === "completed").length,
        Math.max(todaysAppointments.length, 1)
      )
    },
    patientMix: {
      newPatientsToday: newPatientIds.length,
      returningPatientsToday: returningPatientIds.length,
      minorPatientsCount: distinctPatients.filter((row) => row.age < 18).length,
      guardianLinkedPatients: distinctPatients.filter((row) => classifyLinkage(row) === "guardian_linked").length,
      familyLinkedPatients: distinctPatients.filter((row) => classifyLinkage(row) === "family_linked").length,
      repeatVisitRate: percentage(returningPatientIds.length, Math.max(todayEncounterPatientIds.length, 1)),
      followUpDuePatients: data.encounterRows.filter((row) => row.nextVisitDate !== null && row.nextVisitDate <= todayEnd.toISOString().slice(0, 10)).length,
      highRiskPatients: highRiskPatientIds.size
    },
    clinical: {
      totalEncounters: data.encounterRows.length,
      patientsWithAllergies: allergyPatientIds.size,
      patientsWithAbnormalVitals: abnormalPatientIds.size,
      documentationCompleteness: {
        vitalsCapturedRate: percentage(encounterIdsWithVitals.size, Math.max(data.encounterRows.length, 1)),
        diagnosisSavedRate: percentage(encounterIdsWithDiagnoses.size, Math.max(data.encounterRows.length, 1)),
        prescriptionIssuedRate: percentage(encounterIdsWithPrescriptions.size, Math.max(data.encounterRows.length, 1)),
        notesEnteredRate: percentage(
          data.encounterRows.filter((row) => Boolean(row.notes?.trim())).length,
          Math.max(data.encounterRows.length, 1)
        )
      }
    },
    prescribing: {
      clinicalPrescriptionsCount: clinicalPrescriptionIds.length,
      outsidePrescriptionsCount: outsidePrescriptionIds.length,
      directDispenseCount,
      lowStockRelevantCount: lowStockRelevantItems.length,
      unmatchedPrescriptionItemsCount: unmatchedPrescriptionItems.length,
      dispenseCompletionRate: percentage(
        unique(data.dispenseRows.map((row) => row.prescriptionId)).length,
        Math.max(clinicalPrescriptionIds.length, 1)
      )
    }
  };

  const charts = {
    patientVolumeByHour: buildHourSeries(data.appointmentRows.map((row) => row.scheduledAt)),
    walkInVsAppointment: [
      { label: "walk_in", count: data.appointmentRows.filter((row) => row.reason === WALK_IN_REASON).length },
      { label: "appointment", count: data.appointmentRows.filter((row) => row.reason !== WALK_IN_REASON).length }
    ],
    queueFunnel: buildCategoryCounts(data.appointmentRows.map((row) => row.status), ["waiting", "in_consultation", "completed"]),
    waitTimeBuckets: buildCategoryCounts(waitMinutes.map(waitBucketLabel), ["<15m", "15-29m", "30-59m", "60m+"]),
    newVsReturning: [
      { label: "new", count: newPatientIds.length },
      { label: "returning", count: returningPatientIds.length }
    ],
    ageGroups: buildCategoryCounts(distinctPatients.map((row) => ageGroupLabel(row.age)), ["0-17", "18-29", "30-44", "45-59", "60+"]),
    genderSplit: buildCategoryCounts(distinctPatients.map((row) => row.gender), ["male", "female", "other"]),
    linkageSplit: buildCategoryCounts(distinctPatients.map((row) => classifyLinkage(row)), [
      "family_linked",
      "standalone",
      "guardian_linked"
    ]),
    topDiagnoses: buildTopList(data.diagnosisRows.map((row) => row.diagnosisName)),
    topTests: buildTopList(data.testRows.map((row) => row.testName)),
    topMedications: buildTopList(data.prescriptionItemRows.map((row) => row.drugName)),
    encounterCompleteness: [
      { label: "vitals_captured", count: encounterIdsWithVitals.size },
      { label: "diagnosis_saved", count: encounterIdsWithDiagnoses.size },
      { label: "prescription_issued", count: encounterIdsWithPrescriptions.size },
      { label: "notes_entered", count: data.encounterRows.filter((row) => Boolean(row.notes?.trim())).length }
    ],
    prescriptionSourceSplit: [
      { label: "clinical", count: clinicalPrescriptionIds.length },
      { label: "outside", count: outsidePrescriptionIds.length }
    ],
    topDispensedMedicines: buildTopList(
      data.prescriptionRows
        .filter((row) => data.dispenseRows.some((dispense) => dispense.prescriptionId === row.id))
        .flatMap((row) => prescriptionItemsByPrescriptionId.get(row.id) ?? [])
        .filter((item) => item.source === "clinical")
        .map((item) => item.drugName)
    ),
    lowStockRelevantMedicines: lowStockRelevantItems.map((row) => ({ label: row.label, count: row.count, stock: row.stock })),
    prescriptionsByDay: buildDaySeries(data.prescriptionRows.map((row) => row.createdAt), input.range.start, input.range.end)
  };

  const insights = [];
  const peakHour = [...charts.patientVolumeByHour].sort((left, right) => right.count - left.count)[0];
  if (peakHour && peakHour.count > 0) {
    insights.push({
      id: "peak-load",
      level: "info",
      message: `Peak load was ${peakHour.label}-${hourLabel((peakHour.hour + 1) % 24)} with ${peakHour.count} patients.`
    });
  }
  const topDiagnosis = charts.topDiagnoses[0];
  if (topDiagnosis) {
    insights.push({
      id: "top-diagnosis",
      level: "info",
      message: `Most common diagnosis in range: ${topDiagnosis.label}.`
    });
  }
  insights.push({
    id: "long-wait",
    level: longWaitRows.length > 0 ? "warning" : "info",
    message: `${longWaitRows.length} patients are waiting longer than ${LONG_WAIT_THRESHOLD_MINUTES} minutes.`
  });
  if (lowStockRelevantItems[0]) {
    insights.push({
      id: "stock-risk",
      level: "warning",
      message: `${lowStockRelevantItems[0].label} stock is low and frequently prescribed.`
    });
  }
  insights.push({
    id: "walkin-share",
    level: "info",
    message: `Walk-ins are ${percentage(charts.walkInVsAppointment[0].count, Math.max(data.appointmentRows.length, 1))}% of this doctor's workload.`
  });
  insights.push({
    id: "vitals-completeness",
    level: summary.clinical.documentationCompleteness.vitalsCapturedRate < 80 ? "warning" : "info",
    message: `${summary.clinical.documentationCompleteness.vitalsCapturedRate}% of encounters have complete vitals coverage.`
  });

  const alerts = [
    ...longWaitRows.slice(0, 3).map((row) => ({
      id: `long-wait-${row.id}`,
      severity: "warning",
      message: `${patientById.get(row.patientId)?.firstName ?? "Patient"} has been waiting ${Math.round(
        minutesBetween(row.createdAt, input.generatedAt)
      )} minutes.`
    })),
    ...lowStockRelevantItems.slice(0, 3).map((row) => ({
      id: `low-stock-${row.label.toLowerCase().replace(/\s+/g, "-")}`,
      severity: "warning",
      message: `${row.label} is at low stock (${row.stock} units) against reorder level ${row.reorderLevel}.`
    }))
  ];

  return applyOwnerOperationMode(
    {
    roleContext: buildBaseRoleContext(input),
    generatedAt: input.generatedAt.toISOString(),
    range: buildBaseRange(input),
    summary,
    charts,
    insights,
    tables: {
      topDiagnoses: charts.topDiagnoses,
      topTests: charts.topTests,
      topMedications: charts.topMedications,
      lowStockRelevantItems,
      unmatchedPrescriptionItems
    },
    alerts
    },
    input.operationMode
  );
};

const buildAssistantDashboard = async (input: DashboardInput) => {
  const data = await fetchDashboardData(input);
  const patientById = mapById(data.patientRows);
  const todayStart = startOfUtcDay(input.generatedAt);
  const todayEnd = endOfUtcDay(input.generatedAt);
  const todaysAppointments = data.appointmentRows.filter(
    (row) => row.createdAt >= todayStart && row.createdAt <= todayEnd
  );
  const encounterByAppointmentId = new Map(data.encounterRows.map((row) => [row.appointmentId, row]));
  const waitDurations = todaysAppointments
    .map((row) => {
      const encounter = encounterByAppointmentId.get(row.id);
      return encounter ? minutesBetween(row.createdAt, encounter.checkedAt) : null;
    })
    .filter((value): value is number => value !== null);
  const queueLoadByDoctor = buildTopList(
    data.currentQueueRows.map((row) => {
      if (!row.doctorId) {
        return "Unassigned";
      }
      return `Doctor ${row.doctorId}`;
    }),
    10
  );
  const longWaitRows = data.currentQueueRows.filter((row) => minutesBetween(row.createdAt, input.generatedAt) >= LONG_WAIT_THRESHOLD_MINUTES);
  const clinicalPrescriptionIds = unique(
    data.prescriptionItemRows.filter((row) => row.source === "clinical").map((row) => row.prescriptionId)
  );
  const dispensedPrescriptionIds = new Set(data.dispenseRows.map((row) => row.prescriptionId));
  const readyNotCollected = clinicalPrescriptionIds.filter((id) => !dispensedPrescriptionIds.has(id)).length;
  const patientRowsInRange = unique(data.appointmentRows.map((row) => row.patientId))
    .map((id) => patientById.get(id))
    .filter((row): row is PatientRow => Boolean(row));

  const summary = {
    intake: {
      patientsRegisteredToday: todaysAppointments.length,
      walkInsCreatedToday: todaysAppointments.filter((row) => row.reason === WALK_IN_REASON).length,
      appointmentsBookedToday: todaysAppointments.filter((row) => row.reason !== WALK_IN_REASON).length,
      newFamilyLinksCreated: patientRowsInRange.filter((row) => row.familyId !== null).length,
      guardianLinkedMinorRegistrations: patientRowsInRange.filter(
        (row) => row.age < 18 && classifyLinkage(row) === "guardian_linked"
      ).length,
      registrationCompletionRate: percentage(
        todaysAppointments.filter((row) => row.status === "completed").length,
        Math.max(todaysAppointments.length, 1)
      ),
      averageIntakeMinutesEstimate: average(waitDurations)
    },
    queue: {
      waitingQueueNow: data.currentQueueRows.filter((row) => row.status === "waiting").length,
      delayedQueueCount: longWaitRows.length,
      averageWaitMinutes: average(waitDurations),
      noShowOrCancelledCount: data.appointmentRows.filter((row) => row.status === "cancelled").length,
      walkInTrafficRate: percentage(
        data.appointmentRows.filter((row) => row.reason === WALK_IN_REASON).length,
        Math.max(data.appointmentRows.length, 1)
      )
    },
    dispense: {
      pendingDispenseCount: readyNotCollected,
      completedDispenseCount: data.dispenseRows.length,
      averageDispenseTurnaroundMinutes: average(
        data.prescriptionRows
          .map((row) => {
            const dispense = data.dispenseRows.find((item) => item.prescriptionId === row.id);
            return dispense ? minutesBetween(row.createdAt, dispense.dispensedAt) : null;
          })
          .filter((value): value is number => value !== null)
      ),
      readyButNotCollectedCount: readyNotCollected,
      inventoryBlockers: buildTopList(
        data.prescriptionItemRows
          .filter((row) => row.source === "clinical")
          .map((row) => {
            const inventory = matchInventoryItem(data.inventoryRows, row.drugName);
            if (!inventory) {
              return "";
            }
            return toNumber(inventory.stock) <= toNumber(inventory.reorderLevel) ? row.drugName : "";
          })
          .filter(Boolean)
      ).length
    }
  };

  const charts = {
    registrationsByHour: buildHourSeries(todaysAppointments.map((row) => row.createdAt)),
    appointmentsByDoctor: queueLoadByDoctor,
    queueStatusSplit: buildCategoryCounts(data.currentQueueRows.map((row) => row.status), [
      "waiting",
      "in_consultation",
      "completed",
      "cancelled"
    ]),
    dispenseStatusSplit: [
      { label: "pending", count: readyNotCollected },
      { label: "completed", count: data.dispenseRows.length },
      { label: "delayed", count: longWaitRows.length }
    ],
    dailyIntakeTrend: buildDaySeries(data.appointmentRows.map((row) => row.createdAt), input.range.start, input.range.end)
  };

  const insights = [
    {
      id: "doctor-load",
      level: queueLoadByDoctor[0] ? "info" : "warning",
      message: queueLoadByDoctor[0]
        ? `${queueLoadByDoctor[0].label} has the longest queue right now.`
        : "No active queue load is assigned to doctors right now."
    },
    {
      id: "peak-registration",
      level: "info",
      message: `${
        [...charts.registrationsByHour].sort((left, right) => right.count - left.count)[0]?.count ?? 0
      } registrations peaked in the busiest hour today.`
    },
    {
      id: "pending-dispense",
      level: readyNotCollected > 0 ? "warning" : "info",
      message: `${readyNotCollected} pending prescriptions are waiting for dispense.`
    },
    {
      id: "minor-growth",
      level: "info",
      message: `${summary.intake.guardianLinkedMinorRegistrations} guardian-linked minor registrations were captured in range.`
    }
  ];

  const alerts = [
    ...longWaitRows.slice(0, 3).map((row) => ({
      id: `assistant-queue-${row.id}`,
      severity: "warning",
      message: `${patientById.get(row.patientId)?.firstName ?? "Patient"} is waiting longer than ${LONG_WAIT_THRESHOLD_MINUTES} minutes.`
    })),
    ...(readyNotCollected > 0
      ? [
          {
            id: "pending-dispense",
            severity: "warning",
            message: `${readyNotCollected} clinical prescriptions are ready but not yet dispensed.`
          }
        ]
      : [])
  ];

  return {
    roleContext: buildBaseRoleContext(input),
    generatedAt: input.generatedAt.toISOString(),
    range: buildBaseRange(input),
    summary,
    charts,
    insights,
    tables: {
      queueLoadByDoctor,
      pendingClinicalPrescriptions: readyNotCollected
    },
    alerts
  };
};

const buildOwnerDashboard = async (input: DashboardInput) => {
  const data = await fetchDashboardData(input);
  const [doctorUsers, assistantUsers, newPatientsRows] = await Promise.all([
    input.db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(eq(users.organizationId, input.organizationId), eq(users.role, "doctor"), eq(users.isActive, true))),
    input.db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(eq(users.organizationId, input.organizationId), eq(users.role, "assistant"), eq(users.isActive, true))),
    input.db
      .select({ id: patients.id, familyId: patients.familyId, age: patients.age, guardianPatientId: patients.guardianPatientId, createdAt: patients.createdAt })
      .from(patients)
      .where(
        and(
          eq(patients.organizationId, input.organizationId),
          isNull(patients.deletedAt),
          gte(patients.createdAt, input.range.start),
          lte(patients.createdAt, input.range.end)
        )
      )
  ]);
  const doctorNameById = new Map(doctorUsers.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()]));
  const assistantNameById = new Map(assistantUsers.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()]));

  const completionRate = percentage(
    data.appointmentRows.filter((row) => row.status === "completed").length,
    Math.max(data.appointmentRows.length, 1)
  );
  const waitDurations = data.encounterRows
    .map((row) => {
      const appointment = data.appointmentRows.find((item) => item.id === row.appointmentId);
      return appointment ? minutesBetween(appointment.createdAt, row.checkedAt) : null;
    })
    .filter((value): value is number => value !== null);
  const consultDurations = data.encounterRows
    .map((row) => {
      const appointment = data.appointmentRows.find((item) => item.id === row.appointmentId && item.status === "completed");
      return appointment ? minutesBetween(row.checkedAt, appointment.updatedAt) : null;
    })
    .filter((value): value is number => value !== null);
  const patientIdsInRange = unique(data.encounterRows.map((row) => row.patientId));
  const minorPatientsInRange = newPatientsRows.filter((row) => row.age < 18);
  const guardianLinkedMinorCount = minorPatientsInRange.filter((row) => row.guardianPatientId !== null).length;
  const doctorPerformance = doctorUsers.map((doctor) => {
    const doctorEncounters = data.encounterRows.filter((row) => row.doctorId === doctor.id);
    const doctorAppointments = data.appointmentRows.filter((row) => row.doctorId === doctor.id);
    return {
      doctorId: doctor.id,
      doctorName: doctorNameById.get(doctor.id) ?? `Doctor ${doctor.id}`,
      patientsSeen: unique(doctorEncounters.map((row) => row.patientId)).length,
      completionRate: percentage(
        doctorAppointments.filter((row) => row.status === "completed").length,
        Math.max(doctorAppointments.length, 1)
      ),
      avgConsultMinutesEstimate: average(
        doctorEncounters
          .map((row) => {
            const appointment = doctorAppointments.find((item) => item.id === row.appointmentId && item.status === "completed");
            return appointment ? minutesBetween(row.checkedAt, appointment.updatedAt) : null;
          })
          .filter((value): value is number => value !== null)
      ),
      prescriptionVolume: data.prescriptionRows.filter((row) => row.doctorId === doctor.id).length
    };
  });
  const assistantPerformance = assistantUsers.map((assistant) => {
    const assistantAppointments = data.appointmentRows.filter((row) => row.assistantId === assistant.id);
    const assistantDispenses = data.dispenseRows.filter((row) => row.assistantId === assistant.id);
    return {
      assistantId: assistant.id,
      assistantName: assistantNameById.get(assistant.id) ?? `Assistant ${assistant.id}`,
      registrations: assistantAppointments.length,
      appointmentsScheduled: assistantAppointments.length,
      dispenseCount: assistantDispenses.length,
      queueHandlingEfficiency: percentage(
        assistantAppointments.filter((row) => row.status === "completed").length,
        Math.max(assistantAppointments.length, 1)
      )
    };
  });

  const summary = {
    organizationGrowth: {
      totalPatients: data.totalPatientCount,
      newPatients: newPatientsRows.length,
      repeatPatients: Math.max(patientIdsInRange.length - newPatientsRows.length, 0),
      totalFamilies: data.totalFamilyCount,
      encounterVolume: data.encounterRows.length,
      appointmentVolume: data.appointmentRows.length
    },
    operationalPerformance: {
      completionRate,
      averageWaitMinutes: average(waitDurations),
      averageConsultMinutesEstimate: average(consultDurations),
      walkInRate: percentage(
        data.appointmentRows.filter((row) => row.reason === WALK_IN_REASON).length,
        Math.max(data.appointmentRows.length, 1)
      ),
      cancellationRate: percentage(
        data.appointmentRows.filter((row) => row.status === "cancelled").length,
        Math.max(data.appointmentRows.length, 1)
      ),
      dispenseTurnaroundMinutes: average(
        data.prescriptionRows
          .map((row) => {
            const dispense = data.dispenseRows.find((item) => item.prescriptionId === row.id);
            return dispense ? minutesBetween(row.createdAt, dispense.dispensedAt) : null;
          })
          .filter((value): value is number => value !== null)
      )
    },
    quality: {
      abnormalVitalsCount: unique(data.vitalRows.filter(isAbnormalVital).map((row) => row.patientId)).length,
      allergyCoverageRate: percentage(unique(data.allergyRows.map((row) => row.patientId)).length, Math.max(patientIdsInRange.length, 1)),
      guardianLinkageCoverageForMinors: percentage(guardianLinkedMinorCount, Math.max(minorPatientsInRange.length, 1)),
      familyLinkageCoverage: percentage(newPatientsRows.filter((row) => row.familyId !== null).length, Math.max(newPatientsRows.length, 1)),
      documentationCompletenessRate: percentage(
        unique(data.diagnosisRows.map((row) => row.encounterId)).length,
        Math.max(data.encounterRows.length, 1)
      )
    },
    inventory: {
      lowStockCount: data.inventoryRows.filter((row) => toNumber(row.stock) <= toNumber(row.reorderLevel)).length,
      fastMovingItems: buildTopList(
        data.prescriptionItemRows.filter((row) => row.source === "clinical").map((row) => row.drugName),
        5
      ),
      unmatchedPrescriptionToStock: buildTopList(
        data.prescriptionItemRows
          .filter((row) => row.source === "clinical" && !matchInventoryItem(data.inventoryRows, row.drugName))
          .map((row) => row.drugName),
        5
      ).length
    }
  };

  const charts = {
    growthTrend: buildDaySeries(
      [...newPatientsRows.map((row) => row.createdAt), ...data.encounterRows.map((row) => row.checkedAt)],
      input.range.start,
      input.range.end
    ),
    doctorWorkloadComparison: doctorPerformance.map((row) => ({ label: row.doctorName, count: row.patientsSeen })),
    assistantThroughputComparison: assistantPerformance.map((row) => ({ label: row.assistantName, count: row.dispenseCount })),
    appointmentStatusDistribution: buildCategoryCounts(data.appointmentRows.map((row) => row.status), [
      "waiting",
      "in_consultation",
      "completed",
      "cancelled"
    ]),
    busyHours: buildHourSeries(data.appointmentRows.map((row) => row.scheduledAt)),
    lowStockAndTopConsumed: buildTopList(
      data.prescriptionItemRows.filter((row) => row.source === "clinical").map((row) => row.drugName),
      10
    ).map((row) => ({
      label: row.label,
      count: row.count,
      lowStock: Boolean(
        matchInventoryItem(data.inventoryRows, row.label) &&
          toNumber(matchInventoryItem(data.inventoryRows, row.label)!.stock) <=
            toNumber(matchInventoryItem(data.inventoryRows, row.label)!.reorderLevel)
      )
    })),
    completionQualityAcrossRoles: [
      { label: "encounters_completed", count: data.appointmentRows.filter((row) => row.status === "completed").length },
      { label: "dispenses_completed", count: data.dispenseRows.length },
      { label: "diagnoses_saved", count: unique(data.diagnosisRows.map((row) => row.encounterId)).length }
    ]
  };

  const insights = [
    {
      id: "walkin-trend",
      level: "info",
      message: `Walk-ins are ${summary.operationalPerformance.walkInRate}% of appointments in this range.`
    },
    {
      id: "doctor-load-balance",
      level: "info",
      message: `${
        [...doctorPerformance].sort((left, right) => right.patientsSeen - left.patientsSeen)[0]?.doctorName ?? "No doctor"
      } is carrying the highest patient load.`
    },
    {
      id: "guardian-coverage",
      level: summary.quality.guardianLinkageCoverageForMinors < 90 ? "warning" : "info",
      message: `Minor patient guardian linkage coverage is ${summary.quality.guardianLinkageCoverageForMinors}%.`
    },
    {
      id: "stock-risk",
      level: summary.inventory.lowStockCount > 0 ? "warning" : "info",
      message: `${summary.inventory.lowStockCount} medicines are currently at low stock risk.`
    }
  ];

  const alerts = [
    ...(summary.inventory.lowStockCount > 0
      ? [
          {
            id: "owner-low-stock",
            severity: "warning",
            message: `${summary.inventory.lowStockCount} inventory items are at or below reorder level.`
          }
        ]
      : []),
    ...(summary.quality.guardianLinkageCoverageForMinors < 90
      ? [
          {
            id: "owner-guardian-coverage",
            severity: "warning",
            message: `Guardian linkage for minors is below target at ${summary.quality.guardianLinkageCoverageForMinors}%.`
          }
        ]
      : [])
  ];

  return applyOwnerOperationMode(
    {
      roleContext: buildBaseRoleContext(input),
      generatedAt: input.generatedAt.toISOString(),
      range: buildBaseRange(input),
      summary,
      charts,
      insights,
      tables: {
        doctorPerformance,
        assistantPerformance,
        topDiagnoses: buildTopList(data.diagnosisRows.map((row) => row.diagnosisName)),
        topTests: buildTopList(data.testRows.map((row) => row.testName)),
        topMedications: buildTopList(data.prescriptionItemRows.map((row) => row.drugName))
      },
      alerts
    },
    input.operationMode
  );
};

export const buildAnalyticsDashboard = async (input: DashboardInput) => {
  if (input.scope.role === "doctor") {
    return buildDoctorDashboard(input);
  }
  if (input.scope.role === "assistant") {
    return buildAssistantDashboard(input);
  }
  return buildOwnerDashboard(input);
};
