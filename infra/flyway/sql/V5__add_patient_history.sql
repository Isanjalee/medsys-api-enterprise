CREATE TABLE IF NOT EXISTS patient_history_entries (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  patient_id BIGINT NOT NULL REFERENCES patients(id),
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT patient_history_entries_note_length_chk
    CHECK (char_length(note) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS patient_history_entries_org_patient_idx
  ON patient_history_entries (organization_id, patient_id);

CREATE INDEX IF NOT EXISTS patient_history_entries_patient_created_idx
  ON patient_history_entries (patient_id, created_at DESC);
