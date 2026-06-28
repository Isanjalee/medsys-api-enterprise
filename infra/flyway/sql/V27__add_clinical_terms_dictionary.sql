-- Per-doctor clinical term dictionary. Replaces the external ICD-10/LOINC suggestion
-- APIs with a local, self-building dictionary: every diagnosis / medical test / outside
-- drug name a doctor types is saved here and used for future autocomplete suggestions.
-- Scoped per doctor (doctor_user_id) within an organization.

CREATE TABLE IF NOT EXISTS clinical_terms (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  doctor_user_id BIGINT NOT NULL REFERENCES users(id),
  term_type VARCHAR(20) NOT NULL,
  name CITEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clinical_terms_type_check CHECK (term_type IN ('diagnosis', 'test', 'drug')),
  CONSTRAINT clinical_terms_unique UNIQUE (organization_id, doctor_user_id, term_type, name)
);

CREATE INDEX IF NOT EXISTS clinical_terms_lookup_idx
  ON clinical_terms (organization_id, doctor_user_id, term_type, name);
