ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS waiting_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS in_consultation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE appointments
SET registered_at = COALESCE(registered_at, created_at)
WHERE registered_at IS NULL;

UPDATE appointments
SET waiting_at = COALESCE(waiting_at, created_at)
WHERE waiting_at IS NULL
  AND status IN ('waiting', 'in_consultation', 'completed', 'cancelled');

UPDATE appointments
SET in_consultation_at = COALESCE(in_consultation_at, updated_at)
WHERE in_consultation_at IS NULL
  AND status IN ('in_consultation', 'completed');

UPDATE appointments
SET completed_at = COALESCE(completed_at, updated_at)
WHERE completed_at IS NULL
  AND status = 'completed';

CREATE INDEX IF NOT EXISTS appointments_org_waiting_at_idx ON appointments (organization_id, waiting_at);
CREATE INDEX IF NOT EXISTS appointments_org_completed_at_idx ON appointments (organization_id, completed_at);

ALTER TABLE encounters
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

UPDATE encounters
SET closed_at = COALESCE(closed_at, updated_at, checked_at)
WHERE closed_at IS NULL
  AND status = 'completed';

CREATE INDEX IF NOT EXISTS encounters_org_checked_closed_idx ON encounters (organization_id, checked_at, closed_at);
