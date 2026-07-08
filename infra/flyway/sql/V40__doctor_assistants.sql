-- Per-doctor assistant assignment (many-to-many). Completed consultations route to a doctor's
-- active assigned assistant(s); a doctor with none completes directly. Replaces the retired
-- center-wide "operating mode".

CREATE TABLE IF NOT EXISTS doctor_assistants (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  doctor_user_id BIGINT NOT NULL REFERENCES users(id),
  assistant_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS doctor_assistants_pair_idx
  ON doctor_assistants (doctor_user_id, assistant_user_id);
CREATE INDEX IF NOT EXISTS doctor_assistants_assistant_idx ON doctor_assistants (assistant_user_id);
CREATE INDEX IF NOT EXISTS doctor_assistants_org_idx ON doctor_assistants (organization_id);
