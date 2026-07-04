-- Digital-health-identity: capture where the patient actually is at profile creation. NULL
-- lat/lng means location was not captured (permission denied or unavailable) — the clinic can
-- see it's missing.

ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS latitude NUMERIC(9, 6);
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS longitude NUMERIC(9, 6);
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS location_accuracy_m NUMERIC(8, 1);
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ;
