CREATE TABLE IF NOT EXISTS daily_summary_snapshots (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  role_context VARCHAR(20) NOT NULL,
  actor_user_id BIGINT REFERENCES users(id),
  summary_date DATE NOT NULL,
  summary_type VARCHAR(30) NOT NULL DEFAULT 'daily',
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_summary_snapshots_org_date_idx
  ON daily_summary_snapshots(organization_id, summary_date);

CREATE INDEX IF NOT EXISTS daily_summary_snapshots_org_role_date_idx
  ON daily_summary_snapshots(organization_id, role_context, summary_date);
