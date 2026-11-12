import type { Pool } from "@hunch/infra";
import { discoveryReadOnly } from "./discovery.js";
import { canonicalMarketTokenIdSql } from "./canonical-market-token-sql.js";
import { buildWalletMmSuspectedSql } from "../services/wallet-intel-mm.js";
import { walletIntelProtocolAddresses } from "../services/wallet-intel-protocol-addresses.js";
import { buildWalletOwnerResolutionJoinSql } from "../services/wallet-owner-resolution-sql.js";
import { publicHolderLabel } from "../services/hunch-public-presentation.js";
import { units, type Market } from "../services/trader-collection-ledger.js";
import type { Owner } from "../services/trader-collection-ranking.js";

// Bound the driving index walk BEFORE eligibility filters/joins, not after.
export const TRADER_COHORT_SQL = `WITH recent_wallets AS MATERIALIZED (
 SELECT s.wallet_id,s.last_activity_at,s.hedge_ratio,s.hedged_notional_usd,s.two_sided_markets,s.exposure_usd,s.metrics_pnl_30d,s.metrics_resolved_edge_sample_count_30d
 FROM wallet_intel_selector_snapshot s WHERE s.last_activity_at <= $1::timestamptz
 AND s.last_activity_at > $1::timestamptz - interval '7 days'
 ORDER BY s.last_activity_at DESC,s.wallet_id DESC LIMIT 500)
 SELECT w.id::text AS id,w.address,coalesce(ws.owner_wallet_id,resolved_owner.owner_wallet_id,w.id)::text AS owner_family,
 CASE WHEN w.metadata#>>'{identityNames,polymarket,status}'='ok'
 THEN w.metadata#>>'{identityNames,polymarket,username}' END AS venue_name
 FROM recent_wallets s JOIN wallets w ON w.id=s.wallet_id LEFT JOIN wallet_onchain_state ws ON ws.wallet_id=w.id
 ${buildWalletOwnerResolutionJoinSql(true, "resolved_owner")}
 WHERE w.chain='polygon' AND w.address ~ '^0x[0-9a-fA-F]{40}$'
 AND NOT (lower(w.address)=ANY($3::text[]))
 AND s.metrics_pnl_30d>0 AND s.metrics_resolved_edge_sample_count_30d>=20
 AND EXISTS(SELECT 1 FROM wallet_tracking_subjects sub WHERE sub.wallet_id=w.id AND sub.venue='polymarket'
 AND sub.status='active' AND sub.source IN ('recent_top_holder','whale','signal_candidate'))
 AND NOT ${buildWalletMmSuspectedSql({ exposureUsdSql: "s.exposure_usd", hedgedNotionalUsdSql: "s.hedged_notional_usd", hedgeRatioSql: "s.hedge_ratio", twoSidedMarketsSql: "s.two_sided_markets", exposureThresholdSql: "$2::numeric" })}
 ORDER BY s.last_activity_at DESC,s.wallet_id DESC LIMIT 50`;
// Check frozen bindings for every asset, including historical instruments.
// Defer event/category and venue checks, extract the protocol JSON only once,
// and look up a quote only when it can actually be exposed by markets().
export const TRADER_MARKETS_SQL = `WITH requested_assets AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS input_assets(t text,c text,i integer)
), mapped_assets AS MATERIALIZED (
 SELECT k.t,k.c,k.i,min(b.market_id) AS market_id,min(b.protocol_version) AS protocol_version,min(b.position_contract) AS position_contract
 FROM requested_assets k JOIN polymarket_asset_bindings b ON b.chain_id=137 AND b.asset_id=k.t AND b.condition_id=k.c AND b.outcome_index=k.i
 GROUP BY k.t,k.c,k.i HAVING count(*)=1), enriched_assets AS MATERIALIZED (
 SELECT k.t,k.c,k.i,'137:'||k.position_contract||':'||k.protocol_version AS generation,m.id,m.title,m.event_id,
 coalesce(nullif(lower(m.category),''),(SELECT nullif(lower(e.category),'') FROM unified_events e WHERE e.id=m.event_id),'other') AS category,
 CASE k.i WHEN 0 THEN 'YES' WHEN 1 THEN 'NO' END AS side,
 extract(epoch FROM least(m.close_time,m.expiration_time))::float8 AS tradable_until,
 (lower(m.condition_id)=k.c AND (m.resolved_outcome IS NOT NULL OR m.resolved_outcome_pct IS NOT NULL)) AS terminal,
 (m.status='ACTIVE' AND m.resolved_outcome IS NULL AND m.resolved_outcome_pct IS NULL
 AND (SELECT pm.accepting_orders AND pm.active AND NOT pm.closed AND NOT pm.archived FROM polymarket_markets pm WHERE pm.id=m.venue_market_id)
 AND (m.expiration_time IS NULL OR m.expiration_time>$2::timestamptz)
 AND (m.close_time IS NULL OR m.close_time>$2::timestamptz)
 AND lower(m.condition_id)=k.c AND protocol_row.protocol_doc->>'conditionId'=k.c
 AND protocol_row.protocol_doc->>'protocolVersion'=k.protocol_version
 AND lower(protocol_row.protocol_doc->>'positionContract')=k.position_contract
 AND (protocol_row.protocol_doc->'assets'->>k.i)=k.t
 AND k.t=CASE k.i WHEN 0 THEN ${canonicalMarketTokenIdSql("m", "YES")} WHEN 1 THEN ${canonicalMarketTokenIdSql("m", "NO")} END) AS active
 FROM mapped_assets k JOIN unified_markets m ON m.id=k.market_id AND m.venue='polymarket'
 CROSS JOIN LATERAL (SELECT CASE WHEN m.status='ACTIVE' THEN m.metadata->'polymarketProtocol' END AS protocol_doc OFFSET 0) protocol_row
 ) SELECT enriched.*,q.best_ask::text AS ask,extract(epoch FROM q.ts)::bigint::text AS quote_at
 FROM enriched_assets enriched LEFT JOIN LATERAL (
 SELECT q.best_ask,q.ts FROM unified_token_top_latest q
 WHERE enriched.active IS TRUE AND q.token_id=enriched.t AND q.venue='polymarket' OFFSET 0
 ) q ON true`;
export type Asset = {
  token: string;
  condition: string;
  index: number;
  label: string;
};
// The provider supplies no ledger contract: all three fields must identify a
// unique frozen binding. Never merge conflicting indices before that check.
export const assetKey = (v: {
  condition: string;
  token: string;
  index: number | null;
}) => `${v.condition}:${v.token}:${v.index}`;
export class TraderRepository {
  constructor(private db: Pick<Pool, "connect">) {}
  owners(end: number, whaleUsd: number): Promise<Owner[]> {
    return discoveryReadOnly(this.db, async (c) =>
      (
        await c.query<{
          id: string;
          address: string;
          owner_family: string;
          venue_name: string | null;
        }>(TRADER_COHORT_SQL, [
          new Date(end * 1000),
          whaleUsd,
          walletIntelProtocolAddresses(),
        ])
      ).rows.map((r) => ({
        id: r.id,
        address: r.address,
        family: r.owner_family,
        name: publicHolderLabel(r.venue_name, r.address)?.slice(0, 80) ?? null,
      })),
    );
  }
  async markets(assets: Asset[], end: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = new Map<string, Market>();
    const unique = [...new Map(assets.map((a) => [assetKey(a), a])).values()];
    for (let i = 0; i < unique.length; i += 250) {
      signal?.throwIfAborted();
      const batch = unique.slice(i, i + 250);
      const labels = new Map(batch.map((a) => [assetKey(a), a.label]));
      const rows = await discoveryReadOnly(
        this.db,
        async (c) =>
          (
            await c.query(TRADER_MARKETS_SQL, [
              JSON.stringify(
                batch.map((a) => ({ t: a.token, c: a.condition, i: a.index })),
              ),
              new Date(end * 1000),
            ])
          ).rows,
      );
      signal?.throwIfAborted();
      for (const r of rows) {
        const key = assetKey({ token: r.t, condition: r.c, index: r.i });
        if (!r.event_id) continue;
        result.set(key, {
          condition: r.c,
          index: r.i,
          category: /^[a-z0-9_-]{1,48}$/.test(r.category)
            ? r.category
            : "other",
          active: r.active === true,
          terminal: r.terminal === true,
          tradableUntil: Number.isFinite(r.tradable_until)
            ? r.tradable_until
            : null,
          ask: r.active !== true || r.ask === null ? null : units(r.ask),
          quoteAt:
            r.active !== true || r.quote_at === null
              ? null
              : Number(r.quote_at),
          instrument: {
            venue: "polymarket",
            marketId: r.id,
            eventId: r.event_id,
            title: r.title,
            tokenId: r.t,
            generation: r.generation,
            side: r.side,
            outcomeLabel: labels.get(key) || r.side,
          },
        });
      }
    }
    return result;
  }
}
