-- "My Health": per-profile BMI tracking. Each row is one height/weight measurement (with the
-- computed BMI) for the account holder (member_id NULL) or one of their family members.

CREATE TABLE patient_health_metrics (
  id BIGSERIAL PRIMARY KEY,
  patient_account_id BIGINT NOT NULL REFERENCES patient_accounts(id),
  member_id BIGINT REFERENCES patient_account_members(id),
  height_cm NUMERIC(5, 1) NOT NULL,
  weight_kg NUMERIC(5, 1) NOT NULL,
  bmi NUMERIC(4, 1) NOT NULL,
  recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patient_health_metrics_profile_idx
  ON patient_health_metrics (patient_account_id, member_id, recorded_at);
