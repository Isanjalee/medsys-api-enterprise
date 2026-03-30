DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'doctor_workflow_mode'
  ) THEN
    CREATE TYPE doctor_workflow_mode AS ENUM ('self_service', 'clinic_supported');
  END IF;
END
$$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS doctor_workflow_mode doctor_workflow_mode;

UPDATE users
SET doctor_workflow_mode = 'self_service'
WHERE role = 'doctor'
  AND doctor_workflow_mode IS NULL;
