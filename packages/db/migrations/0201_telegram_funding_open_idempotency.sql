-- Keep every accepted Telegram funding/open request in the existing
-- channel-owned, append-only mutation ledger. This permits several callback
-- idempotency keys to resolve to one frozen Receive Session without borrowing
-- the unrelated legacy global idempotency table.

alter table telegram_funding_mutations
  drop constraint if exists telegram_funding_mutations_action_check;

alter table telegram_funding_mutations
  add constraint telegram_funding_mutations_action_check
  check (action in ('open', 'select_target', 'cancel'));

alter table telegram_funding_mutations
  drop constraint if exists telegram_funding_mutations_action_shape_check;

alter table telegram_funding_mutations
  add constraint telegram_funding_mutations_action_shape_check
  check (
    (action = 'select_target' and consent_revision is not null)
    or (action in ('open', 'cancel') and consent_revision is null)
  );
