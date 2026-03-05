CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('owner', 'doctor', 'assistant');
CREATE TYPE gender AS ENUM ('male', 'female', 'other');
CREATE TYPE allergy_severity AS ENUM ('low', 'moderate', 'high');
CREATE TYPE appointment_status AS ENUM ('waiting', 'in_consultation', 'completed', 'cancelled');
CREATE TYPE priority_level AS ENUM ('low', 'normal', 'high', 'critical');
CREATE TYPE test_order_status AS ENUM ('ordered', 'in_progress', 'completed', 'cancelled');
CREATE TYPE drug_source AS ENUM ('clinical', 'outside');
CREATE TYPE inventory_category AS ENUM ('medicine', 'consumable', 'equipment', 'other');
CREATE TYPE inventory_movement_type AS ENUM ('in', 'out', 'adjustment');

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL,
  password_hash TEXT NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  role user_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  token_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS families (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  family_code VARCHAR(30) NOT NULL UNIQUE,
  family_name VARCHAR(120) NOT NULL,
  assigned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS families_org_assigned_idx ON families (organization_id, assigned);

CREATE TABLE IF NOT EXISTS patients (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  nic VARCHAR(20) NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  full_name VARCHAR(170) GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  dob DATE NULL,
  age SMALLINT NULL,
  gender gender NOT NULL,
  phone VARCHAR(30) NULL,
  address TEXT NULL,
  blood_group VARCHAR(5) NULL,
  family_id BIGINT NULL REFERENCES families(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT patients_org_nic_unique UNIQUE (organization_id, nic)
);
CREATE INDEX IF NOT EXISTS patients_org_full_name_idx ON patients (organization_id, full_name);
CREATE INDEX IF NOT EXISTS patients_org_family_idx ON patients (organization_id, family_id);

CREATE TABLE IF NOT EXISTS family_members (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  family_id BIGINT NOT NULL REFERENCES families(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  relationship VARCHAR(40) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (family_id, patient_id)
);
CREATE INDEX IF NOT EXISTS family_members_org_family_idx ON family_members (organization_id, family_id);

CREATE TABLE IF NOT EXISTS patient_allergies (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  allergy_name VARCHAR(120) NOT NULL,
  severity allergy_severity NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS patient_allergies_patient_idx ON patient_allergies (patient_id);

CREATE TABLE IF NOT EXISTS patient_conditions (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  condition_name VARCHAR(180) NOT NULL,
  icd10_code VARCHAR(16) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS patient_conditions_patient_idx ON patient_conditions (patient_id);

CREATE TABLE IF NOT EXISTS appointments (
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

CREATE INDEX IF NOT EXISTS appointments_status_scheduled_idx ON appointments (status, scheduled_at);
CREATE INDEX IF NOT EXISTS appointments_patient_idx ON appointments (patient_id);
CREATE INDEX IF NOT EXISTS appointments_org_scheduled_idx ON appointments (organization_id, scheduled_at);

CREATE TABLE IF NOT EXISTS encounters (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  appointment_id BIGINT NOT NULL UNIQUE REFERENCES appointments(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_id BIGINT NOT NULL REFERENCES users(id),
  checked_at TIMESTAMPTZ NOT NULL,
  notes TEXT NULL,
  next_visit_date DATE NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS encounters_patient_idx ON encounters (patient_id);

CREATE TABLE IF NOT EXISTS encounter_diagnoses (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  icd10_code VARCHAR(16) NULL,
  diagnosis_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS encounter_diagnoses_encounter_idx ON encounter_diagnoses (encounter_id);

CREATE TABLE IF NOT EXISTS test_orders (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  test_name VARCHAR(180) NOT NULL,
  status test_order_status NOT NULL DEFAULT 'ordered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS test_orders_encounter_idx ON test_orders (encounter_id);

CREATE TABLE IF NOT EXISTS prescriptions (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  encounter_id BIGINT NOT NULL REFERENCES encounters(id),
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS prescriptions_patient_idx ON prescriptions (patient_id);
CREATE INDEX IF NOT EXISTS prescriptions_encounter_idx ON prescriptions (encounter_id);

CREATE TABLE IF NOT EXISTS prescription_items (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  prescription_id BIGINT NOT NULL REFERENCES prescriptions(id),
  drug_name VARCHAR(180) NOT NULL,
  dose VARCHAR(80) NOT NULL,
  frequency VARCHAR(80) NOT NULL,
  duration VARCHAR(80) NULL,
  quantity NUMERIC(12, 2) NOT NULL,
  source drug_source NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS prescription_items_prescription_idx ON prescription_items (prescription_id);

CREATE TABLE IF NOT EXISTS dispense_records (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  prescription_id BIGINT NOT NULL REFERENCES prescriptions(id),
  assistant_id BIGINT NOT NULL REFERENCES users(id),
  dispensed_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed',
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dispense_records_prescription_idx ON dispense_records (prescription_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  sku VARCHAR(80) NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  category inventory_category NOT NULL,
  unit VARCHAR(20) NOT NULL,
  stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS inventory_items_org_name_idx ON inventory_items (organization_id, name);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  movement_type inventory_movement_type NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL,
  reference_type VARCHAR(30) NULL,
  reference_id BIGINT NULL,
  created_by_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (inventory_item_id);

CREATE TABLE IF NOT EXISTS patient_vitals (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  encounter_id BIGINT NULL REFERENCES encounters(id),
  bp_systolic SMALLINT NULL,
  bp_diastolic SMALLINT NULL,
  heart_rate SMALLINT NULL,
  temperature_c NUMERIC(4, 1) NULL,
  spo2 SMALLINT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS patient_vitals_patient_recorded_idx ON patient_vitals (patient_id, recorded_at);

CREATE TABLE IF NOT EXISTS patient_timeline_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  encounter_id BIGINT NULL REFERENCES encounters(id),
  event_date DATE NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NULL,
  event_kind VARCHAR(30) NULL,
  tags TEXT[] NULL,
  value VARCHAR(80) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS patient_timeline_events_patient_date_idx
  ON patient_timeline_events (patient_id, event_date);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL NOT NULL,
  organization_id UUID NOT NULL,
  actor_user_id BIGINT NULL REFERENCES users(id),
  entity_type VARCHAR(60) NOT NULL,
  entity_id BIGINT NULL,
  action VARCHAR(30) NOT NULL,
  ip INET NULL,
  user_agent TEXT NULL,
  request_id UUID NULL,
  payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE TABLE IF NOT EXISTS audit_logs_2026_03 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_04 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
