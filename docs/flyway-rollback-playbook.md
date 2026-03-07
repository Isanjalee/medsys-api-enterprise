# Flyway Rollback Playbook

This project uses forward-only Flyway migrations. If a schema release must be rolled back, use this playbook instead of editing applied migrations.

## Scope

Phase 1 introduces `V4__partition_appointments.sql`, which converts `appointments` into a monthly partitioned table and changes `encounters` to reference `(appointment_id, appointment_scheduled_at)`.

## Before rollback

1. Stop API and worker writes.
2. Take a fresh PostgreSQL backup or snapshot.
3. Record row counts for:
   - `appointments`
   - `encounters`
4. Confirm no appointment writes are in flight.

## Rollback steps for `V4__partition_appointments.sql`

Run inside a transaction window during maintenance:

```sql
ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_appointment_id_fkey;

CREATE TABLE appointments_heap (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_id BIGINT NULL REFERENCES users(id),
  assistant_id BIGINT NULL REFERENCES users(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status appointment_status NOT NULL,
  reason TEXT NULL,
  priority priority_level NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX appointments_status_scheduled_idx ON appointments_heap (status, scheduled_at);
CREATE INDEX appointments_patient_idx ON appointments_heap (patient_id);
CREATE INDEX appointments_org_scheduled_idx ON appointments_heap (organization_id, scheduled_at);

INSERT INTO appointments_heap (
  id,
  organization_id,
  patient_id,
  doctor_id,
  assistant_id,
  scheduled_at,
  status,
  reason,
  priority,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  id,
  organization_id,
  patient_id,
  doctor_id,
  assistant_id,
  scheduled_at,
  status,
  reason,
  priority,
  created_at,
  updated_at,
  deleted_at
FROM appointments;

DROP TABLE appointments;
ALTER TABLE appointments_heap RENAME TO appointments;

DROP INDEX IF EXISTS encounters_appointment_fk_idx;
ALTER TABLE encounters DROP COLUMN IF EXISTS appointment_scheduled_at;

ALTER TABLE encounters
  ADD CONSTRAINT encounters_appointment_id_fkey
  FOREIGN KEY (appointment_id)
  REFERENCES appointments (id);
```

## After rollback

1. Compare row counts against the pre-rollback snapshot.
2. Verify encounter rows still resolve to appointments.
3. Run appointment creation and encounter bundle smoke tests.
4. Restart API and worker only after validation passes.
