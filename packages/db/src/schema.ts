import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  inet,
  jsonb,
  numeric,
  pgEnum,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["owner", "doctor", "assistant"]);
export const doctorWorkflowModeEnum = pgEnum("doctor_workflow_mode", ["self_service", "clinic_supported"]);
export const genderEnum = pgEnum("gender", ["male", "female", "other"]);
export const allergySeverityEnum = pgEnum("allergy_severity", ["low", "moderate", "high"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "waiting",
  "in_consultation",
  "completed",
  "cancelled"
]);
export const priorityLevelEnum = pgEnum("priority_level", ["low", "normal", "high", "critical"]);
export const drugSourceEnum = pgEnum("drug_source", ["clinical", "outside"]);
export const inventoryCategoryEnum = pgEnum("inventory_category", [
  "medicine",
  "consumable",
  "equipment",
  "other"
]);
export const inventoryMovementTypeEnum = pgEnum("inventory_movement_type", [
  "in",
  "out",
  "adjustment"
]);
export const testOrderStatusEnum = pgEnum("test_order_status", [
  "ordered",
  "in_progress",
  "completed",
  "cancelled"
]);

const auditTimestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    uuid: uuid("uuid").notNull().defaultRandom().unique(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    firstName: varchar("first_name", { length: 80 }).notNull(),
    lastName: varchar("last_name", { length: 80 }).notNull(),
    role: userRoleEnum("role").notNull(),
    activeRole: userRoleEnum("active_role"),
    doctorWorkflowMode: doctorWorkflowModeEnum("doctor_workflow_mode"),
    extraPermissions: jsonb("extra_permissions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    ...auditTimestamps
  },
  (table) => [uniqueIndex("users_org_email_idx").on(table.organizationId, table.email)]
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    role: userRoleEnum("role").notNull(),
    ...auditTimestamps
  },
  (table) => [
    unique("user_roles_user_role_unique").on(table.userId, table.role),
    index("user_roles_user_idx").on(table.userId)
  ]
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    tokenId: uuid("token_id").notNull().defaultRandom().unique(),
    familyId: uuid("family_id").notNull().defaultRandom(),
    parentTokenId: uuid("parent_token_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replayDetectedAt: timestamp("replay_detected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("refresh_tokens_user_idx").on(table.userId),
    index("refresh_tokens_family_idx").on(table.familyId)
  ]
);

export const families = pgTable(
  "families",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    familyCode: varchar("family_code", { length: 30 }).notNull().unique(),
    familyName: varchar("family_name", { length: 120 }).notNull(),
    assigned: boolean("assigned").notNull().default(false),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [index("families_org_assigned_idx").on(table.organizationId, table.assigned)]
);

export const patients = pgTable(
  "patients",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    uuid: uuid("uuid").notNull().defaultRandom().unique(),
    patientCode: varchar("patient_code", { length: 24 }).notNull(),
    nic: varchar("nic", { length: 20 }),
    firstName: varchar("first_name", { length: 80 }).notNull(),
    lastName: varchar("last_name", { length: 80 }).notNull(),
    fullName: varchar("full_name", { length: 170 })
      .generatedAlwaysAs(sql`"first_name" || ' ' || "last_name"`)
      .notNull(),
    dob: date("dob").notNull(),
    age: bigint("age", { mode: "number" }).notNull(),
    gender: genderEnum("gender").notNull(),
    phone: varchar("phone", { length: 30 }),
    address: text("address"),
    bloodGroup: varchar("blood_group", { length: 5 }),
    familyId: bigint("family_id", { mode: "number" }).references(() => families.id),
    guardianPatientId: bigint("guardian_patient_id", { mode: "number" }).references((): AnyPgColumn => patients.id),
    guardianName: varchar("guardian_name", { length: 120 }),
    guardianNic: varchar("guardian_nic", { length: 20 }),
    guardianPhone: varchar("guardian_phone", { length: 30 }),
    guardianRelationship: varchar("guardian_relationship", { length: 40 }),
    isActive: boolean("is_active").notNull().default(true),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    unique("patients_org_nic_unique").on(table.organizationId, table.nic),
    unique("patients_org_patient_code_unique").on(table.organizationId, table.patientCode),
    index("patients_org_full_name_idx").on(table.organizationId, table.fullName),
    index("patients_org_family_idx").on(table.organizationId, table.familyId),
    index("patients_org_patient_code_idx").on(table.organizationId, table.patientCode),
    index("patients_org_guardian_patient_idx").on(table.organizationId, table.guardianPatientId),
    index("patients_org_guardian_nic_idx").on(table.organizationId, table.guardianNic)
  ]
);

export const familyMembers = pgTable(
  "family_members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    familyId: bigint("family_id", { mode: "number" })
      .notNull()
      .references(() => families.id),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    relationship: varchar("relationship", { length: 40 }),
    ...auditTimestamps
  },
  (table) => [
    unique("family_members_unique").on(table.familyId, table.patientId),
    index("family_members_org_family_idx").on(table.organizationId, table.familyId)
  ]
);

export const patientAllergies = pgTable(
  "patient_allergies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    allergyName: varchar("allergy_name", { length: 120 }).notNull(),
    severity: allergySeverityEnum("severity"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [index("patient_allergies_patient_idx").on(table.patientId)]
);

export const patientConditions = pgTable(
  "patient_conditions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    conditionName: varchar("condition_name", { length: 180 }).notNull(),
    icd10Code: varchar("icd10_code", { length: 16 }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [index("patient_conditions_patient_idx").on(table.patientId)]
);

export const appointments = pgTable(
  "appointments",
  {
    id: bigserial("id", { mode: "number" }).notNull(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    doctorId: bigint("doctor_id", { mode: "number" }).references(() => users.id),
    assistantId: bigint("assistant_id", { mode: "number" }).references(() => users.id),
    visitMode: varchar("visit_mode", { length: 20 }).notNull().default("appointment"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    waitingAt: timestamp("waiting_at", { withTimezone: true }),
    inConsultationAt: timestamp("in_consultation_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reason: text("reason"),
    priority: priorityLevelEnum("priority").notNull().default("normal"),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({ columns: [table.id, table.scheduledAt], name: "appointments_partitioned_pkey" }),
    index("appointments_id_idx").on(table.id),
    index("appointments_status_scheduled_idx").on(table.status, table.scheduledAt),
    index("appointments_patient_idx").on(table.patientId),
    index("appointments_org_scheduled_idx").on(table.organizationId, table.scheduledAt)
  ]
);

export const encounters = pgTable(
  "encounters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    appointmentId: bigint("appointment_id", { mode: "number" }).notNull(),
    appointmentScheduledAt: timestamp("appointment_scheduled_at", { withTimezone: true }).notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    doctorId: bigint("doctor_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
    nextVisitDate: date("next_visit_date"),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.appointmentId, table.appointmentScheduledAt],
      foreignColumns: [appointments.id, appointments.scheduledAt],
      name: "encounters_appointment_id_fkey"
    }).onUpdate("cascade"),
    unique("encounters_appointment_unique").on(table.appointmentId),
    index("encounters_appointment_fk_idx").on(table.appointmentId, table.appointmentScheduledAt),
    index("encounters_patient_idx").on(table.patientId)
  ]
);

export const encounterDiagnoses = pgTable(
  "encounter_diagnoses",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    encounterId: bigint("encounter_id", { mode: "number" })
      .notNull()
      .references(() => encounters.id),
    icd10Code: varchar("icd10_code", { length: 16 }),
    diagnosisName: varchar("diagnosis_name", { length: 255 }).notNull(),
    ...auditTimestamps
  },
  (table) => [index("encounter_diagnoses_encounter_idx").on(table.encounterId)]
);

export const testOrders = pgTable(
  "test_orders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    encounterId: bigint("encounter_id", { mode: "number" })
      .notNull()
      .references(() => encounters.id),
    testName: varchar("test_name", { length: 180 }).notNull(),
    status: testOrderStatusEnum("status").notNull().default("ordered"),
    ...auditTimestamps
  },
  (table) => [index("test_orders_encounter_idx").on(table.encounterId)]
);

export const prescriptions = pgTable(
  "prescriptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    encounterId: bigint("encounter_id", { mode: "number" })
      .notNull()
      .references(() => encounters.id),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    doctorId: bigint("doctor_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("prescriptions_patient_idx").on(table.patientId),
    index("prescriptions_encounter_idx").on(table.encounterId)
  ]
);

export const prescriptionItems = pgTable(
  "prescription_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    prescriptionId: bigint("prescription_id", { mode: "number" })
      .notNull()
      .references(() => prescriptions.id),
    drugName: varchar("drug_name", { length: 180 }).notNull(),
    dose: varchar("dose", { length: 80 }).notNull(),
    frequency: varchar("frequency", { length: 80 }).notNull(),
    duration: varchar("duration", { length: 80 }),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull(),
    source: drugSourceEnum("source").notNull(),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [index("prescription_items_prescription_idx").on(table.prescriptionId)]
);

export const dispenseRecords = pgTable(
  "dispense_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    prescriptionId: bigint("prescription_id", { mode: "number" })
      .notNull()
      .references(() => prescriptions.id),
    assistantId: bigint("assistant_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    dispensedAt: timestamp("dispensed_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    notes: text("notes"),
    ...auditTimestamps
  },
  (table) => [index("dispense_records_prescription_idx").on(table.prescriptionId)]
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    sku: varchar("sku", { length: 80 }).unique(),
    name: varchar("name", { length: 180 }).notNull(),
    genericName: varchar("generic_name", { length: 180 }),
    category: inventoryCategoryEnum("category").notNull(),
    subcategory: varchar("subcategory", { length: 80 }),
    description: text("description"),
    dosageForm: varchar("dosage_form", { length: 40 }),
    strength: varchar("strength", { length: 40 }),
    unit: varchar("unit", { length: 20 }).notNull(),
    dispenseUnit: varchar("dispense_unit", { length: 20 }),
    dispenseUnitSize: numeric("dispense_unit_size", { precision: 12, scale: 2 }),
    purchaseUnit: varchar("purchase_unit", { length: 20 }),
    purchaseUnitSize: numeric("purchase_unit_size", { precision: 12, scale: 2 }),
    route: varchar("route", { length: 40 }),
    prescriptionType: varchar("prescription_type", { length: 20 }),
    packageUnit: varchar("package_unit", { length: 20 }),
    packageSize: numeric("package_size", { precision: 12, scale: 2 }),
    brandName: varchar("brand_name", { length: 120 }),
    supplierName: varchar("supplier_name", { length: 120 }),
    leadTimeDays: bigint("lead_time_days", { mode: "number" }),
    stock: numeric("stock", { precision: 12, scale: 2 }).notNull().default("0"),
    reorderLevel: numeric("reorder_level", { precision: 12, scale: 2 }).notNull().default("0"),
    minStockLevel: numeric("min_stock_level", { precision: 12, scale: 2 }),
    maxStockLevel: numeric("max_stock_level", { precision: 12, scale: 2 }),
    expiryDate: date("expiry_date"),
    batchNo: varchar("batch_no", { length: 80 }),
    storageLocation: varchar("storage_location", { length: 120 }),
    directDispenseAllowed: boolean("direct_dispense_allowed").notNull().default(false),
    isAntibiotic: boolean("is_antibiotic").notNull().default(false),
    isControlled: boolean("is_controlled").notNull().default(false),
    isPediatricSafe: boolean("is_pediatric_safe").notNull().default(false),
    requiresPrescription: boolean("requires_prescription").notNull().default(true),
    clinicUseOnly: boolean("clinic_use_only").notNull().default(false),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("inventory_items_org_name_idx").on(table.organizationId, table.name),
    index("inventory_items_org_generic_name_idx").on(table.organizationId, table.genericName),
    index("inventory_items_org_expiry_date_idx").on(table.organizationId, table.expiryDate)
  ]
);

export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    inventoryItemId: bigint("inventory_item_id", { mode: "number" })
      .notNull()
      .references(() => inventoryItems.id),
    batchNo: varchar("batch_no", { length: 80 }).notNull(),
    expiryDate: date("expiry_date"),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("0"),
    supplierName: varchar("supplier_name", { length: 120 }),
    storageLocation: varchar("storage_location", { length: 120 }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("inventory_batches_item_idx").on(table.inventoryItemId),
    index("inventory_batches_org_expiry_idx").on(table.organizationId, table.expiryDate)
  ]
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    inventoryItemId: bigint("inventory_item_id", { mode: "number" })
      .notNull()
      .references(() => inventoryItems.id),
    batchId: bigint("batch_id", { mode: "number" }).references(() => inventoryBatches.id),
    movementType: inventoryMovementTypeEnum("movement_type").notNull(),
    reason: varchar("reason", { length: 30 }),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull(),
    note: text("note"),
    referenceType: varchar("reference_type", { length: 30 }),
    referenceId: bigint("reference_id", { mode: "number" }),
    createdById: bigint("created_by_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("inventory_movements_item_idx").on(table.inventoryItemId)]
);

export const dailySummarySnapshots = pgTable(
  "daily_summary_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    roleContext: varchar("role_context", { length: 20 }).notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(() => users.id),
    summaryDate: date("summary_date").notNull(),
    summaryType: varchar("summary_type", { length: 30 }).notNull().default("daily"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("daily_summary_snapshots_org_date_idx").on(table.organizationId, table.summaryDate),
    index("daily_summary_snapshots_org_role_date_idx").on(table.organizationId, table.roleContext, table.summaryDate)
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    description: text("description"),
    taskType: varchar("task_type", { length: 40 }).notNull(),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: bigint("source_id", { mode: "number" }),
    assignedRole: userRoleEnum("assigned_role").notNull(),
    assignedUserId: bigint("assigned_user_id", { mode: "number" }).references(() => users.id),
    priority: priorityLevelEnum("priority").notNull().default("normal"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    visitMode: varchar("visit_mode", { length: 20 }),
    doctorWorkflowMode: doctorWorkflowModeEnum("doctor_workflow_mode"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    index("tasks_org_status_idx").on(table.organizationId, table.status),
    index("tasks_org_role_idx").on(table.organizationId, table.assignedRole),
    index("tasks_org_due_idx").on(table.organizationId, table.dueAt)
  ]
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: bigint("task_id", { mode: "number" })
      .notNull()
      .references(() => tasks.id),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(() => users.id),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("task_events_task_idx").on(table.taskId)]
);

export const patientVitals = pgTable(
  "patient_vitals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    encounterId: bigint("encounter_id", { mode: "number" }).references(() => encounters.id),
    bpSystolic: bigint("bp_systolic", { mode: "number" }),
    bpDiastolic: bigint("bp_diastolic", { mode: "number" }),
    heartRate: bigint("heart_rate", { mode: "number" }),
    temperatureC: numeric("temperature_c", { precision: 4, scale: 1 }),
    spo2: bigint("spo2", { mode: "number" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("patient_vitals_patient_recorded_idx").on(table.patientId, table.recordedAt),
    index("patient_vitals_encounter_idx").on(table.encounterId)
  ]
);

export const patientTimelineEvents = pgTable(
  "patient_timeline_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    encounterId: bigint("encounter_id", { mode: "number" }).references(() => encounters.id),
    eventDate: date("event_date").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    eventKind: varchar("event_kind", { length: 30 }),
    tags: text("tags").array(),
    value: varchar("value", { length: 80 }),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [index("patient_timeline_events_patient_date_idx").on(table.patientId, table.eventDate)]
);

export const patientHistoryEntries = pgTable(
  "patient_history_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    patientId: bigint("patient_id", { mode: "number" })
      .notNull()
      .references(() => patients.id),
    createdByUserId: bigint("created_by_user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    note: text("note").notNull(),
    ...auditTimestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    index("patient_history_entries_org_patient_idx").on(table.organizationId, table.patientId),
    index("patient_history_entries_patient_created_idx").on(table.patientId, table.createdAt)
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(() => users.id),
    entityType: varchar("entity_type", { length: 60 }).notNull(),
    entityId: bigint("entity_id", { mode: "number" }),
    action: varchar("action", { length: 30 }).notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: uuid("request_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId)
  ]
);
