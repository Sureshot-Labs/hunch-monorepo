-- Visibility for an already-issued public feed cursor. Current moderation
-- remains authoritative for what can be returned; this only prevents later
-- visibility changes from reshuffling the old cursor's revision membership.
create table if not exists paper_feed_visibility_history (
  thesis_id uuid not null references user_theses(id) on delete cascade,
  change_id bigint generated always as identity,
  changed_at timestamptz not null default clock_timestamp(),
  changed_xid xid8 not null default pg_current_xact_id(),
  public_before boolean not null,
  public_after boolean not null,
  primary key (thesis_id, change_id)
);

create or replace function insert_paper_feed_visibility_history()
returns trigger language plpgsql as $body$
begin
  insert into paper_feed_visibility_history(thesis_id,public_before,public_after)
    values (new.id,
      old.author_hidden_at is null and old.moderation_hidden_at is null and old.proof_invalidated_at is null,
      new.author_hidden_at is null and new.moderation_hidden_at is null and new.proof_invalidated_at is null);
  return null;
end
$body$;
drop trigger if exists paper_feed_record_visibility on user_theses;
create trigger paper_feed_record_visibility
  after update of author_hidden_at, moderation_hidden_at, proof_invalidated_at on user_theses
  for each row when (new.purchase_mode='paper' and
    ((old.author_hidden_at is null and old.moderation_hidden_at is null and old.proof_invalidated_at is null)
       is distinct from
     (new.author_hidden_at is null and new.moderation_hidden_at is null and new.proof_invalidated_at is null)))
  execute function insert_paper_feed_visibility_history();
