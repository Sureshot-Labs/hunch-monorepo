// Same-side revisions keep the exact token. A side flip may have a different
// token-scoped generation, but only for the same canonical binary pair.
export function samePaperIdeaSql(
  market: string,
  before: string,
  after: string,
): string {
  return `(
    (${before}.outcome=${after}.outcome and ${before}.token_id=${after}.token_id
      and ${before}.instrument_generation=${after}.instrument_generation)
    or (${before}.outcome<>${after}.outcome and exists (
      select 1 from unified_markets idea_market where idea_market.id=${market}
        and (
          (idea_market.venue='polymarket' and ${before}.instrument_generation=${after}.instrument_generation
            and idea_market.metadata#>>'{polymarketProtocol,assets,0}'=case ${before}.outcome when 'YES' then ${before}.token_id else ${after}.token_id end
            and idea_market.metadata#>>'{polymarketProtocol,assets,1}'=case ${before}.outcome when 'NO' then ${before}.token_id else ${after}.token_id end
            and ${after}.instrument_generation=concat('137:',lower(idea_market.metadata#>>'{polymarketProtocol,positionContract}'),':',idea_market.metadata#>>'{polymarketProtocol,protocolVersion}'))
          or (idea_market.venue in ('kalshi','limitless')
            and (idea_market.venue='kalshi' and ${before}.instrument_generation='solana:mainnet:'||${before}.token_id
              and ${after}.instrument_generation='solana:mainnet:'||${after}.token_id
            or idea_market.venue='limitless' and split_part(${after}.instrument_generation,':',2) ~ '^0x[0-9a-f]{40}$'
              and ${before}.instrument_generation=concat('8453:',split_part(${after}.instrument_generation,':',2),':',${before}.token_id)
              and ${after}.instrument_generation=concat('8453:',split_part(${after}.instrument_generation,':',2),':',${after}.token_id))
            and (select count(*) from unified_market_tokens pair_row where pair_row.market_id=idea_market.id
              and pair_row.venue=idea_market.venue and pair_row.outcome_side in ('YES','NO'))=2
            and exists(select 1 from unified_market_tokens token_row where token_row.market_id=idea_market.id and token_row.venue=idea_market.venue
              and token_row.token_id=${before}.token_id and token_row.outcome_side=${before}.outcome)
            and exists(select 1 from unified_market_tokens token_row where token_row.market_id=idea_market.id and token_row.venue=idea_market.venue
              and token_row.token_id=${after}.token_id and token_row.outcome_side=${after}.outcome))
        )
    ))
  )`;
}

export function publicPaperAtFeedCutoffSql(post: string): string {
  return `coalesce((
    select history_row.public_after from paper_feed_visibility_history history_row
    where history_row.thesis_id=${post}.id and history_row.changed_at <= $9::timestamptz
      and (pg_visible_in_snapshot(history_row.changed_xid,$10::pg_snapshot)
        or history_row.changed_xid=pg_current_xact_id_if_assigned())
    order by history_row.change_id desc limit 1
  ),(
    select history_row.public_before from paper_feed_visibility_history history_row
    where history_row.thesis_id=${post}.id order by history_row.change_id asc limit 1
  ),(
    (${post}.author_hidden_at is null or ${post}.author_hidden_at>$9::timestamptz)
    and (${post}.moderation_hidden_at is null or ${post}.moderation_hidden_at>$9::timestamptz)
    and (${post}.proof_invalidated_at is null or ${post}.proof_invalidated_at>$9::timestamptz)
  ))`;
}
