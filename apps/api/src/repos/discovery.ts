import type { Pool, PoolClient } from "@hunch/infra";
import { canonicalMarketTokenIdSql } from "./canonical-market-token-sql.js";
import { buildWalletOwnerResolutionJoinSql } from "../services/wallet-owner-resolution-sql.js";
import { buildWalletMmSuspectedSql } from "../services/wallet-intel-mm.js";
import type { RawDiscoveryRow } from "../services/discovery-domain.js";

// Keep this predicate identical to the existing partial public-note indexes.
export const DISCOVERY_PUBLIC_NOTES_SQL = `n.producer_type='holder_research' AND n.source_kind='market'
 AND n.status<>'retracted' AND ((n.note_type='signal'
 AND n.metrics #>> '{publicationDecisionV1,status}'='PUBLISH'
 AND n.metrics #>> '{publicationDecisionV1,authority}'='holder_research_quality_gate')
 OR (n.note_type='context' AND n.metrics ? 'publicContextV1'))`;
const noteColumns = `n.id,n.source_id,n.source_kind,n.producer_type,n.note_type,n.status,
 n.title,n.description,n.created_at,n.lineage,n.metrics,n.model_meta`;
export const DISCOVERY_RESEARCH_PAGE_SQL = `SELECT ${noteColumns} FROM ai_notes n
 WHERE ${DISCOVERY_PUBLIC_NOTES_SQL} AND n.status='active' AND n.note_type='signal'
 AND n.created_at>=$1::timestamptz-interval '7 days' AND n.created_at<=$1::timestamptz
 AND ($2::timestamptz IS NULL OR (n.created_at,n.id)<($2::timestamptz,$3::uuid))
 ORDER BY n.created_at DESC,n.id DESC LIMIT 300`;
export const DISCOVERY_RESEARCH_CURRENT_SQL = `SELECT note_row.* FROM unnest($1::text[]) requested(market_id)
 JOIN LATERAL (SELECT ${noteColumns} FROM ai_notes n WHERE n.source_id=requested.market_id
 AND ${DISCOVERY_PUBLIC_NOTES_SQL} AND n.status='active' AND n.note_type='signal'
 AND n.created_at>=$2::timestamptz-interval '7 days' AND n.created_at<=$2::timestamptz
 ORDER BY n.created_at DESC,n.id DESC LIMIT 1) note_row ON true`;

export const DISCOVERY_QUICK_POOL_SQL = `WITH metric_page AS MATERIALIZED (
 SELECT metric.market_id,metric.volume_last_24h,metric.volume_last_24h::text AS volume_24h_usd,metric.liquidity_now,metric.venue
 FROM unified_market_activity_metrics_24h metric
 WHERE metric.volume_valid AND metric.volume_last_24h>0
 AND metric.volume_last_24h<=coalesce($2::numeric,'Infinity'::numeric)
 AND (metric.volume_last_24h,metric.market_id)<(coalesce($2::numeric,'Infinity'::numeric),coalesce($3::text,''))
 ORDER BY metric.volume_last_24h DESC,metric.market_id DESC LIMIT 500
)
 SELECT metric.market_id AS source_market_id,metric.volume_24h_usd,
 market_row.id AS market_id,market_row.expiration_time,market_row.liquidity::text AS liquidity_usd
 FROM metric_page metric LEFT JOIN LATERAL (
 SELECT market_row.id,market_row.expiration_time,market_row.liquidity
 FROM unified_markets market_row WHERE market_row.id=metric.market_id
 AND market_row.status='ACTIVE' AND market_row.resolved_outcome IS NULL
 AND metric.venue=ANY($1::text[]) AND metric.liquidity_now>=1000
 AND market_row.liquidity>=1000 AND market_row.expiration_time>$4::timestamptz
 AND market_row.expiration_time<=$4::timestamptz+interval '7 days' OFFSET 0
 ) market_row ON true ORDER BY metric.volume_last_24h DESC,metric.market_id DESC`;

const marketColumns = `m.id,m.event_id,m.venue,m.title,m.category,m.status,m.resolved_outcome,m.resolved_outcome_pct,
 m.outcomes,m.expiration_time,m.close_time,m.updated_at,m.liquidity::text AS liquidity_usd,
 e.title AS event_title,e.status AS event_status,e.end_date AS event_end_time,
 coalesce(m.image,e.image) AS image,pm.accepting_orders AS pm_accepting_orders,
 pm.active AS pm_active,pm.closed AS pm_closed,pm.archived AS pm_archived,
 selected_side.side,selected_side.token_id,quote_row.best_bid::text,quote_row.best_ask::text,quote_row.ts AS quote_at`;
const marketJoins = `FROM unnest($1::text[]) requested(market_id)
 JOIN unified_markets m ON m.id=requested.market_id
 LEFT JOIN unified_events e ON e.id=m.event_id
 LEFT JOIN polymarket_markets pm ON m.venue='polymarket' AND pm.id=m.venue_market_id
 CROSS JOIN LATERAL (VALUES ('YES',${canonicalMarketTokenIdSql("m", "YES")}),('NO',${canonicalMarketTokenIdSql("m", "NO")})) selected_side(side,token_id)
 LEFT JOIN unified_token_top_latest quote_row ON quote_row.token_id=selected_side.token_id`;
export const DISCOVERY_MARKET_QUOTES_SQL = `SELECT ${marketColumns},
 jsonb_build_object('dflowNativeAcceptingOrders',m.metadata->'dflowNativeAcceptingOrders') AS metadata ${marketJoins}`;
export const DISCOVERY_MARKET_CARDS_SQL = `SELECT ${marketColumns},m.description,
 CASE WHEN activity_metric.volume_valid THEN activity_metric.volume_last_24h::text ELSE NULL END AS volume_24h_usd,
 jsonb_build_object('polymarketProtocol',m.metadata->'polymarketProtocol',
 'dflowNativeAcceptingOrders',m.metadata->'dflowNativeAcceptingOrders','version',m.metadata->'version',
 'resolutionStatus',m.metadata->'resolutionStatus','umaResolutionStatus',m.metadata->'umaResolutionStatus',
 'umaResolutionStatuses',m.metadata->'umaResolutionStatuses') AS metadata ${marketJoins}
 LEFT JOIN unified_market_activity_metrics_24h activity_metric ON activity_metric.market_id=m.id`;

export const DISCOVERY_WALLET_PAGE_SQL = `WITH wallet_page AS MATERIALIZED (
 SELECT s.wallet_id,s.last_activity_at,s.metrics_pnl_30d,s.metrics_resolved_edge_sample_count_30d,
 s.metrics_resolved_win_rate_edge_30d,s.metrics_as_of,s.exposure_usd,s.hedged_notional_usd,s.hedge_ratio,s.two_sided_markets
 FROM wallet_intel_selector_snapshot s WHERE s.last_activity_at>=$1::timestamptz-interval '7 days'
 AND s.last_activity_at<=coalesce($2::timestamptz,$1::timestamptz+interval '5 minutes')
 AND (s.last_activity_at,s.wallet_id)<(coalesce($2::timestamptz,'infinity'::timestamptz),coalesce($3::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
 ORDER BY s.last_activity_at DESC,s.wallet_id DESC LIMIT 500
),qualified_wallets AS MATERIALIZED (
 SELECT s.wallet_id,s.metrics_pnl_30d::text,s.metrics_resolved_edge_sample_count_30d,
 s.metrics_resolved_win_rate_edge_30d::text,s.metrics_as_of
 FROM wallet_page s JOIN wallets qualified_wallet ON qualified_wallet.id=s.wallet_id
 WHERE s.metrics_as_of>=$1::timestamptz-interval '24 hours'
 AND s.metrics_as_of<=$1::timestamptz+interval '5 minutes'
 AND s.metrics_pnl_30d>0 AND s.metrics_resolved_edge_sample_count_30d>=20 AND s.metrics_resolved_win_rate_edge_30d>0
 AND NOT ${buildWalletMmSuspectedSql({ exposureUsdSql: "s.exposure_usd", hedgedNotionalUsdSql: "s.hedged_notional_usd", hedgeRatioSql: "s.hedge_ratio", twoSidedMarketsSql: "s.two_sided_markets", exposureThresholdSql: "CASE WHEN qualified_wallet.chain='solana' THEN $5::numeric ELSE $4::numeric END" })}
)
 SELECT source_row.wallet_id AS source_wallet_id,source_row.last_activity_at AS source_activity_at,
 qualified.*,coalesce(onchain.owner_wallet_id,resolved_owner.owner_wallet_id,qualified.wallet_id)::text AS owner_key,
 w.address,w.metadata#>>'{identityNames,primary,name}' AS identity_display_name,
 w.metadata#>>'{identityNames,primary,source}' AS identity_display_name_source,wp.profile->>'label_short' AS profile_label
 FROM wallet_page source_row LEFT JOIN qualified_wallets qualified ON qualified.wallet_id=source_row.wallet_id
 LEFT JOIN wallets w ON w.id=qualified.wallet_id
 LEFT JOIN wallet_onchain_state onchain ON onchain.wallet_id=w.id
 LEFT JOIN wallet_profiles wp ON wp.wallet_id=w.id
 ${buildWalletOwnerResolutionJoinSql(true, "resolved_owner")} ORDER BY source_row.last_activity_at DESC,source_row.wallet_id DESC`;

export const DISCOVERY_SMART_INPUTS_SQL = `WITH requested_wallets AS MATERIALIZED (SELECT unnest($1::uuid[]) AS wallet_id),
 valid_rollups AS MATERIALIZED (
 SELECT requested.wallet_id,exposure.open_positions FROM requested_wallets requested
 JOIN wallet_position_exposure exposure ON exposure.wallet_id=requested.wallet_id
 WHERE exposure.open_positions_version=1 AND exposure.as_of>=$2::timestamptz-interval '24 hours'
 AND exposure.as_of<=$2::timestamptz
 AND NOT EXISTS(SELECT 1 FROM wallet_position_snapshots newer WHERE newer.wallet_id=requested.wallet_id
 AND newer.snapshot_at>exposure.as_of AND newer.snapshot_at<=$2::timestamptz)
), current_positions AS MATERIALIZED (
 SELECT r.wallet_id,position_row.venue,position_row."marketId" AS market_id,position_row."outcomeSide" AS side,
 position_row.shares::text AS shares,position_row."sizeUsd"::text AS value_usd,position_row."snapshotAt" AS snapshot_at
 FROM valid_rollups r CROSS JOIN LATERAL jsonb_to_recordset(r.open_positions)
 AS position_row(venue text,"marketId" text,"outcomeSide" text,shares numeric,"sizeUsd" numeric,"snapshotAt" timestamptz)
 WHERE position_row.venue=ANY($3::text[]) AND position_row."snapshotAt">=$2::timestamptz-interval '24 hours'
 AND position_row."snapshotAt"<=$2::timestamptz
 UNION ALL
 SELECT requested.wallet_id,snapshot_row.venue,snapshot_row.market_id,snapshot_row.outcome_side,
 snapshot_row.shares::text,snapshot_row.size_usd::text,snapshot_row.snapshot_at
 FROM requested_wallets requested CROSS JOIN unnest($3::text[]) venue_row(venue)
 JOIN LATERAL (SELECT snapshot_at FROM wallet_position_snapshots latest
 WHERE latest.wallet_id=requested.wallet_id AND latest.venue=venue_row.venue
 AND latest.snapshot_at>=$2::timestamptz-interval '24 hours' AND latest.snapshot_at<=$2::timestamptz
 ORDER BY latest.snapshot_at DESC LIMIT 1) latest ON true
 JOIN wallet_position_snapshots snapshot_row ON snapshot_row.wallet_id=requested.wallet_id
 AND snapshot_row.venue=venue_row.venue AND snapshot_row.snapshot_at=latest.snapshot_at
 WHERE NOT EXISTS(SELECT 1 FROM valid_rollups r WHERE r.wallet_id=requested.wallet_id)
), net_changes AS MATERIALIZED (
 SELECT requested.wallet_id,activity_row.venue,activity_row.market_id,activity_row.outcome_side AS side,
 sum(CASE WHEN activity_row.action='BUY' THEN abs(activity_row.delta_shares)
 WHEN activity_row.action='SELL' THEN -abs(activity_row.delta_shares) ELSE 0 END)::text AS net_shares,
 max(activity_row.occurred_at) AS observed_at
 FROM requested_wallets requested JOIN wallet_activity_events activity_row ON activity_row.wallet_id=requested.wallet_id
 WHERE activity_row.occurred_at>=$2::timestamptz-interval '24 hours' AND activity_row.occurred_at<=$2::timestamptz
 AND activity_row.source='snapshot_delta' AND activity_row.activity_type='delta'
 AND activity_row.outcome_side IN ('YES','NO') AND activity_row.venue=ANY($3::text[])
 GROUP BY requested.wallet_id,activity_row.venue,activity_row.market_id,activity_row.outcome_side
)
 SELECT (SELECT coalesce(jsonb_agg(current_positions),'[]'::jsonb) FROM current_positions) AS positions,
 (SELECT coalesce(jsonb_agg(net_changes),'[]'::jsonb) FROM net_changes) AS changes`;

/** Include known siblings for netting and hedge vetoes even if their alpha metrics do not qualify. */
export const DISCOVERY_OWNER_FAMILY_SQL = `WITH owner_rows AS MATERIALIZED (
 SELECT id,address,chain FROM wallets WHERE id=ANY($1::uuid[])
)
 SELECT owner_row.id AS wallet_id,owner_row.id::text AS owner_key,owner_row.address AS owner_address,owner_row.chain AS owner_chain FROM owner_rows owner_row
 UNION
 SELECT linked.wallet_id,owner_row.id::text,owner_row.address,owner_row.chain FROM owner_rows owner_row
 JOIN wallet_onchain_state linked ON linked.owner_wallet_id=owner_row.id`;
// Metadata-only links have no owner-expression index. Page the raw wallet PK, not matches.
export const DISCOVERY_OWNER_METADATA_SQL = `SELECT id,chain,
 coalesce(metadata->>'ownerAddress',metadata->>'linkedOwnerAddress') AS owner_address
 FROM wallets WHERE id>coalesce($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY id LIMIT 2000`;

export const DISCOVERY_PROJECTION_SQL = `SELECT max(stats.last_successful_finish) AS refreshed_at
 FROM timescaledb_information.jobs jobs JOIN timescaledb_information.job_stats stats ON stats.job_id=jobs.job_id
 WHERE jobs.proc_name IN ('refresh_unified_market_activity_metrics_1h_full_job','refresh_unified_market_activity_metrics_1h_job')`;

/** No query in this repository can write, even if a future helper is accidentally changed. */
export async function discoveryReadOnly<T>(
  pool: Pick<Pool, "connect">,
  work: (client: PoolClient) => Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','1000',true),set_config('jit','off',true)",
      [String(timeoutMs)],
    );
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
// Background-only, bounded note batches. Read the latest complete wallet batch, not
// the last time the particular market appeared (which would resurrect closed positions).
export const DISCOVERY_ESTIMATE_INPUTS_SQL = `SELECT n.id AS note_id,
 representative.target_id AS wallet_id, representative.holder_side,
 stats.metrics_resolved_actual_win_rate_30d::text AS actual_win_rate,
 stats.metrics_resolved_expected_win_rate_30d::text AS expected_win_rate,
 stats.metrics_resolved_edge_sample_count_30d AS sample_size, stats.metrics_as_of,
 latest_batch.snapshot_at AS position_as_of, holding.shares::text AS position_shares,
 CASE WHEN n.lineage->>'side'='YES' THEN n.metrics#>>'{sides,YES,sharpUsd}' ELSE n.metrics#>>'{sides,NO,sharpUsd}' END AS selected_support_usd,
 CASE WHEN n.lineage->>'side'='YES' THEN n.metrics#>>'{sides,NO,sharpUsd}' ELSE n.metrics#>>'{sides,YES,sharpUsd}' END AS opposite_support_usd
 FROM unnest($1::uuid[]) requested(note_id)
 JOIN ai_notes n ON n.id=requested.note_id
 LEFT JOIN LATERAL (
   SELECT t.target_id, t.target_meta->>'side' AS holder_side
   FROM ai_note_targets t WHERE t.note_id=n.id AND t.target_kind='wallet'
   AND t.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND (nullif(n.model_meta#>>'{primary_holder_credentials,primaryHolder,walletId}','') IS NULL
     OR t.target_id=n.model_meta#>>'{primary_holder_credentials,primaryHolder,walletId}')
   ORDER BY t.target_rank,t.target_id LIMIT 1
 ) representative ON true
 LEFT JOIN wallet_intel_selector_snapshot stats ON stats.wallet_id=representative.target_id::uuid
 LEFT JOIN LATERAL (
   SELECT ws.snapshot_at FROM wallet_position_snapshots ws
   WHERE ws.wallet_id=representative.target_id::uuid AND ws.venue=split_part(n.source_id,':',1)
   ORDER BY ws.snapshot_at DESC LIMIT 1
 ) latest_batch ON true
 LEFT JOIN LATERAL (
   SELECT sum(ws.shares) AS shares FROM wallet_position_snapshots ws
   WHERE ws.wallet_id=representative.target_id::uuid AND ws.venue=split_part(n.source_id,':',1)
   AND ws.snapshot_at=latest_batch.snapshot_at AND ws.market_id=n.source_id
   AND ws.outcome_side=n.lineage->>'side'
   AND (
     EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ws.metadata->'assets')='array' THEN ws.metadata->'assets' ELSE '[]'::jsonb END) asset_entry
       WHERE asset_entry->>'tokenId'=n.metrics#>>'{socialInstrumentV1,tokenId}'
       AND (split_part(n.source_id,':',1)='kalshi' OR lower(asset_entry->>'positionContract')=split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',2))
       AND CASE WHEN asset_entry->>'shares' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (asset_entry->>'shares')::numeric>0 ELSE false END
     ) OR (
       NOT (coalesce(ws.metadata,'{}'::jsonb) ? 'assets')
       AND ws.metadata->>'tokenId'=n.metrics#>>'{socialInstrumentV1,tokenId}'
       AND (split_part(n.source_id,':',1)='kalshi'
         OR lower(nullif(btrim(ws.metadata->>'positionContract'),''))=split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',2)
         OR (split_part(n.source_id,':',1)='polymarket' AND nullif(btrim(ws.metadata->>'positionContract'),'') IS NULL))
       AND (split_part(n.source_id,':',1)<>'polymarket' OR nullif(btrim(ws.metadata->>'positionContract'),'') IS NOT NULL OR (
         EXISTS (SELECT 1 FROM polymarket_asset_bindings binding_row
           WHERE binding_row.asset_id=ws.metadata->>'tokenId' AND binding_row.chain_id=137
           AND binding_row.market_id=n.source_id
           AND binding_row.outcome_index=CASE n.lineage->>'side' WHEN 'YES' THEN 0 ELSE 1 END
           AND binding_row.position_contract=split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',2)
           AND binding_row.protocol_version=split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',3))
         AND NOT EXISTS (SELECT 1 FROM polymarket_asset_bindings conflicting_binding
           WHERE conflicting_binding.asset_id=ws.metadata->>'tokenId' AND conflicting_binding.chain_id=137
           AND (conflicting_binding.position_contract<>split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',2)
             OR conflicting_binding.protocol_version<>split_part(n.metrics#>>'{socialInstrumentV1,generation}',':',3)))
       ))
     )
   )
 ) holding ON true
 WHERE ${DISCOVERY_PUBLIC_NOTES_SQL} AND n.status='active' AND n.note_type='signal'`;

export class DiscoveryRepository {
  constructor(readonly pool: Pick<Pool, "connect">) {}
  query(
    sql: string,
    params: unknown[],
    timeout = 5000,
  ): Promise<RawDiscoveryRow[]> {
    return discoveryReadOnly(
      this.pool,
      async (client) => (await client.query(sql, params)).rows,
      timeout,
    );
  }
  marketCards(ids: string[], light = false) {
    if (ids.length > 100) throw Error("discovery_batch_too_large");
    return ids.length
      ? this.query(
          light ? DISCOVERY_MARKET_QUOTES_SQL : DISCOVERY_MARKET_CARDS_SQL,
          [ids],
          1500,
        )
      : Promise.resolve([]);
  }
  currentResearch(ids: string[], now: string) {
    if (ids.length > 100) throw Error("discovery_batch_too_large");
    return ids.length
      ? this.query(DISCOVERY_RESEARCH_CURRENT_SQL, [ids, now], 1500)
      : Promise.resolve([]);
  }
  estimateInputs(noteIds: string[]) {
    if (noteIds.length > 100) throw Error("discovery_batch_too_large");
    return noteIds.length
      ? this.query(DISCOVERY_ESTIMATE_INPUTS_SQL, [noteIds])
      : Promise.resolve([]);
  }
}
