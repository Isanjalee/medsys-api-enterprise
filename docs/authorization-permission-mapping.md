# Authorization and Permission Mapping

Current mapping between:

- Frontend permission strings
- Backend role-based authorization

Date: March 9, 2026
Status: Initial compatibility mapping

## 1. Purpose

The frontend currently authorizes UI actions using permission strings such as `patient.read` and `user.write`.

The backend currently authorizes API routes using role checks:

- `owner`
- `doctor`
- `assistant`

This document defines the current best-fit mapping so the frontend and backend can be aligned without pretending they already share a unified authorization model.

## 2. Current Backend Roles

Defined in [schema.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/packages/db/src/schema.ts#L18):

- `owner`
- `doctor`
- `assistant`

Applied in [auth.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/plugins/auth.ts#L21) via `app.authorize([...roles])`.

## 3. Proposed Permission-to-Role Matrix

| Frontend Permission | Owner | Doctor | Assistant | Current Backend Basis | Notes |
|---|---|---|---|---|---|
| `patient.read` | Yes | Yes | Yes | patient list/get/profile routes | Matches current backend behavior |
| `patient.write` | Yes | No | Yes | patient create/update routes | Frontend meaning must stay scoped to demographics only |
| `patient.delete` | Yes | No | No | no current backend route | New route should likely be owner-only |
| `patient.history.read` | Yes | Yes | Yes | no current backend route | Best match is same access as patient read |
| `patient.history.write` | Yes | Yes | Yes | closest current behavior is timeline create for doctor/assistant | Needs explicit product decision |
| `user.read` | Yes | No | No | no current backend route | Recommend owner-only |
| `user.write` | Yes | No | No | no current backend route | Recommend owner-only |
| `clinical.icd10.read` | Yes | Yes | Yes | no current backend route | Safe default if endpoint is read-only |

## 4. Current Backend Route Evidence

## 4.1 Patient routes

Patient read access in [patients.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/routes/v1/patients.ts#L211):

- `owner`
- `doctor`
- `assistant`

Patient create/update access in [patients.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/routes/v1/patients.ts#L235):

- `owner`
- `assistant`

Clinical patient writes differ from demographic patient writes:

- conditions: `owner`, `doctor`
- allergies: `owner`, `doctor`
- vitals create: `doctor`, `assistant`
- timeline create: `doctor`, `assistant`

This means a single frontend permission like `patient.write` is not rich enough to represent all current backend clinical write rules.

## 4.2 Analytics and audit

Analytics overview in [analytics.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/routes/v1/analytics.ts#L16):

- `owner`
- `doctor`
- `assistant`

Audit logs in [audit.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/routes/v1/audit.ts#L16):

- `owner`

This is relevant because frontend permission growth will need more than the current patient/user permissions.

## 5. Known Gaps

### 5.1 No shared authorization source of truth

The frontend and backend do not currently import a shared permission policy package.

### 5.2 Permission granularity mismatch

The frontend permission model is coarse.

The backend role model is route-specific and sometimes domain-specific.

Examples:

- `patient.write` does not distinguish demographic editing from clinical recording
- user administration permissions are not implemented in the backend yet
- patient history permissions do not exist in the backend yet

### 5.3 Missing enforcement for frontend-only permissions

The following permissions are not yet backed by a corresponding backend endpoint:

- `patient.delete`
- `patient.history.read`
- `patient.history.write`
- `user.read`
- `user.write`
- `clinical.icd10.read`

## 6. Recommended Direction

### Short term

- keep backend role-based authorization as-is
- let the frontend map permissions to visible actions
- document the mapping explicitly in this file

### Medium term

- add a shared authorization package that exports:
  - permission constants
  - permission-to-role rules
  - route-level authorization helpers

### Long term

- move from raw role checks toward explicit capability checks if the domain surface keeps growing

## 7. Recommended New Permissions

If the frontend expands to match the backend domain model, these permissions will likely be needed:

- `patient.demographics.write`
- `patient.conditions.write`
- `patient.allergies.write`
- `patient.vitals.write`
- `patient.timeline.write`
- `audit.read`
- `analytics.read`
- `appointments.read`
- `appointments.write`
- `encounters.read`
- `encounters.write`
- `prescriptions.read`
- `prescriptions.write`
- `inventory.read`
- `inventory.write`

## 8. Immediate Implementation Guidance

Until a shared permission package exists, use this operational mapping:

- `owner`: all current frontend permissions
- `doctor`: `patient.read`, `patient.history.read`, `clinical.icd10.read`
- `assistant`: `patient.read`, `patient.write`, `clinical.icd10.read`

Do not infer that this is a final security model. It is only a compatibility baseline for the currently documented frontend routes.
