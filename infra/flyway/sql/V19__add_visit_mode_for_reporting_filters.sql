ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS visit_mode VARCHAR(20) NOT NULL DEFAULT 'appointment';

UPDATE appointments
SET visit_mode = CASE
  WHEN reason = 'Walk-in consultation' THEN 'walk_in'
  ELSE 'appointment'
END
WHERE visit_mode IS NULL
   OR visit_mode NOT IN ('walk_in', 'appointment');

CREATE INDEX IF NOT EXISTS appointments_org_visit_mode_idx
  ON appointments(organization_id, visit_mode);
