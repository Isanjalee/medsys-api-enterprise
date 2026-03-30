import {
  DOCTOR_WORKFLOW_MODES,
  PERMISSIONS,
  canRoleReceiveExtraPermissions,
  isAssistantSupportPermission,
  normalizePermissions,
  resolveEffectivePermissions,
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
  role: UserRole,
  doctorWorkflowMode: DoctorWorkflowMode | null | undefined,
  field = "doctorWorkflowMode"
): DoctorWorkflowMode | null => {
  if (role !== "doctor") {
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
  role: UserRole,
  extraPermissions: readonly Permission[],
  field = "extraPermissions"
): Permission[] => {
  const normalized = normalizePermissions(extraPermissions);

  if (normalized.length === 0) {
    return normalized;
  }

  if (!canRoleReceiveExtraPermissions(role)) {
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
