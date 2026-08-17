-- Preserve the service identity behind API-key content mutations in the audit log.

alter table content_audit_events
  add column actor_kind text,
  add column actor_service_principal_id uuid
    references admin_service_principals(id) on delete restrict,
  add column actor_label text;

update content_audit_events
set
  actor_kind = case when actor_admin_id is null then 'system' else 'admin' end,
  actor_label = case
    when actor_admin_id is null then 'legacy-system'
    else 'legacy-admin:' || actor_admin_id::text
  end;

create or replace function content_fill_audit_actor()
returns trigger
language plpgsql
as $$
begin
  if new.actor_kind is null then
    new.actor_kind := case
      when new.actor_service_principal_id is not null then 'service'
      when new.actor_admin_id is not null then 'admin'
      else 'system'
    end;
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

create trigger content_audit_events_fill_actor
  before insert or update on content_audit_events
  for each row execute function content_fill_audit_actor();

alter table content_audit_events
  alter column actor_kind set not null,
  alter column actor_label set not null,
  add constraint content_audit_events_actor_kind_check
    check (actor_kind in ('admin', 'service', 'system')),
  add constraint content_audit_events_actor_label_check
    check (char_length(actor_label) between 1 and 200),
  add constraint content_audit_events_actor_contract_check
    check (
      (actor_kind = 'admin' and actor_admin_id is not null and actor_service_principal_id is null)
      or (actor_kind = 'service' and actor_admin_id is null and actor_service_principal_id is not null)
      or (actor_kind = 'system' and actor_admin_id is null and actor_service_principal_id is null)
    );

create index idx_content_audit_service_principal_created
  on content_audit_events (actor_service_principal_id, created_at desc, id desc)
  where actor_service_principal_id is not null;
