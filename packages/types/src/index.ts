export const USER_ROLES = ["owner", "doctor", "assistant"] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
