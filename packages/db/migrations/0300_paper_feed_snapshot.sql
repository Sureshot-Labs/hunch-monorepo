-- No table rewrite or assertion over historical rows. New papers store the
-- originating transaction, which does not change on edits or moderation.
alter table user_theses add column if not exists paper_created_xid xid8;
alter table user_theses add column if not exists paper_revision_parent_id uuid;
alter table user_theses add column if not exists paper_revision_checked boolean not null default false;
alter table user_theses alter column paper_created_xid set default pg_current_xact_id();

-- Bound the index key for unrestricted legacy JSON. The recursive reader
-- also compares the full previous-thesis string, never just its hash.
create index if not exists user_theses_paper_previous_thesis
  on user_theses (md5(buy_snapshot#>>'{provenance,previousThesisId}'))
  where purchase_mode='paper';
