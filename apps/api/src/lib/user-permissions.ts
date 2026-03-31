import {
  DOCTOR_WORKFLOW_MODES,
  PERMISSIONS,
  isAssistantSupportPermission,
  normalizePermissions,
  normalizeRoles,
  resolveEffectivePermissions,
  resolveEffectivePermissionsForRoles,
  type DoctorWorkflowMode,
  type Permission,
  type UserRole
} from "@medsys/types";
import { validationError } from "./http-error.js";

const isPermission = (value: unknown): value is Permission =>
  typeof value === "string" && PERMISSIONS.includes(value as Permission);

export const normalizeStoredExtraPermissions = (value: unknown): Permission[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return normalizePermissions(value.filter(isPermission));
};

export const normalizeStoredDoctorWorkflowMode = (value: unknown): DoctorWorkflowMode | null => {
  if (typeof value !== "string") {
    return null;
  }

  return DOCTOR_WORKFLOW_MODES.includes(value as DoctorWorkflowMode) ? (value as DoctorWorkflowMode) : null;
};

export const resolveDoctorWorkflowMode = (
  roles: readonly UserRole[],
  doctorWorkflowMode: DoctorWorkflowMode | null | undefined,
  field = "doctorWorkflowMode"
): DoctorWorkflowMode | null => {
  if (!roles.includes("doctor")) {
    if (doctorWorkflowMode !== undefined && doctorWorkflowMode !== null) {
      throw validationError([
        {
          field,
          message: "doctorWorkflowMode is only allowed for doctor users."
        }
      ]);
    }

    return null;
  }

  return doctorWorkflowMode ?? "self_service";
};

export const assertAssignableExtraPermissions = (
  roles: readonly UserRole[],
  extraPermissions: readonly Permission[],
  field = "extraPermissions"
): Permission[] => {
  const normalized = normalizePermissions(extraPermissions);

  if (normalized.length === 0) {
    return normalized;
  }

  if (!roles.includes("doctor")) {
    throw validationError([
      {
        field,
        message: "Only doctor users can receive extra permissions."
      }
    ]);
  }

  const disallowed = normalized.filter((permission) => !isAssistantSupportPermission(permission));
  if (disallowed.length > 0) {
    throw validationError([
      {
        field,
        message: `Only assistant-support permissions can be granted: ${disallowed.join(", ")}`
      }
    ]);
  }

  return normalized;
};

export const resolveUserPermissions = (role: UserRole, extraPermissions: readonly Permission[]): Permission[] =>
  resolveEffectivePermissions(role, normalizePermissions(extraPermissions));

export const resolveActiveWorkflowProfile = (
  roles: readonly UserRole[],
  activeRole: UserRole,
  doctorWorkflowMode: DoctorWorkflowMode | null
): { mode: string } | null => {
  if (activeRole === "doctor" && roles.includes("doctor")) {
    return { mode: doctorWorkflowMode ?? "self_service" };
  }

  if (activeRole === "assistant" && roles.includes("assistant")) {
    return { mode: "standard" };
  }

  if (activeRole === "owner" && roles.includes("owner")) {
    return { mode: "standard" };
  }

  return null;
};

export const resolveUserPermissionsForRoles = (
  roles: readonly UserRole[],
  extraPermissions: readonly Permission[]
): Permission[] => resolveEffectivePermissionsForRoles(normalizeRoles(roles), normalizePermissions(extraPermissions));

export const normalizeStoredRoles = (primaryRole: UserRole, storedRoles: readonly UserRole[] = []): UserRole[] =>
  normalizeRoles(storedRoles.length > 0 ? storedRoles : [primaryRole]);

export const resolveActiveRole = (
  roles: readonly UserRole[],
  activeRole: UserRole | null | undefined,
  fallbackRole?: UserRole
): UserRole => {
  const normalizedRoles = normalizeRoles(roles);

  if (activeRole && normalizedRoles.includes(activeRole)) {
    return activeRole;
  }

  if (fallbackRole && normalizedRoles.includes(fallbackRole)) {
    return fallbackRole;
  }

  return normalizedRoles[0] ?? fallbackRole ?? "doctor";
};
