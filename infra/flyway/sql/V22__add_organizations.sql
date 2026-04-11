create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug varchar(80) not null,
  name varchar(160) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists organizations_slug_idx
  on organizations (slug);

insert into organizations (id, slug, name, is_active)
values (
  '11111111-1111-1111-1111-111111111111',
  'default-clinic',
  'Default Clinic',
  true
)
on conflict (id) do update
set
  slug = excluded.slug,
  name = excluded.name,
  is_active = excluded.is_active,
  updated_at = now();
