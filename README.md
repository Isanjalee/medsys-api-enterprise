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
- `/v1/search/patients`
- `/v1/patients`, `/v1/patients/:id`, `/v1/patients/:id/history`, `/v1/patients/:id/profile`
- `/v1/patients/:id/family`, `/v1/patients/:id/allergies`, `/v1/patients/:id/conditions`
- `/v1/patients/:id/vitals`, `/v1/patients/:id/timeline`
- `/v1/families`
- `/v1/appointments`, `/v1/appointments/:id`
- `/v1/encounters`, `/v1/encounters/:id/diagnoses`, `/v1/encounters/:id/tests`
- `/v1/prescriptions`, `/v1/prescriptions/:id`, `/v1/prescriptions/:id/dispense`
- `/v1/prescriptions/queue/pending-dispense`
- `/v1/inventory`, `/v1/inventory/:id/movements`
- `/v1/analytics/overview`
- `/v1/analytics/cache`
- `/v1/analytics/observability`
- `/v1/audit/logs`
- `/metrics`

## Clinical transaction guarantees
- Encounter bundle save is atomic:
  - encounter + diagnoses + tests + prescription + items + appointment status update
- Dispense is atomic:
  - dispense record + stock deduction + inventory movements

## Security baseline
- JWT access + refresh rotation
- Refresh-token replay detection with family revocation
- Role-based access checks (`owner`, `doctor`, `assistant`)
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
- Rollback steps for schema releases are documented in [docs/flyway-rollback-playbook.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/flyway-rollback-playbook.md).
- `patient_history_entries` is introduced in `V5__add_patient_history.sql` for note-based patient history separate from timeline events.
- ICD-10 suggestions are served by `/v1/clinical/icd10`, which currently adapts the NLM Clinical Tables ICD-10-CM API via `ICD10_API_BASE_URL`.
- Patient search supports OpenSearch-backed fuzzy lookup when `OPENSEARCH_URL` is configured; otherwise it falls back to DB search.
- Cache stats are available via `/v1/analytics/cache` for the `appointmentQueue` and `patientProfile` namespaces.
- Observability snapshots are available via `/v1/analytics/observability`.
- Prometheus-style request metrics are available via `/metrics`.
- Login lockout uses `AUTH_LOGIN_MAX_ATTEMPTS` and `AUTH_LOGIN_LOCKOUT_SECONDS`; sensitive throttles use `SECURITY_SENSITIVE_WINDOW_SECONDS`.
- Backup encryption and restore drills are documented in [docs/backup-encryption-restore-runbook.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/backup-encryption-restore-runbook.md).
- Phase 4 observability and security verification is recorded in [docs/phase4-verification.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase4-verification.md).
- Phase 5 test coverage verification is recorded in [docs/phase5-verification.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase5-verification.md).
- Security controls are summarized in [docs/security-hardening.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/security-hardening.md).
- Phase 2 audit pipeline verification is recorded in [docs/phase2-verification.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase2-verification.md).
- Phase 3 search and caching verification is recorded in [docs/phase3-verification.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase3-verification.md).
- Pending implementation plan is tracked in [docs/not-implemented-roadmap.md](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/not-implemented-roadmap.md).
- CI now runs DB-backed backend smoke coverage via [backend-ci.yml](d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/.github/workflows/backend-ci.yml).
