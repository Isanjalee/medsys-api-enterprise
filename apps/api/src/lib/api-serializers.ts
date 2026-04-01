import { resolveWorkflowProfiles, type DoctorWorkflowMode, type Permission, type UserRole } from "@medsys/types";
import { calculateAgeFromDob } from "./date.js";
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
  nic?: string | null;
  fullName: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dob: string | null;
  age?: number | null;
  gender?: string | null;
  phone: string | null;
  address: string | null;
  familyId?: number | null;
  familyName?: string | null;
  guardianPatientId?: number | null;
  visitCount?: number | null;
  lastVisitAt?: Date | null;
  nextAppointment?: {
    id: number;
    scheduledAt: Date;
    status: string;
  } | null;
  allergyHighlights?: string[] | null;
  majorActiveCondition?: string | null;
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

export const serializePatientSummary = (patient: PatientSummaryRow) => {
  const derivedAge =
    patient.dob !== null
      ? calculateAgeFromDob(new Date(patient.dob))
      : patient.age ?? null;

  return {
    id: patient.id,
    patient_code: patient.patientCode ?? null,
    nic: patient.nic ?? null,
    name: patient.fullName ?? buildDisplayName(patient.firstName ?? "", patient.lastName ?? ""),
    date_of_birth: patient.dob,
    age: derivedAge,
    gender: patient.gender ?? null,
    phone: patient.phone,
    address: patient.address,
    family_id: patient.familyId ?? null,
    family_name: patient.familyName ?? null,
    guardian_patient_id: patient.guardianPatientId ?? null,
    visit_count: patient.visitCount ?? 0,
    last_visit_at: patient.lastVisitAt ?? null,
    next_appointment: patient.nextAppointment
      ? {
          id: patient.nextAppointment.id,
          scheduled_at: patient.nextAppointment.scheduledAt,
          status: patient.nextAppointment.status
        }
      : null,
    allergy_highlights: patient.allergyHighlights ?? [],
    major_active_condition: patient.majorActiveCondition ?? null,
    created_at: patient.createdAt
  };
};

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
