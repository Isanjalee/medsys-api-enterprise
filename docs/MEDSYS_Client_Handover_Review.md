# MEDSYS Healthcare Platform
## Client Specification and Implementation Review

Project Code: `MEDLINK-Version2`  
Target Audience: All Medical Field Professionals  
Document Version: `1.0`  
System Reference Date: March 25, 2026  
Status: Tech Manager Review Draft  

Space for branding/logo: `Reserved`

---

## 1. Executive Summary

MEDSYS is a role-based healthcare operations platform designed for clinic and medical-center workflows. The current implementation supports patient management, appointment and walk-in consultation flows, diagnosis and medical test search, prescription lifecycle handling, assistant-driven dispensing, inventory search and stock deduction, user management, analytics, and audit logging.

The strongest implementation area today is the doctor and assistant operational flow:

- doctors can save a complete consultation through a single workflow endpoint
- appointment and walk-in modes are both supported
- prescription items are operationally split into `clinical` and `outside`
- only clinical items enter the dispense queue
- assistant and doctor dispense flows now align with inventory deduction and workflow completion
- patient history is recorded structurally through encounters, timeline events, narrative history notes, and long-term conditions

This document is intended for technical and delivery review. It focuses on what is implemented now, what is stable enough for stakeholder review, and what remains future scope.

---

## 2. Document Control

| Field | Value |
|---|---|
| Document title | MEDSYS Client Specification and Implementation Review |
| Project code | MEDLINK-Version2 |
| Version | 1.0 |
| Date | March 25, 2026 |
| Status | Tech Manager Review Draft |
| Primary audience | Technical manager, delivery leads, implementation stakeholders |
| Basis | Current repository implementation and verified API behavior |

### Version History

| Version | Date | Notes |
|---|---|---|
| 1.0 | March 25, 2026 | Consolidated handover review aligned to implemented backend behavior |

---

## 3. System Overview

MEDSYS currently follows a layered architecture:

1. Frontend application  
   Doctor, assistant, owner, analytics, and support-facing workflows.

2. BFF/API access layer  
   Frontend-facing `/api/*` routes and authenticated browser integration.

3. Core backend API  
   Implemented `/v1/*` business routes for clinical, inventory, auth, user, and audit domains.

4. Persistence and platform services  
   PostgreSQL, Redis-backed queue support, search integration, structured audit logging, and typed validation.

### Main Implemented Backend Domains

- Authentication and session management
- Users and permissions
- Patients, families, guardian handling
- Appointments and visit start
- Consultations and encounters
- Prescriptions and dispense workflow
- Inventory and stock movements
- Clinical terminology lookup
- Analytics and observability
- Audit logs

---

## 4. Core Functional Scope

### 4.1 Authentication and Access Control

Implemented:

- login, refresh, logout, current-user session
- effective permission model using assigned roles plus extra permissions
- multi-role identity with `roles`, `active_role`, and `workflow_profiles`
- authenticated active-role switching through `POST /v1/auth/active-role`
- sensitive action throttling
- doctor, assistant, and owner operational permissions

Important implemented rule:

- frontend should use returned `permissions` for actions, `active_role` for workspace selection, and `workflow_profiles` for role-specific behavior

### 4.2 Patient Management

Implemented:

- patient search and quick selection
- patient summary list, full patient profile, and consultation-centric patient history
- patient creation and update
- guardian-aware patient creation
- family auto-creation and family linking
- patient allergies, conditions, history, timeline, vitals, and bundled family detail in profile

Important implemented rule:

- `dateOfBirth` is canonical; `age` is only a helper/validation aid

### 4.3 Consultation Workflows

Implemented:

- one workflow endpoint: `POST /v1/consultations/save`
- `workflowType = appointment`
- `workflowType = walk_in`
- `patientId` for existing patients
- `patientDraft` for inline quick-create
- `guardianDraft` for real guardian creation when needed
- diagnosis, tests, vitals, allergies, notes, clinical summary, and prescription in one save

### 4.4 Prescription and Dispense

Implemented:

- prescription creation within consultation save
- `source = clinical` and `source = outside`
- pending dispense queue
- doctor direct dispense
- assistant queue-based dispense
- stock deduction and inventory movement creation
- inventory search for unresolved clinical dispense items

### 4.5 Clinical Lookup

Implemented:

- diagnosis autocomplete
- medical test autocomplete
- recommended tests by diagnosis
- provider-backed terminology integration through backend

Important implemented rule:

- diagnoses and tests are separate datasets
- lab and observation search is implemented
- imaging and procedure catalogs are future scope

---

## 5. Workflow Model

## 5.1 Appointment Mode

Entry pattern:

- patient already exists
- appointment already exists
- doctor opens from queue

Backend behavior:

- validates appointment and patient match
- creates consultation encounter
- stores vitals, diagnoses, tests, allergies, history, and prescription
- if no clinical prescription items exist, workflow can complete immediately
- if clinical items exist and not directly dispensed, workflow stays doctor-finished until dispense is completed

Operational result:

- appointment mode supports assistant handoff after doctor save

## 5.2 Walk-In Mode

Entry pattern:

- no appointment required
- doctor searches patient
- if not found, doctor quick-creates inline using `patientDraft`

Backend behavior:

- resolves existing patient or creates a new one
- reuses or creates visit context
- creates encounter and related clinical data
- creates timeline event and optional history entry
- promotes flagged chronic diagnoses into patient conditions

Important implemented conflict rule:

- if an active walk-in consultation already exists for the patient, backend returns `409 Conflict` with a clear message instead of failing generically

## 5.3 Prescription Source Logic

Operational split:

- `clinical`
  - affects workflow completion
  - creates pending dispense queue if not directly dispensed
  - requires inventory resolution
- `outside`
  - remains in prescription print/history
  - does not create dispense queue
  - does not block workflow completion

This is one of the key workflow-hardening changes in the current implementation.

---

## 6. API Integration Model

### Key Implemented Endpoints

| Area | Endpoint |
|---|---|
| Auth | `/v1/auth/login`, `/v1/auth/refresh`, `/v1/auth/me`, `/v1/auth/logout` |
| Auth role switch | `/v1/auth/active-role` |
| Patient search | `/v1/search/patients` |
| Patients | `/v1/patients`, `/v1/patients/:id/profile`, `/v1/patients/:id/consultations` |
| Families | `/v1/families` |
| Appointments | `/v1/appointments` |
| Visit start | `/v1/visits/start` |
| Consultation workflow | `/v1/consultations/save` |
| Encounters | `/v1/encounters` |
| Prescriptions | `/v1/prescriptions`, `/v1/prescriptions/:id/dispense` |
| Dispense queue | `/v1/prescriptions/queue/pending-dispense` |
| Inventory | `/v1/inventory`, `/v1/inventory/search` |
| Clinical lookup | `/v1/clinical/diagnoses`, `/v1/clinical/tests`, `/v1/clinical/diagnoses/:code/recommended-tests` |
| Analytics | `/v1/analytics/overview`, `/v1/analytics/dashboard` |
| Audit | `/v1/audit/logs` |

### Frontend Contract Direction

Frontend should treat these as the primary patterns:

- Diagnosis field = diagnoses only
- Medical Tests field = test catalog only
- Selected diagnosis = can request suggested tests below
- Consultation save = one workflow payload, not many independent save steps
- Dispense completion = requires real `inventoryItemId` selection for clinical items

### Analytics Dashboard Handover

Preferred analytics endpoint for new dashboards:

- `GET /v1/analytics/dashboard`

Recommended query usage:

- doctor workspace: call without `role`; backend resolves doctor context automatically
- assistant workspace: call without `role`; backend resolves assistant context automatically
- owner workspace: call without `role` for organization-wide dashboard
- owner drill-down: use `role=doctor&doctorId=...` or `role=assistant&assistantId=...`
- custom date range: use `range=custom&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`

Stable top-level response shape:

```json
{
  "roleContext": {},
  "generatedAt": "2026-04-03T12:00:00.000Z",
  "range": {},
  "summary": {},
  "charts": {},
  "insights": [],
  "tables": {},
  "alerts": []
}
```

Frontend expectations:

- `summary`, `charts`, and `tables` are role-specific block containers
- `insights` should be rendered as short action-oriented callouts
- `alerts` should be rendered with warning/error emphasis
- `roleContext.resolvedRole` decides which dashboard layout to mount
- `generatedAt` and `range` should be shown in dashboard header/export metadata

Timing fields now available for queue and consultation analytics:

- `appointments.registered_at`
- `appointments.waiting_at`
- `appointments.in_consultation_at`
- `appointments.completed_at`
- `encounters.closed_at`

Use these timing fields for frontend analytics and drill-down displays instead of inferring durations from generic `created_at` or `updated_at`.

---

## 7. Error Handling Contract

The backend now exposes clearer frontend-facing behavior around common failure modes.

### Important Current Error Cases

| Endpoint | Status | Meaning |
|---|---:|---|
| `/v1/consultations/save` | 400 | Validation/input issue |
| `/v1/consultations/save` | 404 | Patient, appointment, or guardian not found |
| `/v1/consultations/save` | 409 | Active walk-in conflict or appointment/patient mismatch |
| `/v1/prescriptions/:id/dispense` | 400 | Missing or invalid dispense item payload |
| `/v1/prescriptions/:id/dispense` | 404 | Prescription or inventory item not found |
| `/v1/prescriptions/:id/dispense` | 409 | Prescription already dispensed or insufficient stock |
| `/v1/prescriptions/:id/dispense` | 429 | Sensitive action rate limit exceeded |
| `/v1/clinical/tests` | 503 | Upstream terminology provider unavailable |

### Important Implemented Conflict Message

```json
{
  "message": "Active walk-in consultation already exists for this patient. Complete or dispense the current consultation before starting a new one."
}
```

This is important for frontend and operational workflows because it prevents duplicate active walk-in consultations.

---

## 8. Current Implementation Status

### Implemented and Verified

- consultation workflow endpoint
- appointment and walk-in branching
- guardian linking and guardian draft creation
- patient timeline and history integration
- diagnosis persistence into patient conditions
- patient profile now includes bundled family detail and patient consultation history can be loaded encounter-first from one endpoint
- terminology lookup endpoints
- noisy medical-test result filtering
- pending dispense queue enrichment
- inventory search for assistant stock matching
- doctor-sensitive dispense permission alignment
- source-aware prescription workflow
- walk-in conflict handling with clean `409`
- Swagger request and error response documentation

### Verification Status

Current verified state:

- `npm run typecheck` passing
- `npm run test --workspace @medsys/api` passing
- 86 API tests passing at the time of this document

---

## 9. Non-Functional and Operational Notes

### Strengths

- typed validation across API boundaries
- transaction-based save flows for critical clinical operations
- permission-driven enforcement
- audit logging support
- cache invalidation support for queue/profile flows
- structured integration patterns for frontend

### Current Practical Readiness

Ready for:

- controlled internal clinic deployment
- technical stakeholder review
- frontend/backend coordination
- QA and UAT planning
- workflow-based operational rollout

Not yet complete for:

- imaging/procedure catalog integration
- advanced external lab integration
- full compliance certification programs
- enterprise-grade patient self-service
- broader interoperability programs

---

## 10. Known Limitations and Future Scope

### Current Known Gaps

- imaging and procedures are not yet part of the main clinical test catalog
- prescription items do not yet persist inventory linkage at item-create time
- outside items are intentionally excluded from internal dispense workflow
- advanced clinical decision support remains limited
- compliance maturity is operationally helpful but not certification-ready

### Recommended Next Steps

1. Add imaging/procedure terminology endpoint separate from lab tests.
2. Add stronger stock-item linkage at prescription item creation time where possible.
3. Continue improving audit/compliance reporting depth.
4. Extend manager-facing analytics and export contracts.
5. Add clearer frontend retry/recovery UX around conflict and provider-unavailable cases.

---

## 11. Handover Recommendation

For technical manager review, the most important achievements so far are:

- backend workflow consolidation around consultation save
- practical doctor UX reduction from many steps to one final save
- proper appointment vs walk-in lifecycle separation
- source-based prescription workflow
- assistant queue and inventory resolution alignment
- clearer frontend error contract and Swagger accuracy

Recommended manager review focus:

1. Validate the workflow model against real clinic operations.
2. Confirm the current status names and handoff stages fit business language.
3. Review remaining terminology/integration scope for imaging and external systems.
4. Approve the current API contract as the baseline for frontend completion.

---

## 12. Supporting Documents

- `docs/MEDSYS_Backend_Client_Specification.html`
- `docs/MEDSYS_Backend_Client_Specification.pdf`
- `docs/MEDSYS_Backend_Developer_Tracker.html`
- `docs/MEDSYS_Backend_Developer_Tracker.pdf`
- `docs/CONSULTATION_WORKFLOW.md`

---

## 13. Final Note

This document is intentionally aligned to implemented backend behavior rather than idealized future-state language. It is suitable as a technical handover/review draft for management and delivery discussion.
