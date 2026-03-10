# Not-Implemented Roadmap

This is the execution plan for all pending backend work after the current MVP.

## How to use this file
- Work top-to-bottom.
- Do not start a lower phase before finishing the `Exit criteria` of the current phase.
- Mark each task as done when merged.

## Active Parallel Track: Frontend Contract Alignment (Priority: P0)
Target: 1-2 weeks
Status: In progress

This track runs in parallel with the backend phases because the current frontend BFF contract does not yet align with the implemented `/v1/...` backend API.

### Tasks
- [x] Produce frontend-backend gap analysis.
- [x] Produce route-by-route contract mapping for auth and patient flows.
- [x] Produce permission-string to backend-role mapping.
- [ ] Decide whether the Next.js BFF contract is the browser-facing source of truth.
- [x] Decide that patient `history` is a new backend resource, not a timeline alias.
- [x] Add backend `GET /v1/auth/me`.
- [x] Add backend `GET /v1/auth/status`.
- [x] Implement backend `POST /v1/auth/register` with bootstrap-owner behavior and owner-controlled post-bootstrap registration.
- [x] Add backend `DELETE /v1/patients/:id`.
- [x] Add backend patient history endpoints:
  - [x] `GET /v1/patients/:id/history`
  - [x] `POST /v1/patients/:id/history`
- [x] Add backend users endpoints:
  - [x] `GET /v1/users`
  - [x] `POST /v1/users`
- [x] Add backend `GET /v1/clinical/icd10`.
- [ ] Normalize response and validation handling at the BFF layer for mismatched backend shapes.

### Deliverables
- `docs/frontend-backend-gap-analysis.md`
- `docs/frontend-backend-contract-mapping.md`
- `docs/authorization-permission-mapping.md`

### Exit criteria
- Frontend auth flow works end-to-end against the backend.
- Frontend patient list/get/update flows work without contract drift.
- Ownership of validation, response normalization, and session profile shape is explicitly documented.

---

## Phase 1: Data Platform Hardening (Priority: P0)
Target: 1 week
Status: Complete

Phase 1 is complete. Verification evidence is recorded in [phase1-verification.md](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase1-verification.md).

### Tasks
- [x] Add monthly partitioning for `appointments` with a safe FK strategy.
- [x] Add partition maintenance SQL script (create next 3 months partitions).
- [x] Add read/write DB connection policy:
  - writes -> primary DB only
  - analytics/reporting reads -> replica
- [x] Add DB migration CI check (`flyway validate` in pipeline).
- [x] Add rollback playbook for Flyway migrations.

### Deliverables
- New Flyway migrations (`V3+`) for partitioning + maintenance function.
- Updated DB docs in README.

### Exit criteria
- [x] `appointments` partition pruning confirmed with `EXPLAIN`.
- [x] Existing clinical writes still pass.
- [x] Migration and rollback tested on staging snapshot.

---

## Phase 2: Async Audit Pipeline (Priority: P0)
Target: 1 week
Status: Complete

Phase 2 is complete. Verification evidence is recorded in [phase2-verification.md](/d:/Projects/MEDLINK/medsys-api-enterprise/medsys-api-enterprise/docs/phase2-verification.md).

### Tasks
- [x] Replace synchronous audit DB writes with async producer path:
  - API publishes audit event
  - Worker consumes and writes to `audit_logs`
- [x] Add retry + dead-letter logic for failed audit events.
- [x] Keep fallback mode: direct DB write when queue unavailable.
- [x] Add request-id + actor metadata contract for audit event payload.

### Deliverables
- Queue adapter interface in API.
- Worker consumer implementation.
- Audit pipeline integration test.

### Exit criteria
- [x] Clinical request latency unaffected by audit write load.
- [x] No audit loss in retry test.

---

## Phase 3: Search + Caching (Priority: P1)
Target: 2 weeks

### Tasks
- [ ] Add OpenSearch index models for:
  - patients (name/NIC/phone)
  - diagnoses
- [ ] Implement index sync on create/update flows.
- [ ] Add `/v1/search/patients` endpoint (fuzzy + pagination).
- [ ] Add Redis caching for:
  - appointment queue
  - patient profile hot reads
- [ ] Add cache invalidation on writes.

### Deliverables
- Search endpoints and index mappings.
- Cache service module + invalidation hooks.

### Exit criteria
- Fuzzy patient search under target latency.
- Cache hit-rate dashboard available.

---

## Phase 4: Observability + Security Hardening (Priority: P0)
Target: 2 weeks

### Tasks
- [ ] Add OpenTelemetry instrumentation (HTTP + DB spans).
- [ ] Export metrics for latency/error/rate.
- [ ] Add Sentry error tracking with PHI scrubbing.
- [ ] Enforce PHI-safe structured logging for all routes.
- [ ] Add refresh-token replay detection and token family revocation.
- [ ] Add stricter auth controls:
  - brute-force lockout strategy
  - per-role sensitive endpoint limits
- [ ] Add backup encryption and restore drill runbook.

### Deliverables
- Tracing/metrics dashboards.
- Security hardening doc.

### Exit criteria
- Can trace one clinical request end-to-end by request-id.
- PHI leak checks pass in logs.

---

## Phase 5: Test Coverage Upgrade (Priority: P0)
Target: 1 week

### Tasks
- [ ] Add integration tests for critical clinical flows:
  - appointment -> encounter bundle -> prescription
  - prescription -> dispense -> inventory movement
  - role-based access deny/allow matrix
- [ ] Add migration smoke test in CI.
- [ ] Add seed data validity test.

### Deliverables
- New `apps/api/test` suites with DB-backed test setup.

### Exit criteria
- All critical flows tested in CI.
- No release without integration test pass.

---

## Phase 6: Infrastructure Completion (Priority: P1)
Target: 2-3 weeks

### Tasks
- [ ] Expand Terraform to provision:
  - VPC/networking basics
  - ECS service for API + worker
  - Aurora PostgreSQL (primary + replica)
  - ElastiCache Redis
  - SQS queues (+ DLQ)
  - OpenSearch domain
  - CloudWatch log groups/alarms
- [ ] Add blue/green deployment pipeline.
- [ ] Add environment promotion plan (dev -> staging -> prod).

### Deliverables
- Full IaC modules and environment tfvars.
- CI/CD deployment workflow docs.

### Exit criteria
- One-click deploy to staging.
- Rolling/blue-green release verified without downtime.

---

## Phase 7: Compliance and Resilience (Priority: P1)
Target: 1-2 weeks

### Tasks
- [ ] HIPAA/PDPA control checklist mapping.
- [ ] Secrets rotation automation.
- [ ] Pen-test and remediation backlog.
- [ ] RTO/RPO definition + disaster recovery drill.

### Deliverables
- Compliance report + remediation register.

### Exit criteria
- Controls documented and test evidence captured.

---

## Weekly execution sequence (recommended)
1. Week 1: Phase 1
2. Week 2: Phase 2 + Phase 5
3. Week 3-4: Phase 3 + Phase 4
4. Week 5-6: Phase 6
5. Week 7: Phase 7

---

## Quick reminders (do not skip)
- Never merge schema changes without migration + rollback note.
- Every sensitive clinical action must remain auditable.
- Do not add features without integration tests for clinical risk paths.
