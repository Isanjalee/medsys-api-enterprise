ALTER TABLE users
  ADD COLUMN IF NOT EXISTS extra_permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
