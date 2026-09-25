import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { pool } from "../db.js";
import {
  publicHolderDisplayName,
  publicHunchSources,
} from "../services/hunch-public-presentation.js";

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
    limit: z.coerce.number().int().min(1).max(100).default(60),
  })
  .refine((value) => value.window !== "latest" || Boolean(value.marketId), {
    message: "marketId is required for latest",
    path: ["marketId"],
  });
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
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    },
    priceSnapshot:
      typeof snapshot.asOf === "string" &&
      typeof snapshot.displayPrice === "number"
        ? {
            asOf: snapshot.asOf,
            price: snapshot.displayPrice,
            side: snapshot.displaySide,
          }
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
const hunchListCache = new Map<
  string,
  { expiresAt: number; result: Promise<HunchListResponse> }
>();

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
  m.event_id, e.title as event_title
`;

export const hunchesRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/hunches",
    { schema: { querystring: querySchema } },
    async (request) => {
      const { window, strength, limit, marketId } = request.query;
      const strengths = strength.split(",");
      const marketFilter = marketId ? "and n.source_id = $4::text" : "";
      const cacheKey = JSON.stringify([
        window,
        strength,
        limit,
        marketId ?? null,
      ]);
      const cached = hunchListCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      const result = pool
        .query<PublicHunchRow>(
          `with recent_notes as materialized (
         select distinct on (n.source_id) n.id, n.source_id
         from ai_notes n
         where ($1::interval is null or n.created_at >= now() - $1::interval)
           and n.status = 'active'
           ${marketFilter}
           and ${PUBLIC_NOTES}
         order by n.source_id, n.created_at desc, n.id desc
       )
       select ${HUNCH_COLUMNS}
       from recent_notes recent
       join ai_notes n on n.id = recent.id
       left join unified_markets m on m.id = n.source_id
       left join unified_events e on e.id = m.event_id
       where 'all' = any($2::text[])
          or ('neutral' = any($2::text[]) and n.note_type = 'context')
          or ('good' = any($2::text[]) and n.note_type = 'signal'
              and coalesce(n.metrics #>> '{hunchStrengthV1,grade}', 'good') = 'good')
          or ('strong' = any($2::text[]) and n.note_type = 'signal'
              and n.metrics #>> '{hunchStrengthV1,grade}' = 'strong')
       order by n.created_at desc, n.id desc
       limit $3`,
          [
            window === "latest" ? null : durations[window],
            strengths,
            limit,
            ...(marketId ? [marketId] : []),
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
         left join unified_markets m on m.id = n.source_id
         left join unified_events e on e.id = m.event_id
         where n.id = $1::uuid and ${PUBLIC_NOTES}`,
        [request.params.noteId],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Hunch not found" });
      const { rows: holderRows } = await pool.query<{
        address: string | null;
        chain: string | null;
        profile_label: string | null;
        target_meta: unknown;
      }>(
        `select w.address, w.chain,
                wp.profile->>'label_short' as profile_label,
                target_row.target_meta
         from ai_note_targets target_row
         left join wallets w on w.id = target_row.target_id::uuid
         left join wallet_profiles wp on wp.wallet_id = w.id
         where target_row.note_id = $1::uuid
           and target_row.target_kind = 'wallet'
         order by target_row.target_rank, target_row.target_id
         limit 5`,
        [row.id],
      );
      const holders = holderRows.map((holder) => {
        const meta = record(holder.target_meta);
        const side = nonEmptyString(meta.side)?.toUpperCase() ?? null;
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
          pnl30dUsd: finiteNumber(meta.pnl30dUsd),
          resolvedWinRateEdge30d: finiteNumber(meta.resolvedWinRateEdge30d),
          resolvedEdgeSampleCount30d: finiteNumber(
            meta.resolvedEdgeSampleCount30d,
          ),
          trades30d: finiteNumber(meta.trades30d),
        };
      });
      return { ok: true, item: { ...toPublicHunch(row), holders } };
    },
  );
};
