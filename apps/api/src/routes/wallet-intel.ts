import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  derivePolymarketFunders,
  inspectSafeWallet,
} from "../services/polymarket-funder.js";
import {
  walletActivityQuerySchema,
  walletFollowBodySchema,
  walletFollowDeleteQuerySchema,
  walletFollowParamsSchema,
  walletFollowingQuerySchema,
  walletPositionsQuerySchema,
  walletProfileParamsSchema,
  walletWhalesQuerySchema,
} from "../schemas/wallet-intel.js";

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  is_system_flagged: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
};

type WalletTagRow = {
  slug: string;
  label: string;
  tag_type: string;
  is_system: boolean;
};

type WalletMetricsRow = {
  period: string;
  as_of: Date;
  trades_count: number | null;
  volume_usd: string | null;
  pnl_usd: string | null;
  roi: string | null;
  win_rate: string | null;
  avg_hold_hours: string | null;
  last_trade_at: Date | null;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  event_id: string | null;
  event_title: string | null;
  venue: string;
  activity_count: number;
  volume_usd: string | null;
  avg_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  position_side: string | null;
  position_shares: string | null;
  position_value_usd: string | null;
  position_price: string | null;
  last_activity_at: Date | null;
};

type WhaleProfileRow = {
  profile: unknown | null;
  profile_updated_at: Date | null;
};

function normalizeAddress(address: string): string {
  if (address.startsWith("0x")) return address.toLowerCase();
  return address.trim();
}

export const walletIntelRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /wallets/follow
   */
  z.post(
    "/wallets/follow",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: walletFollowBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const chain = body.chain.toLowerCase();
      const address = normalizeAddress(body.address);
      const baseLabel = body.label?.trim() || null;

      if (chain !== "solana" && !ethers.isAddress(address)) {
        reply.code(400);
        return reply.send({ error: "Invalid EVM wallet address" });
      }

      const client = await pool.connect();
      try {
        const walletResult = await client.query<WalletRow>(
          `
            insert into wallets (address, chain, label)
            values ($1, $2, $3)
            on conflict (address, chain)
            do update set
              label = coalesce(excluded.label, wallets.label),
              last_seen_at = greatest(wallets.last_seen_at, now()),
              updated_at = now()
            returning id, address, chain, label, is_system_flagged, first_seen_at, last_seen_at
          `,
          [address, chain, body.label ?? null],
        );

        const wallet = walletResult.rows[0];

        const followResult = await client.query<{
          id: string;
          created_at: Date;
        }>(
          `
            insert into wallet_follows (user_id, wallet_id)
            values ($1, $2)
            returning id, created_at
          `,
          [user.id, wallet.id],
        );

        if (chain === "polygon" && ethers.isAddress(address)) {
          try {
            const funderResult = await derivePolymarketFunders({
              signer: address,
            });
            const safeCandidate = funderResult.candidates.find(
              (candidate) =>
                candidate.source === "safe_proxy" &&
                candidate.deployed &&
                candidate.contractKind === "SAFE_LIKE",
            );

            if (safeCandidate) {
              const safeAddress = normalizeAddress(safeCandidate.funder);
              const safeLabel = baseLabel
                ? `${baseLabel} (Safe)`
                : "Safe (auto)";
              const safeWalletResult = await client.query<WalletRow>(
                `
                  insert into wallets (address, chain, label, metadata)
                  values ($1, $2, $3, $4)
                  on conflict (address, chain)
                  do update set
                    label = coalesce(wallets.label, excluded.label),
                    metadata = coalesce(wallets.metadata, '{}'::jsonb) || excluded.metadata,
                    last_seen_at = greatest(wallets.last_seen_at, now()),
                    updated_at = now()
                  returning id
                `,
                [
                  safeAddress,
                  "polygon",
                  safeLabel,
                  {
                    kind: "safe",
                    derivedFrom: address,
                    owners: safeCandidate.safeOwners ?? null,
                    threshold: safeCandidate.safeThreshold ?? null,
                  },
                ],
              );
              const safeWalletId = safeWalletResult.rows[0]?.id;
              if (safeWalletId) {
                await client.query(
                  `
                    insert into wallet_follows (user_id, wallet_id)
                    values ($1, $2)
                    on conflict (user_id, wallet_id)
                    do nothing
                  `,
                  [user.id, safeWalletId],
                );
              }
            }
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, address },
              "Failed to auto-follow Polymarket Safe wallet",
            );
          }

          try {
            const safeInfo = await inspectSafeWallet({ address });
            if (safeInfo.safe) {
              await client.query(
                `
                  update wallets
                  set metadata = coalesce(metadata, '{}'::jsonb) || $2,
                      updated_at = now()
                  where id = $1
                `,
                [
                  wallet.id,
                  {
                    kind: "safe",
                    owners: safeInfo.owners ?? null,
                    threshold: safeInfo.threshold ?? null,
                  },
                ],
              );

              if (safeInfo.owners && safeInfo.owners.length === 1) {
                const owner = normalizeAddress(safeInfo.owners[0]);
                if (owner !== address) {
                  const ownerLabel = baseLabel
                    ? `${baseLabel} (Signer)`
                    : "Signer (auto)";
                  const ownerWalletResult = await client.query<{
                    id: string;
                  }>(
                    `
                      insert into wallets (address, chain, label, metadata)
                      values ($1, $2, $3, $4)
                      on conflict (address, chain)
                      do update set
                        label = coalesce(wallets.label, excluded.label),
                        metadata = coalesce(wallets.metadata, '{}'::jsonb) || excluded.metadata,
                        last_seen_at = greatest(wallets.last_seen_at, now()),
                        updated_at = now()
                      returning id
                    `,
                    [
                      owner,
                      "polygon",
                      ownerLabel,
                      {
                        kind: "safe_owner",
                        derivedFrom: address,
                      },
                    ],
                  );

                  const ownerWalletId = ownerWalletResult.rows[0]?.id;
                  if (ownerWalletId) {
                    await client.query(
                      `
                        insert into wallet_follows (user_id, wallet_id)
                        values ($1, $2)
                        on conflict (user_id, wallet_id)
                        do nothing
                      `,
                      [user.id, ownerWalletId],
                    );
                  }
                }
              }
            }
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, address },
              "Failed to auto-follow Safe owner",
            );
          }
        }

        reply.code(201);
        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            isSystemFlagged: wallet.is_system_flagged,
            firstSeenAt: wallet.first_seen_at,
            lastSeenAt: wallet.last_seen_at,
          },
          follow: {
            id: followResult.rows[0].id,
            createdAt: followResult.rows[0].created_at,
          },
        });
      } catch (error) {
        const code = isRecord(error) ? error["code"] : undefined;
        if (code === "23505") {
          reply.code(409);
          return reply.send({ error: "Wallet already followed" });
        }

        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to follow wallet",
        );
        reply.code(500);
        return reply.send({ error: "Failed to follow wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * DELETE /wallets/follow/:address
   */
  z.delete(
    "/wallets/follow/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowDeleteQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();

      const client = await pool.connect();
      try {
        const walletResult = await client.query<WalletRow>(
          "select id from wallets where address = $1 and chain = $2",
          [address, chain],
        );

        const walletRow = walletResult.rows[0];
        if (!walletRow) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const deleteResult = await client.query(
          `
            delete from wallet_follows
            where user_id = $1 and wallet_id = $2
            returning id
          `,
          [user.id, walletRow.id],
        );

        if (deleteResult.rowCount === 0) {
          reply.code(404);
          return reply.send({ error: "Wallet not followed" });
        }

        return reply.send({ ok: true });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to unfollow wallet",
        );
        reply.code(500);
        return reply.send({ error: "Failed to unfollow wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/following
   */
  z.get(
    "/wallets/following",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletFollowingQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const client = await pool.connect();
      try {
        const rows = await client.query<
          WalletRow & {
            follow_created_at: Date;
            tags: WalletTagRow[] | null;
            metrics: WalletMetricsRow | null;
            inferred_wins: number | null;
            inferred_total: number | null;
            profile: unknown | null;
            profile_updated_at: Date | null;
          }
        >(
          `
            select
              w.id,
              w.address,
              w.chain,
              w.label,
              w.is_system_flagged,
              w.first_seen_at,
              w.last_seen_at,
              wf.created_at as follow_created_at,
              tags.tags,
              metrics.metrics,
              inferred.wins as inferred_wins,
              inferred.total as inferred_total,
              wp.profile as profile,
              wp.updated_at as profile_updated_at
            from wallet_follows wf
            join wallets w on w.id = wf.wallet_id
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                'slug', t.slug,
                'label', t.label,
                'tag_type', t.tag_type,
                'is_system', t.is_system
              ) order by t.tag_type, t.slug) as tags
              from wallet_tag_map tm
              join wallet_tags t on t.id = tm.tag_id
              where tm.wallet_id = w.id
            ) tags on true
            left join lateral (
              select jsonb_build_object(
                'period', s.period,
                'as_of', s.as_of,
                'trades_count', s.trades_count,
                'volume_usd', s.volume_usd,
                'pnl_usd', s.pnl_usd,
                'roi', s.roi,
                'win_rate', s.win_rate,
                'avg_hold_hours', s.avg_hold_hours,
                'last_trade_at', s.last_trade_at
              ) as metrics
              from wallet_metrics_snapshots s
              where s.wallet_id = w.id and s.period = '30d'
              order by s.as_of desc
              limit 1
            ) metrics on true
            left join lateral (
              with latest as (
                select distinct on (ws.market_id, ws.outcome_side)
                  ws.market_id,
                  ws.outcome_side,
                  ws.shares
                from wallet_position_snapshots ws
                where ws.wallet_id = w.id
                  and ws.shares > 0
                order by ws.market_id, ws.outcome_side, ws.snapshot_at desc
              ),
              agg as (
                select
                  market_id,
                  sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
                  sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
                from latest
                group by market_id
              ),
              resolved as (
                select
                  agg.market_id,
                  agg.yes_shares,
                  agg.no_shares,
                  upper(m.resolved_outcome) as resolved_outcome
                from agg
                join unified_markets m on m.id = agg.market_id
                where m.resolved_outcome is not null
                  and upper(m.resolved_outcome) in ('YES', 'NO')
              ),
              eligible as (
                select *
                from resolved
                where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
                   or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
              )
              select
                count(*) filter (
                  where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
                     or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
                ) as wins,
                count(*)::int as total
              from eligible
            ) inferred on true
            where wf.user_id = $1
            order by wf.created_at desc
            limit $2
            offset $3
          `,
          [user.id, query.limit, query.offset],
        );

        return reply.send({
          ok: true,
          wallets: rows.rows.map((row) => ({
            walletId: row.id,
            address: row.address,
            chain: row.chain,
            label: row.label,
            isSystemFlagged: row.is_system_flagged,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            followedAt: row.follow_created_at,
            tags: row.tags ?? [],
            metrics: row.metrics ?? null,
            inferredWinRate:
              row.inferred_total && row.inferred_total > 0 && row.inferred_wins != null
                ? Number(row.inferred_wins) / Number(row.inferred_total)
                : null,
            inferredResolvedCount:
              row.inferred_total != null ? Number(row.inferred_total) : null,
            profile: row.profile ?? null,
            profileUpdatedAt: row.profile_updated_at ?? null,
          })),
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to list wallets");
        reply.code(500);
        return reply.send({ error: "Failed to list wallets" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/whales
   */
  z.get(
    "/wallets/whales",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletWhalesQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const client = await pool.connect();
      try {
        const orderBy = (() => {
          switch (query.sort) {
            case "volume_30d":
              return "whale_score desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
            case "trades_30d":
              return "metrics.metrics_trades desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
            case "exposure_usd":
              return "exposure.exposure_usd desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
            case "winrate":
              return "case when inferred.total > 0 then inferred.wins::float / inferred.total end desc nulls last, inferred.total desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
            case "last_activity":
            default:
              return "activity.last_activity_at desc nulls last, whale_score desc nulls last, w.last_seen_at desc";
          }
        })();

        const whaleRows = await client.query<
          WalletRow &
            WhaleProfileRow & {
            is_followed: boolean;
            tags: WalletTagRow[] | null;
            metrics: WalletMetricsRow | null;
            last_activity_at: Date | null;
            has_trade_activity: boolean | null;
            has_holder_activity: boolean | null;
            metrics_volume: string | null;
            metrics_trades: number | null;
            exposure_usd: string | null;
            whale_score: string | null;
            is_safe: boolean;
            owner_address: string | null;
            owner_label: string | null;
            owner_wallet_id: string | null;
            inferred_wins: number | null;
            inferred_total: number | null;
          }
        >(
          `
            select
              w.id,
              w.address,
              w.chain,
              w.label,
              w.is_system_flagged,
              (w.metadata->>'kind' = 'safe') as is_safe,
              w.first_seen_at,
              w.last_seen_at,
              (wf.wallet_id is not null) as is_followed,
              tags.tags,
              metrics.metrics,
              metrics.metrics_volume,
              metrics.metrics_trades,
              exposure.exposure_usd,
              case
                when w.chain = 'solana'
                  then coalesce(nullif(metrics.metrics_volume, 0), exposure.exposure_usd, 0)
                else coalesce(metrics.metrics_volume, 0)
              end as whale_score,
              owner.owner_address,
              owner.owner_label,
              owner.owner_wallet_id,
              wp.profile as profile,
              wp.updated_at as profile_updated_at,
              activity.last_activity_at,
              inferred.wins as inferred_wins,
              inferred.total as inferred_total
            from wallets w
            join wallet_tag_map tm on tm.wallet_id = w.id
            join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
            left join wallet_follows wf on wf.wallet_id = w.id and wf.user_id = $1
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                'slug', t.slug,
                'label', t.label,
                'tag_type', t.tag_type,
                'is_system', t.is_system
              ) order by t.tag_type, t.slug) as tags
              from wallet_tag_map tm
              join wallet_tags t on t.id = tm.tag_id
              where tm.wallet_id = w.id
            ) tags on true
            left join lateral (
              select
                jsonb_build_object(
                  'period', s.period,
                  'as_of', s.as_of,
                  'trades_count', s.trades_count,
                  'volume_usd', s.volume_usd,
                  'pnl_usd', s.pnl_usd,
                  'roi', s.roi,
                  'win_rate', s.win_rate,
                  'avg_hold_hours', s.avg_hold_hours,
                  'last_trade_at', s.last_trade_at
                ) as metrics,
                s.volume_usd as metrics_volume,
                s.trades_count as metrics_trades
              from wallet_metrics_snapshots s
              where s.wallet_id = w.id and s.period = '30d'
              order by s.as_of desc
              limit 1
            ) metrics on true
            left join lateral (
              select
                max(wa.occurred_at) as last_activity_at,
                bool_or(wa.activity_type in ('delta', 'trade')) as has_trade_activity,
                bool_or(wa.activity_type = 'holder') as has_holder_activity
              from wallet_activity_events wa
              where wa.wallet_id = w.id
                and wa.activity_type in ('delta', 'trade', 'holder')
                and wa.occurred_at >= now() - ($4::text || ' days')::interval
            ) activity on true
            left join lateral (
              select
                sum(coalesce(ws.size_usd, 0)) as exposure_usd
              from wallet_position_snapshots ws
              join (
                select venue, max(snapshot_at) as snapshot_at
                from wallet_position_snapshots
                where wallet_id = w.id
                group by venue
              ) latest on latest.venue = ws.venue and latest.snapshot_at = ws.snapshot_at
              where ws.wallet_id = w.id
            ) exposure on true
            left join lateral (
              select
                w2.address as owner_address,
                w2.label as owner_label,
                w2.id as owner_wallet_id
              from wallets w2
              where w.metadata->>'kind' = 'safe'
                and w2.metadata->>'kind' = 'safe_owner'
                and w2.metadata->>'derivedFrom' = w.address
                and w2.chain = w.chain
              limit 1
            ) owner on true
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join lateral (
              with latest as (
                select distinct on (ws.market_id, ws.outcome_side)
                  ws.market_id,
                  ws.outcome_side,
                  ws.shares
                from wallet_position_snapshots ws
                where ws.wallet_id = w.id
                  and ws.shares > 0
                order by ws.market_id, ws.outcome_side, ws.snapshot_at desc
              ),
              agg as (
                select
                  market_id,
                  sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
                  sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
                from latest
                group by market_id
              ),
              resolved as (
                select
                  agg.market_id,
                  agg.yes_shares,
                  agg.no_shares,
                  upper(m.resolved_outcome) as resolved_outcome
                from agg
                join unified_markets m on m.id = agg.market_id
                where m.resolved_outcome is not null
                  and upper(m.resolved_outcome) in ('YES', 'NO')
              ),
              eligible as (
                select *
                from resolved
                where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
                   or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
              )
              select
                count(*) filter (
                  where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
                     or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
                ) as wins,
                count(*)::int as total
              from eligible
            ) inferred on true
            order by ${orderBy}
            limit $2 offset $3
          `,
          [user.id, query.limit, query.offset, query.windowDays],
        );

        const whaleIds = whaleRows.rows.map((row) => row.id);
        const marketMap = new Map<string, WhaleMarketRow[]>();
        if (whaleIds.length > 0) {
          const marketRows = await client.query<WhaleMarketRow>(
            `
              select
                ranked.*,
                pos.outcome_side as position_side,
                pos.shares as position_shares,
                pos.size_usd as position_value_usd,
                pos.price as position_price
              from (
                select
                  wa.wallet_id,
                  wa.market_id,
                  um.title as market_title,
                  um.event_id,
                  ue.title as event_title,
                  wa.venue,
                  count(*)::int as activity_count,
                  sum(wa.size_usd) as volume_usd,
                  case
                    when sum(wa.delta_shares) is null or sum(wa.delta_shares) = 0
                      then null
                    else sum(wa.price * wa.delta_shares) / nullif(sum(wa.delta_shares), 0)
                  end as avg_price,
                  max(wa.occurred_at) as last_activity_at,
                  um.best_bid,
                  um.best_ask,
                  um.last_price,
                  um.status as market_status,
                  um.close_time,
                  um.expiration_time,
                  um.resolved_outcome,
                  row_number() over (
                    partition by wa.wallet_id
                    order by sum(wa.size_usd) desc nulls last,
                             count(*) desc,
                             max(wa.occurred_at) desc
                  ) as rn
                from wallet_activity_events wa
                left join unified_markets um on um.id = wa.market_id
                left join unified_events ue on ue.id = um.event_id
                where wa.wallet_id = any($1::uuid[])
                  and wa.activity_type in ('delta', 'trade', 'holder')
                  and wa.occurred_at >= now() - ($3::text || ' days')::interval
                group by
                  wa.wallet_id,
                  wa.market_id,
                  um.title,
                  um.event_id,
                  ue.title,
                  wa.venue,
                  um.best_bid,
                  um.best_ask,
                  um.last_price,
                  um.status,
                  um.close_time,
                  um.expiration_time,
                  um.resolved_outcome
              ) ranked
              left join lateral (
                select
                  ws.outcome_side,
                  ws.shares,
                  ws.size_usd,
                  ws.price
                from wallet_position_snapshots ws
                where ws.wallet_id = ranked.wallet_id
                  and ws.market_id = ranked.market_id
                  and ws.shares > 0
                order by ws.snapshot_at desc, ws.size_usd desc nulls last, ws.shares desc
                limit 1
              ) pos on true
              where ranked.rn <= $2
              order by ranked.wallet_id, ranked.rn
            `,
            [whaleIds, query.marketLimit, query.windowDays],
          );

          for (const row of marketRows.rows) {
            const list = marketMap.get(row.wallet_id) ?? [];
            list.push(row);
            marketMap.set(row.wallet_id, list);
          }
        }

        const walletsRaw = whaleRows.rows.map((row) => ({
          walletId: row.id,
          address: row.address,
          chain: row.chain,
          label: row.label,
          isSystemFlagged: row.is_system_flagged,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          isFollowed: row.is_followed,
          tags: row.tags ?? [],
          metrics: row.metrics ?? null,
          lastActivityAt: row.last_activity_at,
          activityKind: (() => {
            const hasTrade = row.has_trade_activity ?? false;
            const hasHolder = row.has_holder_activity ?? false;
            if (hasTrade && hasHolder) return "mixed";
            if (hasTrade) return "trade";
            if (hasHolder) return "holder";
            return null;
          })(),
          trackedExposureUsd: row.exposure_usd ? Number(row.exposure_usd) : null,
          inferredWinRate:
            row.inferred_total && row.inferred_total > 0 && row.inferred_wins != null
              ? Number(row.inferred_wins) / Number(row.inferred_total)
              : null,
          inferredResolvedCount:
            row.inferred_total != null ? Number(row.inferred_total) : null,
          isSafe: row.is_safe,
          ownerAddress: row.owner_address,
          ownerLabel: row.owner_label,
          ownerWalletId: row.owner_wallet_id,
          profile: row.profile ?? null,
          profileUpdatedAt: row.profile_updated_at ?? null,
          topMarkets:
            marketMap.get(row.id)?.map((market) => ({
              marketId: market.market_id,
              marketTitle: market.market_title,
              eventId: market.event_id,
              eventTitle: market.event_title,
              venue: market.venue,
              activityCount: market.activity_count,
              volumeUsd: market.volume_usd
                ? Number(market.volume_usd)
                : null,
              avgPrice: market.avg_price ? Number(market.avg_price) : null,
              bestBid: market.best_bid ? Number(market.best_bid) : null,
              bestAsk: market.best_ask ? Number(market.best_ask) : null,
              lastPrice: market.last_price ? Number(market.last_price) : null,
              marketStatus: market.market_status ?? null,
              closeTime: market.close_time ?? null,
              expirationTime: market.expiration_time ?? null,
              resolvedOutcome: market.resolved_outcome ?? null,
              positionSide: market.position_side,
              positionShares: market.position_shares
                ? Number(market.position_shares)
                : null,
              positionValueUsd: market.position_value_usd
                ? Number(market.position_value_usd)
                : null,
              positionPrice: market.position_price
                ? Number(market.position_price)
                : null,
              lastActivityAt: market.last_activity_at,
            })) ?? [],
        }));

        const filtered = walletsRaw.filter(
          (row) => row.lastActivityAt && row.topMarkets.length > 0,
        );

        const deduped = new Map<string, typeof walletsRaw[number]>();
        for (const row of filtered) {
          const dedupeKey =
            row.isSafe && row.ownerAddress
              ? row.ownerAddress.toLowerCase()
              : row.address.toLowerCase();
          const existing = deduped.get(dedupeKey);
          if (!existing) {
            deduped.set(dedupeKey, row);
            continue;
          }
          const existingVolume =
            existing.metrics && typeof existing.metrics.volume_usd === "string"
              ? Number(existing.metrics.volume_usd)
              : Number(existing.metrics?.volume_usd ?? 0);
          const rowVolume =
            row.metrics && typeof row.metrics.volume_usd === "string"
              ? Number(row.metrics.volume_usd)
              : Number(row.metrics?.volume_usd ?? 0);
          const existingScore = Number.isFinite(existingVolume)
            ? existingVolume
            : 0;
          const rowScore = Number.isFinite(rowVolume) ? rowVolume : 0;

          if (existing.isSafe && !row.isSafe) {
            deduped.set(dedupeKey, row);
            continue;
          }
          if (!existing.isSafe && row.isSafe) {
            continue;
          }
          if (rowScore > existingScore) {
            deduped.set(dedupeKey, row);
            continue;
          }
          if (
            rowScore === existingScore &&
            row.lastActivityAt &&
            existing.lastActivityAt &&
            row.lastActivityAt > existing.lastActivityAt
          ) {
            deduped.set(dedupeKey, row);
          }
        }

        return reply.send({
          ok: true,
          wallets: Array.from(deduped.values()),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load whale wallets",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load whale wallets" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/:walletId
   */
  z.get(
    "/wallets/:walletId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: walletProfileParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const walletId = request.params.walletId;
      const client = await pool.connect();
      try {
        const result = await client.query<
          WalletRow & {
            tags: WalletTagRow[] | null;
            metrics: WalletMetricsRow | null;
          }
        >(
          `
            select
              w.id,
              w.address,
              w.chain,
              w.label,
              w.is_system_flagged,
              w.first_seen_at,
              w.last_seen_at,
              tags.tags,
              metrics.metrics
            from wallets w
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                'slug', t.slug,
                'label', t.label,
                'tag_type', t.tag_type,
                'is_system', t.is_system
              ) order by t.tag_type, t.slug) as tags
              from wallet_tag_map tm
              join wallet_tags t on t.id = tm.tag_id
              where tm.wallet_id = w.id
            ) tags on true
            left join lateral (
              select jsonb_build_object(
                'period', s.period,
                'as_of', s.as_of,
                'trades_count', s.trades_count,
                'volume_usd', s.volume_usd,
                'pnl_usd', s.pnl_usd,
                'roi', s.roi,
                'win_rate', s.win_rate,
                'avg_hold_hours', s.avg_hold_hours,
                'last_trade_at', s.last_trade_at
              ) as metrics
              from wallet_metrics_snapshots s
              where s.wallet_id = w.id and s.period = '30d'
              order by s.as_of desc
              limit 1
            ) metrics on true
            where w.id = $1
            limit 1
          `,
          [walletId],
        );

        const wallet = result.rows[0];
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            isSystemFlagged: wallet.is_system_flagged,
            firstSeenAt: wallet.first_seen_at,
            lastSeenAt: wallet.last_seen_at,
            tags: wallet.tags ?? [],
            metrics: wallet.metrics ?? null,
          },
        });
      } catch (error) {
        app.log.error(
          { error, walletId, userId: user.id },
          "Failed to load wallet",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/activity
   */
  z.get(
    "/wallets/activity",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletActivityQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const params: Array<string | number | null> = [];
      let where = "";
      let idx = 1;

      if (query.walletId) {
        where += `wa.wallet_id = $${idx++}`;
        params.push(query.walletId);
      } else {
        where += `wa.wallet_id in (select wallet_id from wallet_follows where user_id = $${idx++})`;
        params.push(user.id);
      }

      if (query.venue) {
        where += ` and wa.venue = $${idx++}`;
        params.push(query.venue);
      }

      if (query.since) {
        where += ` and wa.occurred_at >= $${idx++}`;
        params.push(query.since);
      }

      params.push(query.limit, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const rows = await client.query<{
          wallet_id: string;
          address: string;
          chain: string;
          venue: string;
          market_id: string;
          market_title: string | null;
          event_id: string | null;
          event_title: string | null;
          best_bid: string | null;
          best_ask: string | null;
          last_price: string | null;
          outcome_side: string | null;
          action: string | null;
          delta_shares: string | null;
          size_usd: string | null;
          price: string | null;
          activity_type: string;
          source: string | null;
          occurred_at: Date;
          metadata: unknown;
        }>(
          `
            select
              wa.wallet_id,
              w.address,
              w.chain,
              wa.venue,
              wa.market_id,
              um.title as market_title,
              um.event_id as event_id,
              ue.title as event_title,
              um.best_bid,
              um.best_ask,
              um.last_price,
              wa.outcome_side,
              wa.action,
              wa.delta_shares,
              wa.size_usd,
              wa.price,
              wa.activity_type,
              wa.source,
              wa.occurred_at,
              wa.metadata
            from wallet_activity_events wa
            join wallets w on w.id = wa.wallet_id
            left join unified_markets um on um.id = wa.market_id
            left join unified_events ue on ue.id = um.event_id
            where ${where}
              and wa.activity_type in ('delta', 'trade')
            order by wa.occurred_at desc
            limit $${limitParam}
            offset $${offsetParam}
          `,
          params,
        );

        const minUsd = env.walletIntelMinPositionUsd;
        const minShares = env.walletIntelMinPositionShares;

        const items = rows.rows.map((row) => ({
          walletId: row.wallet_id,
          address: row.address,
          chain: row.chain,
          venue: row.venue,
          marketId: row.market_id,
          marketTitle: row.market_title,
          eventId: row.event_id,
          eventTitle: row.event_title,
          bestBid: row.best_bid ? Number(row.best_bid) : null,
          bestAsk: row.best_ask ? Number(row.best_ask) : null,
          lastPrice: row.last_price ? Number(row.last_price) : null,
          outcomeSide: row.outcome_side,
          action: row.action,
          deltaShares: row.delta_shares ? Number(row.delta_shares) : null,
          sizeUsd: row.size_usd ? Number(row.size_usd) : null,
          price: row.price ? Number(row.price) : null,
          activityType: row.activity_type,
          source: row.source,
          occurredAt: row.occurred_at,
          metadata: row.metadata ?? null,
        }));

        const filteredItems =
          minUsd <= 0 && minShares <= 0
            ? items
            : items.filter((item) => {
                if (item.sizeUsd != null) {
                  if (item.sizeUsd >= minUsd) return true;
                  if (item.deltaShares != null && item.deltaShares >= minShares) {
                    return true;
                  }
                  return false;
                }
                if (item.deltaShares != null) {
                  return item.deltaShares >= minShares;
                }
                return true;
              });

        return reply.send({
          ok: true,
          items: filteredItems,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load wallet activity",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet activity" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/positions
   */
  z.get(
    "/wallets/positions",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletPositionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const params: Array<string | number | null> = [];
      let where = "";
      let idx = 1;

      if (query.walletId) {
        where += `ws.wallet_id = $${idx++}`;
        params.push(query.walletId);
      } else {
        where += `ws.wallet_id in (select wallet_id from wallet_follows where user_id = $${idx++})`;
        params.push(user.id);
      }

      if (query.venue) {
        where += ` and ws.venue = $${idx++}`;
        params.push(query.venue);
      }

      if (query.since) {
        where += ` and ws.snapshot_at >= $${idx++}`;
        params.push(query.since);
      }

      params.push(query.limit, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const latestOnly = query.latest ?? true;
        const sql = latestOnly
          ? `
              with latest_snapshots as (
                select
                  ws.wallet_id,
                  ws.venue,
                  max(ws.snapshot_at) as snapshot_at
                from wallet_position_snapshots ws
                where ${where}
                group by ws.wallet_id, ws.venue
              )
              select
                ws.wallet_id,
                w.address,
                w.chain,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.event_id as event_id,
                ue.title as event_title,
                um.best_bid,
                um.best_ask,
                um.last_price,
                ws.outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from wallet_position_snapshots ws
              join latest_snapshots ls
                on ls.wallet_id = ws.wallet_id
               and ls.venue = ws.venue
               and ls.snapshot_at = ws.snapshot_at
              join wallets w on w.id = ws.wallet_id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              order by ws.snapshot_at desc
              limit $${limitParam}
              offset $${offsetParam}
            `
          : `
              select
                ws.wallet_id,
                w.address,
                w.chain,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.event_id as event_id,
                ue.title as event_title,
                um.best_bid,
                um.best_ask,
                um.last_price,
                ws.outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from wallet_position_snapshots ws
              join wallets w on w.id = ws.wallet_id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${where}
              order by ws.snapshot_at desc
              limit $${limitParam}
              offset $${offsetParam}
            `;

        const rows = await client.query<{
          wallet_id: string;
          address: string;
          chain: string;
          venue: string;
          market_id: string;
          market_title: string | null;
          event_id: string | null;
          event_title: string | null;
          best_bid: string | null;
          best_ask: string | null;
          last_price: string | null;
          outcome_side: string | null;
          shares: string | null;
          size_usd: string | null;
          price: string | null;
          snapshot_at: Date;
          metadata: unknown;
        }>(sql, params);

        const items = rows.rows.map((row) => ({
          walletId: row.wallet_id,
          address: row.address,
          chain: row.chain,
          venue: row.venue,
          marketId: row.market_id,
          marketTitle: row.market_title,
          eventId: row.event_id,
          eventTitle: row.event_title,
          bestBid: row.best_bid ? Number(row.best_bid) : null,
          bestAsk: row.best_ask ? Number(row.best_ask) : null,
          lastPrice: row.last_price ? Number(row.last_price) : null,
          outcomeSide: row.outcome_side,
          shares: row.shares ? Number(row.shares) : null,
          sizeUsd: row.size_usd ? Number(row.size_usd) : null,
          price: row.price ? Number(row.price) : null,
          snapshotAt: row.snapshot_at,
          metadata: row.metadata ?? null,
        }));

        const minUsd = env.walletIntelMinPositionUsd;
        const minShares = env.walletIntelMinPositionShares;

        const filteredItems =
          minUsd <= 0 && minShares <= 0
            ? items
            : items.filter((item) => {
                if (item.sizeUsd != null) {
                  return item.sizeUsd >= minUsd;
                }
                if (item.shares != null) {
                  return item.shares >= minShares;
                }
                return true;
              });

        return reply.send({
          ok: true,
          items: filteredItems,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load wallet positions",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet positions" });
      } finally {
        client.release();
      }
    },
  );
};
