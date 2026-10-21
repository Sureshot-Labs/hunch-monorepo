import { randomUUID } from "node:crypto";
import {
  acquireEmbeddingGenerationPin,
  embeddingCachePrefix,
  embeddingKey,
  parseEmbeddingVector,
  readActiveGeneration,
} from "@hunch/embeddings";
import { RESP_TYPES } from "redis";
import type { DbQuery } from "../db.js";
import {
  thesisSourceSchema,
  type ThesisSource,
  type SocialBuySnapshot,
} from "../schemas/social-trade.js";
import {
  marketMapActiveKey,
  marketMapRunNodesGlobalKey,
  marketMapRunNodeEventsKey,
  type MarketMapNode,
  type MarketMapEventSummary,
} from "./market-map.js";
import { buildSocialInstrument } from "./social-instrument.js";
import { socialMarketAccepting } from "./social-service.js";
import { SOCIAL_PUBLIC_AI } from "./social-visibility.js";
import type { AgentRedis } from "./agent-theses-state.js";
import { AGENT_THESES_PREFIX } from "./agent-theses-state.js";
import { validatePaperQuote } from "./agent-theses-publish.js";
import { relatedAgentMarkets } from "./agent-theses-retrieval.js";

export type AgentCandidate = {
  marketId: string;
  title: string;
  condition: string;
  category: string;
  eventTitle: string;
  closesAt: string | null;
  sides: Array<{
    label: string;
    instrument: SocialBuySnapshot["instrument"];
    ask: string;
    quoteAsOf: string;
  }>;
  sources: ThesisSource[];
};
type Cursor = {
  node: number;
  event: number;
  pendingEventId: string | null;
  marketAfter: string | null;
  runId: string | null;
};
function json<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function iso(raw: unknown): string | null {
  if (!(typeof raw === "string" || raw instanceof Date)) return null;
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
function text(raw: unknown, max: number) {
  return typeof raw === "string" ? raw.slice(0, max) : "";
}
/** Bounded source pages BEFORE optional filters. No broad candidate/holder SQL scan. */
export async function loadAgentMarketPool(
  db: DbQuery,
  redis: AgentRedis,
  maximum: number,
  ownerUserId?: string,
  interestMarketIds: string[] = [],
) {
  const diagnostics: string[] = [];
  const fresh = (
    await db.query(
      `with recent_notes as materialized (
       select source_id,source_kind,producer_type,status from ai_notes order by created_at desc limit 120
     ) select source_id from recent_notes where source_kind='market' and status='active'
       and producer_type in ('holder_research','map_signals') limit 30`,
    )
  ).rows.map((row) => String(row.source_id));
  // Reserve a rotation slot even for small configured pools. A one-slot pool
  // walks the map; fresh notes still fill it when the map is unavailable.
  const interestIds = [...new Set(interestMarketIds)].slice(
    0,
    Math.floor(maximum / 2),
  );
  const freshQuota = Math.min(
    30,
    Math.max(0, maximum - interestIds.length - 1),
    Math.max(1, Math.floor(maximum / 4)),
  );
  const ids = new Set([...interestIds, ...fresh.slice(0, freshQuota)]);
  const runId = await redis.get(marketMapActiveKey());
  const stored = json<Partial<Cursor>>(
    await redis.get(
      `${AGENT_THESES_PREFIX}:cursor${ownerUserId ? `:${ownerUserId}` : ""}`,
    ),
    {},
  );
  const cursor: Cursor = {
    node:
      Number.isSafeInteger(stored.node) && Number(stored.node) >= 0
        ? Number(stored.node)
        : 0,
    // Keep round-robin progress across map rebuilds. Resetting this offset
    // repeatedly replays the head of large leaves and can starve every later
    // leaf. Moved entries are revisited next circuit; shortened leaves advance.
    event:
      Number.isSafeInteger(stored.event) && Number(stored.event) >= 0
        ? Number(stored.event)
        : 0,
    // Finish an already discovered event by stable ID even if a new map moves it to another leaf.
    pendingEventId:
      typeof stored.pendingEventId === "string" ? stored.pendingEventId : null,
    marketAfter:
      typeof stored.pendingEventId === "string" &&
      typeof stored.marketAfter === "string"
        ? stored.marketAfter
        : null,
    runId,
  };
  const nodesRaw = runId
    ? json<MarketMapNode[]>(
        await redis.get(marketMapRunNodesGlobalKey(runId)),
        [],
      )
    : [];
  const nodes = (Array.isArray(nodesRaw) ? nodesRaw : [])
    .filter((node) => node.childIds?.length === 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  let processedEvents = 0;
  let visitedNodes = 0;
  while (
    runId &&
    nodes.length &&
    ids.size < maximum &&
    processedEvents < 12 &&
    visitedNodes < Math.min(nodes.length, 12)
  ) {
    cursor.node %= nodes.length;
    const node = nodes[cursor.node];
    const raw = json<MarketMapEventSummary[]>(
      await redis.get(marketMapRunNodeEventsKey(runId, node.id)),
      [],
    );
    const events = (Array.isArray(raw) ? raw : [])
      .slice()
      .sort((a, b) => a.eventId.localeCompare(b.eventId));
    if (!cursor.pendingEventId && cursor.event >= events.length) {
      cursor.node = (cursor.node + 1) % nodes.length;
      cursor.event = 0;
      cursor.marketAfter = null;
      visitedNodes++;
      continue;
    }
    const eventId = cursor.pendingEventId ?? events[cursor.event].eventId;
    const take = Math.min(30, maximum - ids.size);
    const markets = (
      await db.query(
        `select id from unified_markets where event_id=$1 ${cursor.marketAfter ? "and id>$2" : ""}
       order by id limit $${cursor.marketAfter ? 3 : 2}`,
        cursor.marketAfter
          ? [eventId, cursor.marketAfter, take]
          : [eventId, take],
      )
    ).rows;
    processedEvents++;
    for (const row of markets) ids.add(row.id);
    if (markets.length < take) {
      cursor.marketAfter = null;
      cursor.pendingEventId = null;
      if (events[cursor.event]?.eventId === eventId) cursor.event++;
      else {
        cursor.node = (cursor.node + 1) % nodes.length;
        cursor.event = 0;
        visitedNodes++;
      }
    } else {
      cursor.marketAfter = markets[markets.length - 1].id;
      cursor.pendingEventId = eventId;
    }
  }
  if (!nodes.length) diagnostics.push("map_unavailable");
  for (const id of fresh) {
    if (ids.size >= maximum) break;
    ids.add(id);
  }
  return {
    marketIds: [...ids].slice(0, maximum),
    freshMarketIds: fresh,
    cursor,
    diagnostics,
  };
}

export async function loadAgentCandidates(input: {
  db: DbQuery;
  redis: AgentRedis;
  marketIds: string[];
  maxQuoteAgeSeconds: number;
  limitlessPositionContract?: string;
  now?: Date;
}): Promise<{ candidates: AgentCandidate[]; diagnostics: string[] }> {
  if (!input.marketIds.length) return { candidates: [], diagnostics: [] };
  const rows = (
    await input.db.query(
      `select m.*,e.title as event_title,e.status as event_status,e.end_date as event_end_time,
      pm.accepting_orders as pm_accepting_orders,
      tok.token_id,tok.side,q.best_ask::text,q.ts as quote_at
     from unnest($1::text[]) requested(market_id)
     join unified_markets m on m.id=requested.market_id
     left join unified_events e on e.id=m.event_id
     left join polymarket_markets pm on m.venue='polymarket' and pm.id=m.venue_market_id
     join unified_tokens tok on tok.market_id=m.id and tok.side in ('YES','NO')
     left join unified_token_top_latest q on q.token_id=tok.token_id`,
      [input.marketIds.slice(0, 120)],
    )
  ).rows;
  // Preserve an explicit historical clock, but live time must follow the read.
  const now = input.now ?? new Date();
  const candidates = new Map<string, AgentCandidate>();
  const diagnostics: string[] = [];
  for (const row of rows) {
    if (!socialMarketAccepting(row)) continue;
    const instrument = buildSocialInstrument({
      marketId: row.id,
      venue: row.venue,
      outcome: row.side,
      tokenId: row.token_id,
      expiry: iso(row.expiration_time),
      metadata: row.metadata,
      limitlessPositionContract: input.limitlessPositionContract,
    });
    if (!instrument) continue;
    let quote;
    try {
      quote = validatePaperQuote({
        ask: row.best_ask,
        asOf: row.quote_at,
        now,
        maxAgeSeconds: input.maxQuoteAgeSeconds,
        maxEntryPrice: "1",
      });
    } catch {
      continue;
    }
    const candidate: AgentCandidate = candidates.get(row.id) ?? {
      marketId: row.id,
      title: text(row.title, 240),
      // Settlement clauses often appear at the end. Only optional excerpts are
      // shortened; the writer's complete request has a separate resource bound.
      condition: typeof row.description === "string" ? row.description : "",
      category: text(row.category, 120),
      eventTitle: text(row.event_title, 240),
      closesAt: iso(row.close_time ?? row.expiration_time),
      sides: [],
      sources: [],
    };
    const outcomes = Array.isArray(row.outcomes)
      ? row.outcomes
      : json<string[]>(row.outcomes, []);
    candidate.sides.push({
      instrument,
      ask: quote.ask,
      quoteAsOf: quote.asOf,
      label: text(outcomes[row.side === "YES" ? 0 : 1], 160) || row.side,
    });
    candidates.set(row.id, candidate);
  }
  // Each exact contract has a citable data record, even when optional news/notes are missing.
  for (const c of candidates.values())
    c.sources.push({
      id: `market:${c.marketId}`,
      kind: "market",
      title: c.title,
      excerpt: c.condition.slice(0, 1200),
      url: null,
      asOf: now.toISOString(),
    });
  diagnostics.push(
    ...(await attachAgentStoredNotes(input.db, [...candidates.values()], now)),
  );
  try {
    diagnostics.push(
      ...(await attachStoredNews(input.redis, [...candidates.values()], now)),
    );
  } catch {
    diagnostics.push("stored_background_unavailable");
  }
  return {
    candidates: input.marketIds.flatMap((id) => {
      const candidate = candidates.get(id);
      return candidate ? [candidate] : [];
    }),
    diagnostics,
  };
}

async function attachAgentStoredNotes(
  db: DbQuery,
  items: AgentCandidate[],
  now: Date,
  deep = false,
) {
  // Persisted map/holder directions are up/down/mixed, not trade outcomes.
  const directionSide = (direction: unknown) =>
    direction === "up" || direction === "YES"
      ? "YES"
      : direction === "down" || direction === "NO"
        ? "NO"
        : null;
  const candidates = new Map(items.map((c) => [c.marketId, c]));
  const diagnostics: string[] = [];
  if (!items.length) return diagnostics;
  try {
    const notes = (
      await db.query(
        `select requested.market_id,note_row.* from unnest($1::text[]) requested(market_id)
       cross join lateral (
         select n.id,n.title,n.description,n.direction,n.created_at,n.metrics->'sides' as holder_sides,
           coalesce(n.metrics#>'{publicContextV1,caveats}',n.model_meta->'caveats') as caveats,
           n.model_meta->'public_source_citations' as cited_sources
         from (select * from ai_notes
           where source_kind='market' and source_id=requested.market_id and created_at<=$2
           order by created_at desc limit 12) n
         where n.status='active' and (
           (n.producer_type='map_signals' and n.note_type='signal') or (${SOCIAL_PUBLIC_AI}))
         order by n.created_at desc limit $3
       ) note_row`,
        [[...candidates.keys()], now, deep ? 12 : 2],
      )
    ).rows;
    // Include the newest opposite interpretation when available, not only a
    // chronological stack of the same direction. It remains Hunch opinion.
    const selectedNotes = deep
      ? items.flatMap((c) => {
          const rows = notes.filter((n) => n.market_id === c.marketId);
          const first = rows[0];
          const firstSide = rows
            .map((n) => directionSide(n.direction))
            .find(Boolean);
          const opposite =
            firstSide &&
            rows.find(
              (n) =>
                directionSide(n.direction) != null &&
                directionSide(n.direction) !== firstSide,
            );
          return [...new Set([first, opposite, ...rows].filter(Boolean))].slice(
            0,
            4,
          );
        })
      : notes;
    for (const note of selectedNotes) {
      const candidate = candidates.get(note.market_id);
      if (!candidate) continue;
      candidate.sources.push({
        id: `note:${note.id}`,
        kind: "hunch_analysis",
        title: text(note.title, 240),
        excerpt: text(
          `${note.direction ? `[Prior ${directionSide(note.direction) ?? note.direction} interpretation] ` : ""}${note.description ?? ""}`,
          1200,
        ),
        url: null,
        asOf: iso(note.created_at),
        caveats: (Array.isArray(note.caveats) ? note.caveats : [])
          .filter((value: unknown) => typeof value === "string")
          .slice(0, 3)
          .map((value: string) => text(value, 300)),
        citedSources: (Array.isArray(note.cited_sources)
          ? note.cited_sources
          : []
        )
          .flatMap((value: Record<string, unknown>) => {
            if (!value || typeof value.url !== "string") return [];
            try {
              const url = new URL(value.url);
              if (!["http:", "https:"].includes(url.protocol)) return [];
              return [
                {
                  title: text(value.title, 160),
                  url: url.href,
                  asOf: iso(value.publishedAt),
                },
              ];
            } catch {
              return [];
            }
          })
          .slice(0, 3),
      });
      // Only already persisted research facts; no new wallet refresh or holder research.
      const holder = note.holder_sides;
      const summary =
        holder && typeof holder === "object"
          ? Object.fromEntries(
              ["YES", "NO"].flatMap((side) => {
                const values = holder[side];
                if (!values || typeof values !== "object") return [];
                return [
                  [
                    side,
                    Object.fromEntries(
                      [
                        "usd",
                        "wallets",
                        "sharpHolders",
                        "sharpUsd",
                        "bestEdge",
                        "bestZScore",
                        "bestSampleCount",
                      ].map((key) => [
                        key,
                        typeof values[key] === "number" &&
                        Number.isFinite(values[key])
                          ? values[key]
                          : null,
                      ]),
                    ),
                  ],
                ];
              }),
            )
          : null;
      if (
        summary &&
        Object.keys(summary).length &&
        candidate.sources.length < 6
      )
        candidate.sources.push({
          id: `holders:${note.id}`,
          kind: "holder_summary",
          title: "Holder research at note time",
          excerpt: JSON.stringify(summary).slice(0, 1200),
          url: null,
          asOf: iso(note.created_at),
        });
    }
  } catch {
    diagnostics.push("stored_notes_unavailable");
  }
  return diagnostics;
}

/** Fresh material gets room, but cannot permanently occupy all model slots. */
export function selectAgentShortlist(
  candidates: AgentCandidate[],
  freshIds: string[],
  lastConsidered: Array<number | null>,
  maximum: number,
  interests = "",
  semanticMarketIds: string[] = [],
) {
  // Cheap soft relevance, not a category gate or semantic matching claim.
  // Rotation still supplies candidates when aliases/languages do not overlap.
  const terms = [
    ...new Set(interests.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  ];
  const interestScore = (candidate: AgentCandidate) => {
    const words = new Set(
      `${candidate.title} ${candidate.eventTitle} ${candidate.category}`
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
    );
    const semanticRank = semanticMarketIds.indexOf(candidate.marketId);
    return (
      terms.reduce((score, term) => score + Number(words.has(term)), 0) +
      (semanticRank < 0 ? 0 : 1 + 1 / (semanticRank + 1))
    );
  };
  const fresh = new Set(freshIds);
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      at: lastConsidered[index] ?? 0,
      relevance: interestScore(candidate),
    }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  // One slot cannot satisfy two quotas: pick the least recently considered
  // candidate so a persistent fresh note cannot starve exploration.
  if (maximum <= 1)
    return ranked.slice(0, Math.max(0, maximum)).map((r) => r.candidate);
  const preferred = ranked
    .filter((r) => r.relevance > 0)
    .sort(
      (a, b) => a.at - b.at || b.relevance - a.relevance || a.index - b.index,
    )
    .slice(0, Math.floor(maximum / 2));
  const preferredIds = new Set(preferred.map((r) => r.candidate.marketId));
  const remaining = ranked.filter(
    (r) => !preferredIds.has(r.candidate.marketId),
  );
  const freshQuota = Math.min(
    Math.max(1, Math.floor(maximum / 3)),
    maximum - preferred.length - 1,
  );
  const selected = [
    ...preferred,
    ...remaining
      .filter((r) => fresh.has(r.candidate.marketId))
      .slice(0, freshQuota),
  ];
  const used = new Set(selected.map((r) => r.candidate.marketId));
  const exploration = [...ranked].sort(
    (a, b) =>
      a.at - b.at ||
      Number(fresh.has(a.candidate.marketId)) -
        Number(fresh.has(b.candidate.marketId)) ||
      a.index - b.index,
  );
  for (const row of exploration)
    if (selected.length < maximum && !used.has(row.candidate.marketId)) {
      selected.push(row);
      used.add(row.candidate.marketId);
    }
  return selected.map((r) => r.candidate);
}

/** Existing vectors improve ranking; unavailable vectors do not hide cached news. */
async function attachStoredNews(
  redis: AgentRedis,
  candidates: AgentCandidate[],
  now: Date,
  deep = false,
) {
  const ids = await redis.zRange(
    "ai:map_search:v1:recent_evidence",
    deep ? -600 : -200,
    -1,
  );
  if (!ids.length) return [];
  const diagnostics: string[] = [];
  const docs = await redis.mGet(
    ids.map((id) => `ai:map_search:v1:evidence:${id}`),
  );
  let newsVectors: Array<number[] | null> = [];
  let marketVectors: Array<number[] | null> = [];
  try {
    const generation = await readActiveGeneration(redis);
    const pin = await acquireEmbeddingGenerationPin(
      redis,
      generation,
      `agent-theses:${randomUUID()}`,
      120,
    );
    if (!pin) throw new Error("embedding_generation_unavailable");
    try {
      const binary = redis.withTypeMapping({
        [RESP_TYPES.BLOB_STRING]: Buffer,
      });
      const [rawNews, rawMarkets] = await Promise.all([
        redis.mGet(
          ids.map((id) => `${embeddingCachePrefix(generation)}:news:${id}`),
        ),
        Promise.all(
          candidates.map((candidate) =>
            binary.hGet(
              embeddingKey(generation, "market", candidate.marketId),
              "embedding",
            ),
          ),
        ),
      ]);
      pin.assertHeld();
      newsVectors = rawNews.map((raw) =>
        parseEmbeddingVector(json(raw, null), generation),
      );
      marketVectors = rawMarkets.map((raw) =>
        parseEmbeddingVector(raw, generation),
      );
    } finally {
      await pin.release();
    }
  } catch {
    // Never compare vectors across generations or after a lost pin.
    newsVectors = [];
    marketVectors = [];
    diagnostics.push("stored_news_vectors_unavailable");
  }
  const news = docs.flatMap((doc, index) => {
    const data = json<Record<string, unknown>>(doc, {});
    const date = iso(data.publishedAt);
    if (
      !date ||
      Date.parse(date) > now.getTime() ||
      Date.parse(date) < now.getTime() - 30 * 86400000
    )
      return [];
    const source = thesisSourceSchema.safeParse({
      id: `news:${ids[index]}`,
      kind: "external_summary",
      title: text(data.headline, 240),
      excerpt: text(data.summary, 1200),
      url: data.sourceUrl ?? null,
      asOf: date,
      confirmation:
        data.confirmation === "confirmed" || data.confirmation === "developing"
          ? data.confirmation
          : "unconfirmed",
      sourceTier: [
        "official",
        "wire",
        "major_media",
        "specialist",
        "social",
      ].includes(String(data.sourceTier))
        ? data.sourceTier
        : "unknown",
    });
    if (!source.success) return [];
    return [
      {
        source: source.data,
        vector: newsVectors[index] ?? null,
      },
    ];
  });
  for (const [index, candidate] of candidates.entries()) {
    const vector = marketVectors[index] ?? null;
    const terms = new Set(
      `${candidate.title} ${candidate.eventTitle}`
        .toLowerCase()
        .match(/\p{L}{4,}/gu) ?? [],
    );
    const ranked = news
      .map((n) => {
        const lexical =
          [...terms].filter((t) =>
            `${n.source.title} ${n.source.excerpt}`.toLowerCase().includes(t),
          ).length / Math.max(1, terms.size);
        let similarity = 0;
        if (vector && n.vector && vector.length === n.vector.length) {
          let dot = 0,
            a = 0,
            b = 0;
          for (let i = 0; i < vector.length; i++) {
            dot += vector[i] * n.vector[i];
            a += vector[i] ** 2;
            b += n.vector[i] ** 2;
          }
          similarity = a && b ? dot / Math.sqrt(a * b) : 0;
        }
        return { ...n, score: Math.max(lexical, similarity) };
      })
      .filter((n) => n.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, deep ? 4 : 3);
    candidate.sources.push(...ranked.map((n) => n.source));
    candidate.sources = [
      ...new Map(candidate.sources.map((s) => [s.id, s])).values(),
    ].slice(0, deep ? 12 : 8);
  }
  return diagnostics;
}

/** Deeper bounded saved context only for Jev's market (or its <=3 fallback).
 * No search, new news embeddings, refreshed holders, or changed entry quote. */
export async function enrichAgentSelectedContext(input: {
  db: DbQuery;
  redis: AgentRedis;
  candidates: AgentCandidate[];
  now: Date;
}) {
  const candidates = input.candidates.slice(0, 3).map((c) => ({
    ...c,
    sources: c.sources.filter((s) => s.kind === "market"),
  }));
  const diagnostics = await attachAgentStoredNotes(
    input.db,
    candidates,
    input.now,
    true,
  );
  // Missing optional sources do not erase the context already used by Jev.
  for (const c of candidates) {
    const previous = input.candidates.find((p) => p.marketId === c.marketId);
    c.sources = [
      ...new Map(
        [...(previous?.sources ?? []), ...c.sources].map((s) => [s.id, s]),
      ).values(),
    ];
  }
  try {
    diagnostics.push(
      ...(await attachStoredNews(input.redis, candidates, input.now, true)),
    );
  } catch {
    diagnostics.push("selected_news_unavailable");
  }
  for (const candidate of candidates) {
    try {
      const ids = await relatedAgentMarkets(input.redis, candidate.marketId);
      const related = ids.map((marketId) => ({
        ...candidate,
        marketId,
        sources: [] as ThesisSource[],
      }));
      diagnostics.push(
        ...(await attachAgentStoredNotes(input.db, related, input.now)),
      );
      const background = related
        .flatMap((c) =>
          c.sources
            .filter((s) => s.kind === "hunch_analysis")
            .map((s) => ({
              ...s,
              excerpt:
                `[Related contract ${c.marketId}; background, not evidence of this contract's outcome] ${s.excerpt}`.slice(
                  0,
                  1200,
                ),
            })),
        )
        .slice(0, 2);
      // Keep exact and external evidence ahead of related interpretations.
      candidate.sources = [
        ...new Map(
          [...candidate.sources, ...background].map((s) => [s.id, s]),
        ).values(),
      ].slice(0, 14);
    } catch {
      diagnostics.push("selected_related_unavailable");
    }
  }
  return { candidates, diagnostics: [...new Set(diagnostics)] };
}
