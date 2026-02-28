-- Unified AI notes storage for signals and future note-producing pipelines.

create table if not exists ai_notes (
  id uuid primary key default gen_random_uuid(),
  note_key text not null unique,
  note_type text not null,
  status text not null default 'active',
  title text not null,
  description text not null,
  rationale text,
  source_kind text,
  source_id text,
  producer_type text not null,
  producer_run_id text not null,
  lineage jsonb not null default '{}'::jsonb,
  signal_type text,
  direction text,
  confidence numeric,
  reason_codes jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  model_meta jsonb not null default '{}'::jsonb,
  supersedes_note_id uuid references ai_notes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('active', 'superseded', 'retracted')),
  check (signal_type is null or signal_type in ('catalyst', 'risk', 'update')),
  check (direction is null or direction in ('up', 'down', 'mixed')),
  check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create index if not exists idx_ai_notes_type_status_created
  on ai_notes(note_type, status, created_at desc);

create index if not exists idx_ai_notes_source_created
  on ai_notes(source_kind, source_id, created_at desc);

create index if not exists idx_ai_notes_created
  on ai_notes(created_at desc);

create index if not exists idx_ai_notes_lineage_map_run
  on ai_notes((lineage->>'map_run_id'), created_at desc)
  where lineage ? 'map_run_id';

create index if not exists idx_ai_notes_lineage_search_run
  on ai_notes((lineage->>'search_run_id'), created_at desc)
  where lineage ? 'search_run_id';

create table if not exists ai_note_targets (
  note_id uuid not null references ai_notes(id) on delete cascade,
  target_kind text not null,
  target_id text not null,
  is_primary boolean not null default false,
  target_rank integer not null default 0,
  affinity_score double precision,
  target_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (note_id, target_kind, target_id)
);

create index if not exists idx_ai_note_targets_target_created
  on ai_note_targets(target_kind, target_id, created_at desc);

create index if not exists idx_ai_note_targets_note_primary_rank
  on ai_note_targets(note_id, is_primary desc, target_rank asc);

create table if not exists ai_note_evidence (
  note_id uuid not null references ai_notes(id) on delete cascade,
  evidence_id text not null,
  relevance double precision,
  created_at timestamptz not null default now(),
  primary key (note_id, evidence_id)
);

create index if not exists idx_ai_note_evidence_evidence
  on ai_note_evidence(evidence_id, created_at desc);
