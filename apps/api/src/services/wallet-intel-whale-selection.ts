import { buildWalletIntelTrackableMarketSql } from "./wallet-intel-market-eligibility.js";

/** Keep the complete activity window, but hydrate only its distinct market IDs.
 * The materialization prevents a misestimated market scan from rebuilding the
 * activity aggregate for every market. The lateral fence keeps hydration on the
 * market PK instead of scanning all active markets (190k+ on production).
 * OFFSET 0 is a PostgreSQL optimization fence, not result pagination/truncation.
 */
export const WALLET_INTEL_WHALE_MARKETS_SQL = `
  WITH whale_markets AS MATERIALIZED (
    SELECT DISTINCT wah.market_id
    FROM wallet_activity_hourly wah
    JOIN wallet_tag_map tm ON tm.wallet_id = wah.wallet_id
    JOIN wallet_tags t ON t.id = tm.tag_id AND t.slug = 'whale'
    WHERE wah.hour_bucket >= $2::timestamptz - interval '7 days'
      AND wah.activity_type IN ('delta', 'trade')
      AND wah.market_id IS NOT NULL
  )
  SELECT um.id, um.venue, um.volume_24h
  FROM whale_markets wm
  CROSS JOIN LATERAL (
    SELECT market_row.id, market_row.venue, market_row.volume_24h, market_row.event_id
    FROM unified_markets market_row
    WHERE market_row.id = wm.market_id
      AND ${buildWalletIntelTrackableMarketSql({
        marketAlias: "market_row",
        eventAlias: null,
        asOfSql: "$2::timestamptz",
      })}
      AND market_row.venue = ANY($3::text[])
      AND (market_row.venue != 'kalshi' OR market_row.is_initialized IS TRUE)
    OFFSET 0
  ) um
  LEFT JOIN unified_events ue ON ue.id = um.event_id
  WHERE ue.id IS NULL OR (
    ue.status = 'ACTIVE'
    AND (ue.end_date IS NULL OR ue.end_date > $2::timestamptz)
  )
  ORDER BY um.volume_24h DESC NULLS LAST, um.id
  LIMIT $1
`;
