-- Step Up mode support.
-- 1) Organization-level operating mode. 'standard' keeps the current Walk-In/Appointment
--    behavior; 'step_up' marks a first-come-first-serve clinic (one doctor, assistants
--    cannot create appointments). Defaults to 'standard' so existing tenants are unchanged.
-- 2) Total dispense price in LKR, captured by the assistant at dispense time. Nullable so
--    historical dispense records and non-Step-Up flows are unaffected.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS operating_mode VARCHAR(20) NOT NULL DEFAULT 'standard';

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_operating_mode_check;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_operating_mode_check
  CHECK (operating_mode IN ('standard', 'step_up'));

ALTER TABLE dispense_records
  ADD COLUMN IF NOT EXISTS price_lkr NUMERIC(12, 2) NULL;
