CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT,
  task_type VARCHAR(40) NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  source_id BIGINT,
  assigned_role user_role NOT NULL,
  assigned_user_id BIGINT REFERENCES users(id),
  priority priority_level NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  visit_mode VARCHAR(20),
  doctor_workflow_mode doctor_workflow_mode,
  due_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS tasks_org_role_idx ON tasks(organization_id, assigned_role);
CREATE INDEX IF NOT EXISTS tasks_org_due_idx ON tasks(organization_id, due_at);

CREATE TABLE IF NOT EXISTS task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id),
  actor_user_id BIGINT REFERENCES users(id),
  event_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id);
