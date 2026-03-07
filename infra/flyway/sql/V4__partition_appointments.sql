ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_appointment_id_fkey;

ALTER TABLE appointments RENAME TO appointments_legacy;

DROP INDEX IF EXISTS appointments_status_scheduled_idx;
DROP INDEX IF EXISTS appointments_patient_idx;
DROP INDEX IF EXISTS appointments_org_scheduled_idx;

CREATE SEQUENCE IF NOT EXISTS appointments_partitioned_id_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS appointments (
  id BIGINT NOT NULL DEFAULT nextval('appointments_partitioned_id_seq'),
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
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT appointments_partitioned_pkey PRIMARY KEY (id, scheduled_at)
) PARTITION BY RANGE (scheduled_at);

CREATE INDEX IF NOT EXISTS appointments_id_idx ON appointments (id);
CREATE INDEX IF NOT EXISTS appointments_status_scheduled_idx ON appointments (status, scheduled_at);
CREATE INDEX IF NOT EXISTS appointments_patient_idx ON appointments (patient_id);
CREATE INDEX IF NOT EXISTS appointments_org_scheduled_idx ON appointments (organization_id, scheduled_at);

CREATE TABLE IF NOT EXISTS appointments_default PARTITION OF appointments DEFAULT;

CREATE OR REPLACE FUNCTION create_appointments_partition(target_month DATE)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', target_month)::DATE;
  v_end DATE := (date_trunc('month', target_month) + INTERVAL '1 month')::DATE;
  v_partition_name TEXT := format('appointments_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF appointments FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    v_start,
    v_end
  );
END;
$$;

CREATE OR REPLACE FUNCTION ensure_appointments_partitions(start_month DATE, month_count INTEGER DEFAULT 4)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', COALESCE(start_month, CURRENT_DATE))::DATE;
  v_offset INTEGER;
BEGIN
  IF month_count < 1 THEN
    RAISE EXCEPTION 'month_count must be greater than zero';
  END IF;

  FOR v_offset IN 0..month_count - 1 LOOP
    PERFORM create_appointments_partition((v_start + make_interval(months => v_offset))::DATE);
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_min_month DATE;
  v_max_month DATE;
  v_existing_months INTEGER;
  v_current_month DATE := date_trunc('month', CURRENT_DATE)::DATE;
BEGIN
  SELECT
    date_trunc('month', MIN(scheduled_at))::DATE,
    date_trunc('month', MAX(scheduled_at))::DATE
  INTO v_min_month, v_max_month
  FROM appointments_legacy;

  IF v_min_month IS NOT NULL THEN
    v_existing_months := (
      (EXTRACT(YEAR FROM age(v_max_month, v_min_month)) * 12)
      + EXTRACT(MONTH FROM age(v_max_month, v_min_month))
    )::INTEGER + 1;

    PERFORM ensure_appointments_partitions(v_min_month, v_existing_months);
  END IF;

  PERFORM ensure_appointments_partitions(v_current_month, 4);
END;
$$;

INSERT INTO appointments (
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
FROM appointments_legacy
ORDER BY id;

DO $$
DECLARE
  v_max_id BIGINT;
BEGIN
  SELECT MAX(id) INTO v_max_id FROM appointments;

  IF v_max_id IS NULL THEN
    PERFORM setval('appointments_partitioned_id_seq', 1, false);
  ELSE
    PERFORM setval('appointments_partitioned_id_seq', v_max_id, true);
  END IF;
END;
$$;

ALTER TABLE encounters ADD COLUMN appointment_scheduled_at TIMESTAMPTZ NULL;

UPDATE encounters AS e
SET appointment_scheduled_at = a.scheduled_at
FROM appointments AS a
WHERE a.id = e.appointment_id
  AND e.appointment_scheduled_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM encounters
    WHERE appointment_scheduled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'encounters.appointment_scheduled_at backfill failed';
  END IF;
END;
$$;

ALTER TABLE encounters ALTER COLUMN appointment_scheduled_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS encounters_appointment_fk_idx
  ON encounters (appointment_id, appointment_scheduled_at);

ALTER TABLE encounters
  ADD CONSTRAINT encounters_appointment_id_fkey
  FOREIGN KEY (appointment_id, appointment_scheduled_at)
  REFERENCES appointments (id, scheduled_at)
  ON UPDATE CASCADE;

DROP TABLE appointments_legacy;
