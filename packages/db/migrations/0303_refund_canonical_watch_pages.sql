/* no-transaction */
-- Source paging before observer/finality filtering, including empty tails.
create index concurrently if not exists funding_observations_operation_kind_id_idx
  on funding_observations (operation_id, kind, id);
