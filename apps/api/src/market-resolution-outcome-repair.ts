import type { PoolClient } from "pg";

import { pool } from "./db.js";
import { env } from "./env.js";
import { isRecord } from "./lib/type-guards.js";
import {
  dflowRequest,
  extractDflowErrorMessage,
} from "./services/dflow-client.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./services/limitless-client.js";
import {
  buildPolymarketSourceRepair,
  hasSafeResolutionOutcome,
  resolveDflowOutcome,
  resolveLimitlessOutcome,
  resolvePolymarketGammaOutcome,
  type PolymarketSourceRepair,
  type SafeResolutionOutcome,
} from "./services/market-resolution-outcomes.js";
import {
  type RepairMarketRef,
  refreshWalletMetricsForMarkets,
} from "./services/market-repair-wallet-metrics.js";
import {
  SHARED_RATE_LIMIT_MAX_ATTEMPTS,
  SharedRateLimitBackoff,
} from "./services/shared-rate-limit-backoff.js";

type Venue = "polymarket" | "limitless" | "kalshi";

type Args = {
  apiTimeoutSec: number;
  concurrency: number;
  confirmUpdate: boolean;
  execute: boolean;
  json: boolean;
  limit: number;
  lookbackDays: number;
  refreshWalletMetrics: boolean;
  sampleLimit: number;
  statementTimeoutSec: number;
  venues: Venue[];
};

type CandidateRow = {
  event_id: string;
  market_id: string;
  slug: string | null;
  terminal_at: Date;
  title: string;
  venue: Venue;
  venue_market_id: string;
};

type ValidationRow = CandidateRow & {
  polymarket_source: PolymarketSourceRepair | null;
  reason: string;
  resolved_outcome: "YES" | "NO" | null;
  resolved_outcome_pct: number | null;
};

type CountRow = {
  label: string;
  rows: string;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 10_000;
const DEFAULT_SAMPLE_LIMIT = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_API_TIMEOUT_SEC = 15;
const DEFAULT_STATEMENT_TIMEOUT_SEC = 300;
const DFLOW_BATCH_SIZE = 100;
const LIMITLESS_RATE_LIMIT_MAX_ATTEMPTS = SHARED_RATE_LIMIT_MAX_ATTEMPTS;
const ALLOWED_VENUES = new Set<Venue>(["polymarket", "limitless", "kalshi"]);

function readValues(argv: string[], name: string): string[] {
  const key = `--${name}`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${key}=`)) {
      const value = arg.slice(key.length + 1).trim();
      if (value.length) values.push(value);
      continue;
    }
    if (arg === key) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value.trim());
        index += 1;
      }
    }
  }

  return values.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function readPositiveInt(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const raw = readValues(argv, name)[0];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Math.trunc(parsed);
}

function normalizeVenues(values: string[]): Venue[] {
  const venues = values.map((entry) => entry.toLowerCase());
  const unknown = venues.filter(
    (entry): entry is string => !ALLOWED_VENUES.has(entry as Venue),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown venue value(s): ${unknown.join(", ")}`);
  }
  return [...new Set(venues)] as Venue[];
}

function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  return {
    apiTimeoutSec: readPositiveInt(
      argv,
      "api-timeout-sec",
      DEFAULT_API_TIMEOUT_SEC,
    ),
    concurrency: readPositiveInt(argv, "concurrency", DEFAULT_CONCURRENCY),
    confirmUpdate: hasFlag(argv, "confirm-update"),
    execute: hasFlag(argv, "execute"),
    json: hasFlag(argv, "json"),
    limit: readPositiveInt(argv, "limit", DEFAULT_LIMIT),
    lookbackDays: readPositiveInt(argv, "lookback-days", DEFAULT_LOOKBACK_DAYS),
    refreshWalletMetrics: hasFlag(argv, "refresh-wallet-metrics"),
    sampleLimit: readPositiveInt(argv, "sample", DEFAULT_SAMPLE_LIMIT),
    statementTimeoutSec: readPositiveInt(
      argv,
      "statement-timeout-sec",
      DEFAULT_STATEMENT_TIMEOUT_SEC,
    ),
    venues: normalizeVenues([
      ...readValues(argv, "venue"),
      ...readValues(argv, "venues"),
    ]),
  };
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -C hunch-monorepo -F api run market:resolution-outcome-repair -- [options]

Options:
  --lookback-days <days>        Recent terminal market window. Default: ${DEFAULT_LOOKBACK_DAYS}
  --limit <count>               Bounded candidate pool size. Default: ${DEFAULT_LIMIT}
  --sample <count>              Sample row count. Default: ${DEFAULT_SAMPLE_LIMIT}
  --venue <venue[,venue]>       Optional venue filter: polymarket, limitless, kalshi. Repeatable.
  --concurrency <count>         Live API request concurrency. Default: ${DEFAULT_CONCURRENCY}
  --api-timeout-sec <sec>       Live API timeout per request. Default: ${DEFAULT_API_TIMEOUT_SEC}
  --statement-timeout-sec <sec> DB statement timeout. Default: ${DEFAULT_STATEMENT_TIMEOUT_SEC}
  --refresh-wallet-metrics      Refresh wallet metrics for wallets tied to repaired markets.
  --json                        Emit one JSON report.
  --execute                     Update live-validated rows. Requires --confirm-update.
  --confirm-update              Required together with --execute.
  --help                        Show this message.

Selection rule:
  unified market status is not ACTIVE
  unified outcome fields are both missing
  market is recent by close/expiration/event/update timestamp
  live venue API returns a safe explicit or terminal outcome

Dry-run is the default. Update mode only runs when both --execute and
--confirm-update are present.`);
}

function assertExecutionFlags(args: Args): void {
  if (args.execute === args.confirmUpdate) return;

  throw new Error(
    "Resolution outcome repair requires both --execute and --confirm-update. Omit both flags for dry-run.",
  );
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return isRecord(first) ? first : null;
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value.data)) {
    const first = value.data[0];
    return isRecord(first) ? first : null;
  }
  if (Array.isArray(value.markets)) {
    const first = value.markets[0];
    return isRecord(first) ? first : null;
  }
  if (isRecord(value.data)) return value.data;
  return value;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.markets)) return value.markets.filter(isRecord);
  if (Array.isArray(value.data)) return value.data.filter(isRecord);
  return [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function dateToString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<
  | { ok: true; payload: unknown }
  | { ok: false; status: number; payload: unknown }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Hunch-API/1.0" },
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);

    if (!res.ok) return { ok: false, status: res.status, payload };
    return { ok: true, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function gammaBaseUrl(): string {
  return (
    process.env.POLYMARKET_GAMMA_BASE?.trim() ||
    "https://gamma-api.polymarket.com"
  ).replace(/\/+$/, "");
}

async function fetchGammaMarket(
  marketId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const encoded = encodeURIComponent(marketId);
  const urls = [
    `${gammaBaseUrl()}/markets/${encoded}`,
    `${gammaBaseUrl()}/markets?id=${encoded}&limit=1&offset=0`,
  ];

  let lastError: string | null = null;
  for (const url of urls) {
    try {
      const res = await fetchJsonWithTimeout(url, timeoutMs);
      if (!res.ok) {
        lastError = `gamma_${res.status}`;
        continue;
      }
      const market = firstRecord(res.payload);
      if (market) return market;
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  if (lastError) throw new Error(lastError);
  return null;
}

async function validatePolymarket(
  candidate: CandidateRow,
  timeoutMs: number,
): Promise<ValidationRow> {
  try {
    const market = await fetchGammaMarket(candidate.venue_market_id, timeoutMs);
    if (!market) return buildValidation(candidate, "gamma_not_found");
    return buildValidation(
      candidate,
      "gamma_checked",
      resolvePolymarketGammaOutcome(market),
      buildPolymarketSourceRepair(market),
    );
  } catch (error) {
    return buildValidation(candidate, `gamma_error:${errorMessage(error)}`);
  }
}

async function validateLimitless(
  candidate: CandidateRow,
  timeoutMs: number,
  rateLimitBackoff: SharedRateLimitBackoff,
): Promise<ValidationRow> {
  const marketRef = candidate.slug ?? candidate.venue_market_id;
  if (!marketRef) return buildValidation(candidate, "limitless_missing_ref");

  for (
    let attempt = 0;
    attempt < LIMITLESS_RATE_LIMIT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    let res: Awaited<ReturnType<typeof limitlessRequest>>;
    try {
      await rateLimitBackoff.wait();
      res = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(marketRef)}`,
        auth: "none",
        allowRetry: false,
        timeoutMs,
      });
    } catch (error) {
      return buildValidation(
        candidate,
        `limitless_error:${errorMessage(error)}`,
      );
    }

    if (!res.ok) {
      if (
        res.status === 429 &&
        attempt < LIMITLESS_RATE_LIMIT_MAX_ATTEMPTS - 1
      ) {
        rateLimitBackoff.noteRateLimit();
        continue;
      }

      const message = extractLimitlessMessage(res.payload);
      return buildValidation(
        candidate,
        `limitless_error:${res.status}${message ? `:${message}` : ""}`,
      );
    }

    rateLimitBackoff.noteSuccess();
    const market = firstRecord(res.payload);
    if (!market) return buildValidation(candidate, "limitless_not_found");
    return buildValidation(
      candidate,
      "limitless_checked",
      resolveLimitlessOutcome(market),
    );
  }

  return buildValidation(candidate, "limitless_error:429");
}

function findDflowMarket(
  markets: Array<Record<string, unknown>>,
  ticker: string,
): Record<string, unknown> | null {
  const normalized = ticker.trim().toLowerCase();
  return (
    markets.find((market) => {
      const candidate =
        stringValue(market.ticker) ??
        stringValue(market.marketTicker) ??
        stringValue(market.market_ticker);
      return candidate?.toLowerCase() === normalized;
    }) ?? null
  );
}

async function validateKalshiChunk(
  candidates: CandidateRow[],
  timeoutMs: number,
): Promise<ValidationRow[]> {
  const tickers = candidates.map((candidate) => candidate.venue_market_id);
  try {
    const res = await dflowRequest({
      baseUrl: env.dflowPredictionMarketsBase,
      timeoutMs,
      method: "POST",
      requestPath: "/api/v1/markets/batch",
      apiKey: env.dflowApiKey,
      body: {
        mints: null,
        tickers,
      },
    });
    if (!res.ok) {
      const message = extractDflowErrorMessage(res.payload);
      const reason = `dflow_error:${res.status}${message ? `:${message}` : ""}`;
      return candidates.map((candidate) => buildValidation(candidate, reason));
    }

    const markets = recordArray(res.payload);
    return candidates.map((candidate) => {
      const market = findDflowMarket(markets, candidate.venue_market_id);
      if (!market) return buildValidation(candidate, "dflow_not_found");
      return buildValidation(
        candidate,
        "dflow_checked",
        resolveDflowOutcome(market),
      );
    });
  } catch (error) {
    return candidates.map((candidate) =>
      buildValidation(candidate, `dflow_error:${errorMessage(error)}`),
    );
  }
}

function buildValidation(
  candidate: CandidateRow,
  reason: string,
  outcome: SafeResolutionOutcome = {
    resolvedOutcome: null,
    resolvedOutcomePct: null,
  },
  polymarketSource: PolymarketSourceRepair | null = null,
): ValidationRow {
  return {
    ...candidate,
    polymarket_source: polymarketSource,
    reason,
    resolved_outcome: outcome.resolvedOutcome,
    resolved_outcome_pct: outcome.resolvedOutcomePct,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.trunc(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => run()),
  );
  return results;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function validateCandidates(
  candidates: CandidateRow[],
  args: Args,
): Promise<ValidationRow[]> {
  const timeoutMs = args.apiTimeoutSec * 1000;
  const polymarket = candidates.filter(
    (candidate) => candidate.venue === "polymarket",
  );
  const limitless = candidates.filter(
    (candidate) => candidate.venue === "limitless",
  );
  const kalshi = candidates.filter((candidate) => candidate.venue === "kalshi");
  const limitlessRateLimitBackoff = new SharedRateLimitBackoff({
    label: "limitless",
    logPrefix: "[market:resolution-outcome-repair]",
  });

  const [polymarketRows, limitlessRows, kalshiRows] = await Promise.all([
    mapWithConcurrency(polymarket, args.concurrency, (candidate) =>
      validatePolymarket(candidate, timeoutMs),
    ),
    mapWithConcurrency(limitless, args.concurrency, (candidate) =>
      validateLimitless(candidate, timeoutMs, limitlessRateLimitBackoff),
    ),
    mapWithConcurrency(
      chunkArray(kalshi, DFLOW_BATCH_SIZE),
      Math.max(1, Math.min(args.concurrency, 2)),
      (chunk) => validateKalshiChunk(chunk, timeoutMs),
    ).then((chunks) => chunks.flat()),
  ]);

  const byId = new Map<string, ValidationRow>();
  for (const row of [...polymarketRows, ...limitlessRows, ...kalshiRows]) {
    byId.set(row.market_id, row);
  }

  return candidates.map(
    (candidate) =>
      byId.get(candidate.market_id) ??
      buildValidation(candidate, "validation_missing"),
  );
}

function queryParams(args: Args): Array<number | Venue[] | null> {
  return [
    args.venues.length > 0 ? args.venues : null,
    args.lookbackDays,
    args.limit,
  ];
}

async function queryCandidates(
  client: PoolClient,
  args: Args,
): Promise<CandidateRow[]> {
  const { rows } = await client.query<CandidateRow>(
    `
      with raw_candidates as (
        select
          m.id as market_id,
          m.venue::text as venue,
          m.venue_market_id,
          m.slug,
          m.event_id,
          m.title,
          m.expiration_time as terminal_at
        from unified_markets m
        where m.status <> 'ACTIVE'::unified_status
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.venue in ('polymarket', 'limitless', 'kalshi')
          and m.venue_market_id is not null
          and m.resolved_outcome is null
          and m.resolved_outcome_pct is null
          and m.expiration_time is not null
          and m.expiration_time between now() - make_interval(days => $2::int) and now()
        union all
        select
          m.id as market_id,
          m.venue::text as venue,
          m.venue_market_id,
          m.slug,
          m.event_id,
          m.title,
          m.close_time as terminal_at
        from unified_markets m
        where m.status <> 'ACTIVE'::unified_status
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.venue in ('polymarket', 'limitless', 'kalshi')
          and m.venue_market_id is not null
          and m.resolved_outcome is null
          and m.resolved_outcome_pct is null
          and m.expiration_time is null
          and m.close_time is not null
          and m.close_time between now() - make_interval(days => $2::int) and now()
        union all
        select
          m.id as market_id,
          m.venue::text as venue,
          m.venue_market_id,
          m.slug,
          m.event_id,
          m.title,
          e.end_date as terminal_at
        from unified_events e
        join unified_markets m on m.event_id = e.id
        where m.status <> 'ACTIVE'::unified_status
          and ($1::text[] is null or m.venue = any($1::text[]))
          and m.venue in ('polymarket', 'limitless', 'kalshi')
          and m.venue_market_id is not null
          and m.resolved_outcome is null
          and m.resolved_outcome_pct is null
          and m.expiration_time is null
          and m.close_time is null
          and e.end_date is not null
          and e.end_date between now() - make_interval(days => $2::int) and now()
      )
      select
        market_id,
        venue,
        venue_market_id,
        slug,
        event_id,
        title,
        terminal_at
      from raw_candidates
      order by terminal_at desc, market_id
      limit $3::int
    `,
    queryParams(args),
  );
  return rows;
}

async function loadCandidates(args: Args): Promise<CandidateRow[]> {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const rows = await queryCandidates(client, args);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function isOutcomeRepairable(row: ValidationRow): boolean {
  return hasSafeResolutionOutcome({
    resolvedOutcome: row.resolved_outcome,
    resolvedOutcomePct: row.resolved_outcome_pct,
  });
}

function summarizeRows(rows: ValidationRow[]) {
  const groups = new Map<
    string,
    {
      markets: number;
      outcome: string;
      reason: string;
      source: string;
      venue: string;
    }
  >();

  for (const row of rows) {
    const outcome =
      row.resolved_outcome ??
      (row.resolved_outcome_pct == null ? "none" : "SCALAR");
    const source = row.polymarket_source ? "source" : "no_source";
    const key = [row.venue, outcome, source, row.reason].join("\u0001");
    const group = groups.get(key) ?? {
      markets: 0,
      outcome,
      reason: row.reason,
      source,
      venue: row.venue,
    };
    group.markets += 1;
    groups.set(key, group);
  }

  return [...groups.values()].sort(
    (a, b) =>
      [
        a.venue.localeCompare(b.venue),
        a.outcome.localeCompare(b.outcome),
        a.source.localeCompare(b.source),
        a.reason.localeCompare(b.reason),
      ].find((value) => value !== 0) ?? 0,
  );
}

function formatSampleRow(row: ValidationRow): Record<string, string | null> {
  return {
    marketId: row.market_id,
    venue: row.venue,
    reason: row.reason,
    resolvedOutcome: row.resolved_outcome,
    resolvedOutcomePct:
      row.resolved_outcome_pct == null
        ? null
        : String(row.resolved_outcome_pct),
    sourceRepair: row.polymarket_source ? "yes" : "no",
    eventId: row.event_id,
    terminalAt: dateToString(row.terminal_at),
    title: row.title,
  };
}

function buildReport(args: Args, validations: ValidationRow[]) {
  const outcomeRepairable = validations.filter(isOutcomeRepairable);
  const polymarketSourceRepairable = validations.filter(
    (row) => row.polymarket_source !== null,
  );
  const actionable = validations.filter(
    (row) => isOutcomeRepairable(row) || row.polymarket_source !== null,
  );
  return {
    args,
    candidateCount: validations.length,
    outcomeRepairableCount: outcomeRepairable.length,
    polymarketSourceRepairableCount: polymarketSourceRepairable.length,
    skippedCount: validations.length - actionable.length,
    summary: summarizeRows(validations),
    repairableSamples: actionable.slice(0, args.sampleLimit),
    allSamples: validations.slice(0, args.sampleLimit),
  };
}

async function updateAndCount(
  client: PoolClient,
  label: string,
  updateSql: string,
): Promise<CountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `
      with updated as (
        ${updateSql}
        returning 1
      )
      select count(*)::text as rows from updated
    `,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
}

async function materializeRepairSet(
  client: PoolClient,
  validations: ValidationRow[],
): Promise<CountRow[]> {
  const payload = JSON.stringify(
    validations
      .filter((row) => isOutcomeRepairable(row) || row.polymarket_source)
      .map((row) => ({
        market_id: row.market_id,
        venue: row.venue,
        venue_market_id: row.venue_market_id,
        resolved_outcome: row.resolved_outcome,
        resolved_outcome_pct: row.resolved_outcome_pct,
        polymarket_source: row.polymarket_source,
      })),
  );

  await client.query(
    `
      create temp table tmp_market_resolution_outcome_repair on commit drop as
      select
        value->>'market_id' as market_id,
        value->>'venue' as venue,
        value->>'venue_market_id' as venue_market_id,
        nullif(value->>'resolved_outcome', '') as resolved_outcome,
        (value->>'resolved_outcome_pct')::numeric as resolved_outcome_pct,
        (value->'polymarket_source')->>'outcome_prices' as polymarket_source_outcome_prices,
        ((value->'polymarket_source')->>'active')::boolean as polymarket_source_active,
        ((value->'polymarket_source')->>'closed')::boolean as polymarket_source_closed,
        ((value->'polymarket_source')->>'archived')::boolean as polymarket_source_archived,
        ((value->'polymarket_source')->>'accepting_orders')::boolean as polymarket_source_accepting_orders,
        (value->'polymarket_source')->>'resolution_source' as polymarket_source_resolution_source,
        (value->'polymarket_source')->>'resolved_by' as polymarket_source_resolved_by,
        (value->'polymarket_source')->'raw' as polymarket_source_raw
      from jsonb_array_elements($1::jsonb) as value
    `,
    [payload],
  );

  const { rows: totalRows } = await client.query<{ rows: string }>(
    "select count(*)::text as rows from tmp_market_resolution_outcome_repair",
  );
  const { rows: outcomeRows } = await client.query<{ rows: string }>(
    `
      select count(*)::text as rows
      from tmp_market_resolution_outcome_repair
      where resolved_outcome is not null
         or resolved_outcome_pct is not null
    `,
  );
  const { rows: sourceRows } = await client.query<{ rows: string }>(
    `
      select count(*)::text as rows
      from tmp_market_resolution_outcome_repair
      where venue = 'polymarket'
        and polymarket_source_raw is not null
    `,
  );

  return [
    { label: "repair_input_rows", rows: totalRows[0]?.rows ?? "0" },
    { label: "safe_outcome_rows", rows: outcomeRows[0]?.rows ?? "0" },
    { label: "polymarket_source_rows", rows: sourceRows[0]?.rows ?? "0" },
  ];
}

async function updateOutcomesAndReturnMarketRefs(
  client: PoolClient,
): Promise<RepairMarketRef[]> {
  const { rows } = await client.query<{ id: string; venue: string | null }>(
    `
      update unified_markets m
      set resolved_outcome = r.resolved_outcome,
          resolved_outcome_pct = r.resolved_outcome_pct,
          updated_at_db = now()
      from tmp_market_resolution_outcome_repair r
      where m.id = r.market_id
        and (r.resolved_outcome is not null or r.resolved_outcome_pct is not null)
        and m.resolved_outcome is null
        and m.resolved_outcome_pct is null
      returning m.id, m.venue::text as venue
    `,
  );
  return rows.map((row) => ({ marketId: row.id, venue: row.venue }));
}

async function runSourceUpdate(client: PoolClient): Promise<CountRow> {
  return updateAndCount(
    client,
    "polymarket_markets_source",
    `
      update polymarket_markets pm
      set outcome_prices = coalesce(r.polymarket_source_outcome_prices, pm.outcome_prices),
          active = coalesce(r.polymarket_source_active, pm.active),
          closed = coalesce(r.polymarket_source_closed, pm.closed),
          archived = coalesce(r.polymarket_source_archived, pm.archived),
          accepting_orders = coalesce(r.polymarket_source_accepting_orders, pm.accepting_orders),
          resolution_source = coalesce(r.polymarket_source_resolution_source, pm.resolution_source),
          resolved_by = coalesce(r.polymarket_source_resolved_by, pm.resolved_by),
          raw = coalesce(r.polymarket_source_raw, pm.raw),
          updated_at_db = now()
      from tmp_market_resolution_outcome_repair r
      where r.venue = 'polymarket'
        and r.polymarket_source_raw is not null
        and pm.id = r.venue_market_id
        and (
          pm.outcome_prices is distinct from coalesce(r.polymarket_source_outcome_prices, pm.outcome_prices)
          or pm.active is distinct from coalesce(r.polymarket_source_active, pm.active)
          or pm.closed is distinct from coalesce(r.polymarket_source_closed, pm.closed)
          or pm.archived is distinct from coalesce(r.polymarket_source_archived, pm.archived)
          or pm.accepting_orders is distinct from coalesce(r.polymarket_source_accepting_orders, pm.accepting_orders)
          or pm.resolution_source is distinct from coalesce(r.polymarket_source_resolution_source, pm.resolution_source)
          or pm.resolved_by is distinct from coalesce(r.polymarket_source_resolved_by, pm.resolved_by)
          or pm.raw is distinct from coalesce(r.polymarket_source_raw, pm.raw)
        )
    `,
  );
}

async function executeRepair(
  args: Args,
  validations: ValidationRow[],
): Promise<{
  repairedMarketRefs: RepairMarketRef[];
  repairedMarketIds: string[];
  selectionCounts: CountRow[];
  updateCounts: CountRow[];
}> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('market_resolution_outcome_repair')) as locked",
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error(
        "Resolution outcome repair aborted: another run is active",
      );
    }

    const selectionCounts = await materializeRepairSet(client, validations);
    const repairedMarketRefs = await updateOutcomesAndReturnMarketRefs(client);
    const repairedMarketIds = repairedMarketRefs.map((ref) => ref.marketId);
    const sourceCount = await runSourceUpdate(client);
    await client.query("commit");

    return {
      repairedMarketRefs,
      repairedMarketIds,
      selectionCounts,
      updateCounts: [
        {
          label: "unified_markets_outcome",
          rows: String(repairedMarketIds.length),
        },
        sourceCount,
      ],
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function jsonReport(
  args: Args,
  validations: ValidationRow[],
  startedAt: number,
  execution?: {
    metricsCounts?: CountRow[];
    repairedMarketIds: string[];
    selectionCounts: CountRow[];
    updateCounts: CountRow[];
  },
) {
  const report = buildReport(args, validations);
  return {
    ...report,
    durationMs: Date.now() - startedAt,
    repairableSamples: report.repairableSamples.map(formatSampleRow),
    allSamples: report.allSamples.map(formatSampleRow),
    ...(execution ?? {}),
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (hasFlag(rawArgs, "help")) {
    printUsage();
    return;
  }

  const args = parseArgs(rawArgs);
  assertExecutionFlags(args);
  const startedAt = Date.now();

  const candidates = await loadCandidates(args);
  const validations = await validateCandidates(candidates, args);

  if (args.execute) {
    const execution = await executeRepair(args, validations);
    const metricsCounts = await refreshWalletMetricsForMarkets(pool, {
      enabled: args.refreshWalletMetrics,
      marketRefs: execution.repairedMarketRefs,
      statementTimeoutSec: args.statementTimeoutSec,
      logPrefix: "[market:resolution-outcome-repair]",
    });
    if (args.json) {
      console.log(
        JSON.stringify(
          jsonReport(args, validations, startedAt, {
            repairedMarketIds: execution.repairedMarketIds,
            selectionCounts: execution.selectionCounts,
            updateCounts: execution.updateCounts,
            metricsCounts,
          }),
          null,
          2,
        ),
      );
      return;
    }

    console.log("[market:resolution-outcome-repair] execute update", {
      candidateCount: validations.length,
      outcomeRepairableCount: validations.filter(isOutcomeRepairable).length,
      polymarketSourceRepairableCount: validations.filter(
        (row) => row.polymarket_source !== null,
      ).length,
      repairedMarketCount: execution.repairedMarketIds.length,
      lookbackDays: args.lookbackDays,
      refreshWalletMetrics: args.refreshWalletMetrics,
      venues: args.venues.length > 0 ? args.venues : "all",
    });
    console.table(buildReport(args, validations).summary);
    console.table(execution.selectionCounts);
    console.table(execution.updateCounts);
    if (metricsCounts.length > 0) console.table(metricsCounts);
    console.log("[market:resolution-outcome-repair] done", {
      durationMs: Date.now() - startedAt,
      readOnly: false,
    });
    return;
  }

  const report = buildReport(args, validations);
  if (args.json) {
    console.log(
      JSON.stringify(jsonReport(args, validations, startedAt), null, 2),
    );
    return;
  }

  console.log("[market:resolution-outcome-repair] dry run", {
    candidateCount: report.candidateCount,
    outcomeRepairableCount: report.outcomeRepairableCount,
    polymarketSourceRepairableCount: report.polymarketSourceRepairableCount,
    skippedCount: report.skippedCount,
    lookbackDays: args.lookbackDays,
    limit: args.limit,
    venues: args.venues.length > 0 ? args.venues : "all",
  });
  console.table(report.summary);
  console.table(report.repairableSamples.map(formatSampleRow));
  console.table(report.allSamples.map(formatSampleRow));
  console.log("[market:resolution-outcome-repair] done", {
    durationMs: Date.now() - startedAt,
    readOnly: true,
  });
}

main()
  .catch((error) => {
    console.error("[market:resolution-outcome-repair] failed", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
