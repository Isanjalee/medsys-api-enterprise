ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id UUID,
  ADD COLUMN IF NOT EXISTS parent_token_id UUID NULL,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS replay_detected_at TIMESTAMPTZ NULL;

UPDATE refresh_tokens
SET family_id = COALESCE(family_id, gen_random_uuid())
WHERE family_id IS NULL;

ALTER TABLE refresh_tokens
  ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
