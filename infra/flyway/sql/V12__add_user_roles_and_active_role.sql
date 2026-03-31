ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_role user_role;

UPDATE users
SET active_role = role
WHERE active_role IS NULL;

CREATE TABLE IF NOT EXISTS user_roles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  role user_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_roles_user_role_unique UNIQUE (user_id, role)
);

INSERT INTO user_roles (user_id, role)
SELECT u.id, u.role
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM user_roles ur
  WHERE ur.user_id = u.id
    AND ur.role = u.role
);
