-- Additive social model. Product limits are runtime policy, not SQL constants.
alter table users
  add column handle text,
  add column bio text,
  add column avatar_asset_id uuid references content_assets(id) on delete set null,
  add column handle_changed_at timestamptz,
  add column profile_name_edited_at timestamptz,
  add column profile_avatar_edited_at timestamptz,
  add column social_suspended_at timestamptz;
create unique index users_social_handle_unique on users (lower(handle)) where handle is not null;
create index users_avatar_asset_reference on users (avatar_asset_id) where avatar_asset_id is not null;

alter table content_assets add column owner_user_id uuid references users(id) on delete set null;
create index content_assets_user_owner on content_assets(owner_user_id, created_at desc, id desc) where owner_user_id is not null;
alter table content_audit_events add column actor_user_id uuid references users(id) on delete set null;
alter table content_audit_events drop constraint content_audit_events_actor_kind_check;
alter table content_audit_events drop constraint content_audit_events_actor_contract_check;
alter table content_audit_events add constraint content_audit_events_actor_kind_check check (actor_kind in ('admin','service','system','user'));
-- A deleted user's audit remains truthful but anonymized (actor_user_id may be null).
alter table content_audit_events add constraint content_audit_events_actor_contract_check check (
  (actor_kind='admin' and actor_admin_id is not null and actor_service_principal_id is null and actor_user_id is null)
  or (actor_kind='service' and actor_admin_id is null and actor_service_principal_id is not null and actor_user_id is null)
  or (actor_kind in ('system','user') and actor_admin_id is null and actor_service_principal_id is null and (actor_kind='user' or actor_user_id is null))
);

create table user_follows (
  follower_user_id uuid not null references users(id) on delete cascade,
  followed_user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_user_id,followed_user_id),
  check (follower_user_id<>followed_user_id)
);
create index user_follows_following_page on user_follows(follower_user_id,created_at desc,followed_user_id desc);
create index user_follows_followers_page on user_follows(followed_user_id,created_at desc,follower_user_id desc);

create table user_blocks (
  blocker_user_id uuid not null references users(id) on delete cascade,
  blocked_user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id,blocked_user_id),
  check (blocker_user_id<>blocked_user_id)
);
create index user_blocks_reverse on user_blocks(blocked_user_id,blocker_user_id);
create index user_blocks_page on user_blocks(blocker_user_id,created_at desc,blocked_user_id desc);

create table user_theses (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references users(id) on delete set null,
  canonical_purchase_key text not null unique,
  order_id uuid references orders(id) on delete restrict,
  execution_id uuid references executions(id) on delete restrict,
  market_id text not null references unified_markets(id) on delete restrict,
  event_id text references unified_events(id) on delete restrict,
  token_id text not null,
  outcome text not null check (outcome in ('YES','NO')),
  instrument_generation text not null,
  expiry timestamptz,
  body text not null,
  buy_snapshot jsonb not null check (jsonb_typeof(buy_snapshot)='object'),
  policy_revision text not null,
  qualifying_notional numeric not null check (qualifying_notional>0),
  idempotency_key text not null,
  payload_hash text not null,
  published_at timestamptz not null default now(),
  author_hidden_at timestamptz,
  moderation_hidden_at timestamptz,
  proof_invalidated_at timestamptz,
  unique(author_id,idempotency_key),
  check (num_nonnulls(order_id,execution_id)=1)
);
create index user_theses_public_page on user_theses(published_at desc,id desc) where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
create index user_theses_author_page on user_theses(author_id,published_at desc,id desc);
create index user_theses_market_page on user_theses(market_id,published_at desc,id desc);
create index user_theses_event_page on user_theses(event_id,published_at desc,id desc);
create index user_theses_author_public_page on user_theses(author_id,published_at desc,id desc) where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
create index user_theses_market_public_page on user_theses(market_id,published_at desc,id desc) include(author_id,event_id) where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
create index user_theses_event_public_page on user_theses(event_id,published_at desc,id desc) include(author_id,market_id) where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
create index user_theses_order_reference on user_theses(order_id) where order_id is not null;
create index user_theses_execution_reference on user_theses(execution_id) where execution_id is not null;
create index user_theses_token_reference on user_theses(token_id);

create table copy_attributions (
  id uuid primary key default gen_random_uuid(),
  copier_user_id uuid references users(id) on delete set null,
  source_thesis_id uuid references user_theses(id) on delete restrict,
  source_ai_note_id uuid references ai_notes(id) on delete restrict,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot)='object'),
  instrument jsonb not null check (jsonb_typeof(instrument)='object'),
  idempotency_key text not null,
  payload_hash text not null,
  prepared_fingerprint text not null,
  provider_reference text not null unique,
  canonical_purchase_key text unique,
  order_id uuid references orders(id) on delete restrict,
  execution_id uuid references executions(id) on delete restrict,
  state text not null default 'pending' check (state in ('pending','confirmed','revoked','failed')),
  facts_revision text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(copier_user_id,idempotency_key),
  check (num_nonnulls(source_thesis_id,source_ai_note_id)=1)
);
create index copy_attributions_thesis_users on copy_attributions(source_thesis_id,copier_user_id) where state='confirmed';
create index copy_attributions_hunch_users on copy_attributions(source_ai_note_id,copier_user_id) where state='confirmed';
create index copy_attributions_order_reference on copy_attributions(order_id) where order_id is not null;
create index copy_attributions_execution_reference on copy_attributions(execution_id) where execution_id is not null;
create index copy_attributions_copier on copy_attributions(copier_user_id,id);
create index copy_attributions_instrument_market on copy_attributions((instrument->>'marketId'));

create table social_comments (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references users(id) on delete set null,
  thesis_id uuid references user_theses(id) on delete restrict,
  ai_note_id uuid references ai_notes(id) on delete restrict,
  observed_ai_note_id uuid references ai_notes(id) on delete restrict,
  body text not null,
  idempotency_key text not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  author_hidden_at timestamptz,
  moderation_hidden_at timestamptz,
  unique(author_id,idempotency_key),
  check (num_nonnulls(thesis_id,ai_note_id)=1),
  check ((ai_note_id is null)=(observed_ai_note_id is null))
);
create index social_comments_thesis_page on social_comments(thesis_id,created_at desc,id desc) where thesis_id is not null;
create index social_comments_hunch_page on social_comments(ai_note_id,created_at desc,id desc) where ai_note_id is not null;
create index social_comments_observed_note on social_comments(observed_ai_note_id) where observed_ai_note_id is not null;
create index social_comments_author on social_comments(author_id,id);

create table social_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references users(id) on delete set null,
  target_profile_id uuid references users(id) on delete set null,
  thesis_id uuid references user_theses(id) on delete restrict,
  comment_id uuid references social_comments(id) on delete restrict,
  target_kind text not null check (target_kind in ('user','thesis','comment')),
  target_id uuid not null,
  reason text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(reporter_id,target_kind,target_id),
  check ((target_kind='user' and thesis_id is null and comment_id is null)
    or (target_kind='thesis' and thesis_id is not null and target_profile_id is null and comment_id is null)
    or (target_kind='comment' and comment_id is not null and target_profile_id is null and thesis_id is null))
);
create index social_reports_queue on social_reports(status,created_at desc,id desc);
create index social_reports_target on social_reports(target_kind,target_id,created_at desc,id desc);
create index social_reports_reporter on social_reports(reporter_id,id) where reporter_id is not null;
create index social_reports_profile_reference on social_reports(target_profile_id,id) where target_profile_id is not null;

-- Pseudonymous audit identifiers intentionally have no cascading FKs.
create table social_moderation_events (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null check (target_kind in ('user','thesis','comment')),
  target_id uuid not null,
  action text not null check (action in ('hide','unhide','suspend','unsuspend','resolve_report')),
  reason text not null,
  admin_id uuid,
  report_id uuid,
  created_at timestamptz not null default now()
);
create index social_moderation_events_target on social_moderation_events(target_kind,target_id,created_at desc,id desc);
create index social_moderation_events_page on social_moderation_events(created_at desc,id desc);
