# Authorization and Permission Mapping

Current mapping between:

- Frontend permission strings
- Backend role-based authorization

Date: March 9, 2026
Status: Shared permission mapping implemented across `/v1`

## 1. Purpose

The frontend currently authorizes UI actions using permission strings such as `patient.read` and `user.write`.

The backend currently authorizes API routes using role checks:

- `owner`
- `doctor`
- `assistant`

This document defines the current best-fit mapping so the frontend and backend can be aligned without pretending they already share a unified authorization model.

Current implementation note:

- shared permission constants and role mappings now exist in `@medsys/types`
- backend routes now use permission-based checks through `app.authorizePermissions(...)` across the full `/v1` surface

## 2. Current Backend Roles

Defined in [schema.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/packages/db/src/schema.ts#L18):

- `owner`
- `doctor`
- `assistant`

Applied in [auth.ts](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/apps/api/src/plugins/auth.ts#L36) via `app.authorizePermissions([...permissions])`.

## 3. Proposed Permission-to-Role Matrix

| Frontend Permission | Owner | Doctor | Assistant | Current Backend Basis | Notes |
|---|---|---|---|---|---|
| `patient.read` | Yes | Yes | Yes | patient list/get/profile routes | Matches current backend behavior |
| `patient.write` | Yes | No | Yes | patient create/update routes | Frontend meaning must stay scoped to demographics only |
| `patient.delete` | Yes | No | No | patient delete route | Implemented as owner-only soft delete |
| `patient.history.read` | Yes | Yes | Yes | patient history list route | Implemented and aligned to patient read access |
| `patient.history.write` | Yes | Yes | Yes | patient history create route | Implemented and aligned to documented contract |
| `user.read` | Yes | No | No | users list route | Implemented as owner-only |
| `user.write` | Yes | No | No | users create/register routes | Implemented as owner-only after bootstrap |
| `clinical.icd10.read` | Yes | Yes | Yes | ICD-10 lookup route | Implemented as read-only backend adapter |

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

### 5.1 Permission granularity mismatch

The frontend permission model is coarse.

The backend role model is route-specific and sometimes domain-specific.

Examples:

- `patient.write` does not distinguish demographic editing from clinical recording
- user administration is only one slice of a broader backend permission surface
- patient history permissions exist now, but the backend also needs explicit permissions for conditions, allergies, vitals, timeline, inventory, families, and dispensing

### 5.2 Remaining frontend-backend mismatch

Most documented frontend permissions are now enforced by backend routes. The remaining mismatch is that the backend permission surface is wider than the current frontend permission catalog.

## 6. Recommended Direction

### Short term

- keep the shared permission map as the source of truth for backend route enforcement
- let the frontend map permissions to visible actions using the same permission names

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

Current operational state:

- `owner`: all backend permissions
- `doctor`: read-heavy clinical access plus doctor-only clinical writes such as encounter creation and condition/allergy updates
- `assistant`: operational access such as patient demographics, appointments, vitals, inventory, family membership, and dispensing

Do not infer that this is a final product authorization model. It is a backend compatibility layer that now preserves route behavior through named permissions instead of raw role arrays.
