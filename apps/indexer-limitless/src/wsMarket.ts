import PQueue from "p-queue";
import { io, type Socket } from "socket.io-client";
import { writeUnifiedBookTop } from "@hunch/db";
import { createTopTickGate, publishMarketState } from "@hunch/infra";

import { env } from "./env.js";
import { log } from "./log.js";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";
import { normalizeLimitlessPricePair } from "./price-normalization.js";
import {
  deriveLimitlessClobSiblingTop,
  limitlessClobDirectTopTracker,
  recordLimitlessClobDerivedSiblingTopSkippedRecentDirect,
  recordLimitlessClobDerivedSiblingTopUpdated,
  type LimitlessClobTokenPair,
} from "./clobComplement.js";
import {
  applyClobBookUpdate,
  buildClobBookSnapshot,
  createClobBookState,
  type ClobBookEntry,
  type ClobBookState,
} from "./clobBook.js";

type OrderbookUpdate = {
  marketSlug?: string;
  orderbook?: {
    bids?: ClobBookEntry[];
    asks?: ClobBookEntry[];
    tokenId?: string;
  };
  timestamp?: number | string;
};

type NewPriceEntry = {
  marketId?: number;
  marketAddress?: string;
  yesPrice?: number | string | null;
  noPrice?: number | string | null;
  yes?: number | string | null;
  no?: number | string | null;
};

type NewPriceData = {
  marketAddress?: string;
  updatedPrices?: NewPriceEntry | NewPriceEntry[];
  timestamp?: number | string;
};

type LimitlessResolvedOutcome = "YES" | "NO";

type ResolvedMarketRef = {
  marketId: string;
  venueMarketId: string;
  slug: string | null;
  address: string | null;
  tokenYes: string;
  tokenNo: string;
  sourceWinningOutcomeIndex: number | null;
};

type ApplyLimitlessResolvedMarketTopInputs = {
  slug?: string | null;
  address?: string | null;
  marketId?: string | number | null;
  winningOutcome?: unknown;
  winningOutcomeIndex?: unknown;
  ts?: Date;
  source: "ws_market_resolved" | "http_fallback";
};

type ApplyLimitlessResolvedMarketTopResult = {
  updated: boolean;
  ignoredReason?: string;
  marketId?: string;
  resolvedOutcome?: LimitlessResolvedOutcome;
  tokensUpdated: number;
};

type TokenPair = {
  yesTokenId: string;
  noTokenId: string;
};

export type WsTargets = {
  slugs: string[];
  addresses: string[];
};

type WsSocketKind = "clob" | "amm";

type SocketState = {
  clob: string[];
  amm: string[];
};

type SocketMap = {
  clob: Socket | null;
  amm: Socket | null;
};

const EMPTY_WS_TARGETS: WsTargets = { slugs: [], addresses: [] };
const EMPTY_SOCKET_STATE: SocketState = { clob: [], amm: [] };
const state: SocketState = { ...EMPTY_SOCKET_STATE };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;
const currentSockets: SocketMap = { clob: null, amm: null };
let baseTargets: WsTargets = EMPTY_WS_TARGETS;
let desiredTargets: WsTargets = EMPTY_WS_TARGETS;
const expectedDisconnectKinds = new Set<WsSocketKind>();
const demandSlugExpiresAt = new Map<string, number>();
const demandAddressExpiresAt = new Map<string, number>();

export type LimitlessWsDemandEventStats = {
  clobOrderbookDemandEvents: number;
  ammPriceDemandEvents: number;
  resolvedDemandEvents: number;
};

const wsDemandEventStats: LimitlessWsDemandEventStats = {
  clobOrderbookDemandEvents: 0,
  ammPriceDemandEvents: 0,
  resolvedDemandEvents: 0,
};

const addressTokens = new Map<string, TokenPair>();
const marketIdTokens = new Map<string, TokenPair>();
const tokenPairByTokenId = new Map<string, LimitlessClobTokenPair>();
const clobBooks = new Map<string, ClobBookState>();
const missingAddressRetryAt = new Map<string, number>();
const missingMarketIdRetryAt = new Map<string, number>();
const missingTokenRetryAt = new Map<string, number>();
const MISSING_TOKEN_RETRY_MS = 10_000;

const topTickGate = createTopTickGate({
  onDeferredPublish: ({ tokenId, bestBid, bestAsk, tsMs }) => {
    const book = clobBooks.get(tokenId);
    const snapshot = book
      ? buildClobBookSnapshot(tokenId, book, String(tsMs))
      : undefined;
    void publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs, snapshot).catch(
      (error) => {
        log.warn("Deferred top tick publish failed", {
          tokenId,
          error: String(error),
        });
      },
    );
  },
});

function bindRedisErrorOnce() {
  if (redisBound) return;
  redisBound = true;
  redis.on("error", (e) => log.err("redis error", e));
}

function normalizeSlug(value: string): string {
  return value.trim();
}

function uniqueSlugs(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeSlug).filter((v) => v.length > 0)),
  );
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueAddresses(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeAddress).filter((v) => v.length > 0)),
  );
}

function isActiveDemandSlug(
  value?: string | null,
  nowMs = Date.now(),
): boolean {
  if (!value) return false;
  const expiresAt = demandSlugExpiresAt.get(normalizeSlug(value));
  return expiresAt != null && expiresAt > nowMs;
}

function isActiveDemandAddress(
  value?: string | null,
  nowMs = Date.now(),
): boolean {
  if (!value) return false;
  const expiresAt = demandAddressExpiresAt.get(normalizeAddress(value));
  return expiresAt != null && expiresAt > nowMs;
}

export function getLimitlessWsDemandEventStats(): LimitlessWsDemandEventStats {
  return { ...wsDemandEventStats };
}

export function diffLimitlessWsDemandEventStats(
  before: LimitlessWsDemandEventStats,
): LimitlessWsDemandEventStats {
  return {
    clobOrderbookDemandEvents:
      wsDemandEventStats.clobOrderbookDemandEvents -
      before.clobOrderbookDemandEvents,
    ammPriceDemandEvents:
      wsDemandEventStats.ammPriceDemandEvents - before.ammPriceDemandEvents,
    resolvedDemandEvents:
      wsDemandEventStats.resolvedDemandEvents - before.resolvedDemandEvents,
  };
}

function prefixLimitlessToken(tokenId?: string | null): string | undefined {
  if (!tokenId) return undefined;
  return tokenId.startsWith("limitless:") ? tokenId : `limitless:${tokenId}`;
}

function cacheLimitlessClobTokenPair(pair: TokenPair): LimitlessClobTokenPair {
  const yesTokenId = prefixLimitlessToken(pair.yesTokenId);
  const noTokenId = prefixLimitlessToken(pair.noTokenId);
  if (!yesTokenId || !noTokenId) return pair;
  const normalized = { yesTokenId, noTokenId };
  tokenPairByTokenId.set(yesTokenId, normalized);
  tokenPairByTokenId.set(noTokenId, normalized);
  return normalized;
}

function expandLimitlessTokenLookupIds(tokenIds: string[]): string[] {
  const out = new Set<string>();
  for (const raw of tokenIds) {
    const tokenId = raw.trim();
    if (!tokenId) continue;
    out.add(tokenId);
    const stripped = tokenId.replace(/^limitless:/, "");
    if (stripped) {
      out.add(stripped);
      out.add(`limitless:${stripped}`);
    }
  }
  return Array.from(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function normalizeLimitlessMarketId(value: unknown): string | null {
  const text = parseString(value);
  if (!text) return null;
  return text.startsWith("limitless:") ? text.slice("limitless:".length) : text;
}

function readResolvedPayloadField(payload: unknown, keys: string[]): unknown {
  if (!isRecord(payload)) return undefined;
  for (const key of keys) {
    if (payload[key] != null) return payload[key];
  }
  const nested = payload.data;
  if (!isRecord(nested)) return undefined;
  for (const key of keys) {
    if (nested[key] != null) return nested[key];
  }
  return undefined;
}

function parseOutcomeIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

export function inferLimitlessResolvedOutcome(input: {
  winningOutcome?: unknown;
  winningOutcomeIndex?: unknown;
  fallbackWinningOutcomeIndex?: number | null;
}): LimitlessResolvedOutcome | null {
  const index =
    parseOutcomeIndex(input.winningOutcomeIndex) ??
    input.fallbackWinningOutcomeIndex ??
    null;
  if (index === 0) return "YES";
  if (index === 1) return "NO";

  const text = parseString(input.winningOutcome);
  if (!text) return null;
  const normalized = text.trim().toUpperCase();
  if (normalized === "YES" || normalized === "Y" || normalized === "0") {
    return "YES";
  }
  if (normalized === "NO" || normalized === "N" || normalized === "1") {
    return "NO";
  }
  return null;
}

function buildBookSide(best: number | null) {
  return best != null ? [{ price: String(best), size: "NA" }] : [];
}

function getClobBook(tokenId: string): ClobBookState {
  const existing = clobBooks.get(tokenId);
  if (existing) return existing;
  const next = createClobBookState();
  clobBooks.set(tokenId, next);
  return next;
}

function clearClobBooks(reason: string): void {
  if (clobBooks.size === 0) return;
  const cleared = clobBooks.size;
  clobBooks.clear();
  log.info("Limitless CLOB book cache cleared", { reason, cleared });
}

function clearSocketBookState(kind: WsSocketKind, reason: string): void {
  if (kind === "clob") clearClobBooks(reason);
}

async function publishTokenTop(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
  snapshot?: unknown,
): Promise<boolean> {
  if (bestBid == null && bestAsk == null) return false;

  const tsMs = ts.getTime();
  if (!topTickGate.shouldPublish({ tokenId, bestBid, bestAsk, tsMs })) {
    return false;
  }

  await publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs, snapshot);
  return true;
}

async function publishTokenTopNow(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
  snapshot?: unknown,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;
  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);
  const snap =
    snapshot ??
    ({
      token_id: tokenId,
      bids: buildBookSide(bestBid),
      asks: buildBookSide(bestAsk),
      timestamp: tsMs.toString(),
    } as const);

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, new Date(tsMs)),
    multi.exec(),
  ]);
}

async function publishClobTopWithSibling(input: {
  directTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  ts: Date;
  snapshot?: unknown;
  pair: LimitlessClobTokenPair | null;
}): Promise<void> {
  const tsMs = input.ts.getTime();
  limitlessClobDirectTopTracker.markDirectTop(input.directTokenId, tsMs);
  await publishTokenTop(
    input.directTokenId,
    input.bestBid,
    input.bestAsk,
    input.ts,
    input.snapshot,
  );

  if (!input.pair) return;
  const sibling = deriveLimitlessClobSiblingTop({
    directTokenId: input.directTokenId,
    pair: input.pair,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
  });
  if (!sibling) return;

  if (
    limitlessClobDirectTopTracker.shouldSkipDerivedTop(sibling.tokenId, tsMs)
  ) {
    recordLimitlessClobDerivedSiblingTopSkippedRecentDirect();
    return;
  }

  const published = await publishTokenTop(
    sibling.tokenId,
    sibling.bestBid,
    sibling.bestAsk,
    input.ts,
  );
  if (published) recordLimitlessClobDerivedSiblingTopUpdated();
}

async function fetchTokensForAddresses(
  addresses: string[],
): Promise<Map<string, TokenPair>> {
  if (!addresses.length) return new Map();
  const { rows } = await pool.query<{
    address: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select lower(m.metadata->>'address') as address,
             m.token_yes,
             m.token_no
      from unified_markets m
      where m.venue = 'limitless'
        and m.metadata ? 'address'
        and lower(m.metadata->>'address') = any($1::text[])
    `,
    [addresses],
  );

  const map = new Map<string, TokenPair>();
  for (const row of rows) {
    if (!row.address || !row.token_yes || !row.token_no) continue;
    const yes = prefixLimitlessToken(row.token_yes);
    const no = prefixLimitlessToken(row.token_no);
    if (!yes || !no) continue;
    map.set(row.address, { yesTokenId: yes, noTokenId: no });
  }
  return map;
}

async function fetchTokensForMarketIds(
  marketIds: string[],
): Promise<Map<string, TokenPair>> {
  if (!marketIds.length) return new Map();
  const { rows } = await pool.query<{
    venue_market_id: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select m.venue_market_id,
             m.token_yes,
             m.token_no
      from unified_markets m
      where m.venue = 'limitless'
        and m.venue_market_id = any($1::text[])
    `,
    [marketIds],
  );

  const map = new Map<string, TokenPair>();
  for (const row of rows) {
    if (!row.venue_market_id || !row.token_yes || !row.token_no) continue;
    const yes = prefixLimitlessToken(row.token_yes);
    const no = prefixLimitlessToken(row.token_no);
    if (!yes || !no) continue;
    map.set(row.venue_market_id, { yesTokenId: yes, noTokenId: no });
  }
  return map;
}

async function fetchTokensForTokenIds(
  tokenIds: string[],
): Promise<Map<string, LimitlessClobTokenPair>> {
  const lookupTokenIds = expandLimitlessTokenLookupIds(tokenIds);
  if (!lookupTokenIds.length) return new Map();

  const { rows } = await pool.query<{
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select m.token_yes,
             m.token_no
      from unified_markets m
      where m.venue = 'limitless'
        and (
          m.token_yes = any($1::text[])
          or m.token_no = any($1::text[])
        )
    `,
    [lookupTokenIds],
  );

  const map = new Map<string, LimitlessClobTokenPair>();
  for (const row of rows) {
    if (!row.token_yes || !row.token_no) continue;
    const pair = cacheLimitlessClobTokenPair({
      yesTokenId: row.token_yes,
      noTokenId: row.token_no,
    });
    map.set(pair.yesTokenId, pair);
    map.set(pair.noTokenId, pair);
  }
  return map;
}

async function ensureTokensForAddress(
  address: string,
): Promise<TokenPair | null> {
  const key = address.toLowerCase();
  const existing = addressTokens.get(key);
  if (existing) return existing;
  const nextRetryAt = missingAddressRetryAt.get(key) ?? 0;
  if (nextRetryAt > Date.now()) return null;
  missingAddressRetryAt.set(key, Date.now() + MISSING_TOKEN_RETRY_MS);
  const map = await fetchTokensForAddresses([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    addressTokens.set(key, tokens);
    cacheLimitlessClobTokenPair(tokens);
    missingAddressRetryAt.delete(key);
  } else {
    log.warn("WS AMM token mapping missing", { address: key });
  }
  return tokens;
}

async function ensureTokensForMarketId(
  marketId: string,
): Promise<TokenPair | null> {
  const key = marketId;
  const existing = marketIdTokens.get(key);
  if (existing) return existing;
  const nextRetryAt = missingMarketIdRetryAt.get(key) ?? 0;
  if (nextRetryAt > Date.now()) return null;
  missingMarketIdRetryAt.set(key, Date.now() + MISSING_TOKEN_RETRY_MS);
  const map = await fetchTokensForMarketIds([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    marketIdTokens.set(key, tokens);
    cacheLimitlessClobTokenPair(tokens);
    missingMarketIdRetryAt.delete(key);
  } else {
    log.warn("WS AMM token mapping missing", { marketId: key });
  }
  return tokens;
}

async function ensureTokensForClobToken(
  tokenId: string,
): Promise<LimitlessClobTokenPair | null> {
  const key = prefixLimitlessToken(tokenId);
  if (!key) return null;
  const existing = tokenPairByTokenId.get(key);
  if (existing) return existing;
  const nextRetryAt = missingTokenRetryAt.get(key) ?? 0;
  if (nextRetryAt > Date.now()) return null;
  missingTokenRetryAt.set(key, Date.now() + MISSING_TOKEN_RETRY_MS);
  const map = await fetchTokensForTokenIds([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    missingTokenRetryAt.delete(key);
  } else {
    log.warn("WS CLOB token pair mapping missing", { tokenId: key });
  }
  return tokens;
}

function pickResolvedSlug(payload: unknown): string | null {
  return parseString(readResolvedPayloadField(payload, ["slug", "marketSlug"]));
}

function pickResolvedAddress(payload: unknown): string | null {
  const value = parseString(
    readResolvedPayloadField(payload, ["address", "marketAddress"]),
  );
  return value?.toLowerCase() ?? null;
}

function pickResolvedMarketId(payload: unknown): string | null {
  return normalizeLimitlessMarketId(
    readResolvedPayloadField(payload, ["marketId", "marketID", "id"]),
  );
}

function pickResolvedTimestamp(payload: unknown): Date {
  const value = readResolvedPayloadField(payload, ["timestamp", "ts"]);
  return parseLimitlessWsTimestamp(value);
}

export function parseLimitlessWsTimestamp(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value < 10_000_000_000 ? value * 1000 : value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = trimmed.length ? Number(trimmed) : NaN;
    const parsed = Number.isFinite(numeric)
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(trimmed);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function resolveMarketForResolution(
  inputs: Pick<
    ApplyLimitlessResolvedMarketTopInputs,
    "slug" | "address" | "marketId"
  >,
): Promise<ResolvedMarketRef | null> {
  const slug = inputs.slug?.trim() || null;
  const address = inputs.address?.trim().toLowerCase() || null;
  const marketId = normalizeLimitlessMarketId(inputs.marketId);
  if (!slug && !address && !marketId) return null;

  const { rows } = await pool.query<{
    market_id: string;
    venue_market_id: string;
    slug: string | null;
    address: string | null;
    token_yes: string | null;
    token_no: string | null;
    winning_outcome_index: number | null;
  }>(
    `
      select
        m.id as market_id,
        m.venue_market_id,
        m.slug,
        lower(nullif(m.metadata->>'address', '')) as address,
        m.token_yes,
        m.token_no,
        lm.winning_outcome_index
      from unified_markets m
      left join limitless_markets lm on lm.id = m.venue_market_id
      where m.venue = 'limitless'
        and (
          ($1::text is not null and m.slug = $1::text)
          or ($2::text is not null and lower(nullif(m.metadata->>'address', '')) = $2::text)
          or ($3::text is not null and m.venue_market_id = $3::text)
        )
      order by
        case
          when $3::text is not null and m.venue_market_id = $3::text then 0
          when $1::text is not null and m.slug = $1::text then 1
          when $2::text is not null and lower(nullif(m.metadata->>'address', '')) = $2::text then 2
          else 3
        end,
        m.updated_at_db desc
      limit 1
    `,
    [slug, address, marketId],
  );

  const row = rows[0];
  const tokenYes = prefixLimitlessToken(row?.token_yes);
  const tokenNo = prefixLimitlessToken(row?.token_no);
  if (!row || !tokenYes || !tokenNo) return null;

  return {
    marketId: row.market_id,
    venueMarketId: row.venue_market_id,
    slug: row.slug,
    address: row.address,
    tokenYes,
    tokenNo,
    sourceWinningOutcomeIndex: row.winning_outcome_index,
  };
}

async function updateResolvedMarketRows(
  ref: ResolvedMarketRef,
  resolvedOutcome: LimitlessResolvedOutcome,
  ts: Date,
  source: ApplyLimitlessResolvedMarketTopInputs["source"],
): Promise<void> {
  const winningOutcomeIndex = resolvedOutcome === "YES" ? 0 : 1;
  const yesPrice = resolvedOutcome === "YES" ? 1 : 0;
  const noPrice = resolvedOutcome === "NO" ? 1 : 0;

  await pool.query(
    `
      update unified_markets
      set status = 'SETTLED',
          resolved_outcome = $2,
          best_bid = $3,
          best_ask = $3,
          last_price = $3,
          metadata = jsonb_set(
            jsonb_set(
              coalesce(metadata, '{}'::jsonb),
              '{resolutionSource}',
              to_jsonb($5::text),
              true
            ),
            '{resolvedBy}',
            to_jsonb('limitless_indexer'::text),
            true
          ),
          updated_at = $4,
          updated_at_db = now()
      where id = $1
        and venue = 'limitless'
    `,
    [ref.marketId, resolvedOutcome, yesPrice, ts, source],
  );

  await pool.query(
    `
      update limitless_markets
      set status = 'RESOLVED',
          expired = true,
          winning_outcome_index = $2,
          prices = array[$3::numeric, $4::numeric],
          updated_at = $5,
          raw = jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(raw, '{}'::jsonb),
                '{status}',
                to_jsonb('RESOLVED'::text),
                true
              ),
              '{expired}',
              'true'::jsonb,
              true
            ),
            '{winningOutcomeIndex}',
            to_jsonb($2::int),
            true
          ),
          updated_at_db = now()
      where id = $1
    `,
    [ref.venueMarketId, winningOutcomeIndex, yesPrice, noPrice, ts],
  );
}

export async function applyLimitlessResolvedMarketTop(
  inputs: ApplyLimitlessResolvedMarketTopInputs,
): Promise<ApplyLimitlessResolvedMarketTopResult> {
  const ref = await resolveMarketForResolution(inputs);
  if (!ref) {
    return {
      updated: false,
      ignoredReason: "market_not_found",
      tokensUpdated: 0,
    };
  }

  const resolvedOutcome = inferLimitlessResolvedOutcome({
    winningOutcome: inputs.winningOutcome,
    winningOutcomeIndex: inputs.winningOutcomeIndex,
    fallbackWinningOutcomeIndex: ref.sourceWinningOutcomeIndex,
  });
  if (!resolvedOutcome) {
    return {
      updated: false,
      ignoredReason: "unknown_winner",
      marketId: ref.marketId,
      tokensUpdated: 0,
    };
  }

  const ts = inputs.ts ?? new Date();
  const yesPrice = resolvedOutcome === "YES" ? 1 : 0;
  const noPrice = resolvedOutcome === "NO" ? 1 : 0;
  await publishTokenTopNow(ref.tokenYes, yesPrice, yesPrice, ts.getTime());
  await publishTokenTopNow(ref.tokenNo, noPrice, noPrice, ts.getTime());
  await updateResolvedMarketRows(ref, resolvedOutcome, ts, inputs.source);

  await publishMarketState({
    redis,
    venue: "limitless",
    tokenId: ref.tokenYes,
    market: ref.venueMarketId,
    conditionId: null,
    status: "SETTLED",
    acceptingOrders: false,
    resolvedOutcome,
    tsMs: ts.getTime(),
  });
  await publishMarketState({
    redis,
    venue: "limitless",
    tokenId: ref.tokenNo,
    market: ref.venueMarketId,
    conditionId: null,
    status: "SETTLED",
    acceptingOrders: false,
    resolvedOutcome,
    tsMs: ts.getTime(),
  });

  return {
    updated: true,
    marketId: ref.marketId,
    resolvedOutcome,
    tokensUpdated: 2,
  };
}

async function handleMarketResolved(
  kind: WsSocketKind,
  payload: unknown,
): Promise<void> {
  const resolvedSlug = pickResolvedSlug(payload);
  const resolvedAddress = pickResolvedAddress(payload);
  const result = await applyLimitlessResolvedMarketTop({
    slug: resolvedSlug,
    address: resolvedAddress,
    marketId: pickResolvedMarketId(payload),
    winningOutcome: readResolvedPayloadField(payload, [
      "winningOutcome",
      "winning_outcome",
      "resolvedOutcome",
      "outcome",
    ]),
    winningOutcomeIndex: readResolvedPayloadField(payload, [
      "winningOutcomeIndex",
      "winning_outcome_index",
    ]),
    ts: pickResolvedTimestamp(payload),
    source: "ws_market_resolved",
  });

  if (!result.updated) {
    log.warn("Limitless marketResolved ignored", {
      kind,
      reason: result.ignoredReason,
      slug: resolvedSlug,
      address: resolvedAddress,
      marketId: pickResolvedMarketId(payload),
    });
    return;
  }

  if (
    isActiveDemandSlug(resolvedSlug) ||
    isActiveDemandAddress(resolvedAddress)
  ) {
    wsDemandEventStats.resolvedDemandEvents += 1;
  }

  log.info("Limitless marketResolved handled", {
    kind,
    marketId: result.marketId,
    resolvedOutcome: result.resolvedOutcome,
    tokensUpdated: result.tokensUpdated,
  });
}

function normalizeTargets(targets: WsTargets): WsTargets {
  const slugs = uniqueSlugs(targets.slugs).slice(0, env.wsSubset);
  const addresses = uniqueAddresses(targets.addresses).slice(0, env.wsSubset);
  return { slugs, addresses };
}

function pruneExpiredDemand(nowMs = Date.now()): void {
  for (const [slug, expiresAt] of demandSlugExpiresAt.entries()) {
    if (expiresAt <= nowMs) demandSlugExpiresAt.delete(slug);
  }
  for (const [address, expiresAt] of demandAddressExpiresAt.entries()) {
    if (expiresAt <= nowMs) demandAddressExpiresAt.delete(address);
  }
}

function trimDemandMap(map: Map<string, number>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const entries = Array.from(map.entries()).sort((a, b) => a[1] - b[1]);
  for (const [key] of entries.slice(0, map.size - maxEntries)) {
    map.delete(key);
  }
}

function recomputeDesiredTargets(nowMs = Date.now()): WsTargets {
  pruneExpiredDemand(nowMs);
  desiredTargets = normalizeTargets({
    slugs: [...baseTargets.slugs, ...demandSlugExpiresAt.keys()],
    addresses: [...baseTargets.addresses, ...demandAddressExpiresAt.keys()],
  });
  return desiredTargets;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function hasRemovedTargets(
  currentValues: string[],
  nextValues: string[],
): boolean {
  const nextSet = new Set(nextValues);
  return currentValues.some((value) => !nextSet.has(value));
}

function restartSocket(kind: WsSocketKind, reason: string): void {
  const current = currentSockets[kind];
  if (current) {
    expectedDisconnectKinds.add(kind);
    current.disconnect();
  }
  state[kind] = [];
  clearSocketBookState(kind, `restart:${reason}`);
  currentSockets[kind] = createSocket(kind);
  log.info("Limitless WS restart", { kind, reason });
}

function syncSubscriptions(
  kind: WsSocketKind,
  socket: Socket,
  targets: WsTargets,
  options?: { force?: boolean },
) {
  if (kind === "amm" && options?.force) {
    missingAddressRetryAt.clear();
    missingMarketIdRetryAt.clear();
  }
  const next = normalizeTargets(targets);
  const nextValues = kind === "clob" ? next.slugs : next.addresses;
  const currentValues = state[kind];
  if (!options?.force && arraysEqual(currentValues, nextValues)) return;
  socket.emit("subscribe_market_prices", {
    marketSlugs: kind === "clob" ? nextValues : [],
    marketAddresses: kind === "amm" ? nextValues : [],
  });
  state[kind] = nextValues;
  log.info(options?.force ? "WS resubscribe" : "WS sync", {
    kind,
    slugs: kind === "clob" ? nextValues.length : 0,
    addresses: kind === "amm" ? nextValues.length : 0,
    total: nextValues.length,
  });
}

function createSocket(kind: WsSocketKind): Socket {
  const label = kind === "clob" ? "CLOB" : "AMM";

  const wsUrl = env.limitlessWsUrl.endsWith("/markets")
    ? env.limitlessWsUrl
    : `${env.limitlessWsUrl}/markets`;

  const headers = env.limitlessWsSession
    ? { cookie: `limitless_session=${env.limitlessWsSession}` }
    : undefined;

  const socket = io(wsUrl, {
    transports: ["websocket"],
    extraHeaders: headers,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
    timeout: 10000,
  });

  currentSockets[kind] = socket;

  if (!shutdownBound) {
    shutdownBound = true;
    const shutdown = () => {
      try {
        currentSockets.clob?.disconnect();
      } catch (error) {
        log.warn("Limitless WS shutdown disconnect failed", {
          kind: "clob",
          error: String(error),
        });
      }
      try {
        currentSockets.amm?.disconnect();
      } catch (error) {
        log.warn("Limitless WS shutdown disconnect failed", {
          kind: "amm",
          error: String(error),
        });
      }
      void redis.quit().catch(() => redis.disconnect());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  socket.on("connect", async () => {
    log.info("Limitless WS connected", { kind, label, url: wsUrl });
    bindRedisErrorOnce();
    await ensureRedis();
    clearSocketBookState(kind, "connect");
    syncSubscriptions(kind, socket, recomputeDesiredTargets(), {
      force: true,
    });
  });

  const onMarketResolved = (payload: unknown) => {
    void mq
      .add(() => handleMarketResolved(kind, payload))
      .catch((err) =>
        log.warn("WS marketResolved handler error", { kind, err }),
      );
  };
  socket.on("marketResolved", onMarketResolved);
  socket.on("market_resolved", onMarketResolved);

  if (kind === "clob") {
    socket.on("orderbookUpdate", (payload: OrderbookUpdate) => {
      void mq
        .add(async () => {
          const orderbook = payload?.orderbook;
          const rawTokenId = orderbook?.tokenId;
          const tokenId = prefixLimitlessToken(rawTokenId);
          if (!tokenId) return;
          if (isActiveDemandSlug(payload.marketSlug)) {
            wsDemandEventStats.clobOrderbookDemandEvents += 1;
          }

          const bids = orderbook?.bids ?? [];
          const asks = orderbook?.asks ?? [];
          const book = getClobBook(tokenId);
          const { bestBid, bestAsk } = applyClobBookUpdate(book, {
            bids,
            asks,
          });

          if (bestBid == null && bestAsk == null) return;
          // For top-of-book freshness, use observation time. Limitless can
          // replay CLOB frames with older source timestamps on subscription.
          const ts = new Date();
          const timestamp = ts.getTime().toString();
          const pair = await ensureTokensForClobToken(tokenId);

          await publishClobTopWithSibling({
            directTokenId: tokenId,
            bestBid,
            bestAsk,
            ts,
            snapshot: buildClobBookSnapshot(tokenId, book, timestamp),
            pair,
          });
        })
        .catch((err) => log.warn("WS orderbook handler error", { kind, err }));
    });
  } else {
    socket.on("newPriceData", (payload: NewPriceData) => {
      void mq
        .add(async () => {
          const updatedPrices = payload?.updatedPrices;
          const entries = Array.isArray(updatedPrices)
            ? updatedPrices
            : updatedPrices
              ? [updatedPrices]
              : [];
          if (!entries.length) return;
          // For top-of-book freshness, use observation time. Limitless can
          // replay AMM frames with older source timestamps on subscription.
          const ts = new Date();

          for (const entry of entries) {
            const marketId =
              entry.marketId != null ? String(entry.marketId) : null;
            const address =
              (entry.marketAddress ?? payload.marketAddress)?.toLowerCase() ??
              null;
            if (isActiveDemandAddress(address)) {
              wsDemandEventStats.ammPriceDemandEvents += 1;
            }

            let tokens: TokenPair | null = null;
            if (address) tokens = await ensureTokensForAddress(address);
            if (!tokens && marketId) {
              tokens = await ensureTokensForMarketId(marketId);
            }
            if (!tokens) {
              continue;
            }

            const [yesPrice, noPrice] = normalizeLimitlessPricePair(
              [entry.yesPrice ?? entry.yes, entry.noPrice ?? entry.no],
              "amm",
            );

            if (yesPrice != null) {
              await publishTokenTop(tokens.yesTokenId, yesPrice, yesPrice, ts);
            }
            if (noPrice != null) {
              await publishTokenTop(tokens.noTokenId, noPrice, noPrice, ts);
            }
          }
        })
        .catch((err) => log.warn("WS price handler error", { kind, err }));
    });
  }

  socket.on("disconnect", (reason) => {
    if (expectedDisconnectKinds.delete(kind)) {
      log.info("Limitless WS disconnected for restart", {
        kind,
        label,
        reason,
      });
      return;
    }
    log.warn("Limitless WS disconnected", { kind, label, reason });
  });

  socket.on("connect_error", (err) => {
    log.warn("Limitless WS connect error", { kind, label, err });
  });

  socket.io.on("reconnect_attempt", (attemptNo) => {
    log.info("Limitless WS reconnecting", { kind, label, attempt: attemptNo });
  });

  socket.io.on("reconnect", () => {
    clearSocketBookState(kind, "reconnect");
    syncSubscriptions(kind, socket, recomputeDesiredTargets(), {
      force: true,
    });
  });

  socket.io.on("reconnect_error", (err) => {
    log.warn("Limitless WS reconnect error", { kind, label, err });
  });

  socket.io.on("reconnect_failed", () => {
    log.warn("Limitless WS reconnect failed", { kind, label });
  });

  return socket;
}

export function startMarketWS(initialTargets: WsTargets): void {
  baseTargets = normalizeTargets(initialTargets);
  demandSlugExpiresAt.clear();
  demandAddressExpiresAt.clear();
  desiredTargets = recomputeDesiredTargets();
  state.clob = [];
  state.amm = [];
  clobBooks.clear();

  currentSockets.clob?.disconnect();
  currentSockets.amm?.disconnect();
  currentSockets.clob = createSocket("clob");
  currentSockets.amm = createSocket("amm");
}

export function updateMarketWSSubscriptions(nextTargets: WsTargets): void {
  const previousDesiredTargets = desiredTargets;
  baseTargets = normalizeTargets(nextTargets);
  desiredTargets = recomputeDesiredTargets();
  const clobSocket = currentSockets.clob;
  if (
    clobSocket?.connected &&
    hasRemovedTargets(previousDesiredTargets.slugs, desiredTargets.slugs)
  ) {
    restartSocket("clob", "target_shrink");
  } else if (clobSocket?.connected) {
    syncSubscriptions("clob", clobSocket, desiredTargets);
  }
  const ammSocket = currentSockets.amm;
  if (
    ammSocket?.connected &&
    hasRemovedTargets(
      previousDesiredTargets.addresses,
      desiredTargets.addresses,
    )
  ) {
    restartSocket("amm", "target_shrink");
  } else if (ammSocket?.connected) {
    syncSubscriptions("amm", ammSocket, desiredTargets);
  }
}

export function addMarketWSDemandTargets(
  targets: WsTargets,
  options: { ttlMs: number; maxTargets: number },
): {
  addresses: number;
  droppedBySubset: number;
  slugs: number;
  subscribedAddresses: number;
  subscribedSlugs: number;
  subscribedTotal: number;
  total: number;
} {
  const normalized = normalizeTargets(targets);
  const ttlMs = Math.max(0, Math.trunc(options.ttlMs));
  const maxTargets = Math.max(0, Math.trunc(options.maxTargets));
  if (ttlMs <= 0 || maxTargets <= 0) {
    return {
      addresses: 0,
      droppedBySubset: 0,
      slugs: 0,
      subscribedAddresses: 0,
      subscribedSlugs: 0,
      subscribedTotal: 0,
      total: 0,
    };
  }

  const expiresAt = Date.now() + ttlMs;
  const requestedSlugs = normalized.slugs.slice(0, maxTargets);
  const requestedAddresses = normalized.addresses.slice(0, maxTargets);
  for (const slug of requestedSlugs) {
    demandSlugExpiresAt.set(slug, expiresAt);
  }
  for (const address of requestedAddresses) {
    demandAddressExpiresAt.set(address, expiresAt);
  }

  const perSideLimit = Math.max(1, maxTargets);
  trimDemandMap(demandSlugExpiresAt, perSideLimit);
  trimDemandMap(demandAddressExpiresAt, perSideLimit);
  const next = recomputeDesiredTargets();

  const clobSocket = currentSockets.clob;
  if (clobSocket?.connected) {
    syncSubscriptions("clob", clobSocket, next);
  }
  const ammSocket = currentSockets.amm;
  if (ammSocket?.connected) {
    syncSubscriptions("amm", ammSocket, next);
  }

  const activeSlugs = new Set(next.slugs);
  const activeAddresses = new Set(next.addresses);
  const subscribedSlugs = requestedSlugs.filter((slug) =>
    activeSlugs.has(slug),
  ).length;
  const subscribedAddresses = requestedAddresses.filter((address) =>
    activeAddresses.has(address),
  ).length;
  const slugs = requestedSlugs.length;
  const addresses = requestedAddresses.length;
  const total = slugs + addresses;
  const subscribedTotal = subscribedSlugs + subscribedAddresses;
  return {
    addresses,
    droppedBySubset: Math.max(0, total - subscribedTotal),
    slugs,
    subscribedAddresses,
    subscribedSlugs,
    subscribedTotal,
    total,
  };
}

export function resubscribeMarketWSSubscriptions(): void {
  const previousDesiredTargets = desiredTargets;
  const next = recomputeDesiredTargets();
  const clobSocket = currentSockets.clob;
  if (
    clobSocket?.connected &&
    hasRemovedTargets(previousDesiredTargets.slugs, next.slugs)
  ) {
    restartSocket("clob", "target_shrink");
  } else if (clobSocket?.connected) {
    syncSubscriptions("clob", clobSocket, next, { force: true });
  }
  const ammSocket = currentSockets.amm;
  if (
    ammSocket?.connected &&
    hasRemovedTargets(previousDesiredTargets.addresses, next.addresses)
  ) {
    restartSocket("amm", "target_shrink");
  } else if (ammSocket?.connected) {
    syncSubscriptions("amm", ammSocket, next, { force: true });
  }
}
