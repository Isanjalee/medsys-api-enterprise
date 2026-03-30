# MEDSYS API Enterprise Backend

Enterprise-ready healthcare backend scaffold aligned to frontend flows in:
- `DoctorSection.tsx`
- `PatientSection.tsx`
- `AssistantSection.tsx`
- `patientProfiles.ts`
- `diagnosisMapping.ts`

## Stack
- Node.js 20 + TypeScript
- Fastify (JWT, rate limit, OpenAPI)
- PostgreSQL 16 + Flyway migrations
- Drizzle ORM for type-safe queries
- Redis + OpenSearch + PgBouncer (local compose)
- Turborepo monorepo layout

## Monorepo layout
```text
/apps
  /api
  /worker
/packages
  /config
  /db
  /types
  /validation
/infra
  /docker
  /flyway
  /terraform
```

## Quick start
1. Copy `.env.example` to `.env` and set JWT RSA keys.
2. Start local dependencies:
```bash
docker compose -f infra/docker/docker-compose.yml up -d
```
Database web UI:
```text
http://localhost:8081
system: PostgreSQL
server: postgres
username: medsys
password: medsys
database: medsys
```
3. Install dependencies:
```bash
npm install
```
4. Run database migrations:
```bash
npm run db:migrate
```
Optional migration status:
```bash
npm run db:info
```
5. Run API:
```bash
npm run dev
```
6. Run worker (for async audit queue consumption):
```bash
npm run dev -w @medsys/worker
```

## Baseline seeded users
- Organization: `11111111-1111-1111-1111-111111111111`
- Owner: `owner@medsys.local`
- Doctor: `doctor@medsys.local`
- Assistant: `assistant@medsys.local`
- Password: `ChangeMe123!`

## API (v1)
- `/v1/auth/login`, `/v1/auth/refresh`, `/v1/auth/logout`, `/v1/auth/register`, `/v1/auth/me`, `/v1/auth/status`
- `/v1/users`
- `/v1/clinical/icd10`
- `/v1/clinical/diagnoses`, `/v1/clinical/tests`, `/v1/clinical/diagnoses/:code/recommended-tests`
- `/v1/search/patients`
- `/v1/patients`, `/v1/patients/:id`, `/v1/patients/:id/history`, `/v1/patients/:id/profile`
- `/v1/patients/:id/family`, `/v1/patients/:id/allergies`, `/v1/patients/:id/conditions`
- `/v1/patients/:id/vitals`, `/v1/patients/:id/timeline`
- `/v1/families`
- `/v1/appointments`, `/v1/appointments/:id`
- `/v1/visits/start`
- `/v1/consultations/save`
- `/v1/encounters`, `/v1/encounters/:id/diagnoses`, `/v1/encounters/:id/tests`
- `/v1/prescriptions`, `/v1/prescriptions/:id`, `/v1/prescriptions/:id/dispense`
- `/v1/prescriptions/queue/pending-dispense`
- `/v1/inventory`, `/v1/inventory/:id/movements`
- `/v1/analytics/overview`
- `/v1/analytics/cache`
- `/v1/analytics/observability`
- `/v1/audit/logs`
- `/metrics`

## Patient API behavior
- `GET /v1/patients` returns a summary list for browsing:
  - `id`, `name`, `date_of_birth`, `patient_code`, `phone`, `address`, `created_at`, `family_id`, `guardian_patient_id`
- `GET /v1/search/patients` is the doctor-facing lookup by code/NIC/guardian NIC/phone/name:
  - searches by patient name, patient code, patient NIC, phone, guardian name, guardian NIC, and guardian phone
  - returns quick-selection fields: `patient_code`, `nic`, `guardian_nic`, `date_of_birth`, `gender`
- `GET /v1/patients/:id/profile` returns the full patient details record:
  - includes identity and guardian fields such as `nic`, `age`, `gender`, `guardian_patient_id`, `guardian_nic`, `guardian_phone`, and `guardian_relationship`
- Patient creation and update support guardian-aware fields:
  - `familyId`, `familyCode`, `guardianPatientId`, `guardianName`, `guardianNic`, `guardianPhone`, `guardianRelationship`
- Patient creation supports profile enrichment fields in both payload styles:
  - `bloodGroup`
  - `allergies` with `allergyName`, `severity`, and `isActive`
- If `familyId` and `familyCode` are both missing on patient create:
  - backend auto-creates a family using the patient name, such as `Nimal Perera Family`
- For minors without a patient NIC, guardian details are required:
  - either link an existing guardian patient or provide guardian name plus guardian NIC or phone
- Allowed allergy severity values are:
  - `low`, `moderate`, `high`
- `priority` is an appointment field, not a patient field:
  - send it to `POST /v1/appointments`, not `POST /v1/patients`
- Vitals API uses a typed clinical payload, not generic `name/value` rows:
  - `bpSystolic`, `bpDiastolic`, `heartRate`, `temperatureC`, `spo2`, `recordedAt`
- `POST /v1/patients/:id/vitals` requires at least one actual measurement field
- `PATCH /v1/patients/:id/vitals/:vitalId` supports correcting a saved vitals row
- `DELETE /v1/patients/:id/vitals/:vitalId` soft-deletes a mistaken vitals row
- `encounterId` on vitals is optional, but if provided it must belong to the same patient
- `POST /v1/encounters` can now accept an optional `vitals` block:
  - backend creates the encounter and initial vitals in one workflow
  - if `vitals.recordedAt` is omitted, backend defaults it to `checkedAt`
- `POST /v1/consultations/save` is the doctor-facing orchestration route:
  - `workflowType` supports `walk_in` and `appointment`
  - `appointment` mode requires `appointmentId` plus `patientId`
  - `walk_in` mode accepts `patientId` or `patientDraft`
  - optional `dispense.mode` supports `assistant_queue` and `doctor_direct`
  - send `patientId` for an existing patient or `patientDraft` for a quick-created patient
  - backend creates or resolves the patient, reuses or creates the visit, saves the encounter, and optionally persists diagnoses, tests, vitals, prescription items, and allergies
  - backend always creates a patient timeline event for the completed consultation
  - `clinicalSummary` optionally writes a narrative entry to patient history
  - diagnosis rows with `persistAsCondition: true` are also stored in long-term patient conditions
  - `guardianDraft` can be sent for minor flows when frontend wants backend to create a real guardian patient and family linkage in the same save
  - prescription items are operationally split by `source`:
    - `clinical` items drive dispense queue and completion state
    - `outside` items stay on prescription print/history only
  - response now includes `workflow_type`, `appointment_id`, `workflow_status`, `dispense_status`, `doctor_direct_dispense`, `clinical_item_count`, and `outside_item_count`
- `GET /v1/appointments?status=waiting` now returns the waiting queue in backend-controlled FIFO order and includes `queuePosition` for explicit queue numbering
- `GET /v1/prescriptions/queue/pending-dispense` now returns an assistant-facing queue payload with patient context, diagnosis summary, and only clinic-dispensable prescription items
- `GET /v1/inventory/search?q=...&category=medicine` supports assistant stock matching when queue items still need inventory resolution before dispense
- `GET /v1/clinical/diagnoses` is the normalized diagnosis lookup endpoint:
  - returns `{ code, codeSystem, display }` objects for frontend autocomplete
- `GET /v1/clinical/tests` is the normalized clinical test lookup endpoint:
  - returns `{ code, codeSystem, display, category }` objects for frontend autocomplete
  - uses provider-backed terminology search via `LOINC_API_BASE_URL`; default is the public NLM Clinical Tables LOINC search endpoint
  - intended for lab tests and clinical observations, not as the final source for imaging procedures such as X-ray, CT, MRI, or ultrasound
- `GET /v1/clinical/diagnoses/:code/recommended-tests` returns curated backend-owned recommended tests for a selected diagnosis code
- `patientDraft` follows the frontend patient payload style:
  - minimum fields are `name` and `dateOfBirth`
  - use `dateOfBirth` as the canonical identity field; `age` is optional validation help only
- For minors without a patient NIC inside `patientDraft`:
  - send `guardianName` and either `guardianNic` or `guardianPhone`
  - if `guardianNic` already matches an existing patient, backend auto-links `guardianPatientId` and inherits the guardian family when possible

## Doctor-only clinic mode workflow
For clinics operating without an assistant, the doctor workflow natively supports end-to-end administration:
1. Doctor searches patient using `GET /v1/search/patients`.
2. If found, frontend sends `POST /v1/consultations/save` with `patientId`.
3. If not found, frontend keeps the doctor on the same screen and sends `POST /v1/consultations/save` with `patientDraft`.
4. Backend creates or resolves the patient, reuses an active `waiting` or `in_consultation` visit when present, otherwise creates a new walk-in visit, then saves the clinical encounter atomically.
5. The same workflow request can include initial vitals, allergies, diagnoses, tests, notes, and prescription items.
6. Doctor optionally completes the dispense workflow directly if `prescription.dispense` is granted.

## Dual clinic workflow support
- Small-clinic walk-in mode:
  - doctor searches patient first
  - if found, call `POST /v1/consultations/save` with `patientId`
  - if not found, call `POST /v1/consultations/save` with `patientDraft`
  - backend reuses or creates the live visit record and persists the encounter in one transaction
  - if an active walk-in consultation with an encounter already exists, backend now returns `409` with a clear conflict message instead of failing at the DB layer
- Appointment-first center mode:
  - assistant or scheduling flow creates appointment via `POST /v1/appointments`
  - doctor works from the waiting queue
  - when saving clinical work, frontend can use `POST /v1/consultations/save` for the one-button doctor workflow or keep the resource-level visit plus encounter sequence where needed
- `POST /v1/appointments`, `POST /v1/visits/start`, and `POST /v1/encounters` remain valid resource-level routes; `POST /v1/consultations/save` is the new doctor-facing orchestration route.


## Clinical transaction guarantees
- Patient profile update is atomic:
  - `PATCH /v1/patients/:id` rolls back patient, family, and allergy changes together if any part fails
- Patient summary responses remain stable:
  - `/v1/patients` uses snake_case fields such as `patient_code`, `family_id`, `guardian_patient_id`, and `created_at`
- Encounter bundle save is atomic:
  - encounter + diagnoses + tests + prescription + items + appointment status update
- Consultation workflow save is atomic:
  - patient resolve or create + family or guardian mapping + visit reuse or create + encounter + diagnoses + optional long-term conditions + tests + vitals + prescription + allergies + timeline event + optional patient history note + appointment status update
- Dispense is atomic:
  - dispense record + stock deduction + inventory movements

## Security baseline
- JWT access + refresh rotation
- Refresh-token replay detection with family revocation
- Role-based access checks (`owner`, `doctor`, `assistant`)
- explicit `doctor_workflow_mode` identity for doctor accounts (`self_service` or `clinic_supported`)
- Request ID correlation via `x-request-id`
- Rate limiting:
  - login: 5/min
  - default authenticated routes: 100/min
- brute-force login lockout
- per-role sensitive action throttles
- PHI-safe structured logging with scrubbed request/error payloads
- optional Sentry capture via `SENTRY_DSN`

## Notes
- `npm run db:migrate`, `npm run db:validate`, and `npm run db:info` use Dockerized Flyway by default.
- Override Flyway connection details with `FLYWAY_URL`, `FLYWAY_USER`, `FLYWAY_PASSWORD`, `FLYWAY_IMAGE`, or `FLYWAY_LOCATIONS` when needed.
- Audit logging now supports async queue mode via Redis:
  - `AUDIT_TRANSPORT=auto|direct|redis`
  - `auto` uses Redis queue if `REDIS_URL` is set, otherwise direct DB write.
  - API falls back to direct DB write if queue publish fails.
  - Worker retries failed events using `AUDIT_MAX_RETRIES` and `AUDIT_RETRY_BASE_DELAY_MS`.
  - Retry messages use `AUDIT_RETRY_QUEUE_KEY` or default to `${AUDIT_QUEUE_KEY}:retry`.
  - Dead-lettered events use `AUDIT_DLQ_KEY` or default to `${AUDIT_QUEUE_KEY}:dlq`.
- `audit_logs` is partitioned monthly in `V1__init.sql`.
- `appointments` is partitioned monthly by `scheduled_at` in `V4__partition_appointments.sql`.
- Keep future `appointments` partitions warm with [infra/flyway/scripts/maintain_appointments_partitions.sql](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/infra/flyway/scripts/maintain_appointments_partitions.sql).
- `app.db` and `app.readDb` are pinned to `DATABASE_URL` for writes and operational reads; analytics/reporting routes use `app.analyticsDb`, which targets `DATABASE_READ_URL` when configured.
- Migration validation now runs in CI via [flyway-validate.yml](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/.github/workflows/flyway-validate.yml).
- Consolidated client-facing backend documentation is maintained in [docs/MEDSYS_Backend_Client_Specification.html](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/MEDSYS_Backend_Client_Specification.html) and [docs/MEDSYS_Backend_Client_Specification.pdf](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/MEDSYS_Backend_Client_Specification.pdf).
- The editable doctor workflow handoff is maintained in [docs/CONSULTATION_WORKFLOW.md](d:/Projects/MEDLINK/Medsys-Backend-git/medsys-api-enterprise/docs/CONSULTATION_WORKFLOW.md).
- `patient_history_entries` is introduced in `V5__add_patient_history.sql` for note-based patient history separate from timeline events.
- ICD-10 suggestions are served by `/v1/clinical/icd10`, which currently adapts the NLM Clinical Tables ICD-10-CM API via `ICD10_API_BASE_URL`.
- Clinical test suggestions are served by `/v1/clinical/tests`, which currently adapts a provider-backed LOINC search via `LOINC_API_BASE_URL`; the default configuration uses the public NLM Clinical Tables LOINC endpoint.
- Patient search supports OpenSearch-backed fuzzy lookup when `OPENSEARCH_URL` is configured; otherwise it falls back to DB search.
- Cache stats are available via `/v1/analytics/cache` for the `appointmentQueue` and `patientProfile` namespaces.
- Observability snapshots are available via `/v1/analytics/observability`.
- Prometheus-style request metrics are available via `/metrics`.
- Login lockout uses `AUTH_LOGIN_MAX_ATTEMPTS` and `AUTH_LOGIN_LOCKOUT_SECONDS`; sensitive throttles use `SECURITY_SENSITIVE_WINDOW_SECONDS`.
- Consolidated developer-facing implementation and roadmap tracking is maintained in [docs/MEDSYS_Backend_Developer_Tracker.html](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/MEDSYS_Backend_Developer_Tracker.html) and [docs/MEDSYS_Backend_Developer_Tracker.pdf](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/MEDSYS_Backend_Developer_Tracker.pdf).
- CI now runs DB-backed backend smoke coverage via [backend-ci.yml](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/.github/workflows/backend-ci.yml).
