import type { PoolClient } from "pg";

export const HOLDER_RESEARCH_PRICE_MOVEMENT_VERSION = 1;
// The baseline is an hourly candle, not a tick exactly 24 hours ago.
const MAX_BASELINE_LAG_MS = 2 * 3_600_000;

export type HolderResearchPriceBaseline = {
  yes: number | null;
  no: number | null;
  yesAt: string | null;
  noAt: string | null;
};

export type HolderResearchPriceMovement = {
  version: typeof HOLDER_RESEARCH_PRICE_MOVEMENT_VERSION;
  unit: "probability";
  referenceKind: "hourly_midpoint";
  referenceAt: string | null;
  checkedAt: string;
  yesProbability24hAgo: number | null;
  yesDeltaProbability24h: number | null;
  yesRelativeReturn24h: number | null;
  noRelativeReturn24h: number | null;
  quality: "available" | "missing" | "stale" | "inconsistent";
};

function probability(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function buildHolderResearchPriceMovement(input: {
  baseline: HolderResearchPriceBaseline | null;
  yesProbabilityNow: number | null;
  now: Date;
}): HolderResearchPriceMovement {
  const result: HolderResearchPriceMovement = {
    version: HOLDER_RESEARCH_PRICE_MOVEMENT_VERSION,
    unit: "probability",
    referenceKind: "hourly_midpoint",
    referenceAt: null,
    checkedAt: input.now.toISOString(),
    yesProbability24hAgo: null,
    yesDeltaProbability24h: null,
    yesRelativeReturn24h: null,
    noRelativeReturn24h: null,
    quality: "missing",
  };
  const current = probability(input.yesProbabilityNow);
  if (!input.baseline || current == null) return result;
  const yes = probability(input.baseline.yes);
  const no = probability(input.baseline.no);
  if (yes == null && no == null) return result;
  const referenceAt = yes != null ? input.baseline.yesAt : input.baseline.noAt;
  result.referenceAt = referenceAt;
  const referenceMs = referenceAt == null ? NaN : Date.parse(referenceAt);
  const expectedBucket =
    Math.floor((input.now.getTime() - 24 * 3_600_000) / 3_600_000) * 3_600_000;
  if (
    !Number.isFinite(referenceMs) ||
    referenceMs > expectedBucket ||
    expectedBucket - referenceMs > MAX_BASELINE_LAG_MS
  ) {
    return { ...result, quality: "stale" };
  }
  if (
    yes != null &&
    no != null &&
    (Math.abs(yes - (1 - no)) > 0.02 + 1e-9 ||
      Date.parse(input.baseline.noAt ?? "") !== referenceMs)
  )
    return { ...result, quality: "inconsistent" };
  const previous = yes ?? 1 - (no as number);
  const delta = current - previous;
  return {
    ...result,
    quality: "available",
    yesProbability24hAgo: previous,
    yesDeltaProbability24h: delta,
    yesRelativeReturn24h: previous > 0 ? delta / previous : null,
    noRelativeReturn24h: previous < 1 ? -delta / (1 - previous) : null,
  };
}

export async function loadHolderResearchPriceBaselines(
  client: Pick<PoolClient, "query">,
  marketIds: string[],
): Promise<Map<string, HolderResearchPriceBaseline>> {
  if (marketIds.length === 0) return new Map();
  const { rows } = await client.query<{
    market_id: string;
    yes_price: string | number | null;
    no_price: string | number | null;
    yes_at: Date | string | null;
    no_at: Date | string | null;
  }>(
    `
    select requested.market_id,
      yes_history.avg_mid_24h as yes_price,
      no_history.avg_mid_24h as no_price,
      yes_history.bucket_24h as yes_at,
      no_history.bucket_24h as no_at
    from unnest($1::text[]) as requested(market_id)
    left join lateral (
      select token_id from unified_market_tokens
      where market_id = requested.market_id and outcome_side = 'YES'
      order by updated_at desc nulls last, token_id asc limit 1
    ) yes_token on true
    left join lateral (
      select token_id from unified_market_tokens
      where market_id = requested.market_id and outcome_side = 'NO'
      order by updated_at desc nulls last, token_id asc limit 1
    ) no_token on true
    left join unified_token_change_24h yes_history on yes_history.token_id = yes_token.token_id
    left join unified_token_change_24h no_history on no_history.token_id = no_token.token_id
  `,
    [Array.from(new Set(marketIds))],
  );
  const iso = (value: Date | string | null) =>
    value == null ? null : new Date(value).toISOString();
  return new Map(
    rows.map((row) => [
      row.market_id,
      {
        yes: probability(row.yes_price),
        no: probability(row.no_price),
        yesAt: iso(row.yes_at),
        noAt: iso(row.no_at),
      },
    ]),
  );
}
