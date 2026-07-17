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
