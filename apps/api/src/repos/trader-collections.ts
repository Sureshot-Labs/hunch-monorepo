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
// Shortlist hints only: a positive share delta is not an executed buy.
export const publicSourcesSql =
  "('polymarket','auto_tracked_wallet','alchemy','followed_wallet')";
export const tokenSql = (doc: string) =>
  `CASE WHEN NOT (${doc} ? 'assets') THEN coalesce(${doc}->>'onchainTokenId',${doc}->>'tokenId') WHEN jsonb_typeof(${doc}->'assets')='array' THEN CASE WHEN jsonb_array_length(${doc}->'assets')=1 THEN ${doc}#>>'{assets,0,tokenId}' END END`;
export const contractSql = (doc: string) =>
  `lower(coalesce(${doc}#>>'{assets,0,positionContract}',${doc}->>'positionContract',''))`;
const actualZero = `EXISTS(SELECT 1 FROM wallet_position_snapshots ws WHERE ws.wallet_id=a.wallet_id AND ws.venue=a.venue AND ws.market_id=a.market_id AND ws.outcome_side=a.outcome_side AND ws.snapshot_at=a.occurred_at AND ws.shares=0 AND ws.metadata->>'source' IN ${publicSourcesSql})`;
const largePurchaseHint = `a.occurred_at>$1::timestamptz-interval '24 hours' AND a.action='BUY' AND a.size_usd >= 500 AND a.size_usd < 'Infinity'::numeric AND a.delta_shares>0 AND a.delta_shares<'Infinity'::numeric`;
export const TRADER_COHORT_SQL = `WITH recent_wallets AS MATERIALIZED (
 SELECT s.wallet_id,s.last_activity_at,s.hedge_ratio,s.hedged_notional_usd,s.two_sided_markets,s.exposure_usd,s.metrics_pnl_30d,s.metrics_resolved_edge_sample_count_30d
 FROM wallet_intel_selector_snapshot s WHERE s.last_activity_at <= $1::timestamptz
 AND s.last_activity_at > $1::timestamptz - interval '7 days'
 ORDER BY s.last_activity_at DESC,s.wallet_id DESC LIMIT 2000), eligible_wallets AS MATERIALIZED (
 SELECT w.id AS wallet_id,s.last_activity_at,w.address,coalesce(ws.owner_wallet_id,resolved_owner.owner_wallet_id,w.id)::text AS owner_family,
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
 ), hinted_wallets AS MATERIALIZED (
 SELECT e.*,h.closed_at,h.purchase_usd,h.purchase_at FROM eligible_wallets e
 CROSS JOIN LATERAL (
   SELECT greatest(max(a.occurred_at) FILTER (WHERE a.occurred_at>$1::timestamptz-interval '24 hours' AND a.action='SELL' AND
     a.metadata->>'prevShares' ~ '^([1-9][0-9]*([.][0-9]+)?|0[.]0*[1-9][0-9]*)$'
     AND a.metadata->>'currShares' ~ '^0([.]0+)?$' AND ${actualZero}), max(settlement.resolution_observed_at)) AS closed_at,
     max(a.size_usd) FILTER (WHERE ${largePurchaseHint}) AS purchase_usd,
     max(a.occurred_at) FILTER (WHERE ${largePurchaseHint}) AS purchase_at
   FROM (SELECT wact.wallet_id,wact.market_id,wact.outcome_side,wact.occurred_at,wact.venue,wact.activity_type,wact.action,wact.metadata,wact.size_usd,wact.source,wact.delta_shares
         FROM wallet_activity_events wact WHERE wact.wallet_id=e.wallet_id AND wact.occurred_at<=$1::timestamptz
         AND wact.occurred_at>$1::timestamptz-interval '30 days'
         ORDER BY wact.occurred_at DESC,wact.id DESC LIMIT 32) a
   LEFT JOIN LATERAL (SELECT m.resolution_observed_at FROM unified_markets m WHERE m.id=a.market_id
    AND m.venue='polymarket' AND a.action='BUY' AND a.outcome_side IN ('YES','NO') AND m.resolved_outcome::text IN ('YES','NO')
    AND m.resolution_observed_at BETWEEN a.occurred_at AND $1::timestamptz
    AND m.resolution_observed_at>$1::timestamptz-interval '24 hours' OFFSET 0) settlement ON true
   WHERE a.venue='polymarket' AND a.activity_type='delta' AND a.source='snapshot_delta' AND a.metadata->>'snapshotSource' IN ${publicSourcesSql}
 ) h
 ), lane_slots AS (
 SELECT wallet_id,(n-1)/2*5+(n-1)%2 AS slot_number FROM
   (SELECT wallet_id,row_number() OVER (ORDER BY closed_at DESC,wallet_id DESC) AS n FROM hinted_wallets WHERE closed_at IS NOT NULL) closers
 UNION ALL
 SELECT wallet_id,(n-1)/2*5+(n-1)%2+2 FROM
   (SELECT wallet_id,row_number() OVER (ORDER BY purchase_usd DESC,purchase_at DESC,wallet_id DESC) AS n FROM hinted_wallets WHERE purchase_usd IS NOT NULL) buyers
 UNION ALL
 SELECT wallet_id,(row_number() OVER (ORDER BY last_activity_at DESC,wallet_id DESC)-1)*5+4 FROM hinted_wallets
 ), selected_wallets AS (
 SELECT wallet_id,min(slot_number) AS first_slot FROM lane_slots GROUP BY wallet_id ORDER BY first_slot,wallet_id DESC LIMIT $4::int)
 SELECT h.wallet_id::text AS id,h.address,h.owner_family,h.venue_name FROM selected_wallets s
 JOIN hinted_wallets h ON h.wallet_id=s.wallet_id ORDER BY s.first_slot,h.wallet_id DESC`;
// Check frozen bindings for every asset, including historical instruments.
// Defer event/category and venue checks, extract the protocol JSON only once,
// and look up a quote only when it can actually be exposed by markets().
const marketLookupSql = (
  local: boolean,
) => `WITH requested_assets AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS input_assets(t text,c text,i integer)
), mapped_assets AS MATERIALIZED (
 SELECT k.t,${local ? "min(b.condition_id) AS c" : "k.c"},k.i,min(b.market_id) AS market_id,min(b.protocol_version) AS protocol_version,min(b.position_contract) AS position_contract
 FROM requested_assets k JOIN polymarket_asset_bindings b ON b.chain_id=137 AND b.asset_id=k.t AND ${local ? "b.market_id=k.c" : "b.condition_id=k.c"} AND b.outcome_index=k.i
 GROUP BY k.t,k.c,k.i HAVING count(*)=1), enriched_assets AS MATERIALIZED (
 SELECT k.t,k.c,k.i,'137:'||k.position_contract||':'||k.protocol_version AS generation,m.id,m.title,m.event_id,
 event_row.title AS event_title,coalesce(nullif(lower(m.category),''),nullif(lower(event_row.category),''),'other') AS category,
 CASE k.i WHEN 0 THEN 'YES' WHEN 1 THEN 'NO' END AS side,
 extract(epoch FROM least(m.close_time,m.expiration_time))::float8 AS tradable_until,
 ${
   local
     ? `protocol_row.protocol_doc->'assets'->>(1-k.i) AS opposite_token,
 CASE WHEN lower(m.condition_id)=k.c AND m.resolution_observed_at <= $2::timestamptz AND
 ((m.resolved_outcome::text='YES' AND (m.resolved_outcome_pct IS NULL OR m.resolved_outcome_pct=10000)) OR
 (m.resolved_outcome::text='NO' AND (m.resolved_outcome_pct IS NULL OR m.resolved_outcome_pct=0))) THEN m.resolved_outcome::text END AS winner,
 extract(epoch FROM m.resolution_observed_at)::float8 AS resolved_at,`
     : ""
 }
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
 LEFT JOIN LATERAL (SELECT e.title,e.category FROM unified_events e WHERE e.id=m.event_id OFFSET 0) event_row ON true
 CROSS JOIN LATERAL (SELECT CASE WHEN m.status='ACTIVE' THEN m.metadata->'polymarketProtocol' END AS protocol_doc OFFSET 0) protocol_row
 ) SELECT enriched.*,q.best_ask::text AS ask,${local ? "q.best_bid::text AS mark_bid," : ""}extract(epoch FROM q.ts)::bigint::text AS quote_at
 FROM enriched_assets enriched LEFT JOIN LATERAL (
 SELECT q.best_ask,${local ? "q.best_bid," : ""}q.ts FROM unified_token_top_latest q
 WHERE enriched.active IS TRUE AND q.token_id=enriched.t AND q.venue='polymarket' OFFSET 0
 ) q ON true`;
export const TRADER_MARKETS_SQL = marketLookupSql(false);
export const TRADER_LOCAL_MARKETS_SQL = marketLookupSql(true);
// Page raw index entries first; do not scan past the cap looking for qualifying
// deltas. The cursor is the exact PG timestamp (never a JS millisecond Date) + PK.
export const TRADER_LOCAL_PAGE_SQL = `WITH activity_page AS MATERIALIZED (
 SELECT a.* FROM wallet_activity_events a WHERE a.wallet_id=$1::uuid AND a.occurred_at >= $2::timestamptz
 AND (a.occurred_at,a.id)>($2::timestamptz,$3::uuid) AND a.occurred_at <= $4::timestamptz
 AND a.created_at <= $4::timestamptz ORDER BY a.occurred_at,a.id LIMIT 1000)
 SELECT a.occurred_at::text AS stamp,a.id::text AS id,extract(epoch FROM a.occurred_at)::float8 AS observed_seconds,
  a.venue,a.market_id,a.outcome_side AS side,a.activity_type,a.action,a.source,a.metadata->>'snapshotSource' AS observation_source,
  ${tokenSql("a.metadata")} AS token,${contractSql("a.metadata")} AS contract,
  a.metadata->>'prevShares' AS previous_shares,a.metadata->>'currShares' AS current_shares,a.delta_shares::text AS shares,a.price::text AS price,
  CASE WHEN a.source='snapshot_delta' AND a.action='SELL' AND a.metadata->>'currShares' ~ '^0([.]0+)?$'
    THEN ${actualZero} ELSE true END AS observed_balance,
  prev.price::text AS previous_mark,prev.snapshot_at IS NOT NULL AS has_prior_snapshot,extract(epoch FROM prev.snapshot_at)::float8 AS previous_seconds,
  CASE WHEN prev.snapshot_at IS NULL THEN false ELSE
   (prev.metadata->>'source' IN ${publicSourcesSql} AND ${tokenSql("prev.metadata")}=${tokenSql("a.metadata")}
    AND (${contractSql("prev.metadata")}='' OR ${contractSql("a.metadata")}='' OR ${contractSql("prev.metadata")}=${contractSql("a.metadata")})
    AND abs(prev.shares - CASE WHEN a.metadata->>'prevShares' ~ '^[0-9]{1,78}([.][0-9]{1,30})?$' THEN (a.metadata->>'prevShares')::numeric END)<=0.000001) IS TRUE END AS comparable_before
 FROM activity_page a LEFT JOIN LATERAL (SELECT ws.snapshot_at,ws.price,ws.metadata,ws.shares FROM wallet_position_snapshots ws
   WHERE a.venue='polymarket' AND a.source='snapshot_delta' AND a.metadata->>'snapshotSource' IN ${publicSourcesSql}
   AND ws.wallet_id=a.wallet_id AND ws.venue=a.venue AND ws.market_id=a.market_id
   AND ws.outcome_side=a.outcome_side AND ws.snapshot_at<a.occurred_at ORDER BY ws.snapshot_at DESC LIMIT 1) prev ON true ORDER BY a.occurred_at,a.id`;
export type LocalActivity = {
  stamp: string;
  id: string;
  observed_seconds: number;
  venue: string;
  market_id: string;
  side: string;
  activity_type: string;
  action: string;
  source: string;
  observation_source: string | null;
  token: string | null;
  contract: string;
  previous_shares: string | null;
  current_shares: string | null;
  shares: string | null;
  price: string | null;
  observed_balance: boolean | null;
  comparable_before: boolean;
  previous_mark: string | null;
  has_prior_snapshot: boolean;
  previous_seconds: number | null;
};
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
  owners(
    end: number,
    whaleUsd: number,
    limit: 50 | 100 = 50,
  ): Promise<Owner[]> {
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
          limit,
        ])
      ).rows.map((r) => ({
        id: r.id,
        address: r.address,
        family: r.owner_family,
        name: publicHolderLabel(r.venue_name, r.address)?.slice(0, 80) ?? null,
      })),
    );
  }
  localPage(walletId: string, stamp: string, id: string, end: number) {
    return discoveryReadOnly(
      this.db,
      async (c) =>
        (
          await c.query<LocalActivity>(TRADER_LOCAL_PAGE_SQL, [
            walletId,
            stamp,
            id,
            new Date(end * 1000),
          ])
        ).rows,
    );
  }
  async markets(
    assets: Asset[],
    end: number,
    signal?: AbortSignal,
    local = false,
  ) {
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
            await c.query(
              local ? TRADER_LOCAL_MARKETS_SQL : TRADER_MARKETS_SQL,
              [
                JSON.stringify(
                  batch.map((a) => ({
                    t: a.token,
                    c: a.condition,
                    i: a.index,
                  })),
                ),
                new Date(end * 1000),
              ],
            )
          ).rows,
      );
      signal?.throwIfAborted();
      for (const r of rows) {
        const key = assetKey({
          token: r.t,
          condition: local ? r.id : r.c,
          index: r.i,
        });
        if (!r.event_id) continue;
        result.set(key, {
          condition: r.c,
          index: r.i,
          category: /^[a-z0-9_-]{1,48}$/.test(r.category)
            ? r.category
            : "other",
          active: r.active === true,
          terminal: r.terminal === true,
          ...(local
            ? {
                oppositeToken: r.opposite_token ?? undefined,
                winner: r.winner,
                resolvedAt: r.resolved_at,
                markBid: r.mark_bid == null ? null : units(r.mark_bid),
              }
            : {}),
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
            eventTitle: r.event_title?.trim() || null,
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
