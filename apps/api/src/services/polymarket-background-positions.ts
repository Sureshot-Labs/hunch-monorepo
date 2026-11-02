import { createHash } from "node:crypto";
import { normalizePolymarketAssetId } from "@hunch/shared";
import {
  fetchPolymarketDataApiV2Page,
  parsePolymarketDataApiV2Position,
  polymarketDataApiV2PositionParams,
  PolymarketDataApiV2Error,
  PolymarketDataApiV2CursorError,
} from "./polymarket-data-api-v2.js";
import { walletIntelProtocolAddresses } from "./wallet-intel-protocol-addresses.js";

export interface PositionDiscoveryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
type Token = { tokenId: string; averagePrice: string | null };
type Checkpoint = {
  version: 1;
  scope: string;
  startedAt: number;
  updatedAt: number;
  cursor: string | null;
  seen: string[];
  tokens: [string, string | null][];
  pages: number;
  retryDelay?: { until: number; reason: "rate_limited" | "upstream_error" };
};
export type BackgroundPositionConfig = {
  pageTimeoutMs: number;
  walletBudgetMs: number;
  pagesPerSlice: number;
  maxRows: number;
  maxPages: number;
  checkpointTtlMs: number;
  maxAttempts: number;
};
export const BACKGROUND_POSITION_DEFAULTS: Readonly<BackgroundPositionConfig> =
  Object.freeze({
    pageTimeoutMs: 5000,
    walletBudgetMs: 15000,
    pagesPerSlice: 60,
    maxRows: 100000,
    maxPages: 1024,
    checkpointTtlMs: 6 * 3600000,
    maxAttempts: 2,
  });
export function loadBackgroundPositionConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): BackgroundPositionConfig {
  const read = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(source[`WALLET_INTEL_POLY_POSITIONS_${key}`]);
    return Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  };
  return {
    pageTimeoutMs: read("PAGE_TIMEOUT_MS", 5000, 100, 30000),
    walletBudgetMs: read("WALLET_BUDGET_MS", 15000, 1000, 120000),
    pagesPerSlice: read("PAGES_PER_SLICE", 60, 1, 200),
    maxRows: read("MAX_ROWS", 100000, 100, 1000000),
    maxPages: read("MAX_PAGES", 1024, 1, 10000),
    checkpointTtlMs: read(
      "CHECKPOINT_TTL_MS",
      6 * 3600000,
      60000,
      24 * 3600000,
    ),
    maxAttempts: read("MAX_ATTEMPTS", 2, 1, 3),
  };
}
type Reason =
  | "complete"
  | "protocol_contract"
  | "invalid_owner"
  | "time_budget"
  | "page_budget"
  | "upstream_timeout"
  | "rate_limited"
  | "upstream_error"
  | "invalid_request"
  | "invalid_response"
  | "capacity";
export type BackgroundPositionResult = {
  status: "complete" | "deferred" | "excluded";
  reason: Reason;
  tokens: Token[];
  pages: number;
  pagesThisSlice: number;
  discoveredTokens: number;
  elapsedMs: number;
  resumed: boolean;
  checkpointAvailable: boolean;
  retries: number;
  cursorRestarts: number;
  httpStatus: number | null;
  parameter: string | null;
  traceId: string | null;
};

/** Only called by wallet-intel under its process-wide PG advisory lock. Redis is
 * a derived checkpoint, not portfolio truth. UI/financial sync keeps its own fast
 * reader. No partial inventory is returned as complete or used to infer a sale.
 */
export async function discoverBackgroundPolymarketPositions(input: {
  owner: string;
  baseUrl: string;
  store?: PositionDiscoveryStore | null;
  protocolAddresses?: readonly string[];
  config?: Partial<BackgroundPositionConfig>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BackgroundPositionResult> {
  const cfg = { ...BACKGROUND_POSITION_DEFAULTS, ...input.config };
  for (const value of Object.values(cfg))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid background position bounds");
  const now = input.now ?? Date.now,
    start = now(),
    deadline = start + cfg.walletBudgetMs;
  const owner = input.owner.toLowerCase();
  let state: Checkpoint,
    resumed = false,
    checkpointAvailable = !!input.store;
  let pagesThisSlice = 0,
    retries = 0,
    cursorRestarts = 0;
  let lastError: unknown;
  const params = polymarketDataApiV2PositionParams(owner);
  const scope = createHash("sha256")
    .update(JSON.stringify([new URL(input.baseUrl).origin, params]))
    .digest("hex");
  const key = `wallet-intel:poly-positions:v1:${scope}`;
  const fresh = (): Checkpoint => ({
    version: 1,
    scope,
    startedAt: now(),
    updatedAt: now(),
    cursor: null,
    seen: [],
    tokens: [],
    pages: 0,
  });
  state = fresh();
  let tokens = new Map<string, string | null>();
  const result = (
    status: BackgroundPositionResult["status"],
    reason: Reason,
  ): BackgroundPositionResult => ({
    status,
    reason,
    tokens:
      status === "complete"
        ? [...tokens].map(([tokenId, averagePrice]) => ({
            tokenId,
            averagePrice,
          }))
        : [],
    pages: state.pages,
    pagesThisSlice,
    discoveredTokens: tokens.size,
    elapsedMs: now() - start,
    resumed,
    checkpointAvailable,
    retries,
    cursorRestarts,
    httpStatus:
      lastError instanceof PolymarketDataApiV2Error ? lastError.status : null,
    parameter:
      lastError instanceof PolymarketDataApiV2Error
        ? lastError.parameter
        : null,
    traceId:
      lastError instanceof PolymarketDataApiV2Error ? lastError.traceId : null,
  });
  if (!/^0x[a-f0-9]{40}$/.test(owner))
    return result("excluded", "invalid_owner");
  if (
    (input.protocolAddresses ?? walletIntelProtocolAddresses()).some(
      (a) => a.toLowerCase() === owner,
    )
  )
    return result("excluded", "protocol_contract");
  const clear = async () => {
    try {
      await input.store?.del(key);
    } catch {
      checkpointAvailable = false;
    }
  };
  if (input.store) {
    try {
      const raw = await input.store.get(key);
      // Bound untrusted cache parsing; 100k compact tokens are about 10 MB.
      if (raw && raw.length <= cfg.maxRows * 180 + cfg.maxPages * 8192) {
        const value: Checkpoint = JSON.parse(raw);
        if (
          value.version === 1 &&
          value.scope === scope &&
          Number.isSafeInteger(value.startedAt) &&
          value.startedAt <= now() + 5000 &&
          Number.isSafeInteger(value.updatedAt) &&
          value.updatedAt >= value.startedAt &&
          value.updatedAt <= now() + 5000 &&
          (value.retryDelay === undefined ||
            (Number.isSafeInteger(value.retryDelay?.until) &&
              value.retryDelay.until >= value.startedAt &&
              ["rate_limited", "upstream_error"].includes(
                value.retryDelay.reason,
              ))) &&
          Number.isSafeInteger(value.pages) &&
          value.pages >= 0 &&
          value.pages <= cfg.maxPages &&
          (value.cursor === null ||
            (typeof value.cursor === "string" &&
              value.cursor.length > 0 &&
              value.cursor.length <= 8192)) &&
          Array.isArray(value.seen) &&
          value.seen.length <= cfg.maxPages &&
          value.seen.every(
            (c) => typeof c === "string" && c.length > 0 && c.length <= 8192,
          ) &&
          new Set(value.seen).size === value.seen.length &&
          value.pages === value.seen.length &&
          (value.pages === 0
            ? value.cursor === null && value.tokens?.length === 0
            : value.cursor === value.seen.at(-1)) &&
          Array.isArray(value.tokens) &&
          value.tokens.length <= cfg.maxRows &&
          value.tokens.every(
            (t) =>
              Array.isArray(t) &&
              t.length === 2 &&
              normalizePolymarketAssetId(t[0]) === t[0] &&
              (t[1] === null ||
                (typeof t[1] === "string" &&
                  t[1].length <= 80 &&
                  Number.isFinite(Number(t[1])))),
          )
        ) {
          if (now() - value.startedAt > cfg.checkpointTtlMs) {
            // Discard old discovery facts, not an upstream-mandated retry deadline.
            if (value.retryDelay && value.retryDelay.until > now()) {
              state = fresh();
              state.retryDelay = value.retryDelay;
            } else await clear();
          } else {
            state = value;
            tokens = new Map(value.tokens);
            resumed = state.cursor !== null;
          }
        } else await clear();
      } else if (raw) await clear();
    } catch {
      checkpointAvailable = false;
      await clear();
    }
  }
  const save = async () => {
    if (!input.store) return;
    state.updatedAt = now();
    state.tokens = [...tokens];
    try {
      await input.store.set(key, JSON.stringify(state), {
        PX: Math.max(
          cfg.checkpointTtlMs,
          (state.retryDelay?.until ?? 0) - now(),
        ),
      });
      checkpointAvailable = true;
    } catch {
      checkpointAvailable = false;
    }
  };
  const defer = async (reason: Reason) => {
    await save();
    return result("deferred", reason);
  };
  while (pagesThisSlice < cfg.pagesPerSlice) {
    if (state.retryDelay) {
      if (now() < state.retryDelay.until) return defer(state.retryDelay.reason);
      delete state.retryDelay;
    }
    if (now() >= deadline) return defer("time_budget");
    let page:
      | Awaited<
          ReturnType<
            typeof fetchPolymarketDataApiV2Page<
              ReturnType<typeof parsePolymarketDataApiV2Position>
            >
          >
        >
      | undefined;
    for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
      if (now() >= deadline) return defer("time_budget");
      try {
        page = await fetchPolymarketDataApiV2Page({
          baseUrl: input.baseUrl,
          endpoint: "positions",
          params,
          cursor: state.cursor,
          timeoutMs: Math.max(1, Math.min(cfg.pageTimeoutMs, deadline - now())),
          parseRow: parsePolymarketDataApiV2Position,
          fetchImpl: input.fetchImpl,
        });
        delete state.retryDelay;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (
          error instanceof PolymarketDataApiV2Error &&
          error.reason === "protocol_contract"
        ) {
          await clear();
          return result("excluded", "protocol_contract");
        }
        if (
          error instanceof PolymarketDataApiV2CursorError ||
          (error instanceof PolymarketDataApiV2Error &&
            error.reason === "invalid_cursor" &&
            state.cursor !== null)
        ) {
          await clear();
          state = fresh();
          tokens.clear();
          if (cursorRestarts > 0) return result("deferred", "invalid_response");
          cursorRestarts++;
          break;
        }
        const aborted =
          error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name);
        const retryable =
          aborted ||
          (error instanceof PolymarketDataApiV2Error && error.retryable);
        if (
          error instanceof PolymarketDataApiV2Error &&
          (error.status === 429 || error.status === 503) &&
          error.retryAfterMs !== null &&
          error.retryAfterMs > 0
        ) {
          state.retryDelay = {
            until: now() + error.retryAfterMs,
            reason: error.status === 429 ? "rate_limited" : "upstream_error",
          };
        }
        if (!retryable || attempt + 1 >= cfg.maxAttempts || now() >= deadline)
          return defer(
            aborted
              ? "upstream_timeout"
              : error instanceof PolymarketDataApiV2Error
                ? error.status === 429
                  ? "rate_limited"
                  : error.status === 400
                    ? "invalid_request"
                    : "upstream_error"
                : "invalid_response",
          );
        const pause =
          error instanceof PolymarketDataApiV2Error
            ? (error.retryAfterMs ?? 250)
            : 250;
        // Respect upstream Retry-After; defer rather than retry early/outside budget.
        if (now() + pause >= deadline) {
          const reason =
            error instanceof PolymarketDataApiV2Error && error.status === 429
              ? "rate_limited"
              : aborted
                ? "upstream_timeout"
                : "upstream_error";
          return defer(reason);
        }
        retries++;
        await (
          input.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(pause);
      }
    }
    if (!page) continue; // rejected cursor was reset; retry first page within the same budget
    if (
      page.data.some((row) => row.proxyWallet.toLowerCase() !== owner) ||
      (page.nextCursor !== null && state.seen.includes(page.nextCursor))
    ) {
      await clear();
      return result("deferred", "invalid_response");
    }
    const additions = new Set(
      page.data.map((row) => row.tokenId).filter((id) => !tokens.has(id)),
    );
    if (
      tokens.size + additions.size > cfg.maxRows ||
      state.pages >= cfg.maxPages
    )
      return defer("capacity"); // keep the cursor; a larger explicit resource budget can resume
    for (const row of page.data)
      if (!tokens.has(row.tokenId))
        tokens.set(row.tokenId, row.averagePrice?.toString() ?? null);
    state.pages++;
    pagesThisSlice++;
    state.cursor = page.nextCursor;
    if (page.nextCursor === null) {
      await clear();
      return result("complete", "complete");
    }
    state.seen.push(page.nextCursor);
    // Checkpoint compact tokens, not raw positions or model/account metadata.
    if (pagesThisSlice % 5 === 0) await save();
  }
  return defer("page_budget");
}
