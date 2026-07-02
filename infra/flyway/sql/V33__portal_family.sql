-- Patient-portal families: a public account can name a family and add members
-- (spouse, children, parents…) with their own profile fields. Members are shared to
-- doctors as clinic patients grouped under the family, and history aggregates across them.

ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS family_name VARCHAR(120);

CREATE TABLE IF NOT EXISTS patient_account_members (
  id BIGSERIAL PRIMARY KEY,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  dob DATE,
  gender VARCHAR(10),
  nic VARCHAR(30),
  phone VARCHAR(30),
  blood_group VARCHAR(8),
  -- Family role: father, mother, son, daughter, sister, brother, grandfather, etc.
  relationship VARCHAR(40) NOT NULL,
  allergies JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patient_account_members_account_idx
  ON patient_account_members (patient_account_id);
