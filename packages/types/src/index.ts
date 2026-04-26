export const USER_ROLES = ["owner", "doctor", "assistant"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DOCTOR_WORKFLOW_MODES = ["self_service", "clinic_supported"] as const;
export type DoctorWorkflowMode = (typeof DOCTOR_WORKFLOW_MODES)[number];

export const STANDARD_WORKFLOW_MODES = ["standard"] as const;
export type StandardWorkflowMode = (typeof STANDARD_WORKFLOW_MODES)[number];

export type WorkflowProfiles = {
  doctor: { mode: DoctorWorkflowMode } | null;
  assistant: { mode: StandardWorkflowMode } | null;
  owner: { mode: StandardWorkflowMode } | null;
};

export const PERMISSIONS = [
  "patient.read",
  "patient.write",
  "patient.delete",
  "patient.history.read",
  "patient.history.write",
  "patient.profile.read",
  "patient.family.read",
  "patient.allergy.read",
  "patient.allergy.write",
  "patient.condition.read",
  "patient.condition.write",
  "patient.vital.read",
  "patient.vital.write",
  "patient.timeline.read",
  "patient.timeline.write",
  "user.read",
  "user.write",
  "clinical.icd10.read",
  "appointment.read",
  "appointment.create",
  "appointment.update",
  "analytics.read",
  "task.read",
  "task.write",
  "audit.read",
  "encounter.read",
  "encounter.write",
  "family.read",
  "family.write",
  "inventory.read",
  "inventory.write",
  "prescription.read",
  "prescription.dispense"
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  doctor: [
    "patient.read",
    "patient.write",
    "patient.history.read",
    "patient.history.write",
    "patient.profile.read",
    "patient.family.read",
    "patient.allergy.read",
    "patient.allergy.write",
    "patient.condition.read",
    "patient.condition.write",
    "patient.vital.read",
    "patient.vital.write",
    "patient.timeline.read",
    "patient.timeline.write",
    "clinical.icd10.read",
    "appointment.read",
    "appointment.create",
    "appointment.update",
    "analytics.read",
    "task.read",
    "task.write",
    "encounter.read",
    "encounter.write",
    "family.read",
    "inventory.read",
    "inventory.write",
    "prescription.read",
    "prescription.dispense"
  ],
  assistant: [
    "patient.read",
    "patient.write",
    "patient.history.read",
    "patient.history.write",
    "patient.profile.read",
    "patient.family.read",
    "patient.allergy.read",
    "patient.condition.read",
    "patient.vital.read",
    "patient.vital.write",
    "patient.timeline.read",
    "patient.timeline.write",
    "clinical.icd10.read",
    "appointment.read",
    "appointment.create",
    "appointment.update",
    "analytics.read",
    "task.read",
    "task.write",
    "audit.read",
    "encounter.read",
    "family.read",
    "family.write",
    "inventory.read",
    "inventory.write",
    "prescription.read",
    "prescription.dispense"
  ]
} as const;

export const ASSISTANT_SUPPORT_PERMISSIONS = [
  "patient.write",
  "appointment.create",
  "family.write",
  "inventory.write",
  "prescription.dispense"
] as const satisfies readonly Permission[];

export const hasPermission = (role: UserRole, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const hasAllPermissions = (role: UserRole, permissions: readonly Permission[]): boolean =>
  permissions.every((permission) => hasPermission(role, permission));

export const hasAllResolvedPermissions = (
  effectivePermissions: readonly Permission[],
  permissions: readonly Permission[]
): boolean => permissions.every((permission) => effectivePermissions.includes(permission));

export const normalizePermissions = (permissions: readonly Permission[]): Permission[] =>
  [...new Set(permissions)].sort();

export const normalizeRoles = (roles: readonly UserRole[]): UserRole[] =>
  [...new Set(roles)].sort((a, b) => USER_ROLES.indexOf(a) - USER_ROLES.indexOf(b));

export const resolveEffectivePermissions = (
  role: UserRole,
  extraPermissions: readonly Permission[] = []
): Permission[] => normalizePermissions([...ROLE_PERMISSIONS[role], ...extraPermissions]);

export const resolveEffectivePermissionsForRoles = (
  roles: readonly UserRole[],
  extraPermissions: readonly Permission[] = []
): Permission[] =>
  normalizePermissions([
    ...roles.flatMap((role) => ROLE_PERMISSIONS[role]),
    ...normalizePermissions(extraPermissions)
  ]);

export const resolveWorkflowProfiles = (
  roles: readonly UserRole[],
  doctorWorkflowMode: DoctorWorkflowMode | null
): WorkflowProfiles => ({
  doctor: roles.includes("doctor") ? { mode: doctorWorkflowMode ?? "self_service" } : null,
  assistant: roles.includes("assistant") ? { mode: "standard" } : null,
  owner: roles.includes("owner") ? { mode: "standard" } : null
});

export const canRoleReceiveExtraPermissions = (role: UserRole): boolean => role === "doctor";

export const isAssistantSupportPermission = (permission: Permission): boolean =>
  (ASSISTANT_SUPPORT_PERMISSIONS as readonly Permission[]).includes(permission);

export const GENDERS = ["male", "female", "other"] as const;
export type Gender = (typeof GENDERS)[number];

export const APPOINTMENT_STATUSES = [
  "waiting",
  "in_consultation",
  "completed",
  "cancelled"
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const PRIORITY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const DRUG_SOURCES = ["clinical", "outside"] as const;
export type DrugSource = (typeof DRUG_SOURCES)[number];

export const INVENTORY_MOVEMENT_TYPES = ["in", "out", "adjustment"] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

export type AuditEvent = {
  organizationId: string;
  actorUserId: number | null;
  entityType: string;
  entityId: number | null;
  action: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  payload: unknown;
  createdAt: string;
};

export type AuditQueueMessage = {
  version: 1;
  event: AuditEvent;
  attempt: number;
  firstQueuedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isAuditEvent = (value: unknown): value is AuditEvent =>
  isRecord(value) &&
  typeof value.organizationId === "string" &&
  (typeof value.actorUserId === "number" || value.actorUserId === null) &&
  typeof value.entityType === "string" &&
  (typeof value.entityId === "number" || value.entityId === null) &&
  typeof value.action === "string" &&
  (typeof value.ip === "string" || value.ip === null) &&
  (typeof value.userAgent === "string" || value.userAgent === null) &&
  (typeof value.requestId === "string" || value.requestId === null) &&
  "payload" in value &&
  typeof value.createdAt === "string";

export const isAuditQueueMessage = (value: unknown): value is AuditQueueMessage =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.attempt === "number" &&
  typeof value.firstQueuedAt === "string" &&
  (typeof value.lastAttemptAt === "string" || value.lastAttemptAt === null) &&
  (typeof value.lastError === "string" || value.lastError === null) &&
  isAuditEvent(value.event);

export const createAuditQueueMessage = (event: AuditEvent): AuditQueueMessage => ({
  version: 1,
  event,
  attempt: 0,
  firstQueuedAt: event.createdAt,
  lastAttemptAt: null,
  lastError: null
});

export const parseAuditQueueMessage = (raw: string): AuditQueueMessage => {
  const parsed = JSON.parse(raw) as unknown;

  if (isAuditQueueMessage(parsed)) {
    return parsed;
  }

  if (isAuditEvent(parsed)) {
    return createAuditQueueMessage(parsed);
  }

  throw new Error("Invalid audit queue message");
};
