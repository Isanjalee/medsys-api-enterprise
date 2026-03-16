UPDATE patients
SET age = EXTRACT(YEAR FROM age(CURRENT_DATE, dob))::SMALLINT
WHERE dob IS NOT NULL AND age IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM patients
    WHERE dob IS NULL
       OR age IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce required patients.dob and patients.age because existing patient rows still contain NULL values.';
  END IF;
END $$;

ALTER TABLE patients
  ALTER COLUMN full_name SET NOT NULL,
  ALTER COLUMN dob SET NOT NULL,
  ALTER COLUMN age SET NOT NULL;
