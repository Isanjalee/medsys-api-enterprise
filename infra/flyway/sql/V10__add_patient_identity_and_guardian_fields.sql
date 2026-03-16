ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS patient_code VARCHAR(24),
  ADD COLUMN IF NOT EXISTS guardian_patient_id BIGINT,
  ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS guardian_nic VARCHAR(20),
  ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS guardian_relationship VARCHAR(40);

UPDATE patients
SET patient_code = CONCAT('P-', LPAD(id::text, 10, '0'))
WHERE patient_code IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM patients
    WHERE patient_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce patients.patient_code because existing patient rows still contain NULL values.';
  END IF;
END $$;

ALTER TABLE patients
  ALTER COLUMN patient_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patients_org_patient_code_unique'
  ) THEN
    ALTER TABLE patients
      ADD CONSTRAINT patients_org_patient_code_unique UNIQUE (organization_id, patient_code);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patients_guardian_patient_id_fkey'
  ) THEN
    ALTER TABLE patients
      ADD CONSTRAINT patients_guardian_patient_id_fkey
      FOREIGN KEY (guardian_patient_id) REFERENCES patients(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS patients_org_patient_code_idx ON patients (organization_id, patient_code);
CREATE INDEX IF NOT EXISTS patients_org_guardian_patient_idx ON patients (organization_id, guardian_patient_id);
CREATE INDEX IF NOT EXISTS patients_org_guardian_nic_idx ON patients (organization_id, guardian_nic);
