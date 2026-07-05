-- "Health Sri Lanka": a light public-health self-survey (COVID / Dengue / chronic conditions)
-- that feeds a universal, district-level heat map. Aggregation is by district, so every profile
-- carries a district; each survey stores the device (or profile) location at submission time.

ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS district VARCHAR(40);
ALTER TABLE patient_account_members ADD COLUMN IF NOT EXISTS district VARCHAR(40);

CREATE TABLE IF NOT EXISTS patient_health_surveys (
  id BIGSERIAL PRIMARY KEY,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  -- null = the account holder ("self"); otherwise one of their family members.
  member_id BIGINT REFERENCES patient_account_members(id),
  district VARCHAR(40) NOT NULL,
  had_covid BOOLEAN NOT NULL DEFAULT false,
  had_dengue BOOLEAN NOT NULL DEFAULT false,
  -- e.g. ["sugar","cholesterol","pressure","arthritis"] — extensible.
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Where the device actually was at submission (null = not captured; falls back to district only).
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patient_health_surveys_district_idx ON patient_health_surveys (district);
CREATE INDEX IF NOT EXISTS patient_health_surveys_profile_idx ON patient_health_surveys (patient_account_id, member_id);
