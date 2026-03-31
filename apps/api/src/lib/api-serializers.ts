import { resolveWorkflowProfiles, type DoctorWorkflowMode, type Permission, type UserRole } from "@medsys/types";
import { buildDisplayName } from "./names.js";

export type AuthUserRow = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  roles: UserRole[];
  activeRole: UserRole;
  doctorWorkflowMode: DoctorWorkflowMode | null;
  permissions: Permission[];
  extraPermissions: Permission[];
  createdAt?: Date;
};

export type CreatedUserRow = AuthUserRow & {
  createdAt: Date;
};

export type PatientSummaryRow = {
  id: number;
  patientCode?: string | null;
  fullName: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dob: string | null;
  phone: string | null;
  address: string | null;
  familyId?: number | null;
  guardianPatientId?: number | null;
  createdAt: Date;
};

export type PatientHistoryRow = {
  id: number;
  note: string;
  createdAt: Date;
  createdByUserId: number;
  createdByFirstName: string;
  createdByLastName: string;
  createdByRole: "owner" | "doctor" | "assistant";
};

export type PatientVitalRow = {
  id: number;
  patientId: number;
  encounterId: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  temperatureC: string | number | null;
  spo2: number | null;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const serializeAuthUser = (row: AuthUserRow) => ({
  id: row.id,
  user_id: row.id,
  name: buildDisplayName(row.firstName, row.lastName),
  email: row.email,
  role: row.role,
  roles: row.roles,
  active_role: row.activeRole,
  doctor_workflow_mode: row.doctorWorkflowMode,
  permissions: row.permissions,
  workflow_profiles: resolveWorkflowProfiles(row.roles, row.doctorWorkflowMode),
  extra_permissions: row.extraPermissions,
  ...(row.createdAt ? { created_at: row.createdAt } : {})
});

export const serializeCreatedUser = (row: CreatedUserRow) => ({
  ...serializeAuthUser(row),
  created_at: row.createdAt
});

export const serializePatientSummary = (patient: PatientSummaryRow) => ({
  id: patient.id,
  patient_code: patient.patientCode ?? null,
  name: patient.fullName ?? buildDisplayName(patient.firstName ?? "", patient.lastName ?? ""),
  date_of_birth: patient.dob,
  phone: patient.phone,
  address: patient.address,
  family_id: patient.familyId ?? null,
  guardian_patient_id: patient.guardianPatientId ?? null,
  created_at: patient.createdAt
});

export const serializePatientHistoryEntry = (row: PatientHistoryRow) => ({
  id: row.id,
  note: row.note,
  created_at: row.createdAt,
  created_by_user_id: row.createdByUserId,
  created_by_name: buildDisplayName(row.createdByFirstName, row.createdByLastName),
  created_by_role: row.createdByRole
});

export const serializePatientVital = (row: PatientVitalRow) => ({
  id: row.id,
  patient_id: row.patientId,
  encounter_id: row.encounterId,
  bp_systolic: row.bpSystolic,
  bp_diastolic: row.bpDiastolic,
  heart_rate: row.heartRate,
  temperature_c: row.temperatureC === null ? null : Number(row.temperatureC),
  spo2: row.spo2,
  recorded_at: row.recordedAt,
  created_at: row.createdAt,
  updated_at: row.updatedAt
});
