-- Patient self-service portal. Patients are a GLOBAL identity (not org-scoped):
-- they sign up themselves, then link to one or more clinics. Linking creates a
-- per-clinic patient record flagged self_registered (pending clinic verification);
-- it never auto-merges into an existing chart. Documents flow patient -> doctor.

-- Global patient accounts (own login, separate from staff `users`).
CREATE TABLE IF NOT EXISTS patient_accounts (
  id BIGSERIAL PRIMARY KEY,
  uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone VARCHAR(30),
  first_name VARCHAR(80),
  last_name VARCHAR(80),
  dob DATE,
  gender VARCHAR(10),
  nic VARCHAR(20),
  address TEXT,
  blood_group VARCHAR(5),
  allergies JSONB NOT NULL DEFAULT '[]'::jsonb,
  profile_completed BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Refresh-token rotation/replay tracking for patient accounts (no organization).
CREATE TABLE IF NOT EXISTS patient_refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  token_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_token_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replay_detected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_refresh_tokens_account_idx ON patient_refresh_tokens (patient_account_id);
CREATE INDEX IF NOT EXISTS patient_refresh_tokens_family_idx ON patient_refresh_tokens (family_id);

-- Flag clinic records that originated from patient self-registration so staff can
-- tell them apart from verified charts and later verify/merge them.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS self_registered BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per (patient account, doctor) link. Each link owns exactly one clinic
-- patient record (patient_id) in that doctor's organization.
CREATE TABLE IF NOT EXISTS patient_doctor_links (
  id BIGSERIAL PRIMARY KEY,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_user_id BIGINT NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'self_registered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_doctor_links_status_check CHECK (status IN ('self_registered', 'verified')),
  CONSTRAINT patient_doctor_links_unique UNIQUE (patient_account_id, doctor_user_id)
);
CREATE INDEX IF NOT EXISTS patient_doctor_links_account_idx ON patient_doctor_links (patient_account_id);
CREATE INDEX IF NOT EXISTS patient_doctor_links_patient_idx ON patient_doctor_links (patient_id);
CREATE INDEX IF NOT EXISTS patient_doctor_links_doctor_idx ON patient_doctor_links (doctor_user_id);

-- Documents uploaded by a patient and shared to a specific doctor; bytes live in S3.
CREATE TABLE IF NOT EXISTS patient_documents (
  id BIGSERIAL PRIMARY KEY,
  uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  doctor_user_id BIGINT NOT NULL REFERENCES users(id),
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  s3_key TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'shared',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_documents_patient_idx ON patient_documents (organization_id, patient_id);
CREATE INDEX IF NOT EXISTS patient_documents_account_idx ON patient_documents (patient_account_id);
CREATE INDEX IF NOT EXISTS patient_documents_doctor_idx ON patient_documents (doctor_user_id);
