import type { Pool } from "@hunch/infra";
import { discoveryReadOnly } from "./discovery.js";
import {
  contractSql,
  publicSourcesSql,
  tokenSql,
} from "./trader-collections.js";
import { buildWalletOwnerResolutionJoinSql } from "../services/wallet-owner-resolution-sql.js";
import { buildWalletMmSuspectedSql } from "../services/wallet-intel-mm.js";
import { walletIntelProtocolAddresses } from "../services/wallet-intel-protocol-addresses.js";
import { publicHolderLabel } from "../services/hunch-public-presentation.js";

// The time BRIN bounds the source, independently of wallet_id. Filter exact
// decimal notional before fetching snapshots or enriching markets/owners.
export const MOVE_DAY_SQL = `SELECT a.wallet_id::text AS wallet,a.market_id AS market,
 a.outcome_side AS side,a.metadata->>'snapshotSource' AS provenance,a.metadata->>'prevShares' AS prev_qty,a.metadata->>'currShares' AS curr_qty,
 a.delta_shares::text AS shares,round(a.delta_shares*a.price,6)::text AS cash,a.price::text AS price,
 extract(epoch from a.occurred_at)::float8 AS observed_sec,${tokenSql("a.metadata")} AS token,${contractSql("a.metadata")} AS contract
 FROM (SELECT ev.* FROM wallet_activity_events ev WHERE ev.occurred_at>$1::timestamptz AND ev.occurred_at<=$2::timestamptz
 AND ev.created_at<=$3::timestamptz AND ev.source='snapshot_delta' AND ev.activity_type='delta'
 AND ev.action='BUY' AND ev.outcome_side IN ('YES','NO') OFFSET 0) a WHERE a.venue='polymarket'
 AND a.metadata->>'snapshotSource' IN ${publicSourcesSql}
 AND a.delta_shares>0 AND a.delta_shares<'Infinity'::numeric AND a.price>0 AND a.price<1
 AND a.delta_shares*a.price >= 500`;

export const MOVE_OWNERS_SQL = `SELECT w.id::text AS wallet,w.address,
 coalesce(ws.owner_wallet_id,resolved_owner.owner_wallet_id,w.id)::text AS family,
 EXISTS(SELECT 1 FROM wallet_tracking_subjects sub WHERE sub.wallet_id=w.id AND sub.venue='polymarket'
 AND sub.status='active' AND sub.source IN ('recent_top_holder','whale','signal_candidate')) AS system_tracked,
 CASE WHEN w.metadata#>>'{identityNames,polymarket,status}'='ok' THEN w.metadata#>>'{identityNames,polymarket,username}' END AS name
 FROM unnest($1::uuid[]) AS req(wallet_id) JOIN wallets w ON w.id=req.wallet_id
 LEFT JOIN wallet_onchain_state ws ON ws.wallet_id=w.id
 LEFT JOIN wallet_intel_selector_snapshot s ON s.wallet_id=w.id
 ${buildWalletOwnerResolutionJoinSql(true, "resolved_owner")}
 WHERE w.chain='polygon' AND w.address ~ '^0x[0-9a-fA-F]{40}$' AND NOT(lower(w.address)=ANY($2::text[]))
 AND NOT ${buildWalletMmSuspectedSql({ exposureUsdSql: "s.exposure_usd", hedgedNotionalUsdSql: "s.hedged_notional_usd", hedgeRatioSql: "s.hedge_ratio", twoSidedMarketsSql: "s.two_sided_markets", exposureThresholdSql: "$3::numeric" })}`;

// One indexed range per requested wallet/market/side plus its opening observation.
// Do not filter out synthetic zeroes here: they invalidate continuity.
export const MOVE_BALANCES_SQL = `WITH pairs AS MATERIALIZED (
 SELECT p.w,p.m,sd.side_code FROM jsonb_to_recordset($1::jsonb) AS p(w uuid,m text)
 CROSS JOIN (VALUES ('YES'),('NO')) AS sd(side_code))
 SELECT p.w::text AS wallet,p.m AS market,p.side_code AS side,extract(epoch FROM b.snapshot_at)::float8 AS observed_sec,
 b.shares::text AS shares,b.metadata->>'source' IN ${publicSourcesSql} AS observed,
 ${tokenSql("b.metadata")} AS token,${contractSql("b.metadata")} AS contract
 FROM pairs p CROSS JOIN LATERAL (
 (SELECT s.snapshot_at,s.shares,s.metadata FROM wallet_position_snapshots s WHERE s.wallet_id=p.w AND s.market_id=p.m
 AND s.venue='polymarket' AND s.outcome_side=p.side_code AND s.snapshot_at<=$2::timestamptz ORDER BY s.snapshot_at DESC LIMIT 1)
 UNION ALL
 (SELECT s.snapshot_at,s.shares,s.metadata FROM wallet_position_snapshots s WHERE s.wallet_id=p.w AND s.market_id=p.m
 AND s.venue='polymarket' AND s.outcome_side=p.side_code AND s.snapshot_at>$2::timestamptz AND s.snapshot_at<=$3::timestamptz OFFSET 0)
 ) b ORDER BY p.w,p.m,b.snapshot_at,p.side_code`;
export type Delta = {
  wallet: string;
  market: string;
  side: "YES" | "NO";
  provenance: string;
  prev_qty: string;
  curr_qty: string;
  shares: string;
  cash: string;
  price: string;
  observed_sec: number;
  token: string;
  contract: string;
};
export type Balance = Pick<
  Delta,
  | "wallet"
  | "market"
  | "side"
  | "observed_sec"
  | "token"
  | "contract"
  | "shares"
> & { observed: boolean };
export type PublicOwner = {
  wallet: string;
  family: string;
  name: string | null;
  system_tracked: boolean;
};
export class GlobalMoveRepository {
  constructor(private pool: Pick<Pool, "connect">) {}
  deltas(lo: number, hi: number, end: number) {
    return discoveryReadOnly(this.pool, async (c) => {
      // The generic estimate can walk the market/time B-tree for seconds.
      // Let PG see this exact 3h BRIN range, only for this read transaction.
      await c.query("SET LOCAL plan_cache_mode = force_custom_plan");
      return (
        await c.query<Delta>(MOVE_DAY_SQL, [
          new Date(lo * 1000),
          new Date(hi * 1000),
          new Date(end * 1000),
        ])
      ).rows;
    });
  }
  owners(ids: string[], whale: number) {
    return discoveryReadOnly(this.pool, async (c) =>
      (
        await c.query<PublicOwner & { address: string }>(MOVE_OWNERS_SQL, [
          ids,
          walletIntelProtocolAddresses(),
          whale,
        ])
      ).rows.map((r) => ({
        wallet: r.wallet,
        family: r.family,
        system_tracked: r.system_tracked,
        name: publicHolderLabel(r.name, r.address)?.slice(0, 80) ?? null,
      })),
    );
  }
  balances(pairs: { w: string; m: string }[], lo: number, end: number) {
    return discoveryReadOnly(
      this.pool,
      async (c) =>
        (
          await c.query<Balance>(MOVE_BALANCES_SQL, [
            JSON.stringify(pairs),
            new Date(lo * 1000),
            new Date(end * 1000),
          ])
        ).rows,
    );
  }
}
