import { buildDisplayName } from "./names.js";

export type AuthUserRow = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: "owner" | "doctor" | "assistant";
};

export type CreatedUserRow = AuthUserRow & {
  createdAt: Date;
};

export type PatientSummaryRow = {
  id: number;
  fullName: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dob: string | null;
  phone: string | null;
  address: string | null;
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

export const serializeAuthUser = (row: AuthUserRow) => ({
  id: row.id,
  name: buildDisplayName(row.firstName, row.lastName),
  email: row.email,
  role: row.role
});

export const serializeCreatedUser = (row: CreatedUserRow) => ({
  ...serializeAuthUser(row),
  created_at: row.createdAt
});

export const serializePatientSummary = (patient: PatientSummaryRow) => ({
  id: patient.id,
  name: patient.fullName ?? buildDisplayName(patient.firstName ?? "", patient.lastName ?? ""),
  date_of_birth: patient.dob,
  phone: patient.phone,
  address: patient.address,
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
