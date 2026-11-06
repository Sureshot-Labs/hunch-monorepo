export type CanonicalOutcomeSide = "YES" | "NO";

/** Indexed, deterministic lookup for the explicit canonical token mapping. */
export function canonicalMarketTokenIdSql(
  marketAlias: string,
  side: CanonicalOutcomeSide,
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(marketAlias)) {
    throw new Error(`Unsafe SQL alias: ${marketAlias}`);
  }
  return `(
    select umt.token_id
    from unified_market_tokens umt
    where umt.market_id = ${marketAlias}.id
      and umt.outcome_side = '${side}'
    order by umt.updated_at desc nulls last, umt.token_id asc
    limit 1
  )`;
}

/** Resolve both sides in one indexed market lookup with the same tie-breaks. */
export function canonicalMarketTokenPairSql(marketAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(marketAlias)) {
    throw new Error(`Unsafe SQL alias: ${marketAlias}`);
  }
  return `
    select
      max(canonical_mapping.token_id) filter (where canonical_mapping.outcome_side = 'YES') as token_yes,
      max(canonical_mapping.token_id) filter (where canonical_mapping.outcome_side = 'NO') as token_no
    from (
      select distinct on (umt.outcome_side) umt.outcome_side, umt.token_id
      from unified_market_tokens umt
      where umt.market_id = ${marketAlias}.id
        and umt.outcome_side in ('YES', 'NO')
      order by umt.outcome_side, umt.updated_at desc nulls last, umt.token_id asc
    ) canonical_mapping
  `;
}
