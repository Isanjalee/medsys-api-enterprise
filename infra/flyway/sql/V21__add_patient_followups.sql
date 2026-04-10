create table if not exists patient_followups (
  id bigserial primary key,
  organization_id uuid not null,
  patient_id bigint not null references patients(id),
  encounter_id bigint references encounters(id),
  doctor_id bigint references users(id),
  followup_type varchar(40) not null,
  due_date date not null,
  status varchar(20) not null default 'pending',
  visit_mode varchar(20),
  doctor_workflow_mode doctor_workflow_mode,
  note text,
  created_by_user_id bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists patient_followups_org_due_idx
  on patient_followups (organization_id, due_date);

create index if not exists patient_followups_org_status_idx
  on patient_followups (organization_id, status);

create index if not exists patient_followups_org_doctor_idx
  on patient_followups (organization_id, doctor_id);

create index if not exists patient_followups_patient_idx
  on patient_followups (patient_id);
