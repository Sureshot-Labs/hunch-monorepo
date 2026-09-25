import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { pool } from "../db.js";
import {
  publicHolderDisplayName,
  publicHunchSources,
} from "../services/hunch-public-presentation.js";
import { buildWalletIntelAcceptingOrdersSql } from "../services/wallet-intel-market-eligibility.js";
import { loadLatestWalletPositionNowMap } from "../services/wallet-position-approx.js";
import { makeWalletPositionLedgerKey } from "../services/wallet-position-ledger.js";

const querySchema = z
  .object({
    window: z.enum(["1h", "6h", "24h", "7d", "latest"]).default("24h"),
    strength: z
      .string()
      .regex(
        /^(?:all|(?:strong|good|neutral)(?:,(?:strong|good|neutral)){0,2})$/,
      )
      .default("all"),
    marketId: z.string().trim().min(1).max(180).optional(),
    walletId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(60),
  })
  .refine(
    (value) =>
      value.window !== "latest" || Boolean(value.marketId || value.walletId),
    {
      message: "marketId or walletId is required for latest",
      path: ["marketId"],
    },
  );
const paramsSchema = z.object({ noteId: z.string().uuid() });
const durations: Record<
  Exclude<z.infer<typeof querySchema>["window"], "latest">,
  string
> = {
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "7d": "7 days",
};

type PublicHunchRow = {
  id: string;
  note_type: string;
  title: string;
  description: string;
  created_at: Date | string;
  updated_at: Date | string;
  source_id: string;
  lineage: unknown;
  metrics: unknown;
  model_meta: unknown;
  market_title: string | null;
  market_venue: string | null;
  market_outcomes: string | null;
  market_image: string | null;
  event_id: string | null;
  event_title: string | null;
  accepting_orders: boolean | null;
  resolved_outcome: string | null;
  current_price: string | number | null;
  current_price_as_of: Date | string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicStrength(row: PublicHunchRow): "strong" | "good" | "neutral" {
  if (row.note_type === "context") return "neutral";
  const grade = record(record(row.metrics).hunchStrengthV1).grade;
  return grade === "strong" ? "strong" : "good";
}

function outcomeLabel(row: PublicHunchRow, side: string | null): string | null {
  if (!side) return null;
  try {
    const outcomes = JSON.parse(row.market_outcomes ?? "null") as unknown;
    if (Array.isArray(outcomes) && outcomes.length >= 2) {
      const entry = outcomes[side === "NO" ? 1 : 0];
      if (typeof entry === "string" && entry.trim()) return entry;
    }
  } catch {
    // The market title and canonical side remain available.
  }
  return side;
}

function toPublicHunch(row: PublicHunchRow) {
  const metrics = record(row.metrics);
  const lineage = record(row.lineage);
  const meta = record(row.model_meta);
  const context = record(metrics.publicContextV1);
  const snapshot = record(metrics.signalPriceSnapshotV1);
  const strength = publicStrength(row);
  const side =
    typeof lineage.side === "string" ? lineage.side.toUpperCase() : null;
  const resolvedSide = row.resolved_outcome?.toUpperCase() ?? null;
  const researchedPrice = finiteNumber(snapshot.displayPrice);
  const currentPrice = finiteNumber(row.current_price);
  const researchedAt =
    typeof snapshot.asOf === "string" ? Date.parse(snapshot.asOf) : NaN;
  const currentAt = row.current_price_as_of
    ? new Date(row.current_price_as_of).getTime()
    : NaN;
  const evidence = publicHunchSources({
    kind: row.note_type === "context" ? "context" : "signal",
    metrics,
    modelMeta: meta,
  });
  const sources = evidence.map((item) => item.url);
  const caveats = row.note_type === "context" ? context.caveats : meta.caveats;
  return {
    noteId: row.id,
    cardKey: row.source_id,
    revisionId: row.id,
    kind: row.note_type as "signal" | "context",
    strength,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    headline: row.title,
    summary: row.description,
    caveats: Array.isArray(caveats)
      ? caveats.filter((item): item is string => typeof item === "string")
      : [],
    contextReason: typeof context.reason === "string" ? context.reason : null,
    strengthReasons:
      strength === "strong" &&
      Array.isArray(record(metrics.hunchStrengthV1).reasons)
        ? (record(metrics.hunchStrengthV1).reasons as unknown[]).filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    market: {
      marketId: row.source_id,
      title: row.market_title,
      venue: row.market_venue,
      image: row.market_image,
      eventId: row.event_id,
      eventTitle: row.event_title,
      side,
      outcomeLabel: outcomeLabel(row, side),
      acceptingOrders: row.accepting_orders === true,
    },
    selectedSideResult:
      row.note_type === "signal" &&
      (side === "YES" || side === "NO") &&
      (resolvedSide === "YES" || resolvedSide === "NO")
        ? side === resolvedSide
          ? "WIN"
          : "LOSS"
        : null,
    priceSnapshot:
      typeof snapshot.asOf === "string" && researchedPrice !== null
        ? {
            asOf: snapshot.asOf,
            price: researchedPrice,
            side: snapshot.displaySide,
          }
        : null,
    latestPriceSnapshot:
      row.note_type === "signal" &&
      snapshot.displaySide === side &&
      researchedPrice !== null &&
      currentPrice !== null &&
      currentPrice >= 0 &&
      currentPrice <= 1 &&
      Number.isFinite(researchedAt) &&
      Number.isFinite(currentAt) &&
      currentAt >= researchedAt &&
      currentAt <= Date.now() + 5 * 60_000 &&
      Date.now() - currentAt <= 2 * 60 * 60_000
        ? { asOf: new Date(currentAt).toISOString(), price: currentPrice, side }
        : null,
    evidence,
    sources,
  };
}

type HunchListResponse = {
  ok: true;
  items: ReturnType<typeof toPublicHunch>[];
  total: number;
};
const HUNCH_LIST_CACHE_MS = 10_000;
const HUNCH_LIST_CACHE_MAX_KEYS = 256;
const LATEST_HOLDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LATEST_HOLDER_CACHE_MS = 15_000;
const LATEST_HOLDER_CACHE_MAX_KEYS = 256;
type LatestHolderPositionMap = Awaited<
  ReturnType<typeof loadLatestWalletPositionNowMap>
>;
const hunchListCache = new Map<
  string,
  { expiresAt: number; result: Promise<HunchListResponse> }
>();
const latestHolderCache = new Map<
  string,
  { expiresAt: number; result: Promise<LatestHolderPositionMap> }
>();

function loadLatestHolderPositions(
  positionKeys: Parameters<typeof loadLatestWalletPositionNowMap>[1],
): Promise<LatestHolderPositionMap> {
  const cacheKey = JSON.stringify(positionKeys);
  const cached = latestHolderCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = loadLatestWalletPositionNowMap(pool, positionKeys);
  void result.catch(() => {
    if (latestHolderCache.get(cacheKey)?.result === result) {
      latestHolderCache.delete(cacheKey);
    }
  });
  latestHolderCache.delete(cacheKey);
  latestHolderCache.set(cacheKey, {
    expiresAt: Date.now() + LATEST_HOLDER_CACHE_MS,
    result,
  });
  while (latestHolderCache.size > LATEST_HOLDER_CACHE_MAX_KEYS) {
    const oldestKey = latestHolderCache.keys().next().value;
    if (oldestKey === undefined) break;
    latestHolderCache.delete(oldestKey);
  }
  return result;
}

const PUBLIC_NOTES = `
  n.producer_type = 'holder_research'
  and n.source_kind = 'market'
  and n.status <> 'retracted'
  and (
    (n.note_type = 'signal'
     and n.metrics #>> '{publicationDecisionV1,status}' = 'PUBLISH'
     and n.metrics #>> '{publicationDecisionV1,authority}' = 'holder_research_quality_gate')
    or (n.note_type = 'context' and n.metrics ? 'publicContextV1')
  )
`;

const HUNCH_COLUMNS = `
  n.id, n.note_type, n.title, n.description, n.created_at, n.updated_at,
  n.source_id, n.lineage, n.metrics, n.model_meta,
  m.title as market_title, m.venue as market_venue,
  m.outcomes as market_outcomes, coalesce(m.image, e.image) as market_image,
  m.event_id, e.title as event_title, m.resolved_outcome,
  ${buildWalletIntelAcceptingOrdersSql({ marketAlias: "m", eventAlias: "e" })} as accepting_orders,
  latest_quote.current_price, latest_quote.current_price_as_of
`;

const HUNCH_JOINS = `
  left join unified_markets m on m.id = n.source_id
  left join unified_events e on e.id = m.event_id
  left join lateral (
    select coalesce(quote_row.mid, (quote_row.best_bid + quote_row.best_ask) / 2) as current_price,
           quote_row.ts as current_price_as_of
    from unified_tokens market_token
    join unified_token_top_latest quote_row on quote_row.token_id = market_token.token_id
    where market_token.market_id = n.source_id
      and market_token.side = upper(n.lineage->>'side')
    limit 1
  ) latest_quote on true
`;

export const hunchesRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/hunches",
    { schema: { querystring: querySchema } },
    async (request) => {
      const { window, strength, limit, marketId, walletId } = request.query;
      const strengths = strength.split(",");
      const marketFilter = marketId ? "and n.source_id = $4::text" : "";
      const walletJoin = walletId
        ? `join ai_note_targets wallet_target
             on wallet_target.note_id = n.id
            and wallet_target.target_kind = 'wallet'
            and wallet_target.target_id = $${marketId ? 5 : 4}::uuid::text`
        : "";
      const contextOnlyFilter =
        strength === "neutral" ? "and n.note_type = 'context'" : "";
      const cacheKey = JSON.stringify([
        window,
        strength,
        limit,
        marketId ?? null,
        walletId ?? null,
      ]);
      const cached = hunchListCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      const result = pool
        .query<PublicHunchRow>(
          `with recent_notes as materialized (
         select distinct on (n.source_id) n.id, n.source_id
         from ai_notes n
         ${walletJoin}
         where ($1::interval is null or n.created_at >= now() - $1::interval)
           and n.status = 'active'
           ${marketFilter}
           ${contextOnlyFilter}
           and ${PUBLIC_NOTES}
         order by n.source_id,
                  case when n.note_type = 'signal' then 0 else 1 end,
                  n.created_at desc, n.id desc
       ), selected_notes as materialized (
         select n.id, n.created_at
         from recent_notes recent
         join ai_notes n on n.id = recent.id
         where 'all' = any($2::text[])
          or ('neutral' = any($2::text[]) and n.note_type = 'context')
          or ('good' = any($2::text[]) and n.note_type = 'signal'
              and coalesce(n.metrics #>> '{hunchStrengthV1,grade}', 'good') = 'good')
          or ('strong' = any($2::text[]) and n.note_type = 'signal'
              and n.metrics #>> '{hunchStrengthV1,grade}' = 'strong')
         order by n.created_at desc, n.id desc
         limit $3
       )
       select ${HUNCH_COLUMNS}
       from selected_notes selected
       join ai_notes n on n.id = selected.id
       ${HUNCH_JOINS}
       order by selected.created_at desc, n.id desc`,
          [
            window === "latest" ? null : durations[window],
            strengths,
            limit,
            ...(marketId ? [marketId] : []),
            ...(walletId ? [walletId] : []),
          ],
        )
        .then(({ rows }): HunchListResponse => {
          const items = rows.map(toPublicHunch);
          return { ok: true, items, total: items.length };
        });
      hunchListCache.delete(cacheKey);
      hunchListCache.set(cacheKey, {
        expiresAt: Date.now() + HUNCH_LIST_CACHE_MS,
        result,
      });
      if (hunchListCache.size > HUNCH_LIST_CACHE_MAX_KEYS) {
        const oldestKey = hunchListCache.keys().next().value;
        if (oldestKey) hunchListCache.delete(oldestKey);
      }
      try {
        return await result;
      } catch (error) {
        hunchListCache.delete(cacheKey);
        throw error;
      }
    },
  );
  typed.get(
    "/hunches/:noteId",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { rows } = await pool.query<PublicHunchRow>(
        `select ${HUNCH_COLUMNS}
         from ai_notes n
         ${HUNCH_JOINS}
         where n.id = $1::uuid and ${PUBLIC_NOTES}`,
        [request.params.noteId],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Hunch not found" });
      const { rows: holderRows } = await pool.query<{
        wallet_id: string | null;
        address: string | null;
        chain: string | null;
        profile_label: string | null;
        target_meta: unknown;
        metrics_as_of: Date | null;
        metrics_pnl_30d: string | null;
        metrics_trades_30d: number | null;
        metrics_resolved_win_rate_edge_30d: string | null;
        metrics_resolved_edge_sample_count_30d: number | null;
      }>(
        `select w.id as wallet_id, w.address, w.chain,
                wp.profile->>'label_short' as profile_label,
                target_row.target_meta,
                selector.metrics_as_of, selector.metrics_pnl_30d,
                selector.metrics_trades_30d,
                selector.metrics_resolved_win_rate_edge_30d,
                selector.metrics_resolved_edge_sample_count_30d
         from ai_note_targets target_row
         left join wallets w on w.id = target_row.target_id::uuid
         left join wallet_profiles wp on wp.wallet_id = w.id
         left join wallet_intel_selector_snapshot selector
           on selector.wallet_id = w.id
         where target_row.note_id = $1::uuid
           and target_row.target_kind = 'wallet'
         order by target_row.target_rank, target_row.target_id
         limit 5`,
        [row.id],
      );
      const positionKeys = holderRows.flatMap((holder) => {
        const side = nonEmptyString(
          record(holder.target_meta).side,
        )?.toUpperCase();
        return holder.wallet_id &&
          row.market_venue &&
          (side === "YES" || side === "NO")
          ? [
              {
                walletId: holder.wallet_id,
                venue: row.market_venue,
                marketId: row.source_id,
                outcomeSide: side,
              },
            ]
          : [];
      });
      let latestPositions: LatestHolderPositionMap = new Map();
      if (positionKeys.length > 0) {
        try {
          latestPositions = await loadLatestHolderPositions(positionKeys);
        } catch (error) {
          request.log.warn(
            { error, noteId: row.id },
            "Latest holder positions unavailable; using research snapshots",
          );
        }
      }
      const now = Date.now();
      const researchedAt = new Date(row.created_at).getTime();
      const isRecent = (value: Date | string | null | undefined) => {
        if (!value) return false;
        const timestamp = new Date(value).getTime();
        return (
          Number.isFinite(timestamp) &&
          timestamp >= researchedAt - 5 * 60_000 &&
          timestamp <= now + 5 * 60_000 &&
          now - timestamp <= LATEST_HOLDER_MAX_AGE_MS
        );
      };
      const holders = holderRows.map((holder) => {
        const meta = record(holder.target_meta);
        const side = nonEmptyString(meta.side)?.toUpperCase() ?? null;
        const latestPosition = holder.wallet_id
          ? latestPositions.get(
              makeWalletPositionLedgerKey(
                holder.wallet_id,
                row.source_id,
                side,
              ),
            )
          : null;
        const positionIsRecent =
          latestPosition?.positionSizeUsd != null &&
          latestPosition.positionSizeUsd > 0 &&
          isRecent(latestPosition.snapshotAt);
        const metricsAreRecent = isRecent(holder.metrics_as_of);
        return {
          address: holder.address,
          chain: holder.chain,
          side,
          outcomeLabel: outcomeLabel(row, side),
          descriptor: null,
          displayName: publicHolderDisplayName({
            profileLabel: holder.profile_label,
            identityDisplayName: meta.identityDisplayName,
            identityDisplayNameSource: meta.identityDisplayNameSource,
            address: holder.address,
          }),
          positionUsd: finiteNumber(meta.positionUsd),
          openPnlUsd: finiteNumber(meta.openPnlUsd),
          latestPosition: positionIsRecent
            ? {
                positionUsd: latestPosition.positionSizeUsd,
                openPnlUsd:
                  latestPosition.approxReliable &&
                  latestPosition.approxPnlSource === "activity"
                    ? latestPosition.openPnlUsd
                    : null,
              }
            : null,
          pnl30dUsd: finiteNumber(meta.pnl30dUsd),
          resolvedWinRateEdge30d: finiteNumber(meta.resolvedWinRateEdge30d),
          resolvedEdgeSampleCount30d: finiteNumber(
            meta.resolvedEdgeSampleCount30d,
          ),
          trades30d: finiteNumber(meta.trades30d),
          latestMetrics: metricsAreRecent
            ? {
                pnl30dUsd: finiteNumber(holder.metrics_pnl_30d),
                resolvedWinRateEdge30d: finiteNumber(
                  holder.metrics_resolved_win_rate_edge_30d,
                ),
                resolvedEdgeSampleCount30d: finiteNumber(
                  holder.metrics_resolved_edge_sample_count_30d,
                ),
                trades30d: finiteNumber(holder.metrics_trades_30d),
              }
            : null,
        };
      });
      return { ok: true, item: { ...toPublicHunch(row), holders } };
    },
  );
};
