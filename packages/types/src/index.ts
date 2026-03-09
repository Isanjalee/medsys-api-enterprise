export const USER_ROLES = ["owner", "doctor", "assistant"] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
    "appointment.update",
    "analytics.read",
    "encounter.read",
    "encounter.write",
    "family.read",
    "inventory.read",
    "prescription.read"
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
    "encounter.read",
    "family.read",
    "family.write",
    "inventory.read",
    "inventory.write",
    "prescription.read",
    "prescription.dispense"
  ]
} as const;

export const hasPermission = (role: UserRole, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const hasAllPermissions = (role: UserRole, permissions: readonly Permission[]): boolean =>
  permissions.every((permission) => hasPermission(role, permission));

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
