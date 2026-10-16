-- Existing users are exempt. Future inserts enroll independently of auth method.
-- Keep both defaults in this transaction: a missing state row is not a cohort.
alter table users add column onboarding_version smallint not null default 0
  check (onboarding_version in (0,1));
alter table users alter column onboarding_version set default 1;

create table onboarding_interests (
  id text primary key,
  label text not null,
  enabled boolean not null default true,
  sort_order smallint not null unique
);
insert into onboarding_interests(id,label,sort_order) values
  ('usElections','US elections',0),
  ('politics','Politics',1),
  ('technology','Technology',2),
  ('sports','Sports',3),
  ('culture','Culture',4),
  ('economy','Economy',5),
  ('geopolitics','Geopolitics',6),
  ('trump','Trump',7),
  ('entertainment','Entertainment',8);

create table user_onboarding_state (
  user_id uuid primary key references users(id) on delete cascade,
  flow_version smallint not null default 1 check (flow_version=1),
  revision bigint not null check (revision between 0 and 9007199254740991),
  status text not null check (status in ('not_started','in_progress','completed')),
  completion_reason text check (completion_reason in ('flow','legacy')),
  completed_at timestamptz,
  steps jsonb not null check (jsonb_typeof(steps)='object'
    and steps ?& array['interests','handle','photo','passkey','notifications','traders']
    and steps - array['interests','handle','photo','passkey','notifications','traders'] = '{}'::jsonb),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status='completed' and completion_reason is not null and (
      (completion_reason='flow' and completed_at is not null)
      or (completion_reason='legacy' and completed_at is null)
    ))
    or (status<>'completed' and completion_reason is null and completed_at is null)
  )
);

create table user_interests (
  user_id uuid not null references users(id) on delete cascade,
  interest_id text not null references onboarding_interests(id),
  primary key(user_id,interest_id)
);
-- Reverse FK checks when a catalog ID is retired/deleted remain bounded too.
create index user_interests_catalog_reference on user_interests(interest_id,user_id);
