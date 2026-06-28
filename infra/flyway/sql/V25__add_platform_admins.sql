-- Platform super-admin: a cross-clinic administrator that sits above every organization.
-- Kept in its own table because tenant users (owner/doctor/assistant) are always scoped to
-- a single organization, whereas the platform admin manages all of them.

CREATE TABLE IF NOT EXISTS platform_admins (
  id BIGSERIAL PRIMARY KEY,
  username CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(120) NOT NULL DEFAULT 'Super Admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the initial super admin (username: supper-admin). Password hash matches the app's
-- sha256: scheme. ON CONFLICT keeps the seeded credential in sync if the migration re-runs.
INSERT INTO platform_admins (username, password_hash, display_name)
VALUES (
  'supper-admin',
  'sha256:8dfa838f5cc914b2e6bbe8c7789ff098f86349773a26dae787c24019cac0b4ee',
  'Super Admin'
)
ON CONFLICT (username) DO UPDATE
SET
  password_hash = EXCLUDED.password_hash,
  is_active = TRUE,
  updated_at = NOW();
