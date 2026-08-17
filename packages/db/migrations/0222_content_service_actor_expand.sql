-- Expand content attribution so human, service, and system actors are explicit.
-- Strict contract constraints intentionally follow in a later rollout migration.

alter table content_audit_events
  add column actor_kind text,
  add column actor_service_principal_id uuid,
  add column actor_label text;

alter table content_audit_events
  add constraint content_audit_events_actor_kind_expand_check
  check (actor_kind is null or actor_kind in ('admin', 'service', 'system')),
  add constraint content_audit_events_actor_label_check
  check (actor_label is null or char_length(actor_label) between 1 and 200);

update content_audit_events
set
  actor_kind = case when actor_admin_id is null then 'system' else 'admin' end,
  actor_label = case
    when actor_admin_id is null then 'legacy-system'
    else 'legacy-admin:' || actor_admin_id::text
  end
where actor_kind is null or actor_label is null;

create index idx_content_audit_service_principal_created
  on content_audit_events (
    actor_service_principal_id,
    created_at desc,
    id desc
  )
  where actor_service_principal_id is not null;

alter table content_articles
  add column created_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null,
  add column updated_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null;

alter table content_article_drafts
  add column updated_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null;

alter table content_article_versions
  add column created_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null;

alter table content_assets
  add column created_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null,
  add column updated_by_admin_id uuid,
  add column updated_by_service_principal_id uuid
    references admin_service_principals(id) on delete set null;

create index idx_content_articles_created_by_service
  on content_articles (created_by_service_principal_id, created_at desc, id desc)
  where created_by_service_principal_id is not null;

create index idx_content_articles_updated_by_service
  on content_articles (updated_by_service_principal_id, updated_at desc, id desc)
  where updated_by_service_principal_id is not null;

create index idx_content_assets_created_by_service
  on content_assets (created_by_service_principal_id, created_at desc, id desc)
  where created_by_service_principal_id is not null;
