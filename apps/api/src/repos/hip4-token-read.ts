import {
  hip4Identity,
  hip4ReadMarketSchema,
  parseHip4Coin,
  type Hip4Environment,
} from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { hip4CatalogProjection } from "../services/hip4-catalog-projection.js";
import type { MarketByTokenRow } from "./unified-read.js";

export const HIP4_TOKEN_READ_SQL = `select read_model from hip4_read_markets
  where environment=$1 and outcome=any($2::bigint[])`;

export function nativePublicReadIdAllowed(
  id: string,
  environment: Hip4Environment | null,
): boolean {
  return (
    !id.startsWith("hyperliquid:") ||
    (environment !== null && id.startsWith(`hyperliquid:${environment}:`))
  );
}

/** Explicit public-read adapter. Default financial legacy hydration does not
 * call this. IDs, environment, instance and native sides are revalidated. */
export async function fetchHip4MarketsByTokenIds(
  db: Pick<Pool, "query">,
  input: {
    tokenIds: string[];
    environment: Hip4Environment;
  },
): Promise<MarketByTokenRow[]> {
  const ids = [...new Set(input.tokenIds)].flatMap((tokenId) => {
    const match = /^hyperliquid:(mainnet|testnet):(\d+)$/.exec(tokenId);
    if (!match || match[1] !== input.environment) return [];
    try {
      return [{ tokenId, ...parseHip4Coin(`#${match[2]}`) }];
    } catch {
      return [];
    }
  });
  if (!ids.length) return [];
  const { rows } = await db.query(HIP4_TOKEN_READ_SQL, [
    input.environment,
    [...new Set(ids.map((id) => id.outcome))],
  ]);
  const result: MarketByTokenRow[] = [];
  for (const row of rows) {
    const parsed = hip4ReadMarketSchema.safeParse(row.read_model);
    if (!parsed.success) continue;
    const native = parsed.data;
    const identity = hip4Identity(input.environment, native.outcome);
    if (
      native.environment !== input.environment ||
      native.marketId !== identity.marketId ||
      native.sides.some(
        (side, index) =>
          side.sideIndex !== index ||
          side.tokenId !== identity.sides[index]?.tokenId ||
          side.coin !== identity.sides[index]?.coin ||
          side.assetId !== identity.sides[index]?.assetId,
      )
    )
      continue;
    const catalog = hip4CatalogProjection(native);
    for (const token of ids.filter((id) => id.outcome === native.outcome)) {
      result.push({
        token_id: token.tokenId,
        side: token.sideIndex === 0 ? "YES" : "NO",
        asset_context: null,
        market_id: native.marketId,
        venue: "hyperliquid",
        venue_market_id: String(native.outcome),
        market_title: native.title,
        market_description: native.description,
        market_type: null,
        market_duration_minutes: null,
        market_status:
          native.status === "observed"
            ? "ACTIVE"
            : native.status === "settled"
              ? "RESOLVED"
              : "CLOSED",
        pm_accepting_orders: null,
        pm_neg_risk: null,
        pm_neg_risk_market_id: null,
        pm_neg_risk_parent_condition_id: null,
        pm_neg_risk_request_id: null,
        pm_question_id: null,
        open_time: null,
        close_time: native.expiry,
        expiration_time: native.expiry,
        volume_24h: catalog.volume24h,
        volume_total: null,
        open_interest: null,
        liquidity: null,
        best_bid: null,
        best_ask: null,
        best_bid_yes: null,
        best_ask_yes: null,
        top_ts_yes: null,
        best_bid_no: null,
        best_ask_no: null,
        top_ts_no: null,
        last_price: null,
        outcomes: JSON.stringify(native.sides.map((side) => side.label)),
        token_yes: identity.sides[0].tokenId,
        token_no: identity.sides[1].tokenId,
        clob_token_ids: null,
        condition_id: null,
        market_ledger: null,
        settlement_mint: null,
        is_initialized: null,
        redemption_status: null,
        resolved_outcome:
          catalog.resolvedOutcomePct === "10000"
            ? "YES"
            : catalog.resolvedOutcomePct === "0"
              ? "NO"
              : null,
        resolved_outcome_pct: catalog.resolvedOutcomePct,
        slug: null,
        market_category: null,
        market_image: null,
        market_icon: null,
        market_metadata: { hip4: native },
        created_at: null,
        updated_at: native.fetchedAt,
        event_id: native.eventId,
        event_venue: "hyperliquid",
        venue_event_id: String(native.questionId ?? native.outcome),
        event_title: native.eventTitle,
        event_description: null,
        event_category: null,
        event_status: native.status === "observed" ? "ACTIVE" : "CLOSED",
        event_duration_minutes: null,
        start_date: null,
        end_date: native.expiry,
        event_volume_total: null,
        event_volume_24h: null,
        event_liquidity: null,
        event_open_interest: null,
        event_slug: null,
        event_image: null,
        event_icon: null,
        event_metadata: { hip4Environment: native.environment },
      });
    }
  }
  return result.sort(
    (left, right) =>
      input.tokenIds.indexOf(left.token_id) -
      input.tokenIds.indexOf(right.token_id),
  );
}
