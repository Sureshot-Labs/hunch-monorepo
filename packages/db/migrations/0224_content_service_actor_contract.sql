-- Contract generalized content actors while keeping the immediately previous
-- API binary safe during a rolling deploy. Compatibility triggers infer legacy
-- audit actors and clear stale service attribution when old code writes an
-- admin updater column without knowing its companion column.

create or replace function content_fill_legacy_audit_actor()
returns trigger
language plpgsql
as $$
begin
  if new.actor_kind is null then
    if new.actor_service_principal_id is not null then
      new.actor_kind := 'service';
    elsif new.actor_admin_id is not null then
      new.actor_kind := 'admin';
    else
      new.actor_kind := 'system';
    end if;
  end if;
  if new.actor_label is null or btrim(new.actor_label) = '' then
    new.actor_label := case new.actor_kind
      when 'admin' then 'legacy-admin:' || new.actor_admin_id::text
      when 'service' then 'legacy-service:' || new.actor_service_principal_id::text
      else 'legacy-system'
    end;
  end if;
  return new;
end;
$$;

create trigger content_audit_events_fill_legacy_actor
  before insert or update on content_audit_events
  for each row execute function content_fill_legacy_audit_actor();

update content_audit_events
set
  actor_kind = coalesce(
    actor_kind,
    case
      when actor_service_principal_id is not null then 'service'
      when actor_admin_id is not null then 'admin'
      else 'system'
    end
  ),
  actor_label = coalesce(
    nullif(btrim(actor_label), ''),
    case
      when actor_service_principal_id is not null
        then 'legacy-service:' || actor_service_principal_id::text
      when actor_admin_id is not null
        then 'legacy-admin:' || actor_admin_id::text
      else 'legacy-system'
    end
  );

alter table content_audit_events
  alter column actor_kind set not null,
  alter column actor_label set not null,
  add constraint content_audit_events_actor_contract_check
  check (
    (actor_kind = 'admin' and actor_admin_id is not null and actor_service_principal_id is null)
    or (actor_kind = 'service' and actor_admin_id is null and actor_service_principal_id is not null)
    or (actor_kind = 'system' and actor_admin_id is null and actor_service_principal_id is null)
  );

create or replace function content_articles_compat_actor_columns()
returns trigger
language plpgsql
as $$
begin
  if new.updated_by_admin_id is not null
     and new.updated_by_service_principal_id is not null then
    if new.updated_by_service_principal_id is distinct from old.updated_by_service_principal_id
       and new.updated_by_admin_id is not distinct from old.updated_by_admin_id then
      new.updated_by_admin_id := null;
    else
      new.updated_by_service_principal_id := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger content_articles_compat_actor_columns
  before update on content_articles
  for each row execute function content_articles_compat_actor_columns();

create or replace function content_drafts_compat_actor_columns()
returns trigger
language plpgsql
as $$
begin
  if new.updated_by_admin_id is not null
     and new.updated_by_service_principal_id is not null then
    if new.updated_by_service_principal_id is distinct from old.updated_by_service_principal_id
       and new.updated_by_admin_id is not distinct from old.updated_by_admin_id then
      new.updated_by_admin_id := null;
    else
      new.updated_by_service_principal_id := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger content_drafts_compat_actor_columns
  before update on content_article_drafts
  for each row execute function content_drafts_compat_actor_columns();

create or replace function content_assets_compat_actor_columns()
returns trigger
language plpgsql
as $$
begin
  if new.updated_by_admin_id is not null
     and new.updated_by_service_principal_id is not null then
    if new.updated_by_service_principal_id is distinct from old.updated_by_service_principal_id
       and new.updated_by_admin_id is not distinct from old.updated_by_admin_id then
      new.updated_by_admin_id := null;
    else
      new.updated_by_service_principal_id := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger content_assets_compat_actor_columns
  before update on content_assets
  for each row execute function content_assets_compat_actor_columns();

alter table content_articles
  add constraint content_articles_created_actor_check
    check (num_nonnulls(created_by_admin_id, created_by_service_principal_id) <= 1),
  add constraint content_articles_updated_actor_check
    check (num_nonnulls(updated_by_admin_id, updated_by_service_principal_id) <= 1);

alter table content_article_drafts
  add constraint content_article_drafts_updated_actor_check
    check (num_nonnulls(updated_by_admin_id, updated_by_service_principal_id) <= 1);

alter table content_article_versions
  add constraint content_article_versions_created_actor_check
    check (num_nonnulls(created_by_admin_id, created_by_service_principal_id) <= 1);

alter table content_assets
  add constraint content_assets_created_actor_check
    check (num_nonnulls(created_by_admin_id, created_by_service_principal_id) <= 1),
  add constraint content_assets_updated_actor_check
    check (num_nonnulls(updated_by_admin_id, updated_by_service_principal_id) <= 1);
