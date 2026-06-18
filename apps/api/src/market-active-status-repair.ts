import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { env } from "./env.js";
import { isRecord } from "./lib/type-guards.js";
import { dflowRequest, extractDflowErrorMessage } from "./services/dflow-client.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./services/limitless-client.js";

type UnifiedStatus = "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
type Venue = "polymarket" | "limitless" | "kalshi";

type Args = {
  apiTimeoutSec: number;
  concurrency: number;
  confirmUpdate: boolean;
  cutoffDays: number;
  execute: boolean;
  json: boolean;
  limit: number;
  sampleLimit: number;
  statementTimeoutSec: number;
  venues: Venue[];
};

type CandidateRow = {
  market_id: string;
  venue: Venue;
  venue_market_id: string;
  slug: string | null;
  event_id: string;
  title: string;
  terminal_at: Date;
};

type ValidationRow = CandidateRow & {
  current_status: "ACTIVE";
  target_status: Exclude<UnifiedStatus, "ACTIVE"> | null;
  reason: string;
};

type SummaryRow = {
  section: string;
  venue: string | null;
  targetStatus: string | null;
  reason: string;
  markets: string;
  oldest: string | null;
  newest: string | null;
};

type CountRow = {
  label: string;
  rows: string;
};

const DEFAULT_CUTOFF_DAYS = 90;
const DEFAULT_LIMIT = 10_000;
const DEFAULT_SAMPLE_LIMIT = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_API_TIMEOUT_SEC = 15;
const DFLOW_BATCH_SIZE = 100;
const ALLOWED_VENUES = new Set<Venue>([
  "polymarket",
  "limitless",
  "kalshi",
]);

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
    cutoffDays:
      readValues(argv, "cutoff-days")[0] !== undefined
        ? readPositiveInt(argv, "cutoff-days", DEFAULT_CUTOFF_DAYS)
        : readPositiveInt(argv, "retention-days", DEFAULT_CUTOFF_DAYS),
    execute: hasFlag(argv, "execute"),
    json: hasFlag(argv, "json"),
    limit: readPositiveInt(argv, "limit", DEFAULT_LIMIT),
    sampleLimit: readPositiveInt(argv, "sample", DEFAULT_SAMPLE_LIMIT),
    statementTimeoutSec: readPositiveInt(argv, "statement-timeout-sec", 180),
    venues: normalizeVenues([
      ...readValues(argv, "venue"),
      ...readValues(argv, "venues"),
    ]),
  };
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -C hunch-monorepo -F api run market:active-status-repair -- [options]

Options:
  --cutoff-days <days>          ACTIVE market terminal age threshold. Default: ${DEFAULT_CUTOFF_DAYS}
  --limit <count>               Bounded candidate pool size. Default: ${DEFAULT_LIMIT}
  --sample <count>              Sample row count. Default: ${DEFAULT_SAMPLE_LIMIT}
  --venue <venue[,venue]>       Optional venue filter: polymarket, limitless, kalshi. Repeatable.
  --concurrency <count>         Live API request concurrency. Default: ${DEFAULT_CONCURRENCY}
  --api-timeout-sec <sec>       Live API timeout per request. Default: ${DEFAULT_API_TIMEOUT_SEC}
  --statement-timeout-sec <sec> DB query timeout. Default: 180
  --json                        Emit one JSON report.
  --execute                     Update live-validated rows. Requires --confirm-update.
  --confirm-update              Required together with --execute.
  --help                        Show this message.

Selection rule:
  unified market status is ACTIVE
  terminal_at = coalesce(market.close_time, market.expiration_time, event.end_date)
  terminal_at older than cutoff
  live venue API says the market is CLOSED, SETTLED, or ARCHIVED

Live sources:
  polymarket: Gamma markets API
  limitless: Limitless /markets/:slug API
  kalshi: DFlow /api/v1/markets/batch API

Dry-run is the default. Update mode only runs when both --execute and
--confirm-update are present.`);
}

function assertExecutionFlags(args: Args): void {
  if (args.execute === args.confirmUpdate) return;

  throw new Error(
    "ACTIVE status repair requires both --execute and --confirm-update. Omit both flags for dry-run.",
  );
}

function queryParams(args: Args): Array<number | Venue[] | null> {
  return [
    args.venues.length > 0 ? args.venues : null,
    args.cutoffDays,
    args.limit,
  ];
}

function dateToString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function logSection(title: string): void {
  console.log(`\n[market:active-status-repair] ${title}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function boolValue(
  record: Record<string, unknown>,
  keys: string[],
): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
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
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.markets)) return value.markets.filter(isRecord);
  if (Array.isArray(value.data)) return value.data.filter(isRecord);
  return [];
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

function mapGammaMarketStatus(
  market: Record<string, unknown>,
): Pick<ValidationRow, "target_status" | "reason"> {
  const archived = boolValue(market, ["archived"]);
  const closed = boolValue(market, ["closed"]);
  const active = boolValue(market, ["active"]);
  const acceptingOrders = boolValue(market, [
    "acceptingOrders",
    "accepting_orders",
  ]);

  if (archived === true) {
    return { target_status: "ARCHIVED", reason: "gamma_archived" };
  }
  if (closed === true) {
    return { target_status: "CLOSED", reason: "gamma_closed" };
  }
  if (active === false) {
    return { target_status: "CLOSED", reason: "gamma_inactive" };
  }
  if (acceptingOrders === false) {
    return { target_status: "CLOSED", reason: "gamma_not_accepting_orders" };
  }
  return { target_status: null, reason: "gamma_active" };
}

async function validatePolymarket(
  candidate: CandidateRow,
  timeoutMs: number,
): Promise<ValidationRow> {
  try {
    const market = await fetchGammaMarket(candidate.venue_market_id, timeoutMs);
    if (!market) {
      return buildValidation(candidate, null, "gamma_not_found");
    }
    const status = mapGammaMarketStatus(market);
    return buildValidation(candidate, status.target_status, status.reason);
  } catch (error) {
    return buildValidation(candidate, null, `gamma_error:${errorMessage(error)}`);
  }
}

async function validateLimitless(
  candidate: CandidateRow,
  timeoutMs: number,
): Promise<ValidationRow> {
  const marketRef = candidate.slug ?? candidate.venue_market_id;
  if (!marketRef) {
    return buildValidation(candidate, null, "limitless_missing_market_ref");
  }

  try {
    const res = await limitlessRequest({
      method: "GET",
      requestPath: `/markets/${encodeURIComponent(marketRef)}`,
      auth: "none",
      timeoutMs,
    });
    if (!res.ok) {
      const message = extractLimitlessMessage(res.payload);
      return buildValidation(
        candidate,
        null,
        `limitless_error:${res.status}${message ? `:${message}` : ""}`,
      );
    }

    const market = firstRecord(res.payload);
    if (!market) {
      return buildValidation(candidate, null, "limitless_not_found");
    }

    const status = stringValue(market.status)?.toUpperCase() ?? "";
    const expired = boolValue(market, ["expired"]);
    if (status === "RESOLVED") {
      return buildValidation(candidate, "SETTLED", "limitless_resolved");
    }
    if (expired === true) {
      return buildValidation(candidate, "CLOSED", "limitless_expired");
    }
    return buildValidation(candidate, null, "limitless_active");
  } catch (error) {
    return buildValidation(
      candidate,
      null,
      `limitless_error:${errorMessage(error)}`,
    );
  }
}

function mapDflowStatusToUnified(value: unknown): UnifiedStatus {
  const status = stringValue(value)?.toLowerCase() ?? "";
  if (!status) return "ACTIVE";

  if (status === "archived") return "ARCHIVED";
  if (
    ["finalized", "finalised", "determined", "settled", "resolved"].includes(
      status,
    )
  ) {
    return "SETTLED";
  }
  if (
    [
      "closed",
      "expired",
      "halted",
      "suspended",
      "inactive",
      "paused",
      "cancelled",
      "canceled",
      "void",
    ].includes(status)
  ) {
    return "CLOSED";
  }

  return "ACTIVE";
}

function mapDflowReason(status: UnifiedStatus, rawStatus: string | null): string {
  if (status === "ACTIVE") return "dflow_active";
  const suffix = rawStatus?.toLowerCase() || status.toLowerCase();
  return `dflow_${suffix}`;
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
      return candidates.map((candidate) =>
        buildValidation(candidate, null, reason),
      );
    }

    const markets = recordArray(res.payload);
    return candidates.map((candidate) => {
      const market = findDflowMarket(markets, candidate.venue_market_id);
      if (!market) {
        return buildValidation(candidate, null, "dflow_not_found");
      }
      const rawStatus = stringValue(market.status);
      const targetStatus = mapDflowStatusToUnified(rawStatus);
      if (targetStatus === "ACTIVE") {
        return buildValidation(candidate, null, "dflow_active");
      }
      return buildValidation(
        candidate,
        targetStatus,
        mapDflowReason(targetStatus, rawStatus),
      );
    });
  } catch (error) {
    return candidates.map((candidate) =>
      buildValidation(candidate, null, `dflow_error:${errorMessage(error)}`),
    );
  }
}

function buildValidation(
  candidate: CandidateRow,
  targetStatus: Exclude<UnifiedStatus, "ACTIVE"> | null,
  reason: string,
): ValidationRow {
  return {
    ...candidate,
    current_status: "ACTIVE",
    target_status: targetStatus,
    reason,
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

  const [polymarketRows, limitlessRows, kalshiRows] = await Promise.all([
    mapWithConcurrency(polymarket, args.concurrency, (candidate) =>
      validatePolymarket(candidate, timeoutMs),
    ),
    mapWithConcurrency(limitless, args.concurrency, (candidate) =>
      validateLimitless(candidate, timeoutMs),
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
      buildValidation(candidate, null, "validation_missing"),
  );
}

async function queryCandidates(
  client: PoolClient,
  args: Args,
): Promise<CandidateRow[]> {
  const { rows } = await client.query<CandidateRow>(
    `
      select
        m.id as market_id,
        m.venue::text as venue,
        m.venue_market_id,
        m.slug,
        m.event_id,
        m.title,
        coalesce(m.close_time, m.expiration_time, e.end_date) as terminal_at
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.status = 'ACTIVE'::unified_status
        and ($1::text[] is null or m.venue = any($1::text[]))
        and m.venue in ('polymarket', 'limitless', 'kalshi')
        and m.venue_market_id is not null
        and coalesce(m.close_time, m.expiration_time, e.end_date) is not null
        and coalesce(m.close_time, m.expiration_time, e.end_date) < now() - make_interval(days => $2::int)
      order by coalesce(m.close_time, m.expiration_time, e.end_date) asc, m.id asc
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

function summarizeRows(rows: ValidationRow[]): SummaryRow[] {
  const groups = new Map<
    string,
    {
      section: string;
      venue: string | null;
      targetStatus: string | null;
      reason: string;
      markets: number;
      oldest: Date | null;
      newest: Date | null;
    }
  >();

  function add(
    section: string,
    venue: string | null,
    targetStatus: string | null,
    reason: string,
    row: ValidationRow,
  ) {
    const key = [section, venue ?? "", targetStatus ?? "", reason].join("\u0001");
    const group =
      groups.get(key) ??
      {
        section,
        venue,
        targetStatus,
        reason,
        markets: 0,
        oldest: null,
        newest: null,
      };
    group.markets += 1;
    if (!group.oldest || row.terminal_at < group.oldest) {
      group.oldest = row.terminal_at;
    }
    if (!group.newest || row.terminal_at > group.newest) {
      group.newest = row.terminal_at;
    }
    groups.set(key, group);
  }

  for (const row of rows) {
    add("candidate_by_venue", row.venue, null, "all", row);
    if (row.target_status) {
      add(
        "repair_by_venue_status_reason",
        row.venue,
        row.target_status,
        row.reason,
        row,
      );
    } else {
      add("skipped_by_venue_reason", row.venue, null, row.reason, row);
    }
  }

  return [...groups.values()]
    .sort((a, b) =>
      [
        a.section.localeCompare(b.section),
        (a.venue ?? "").localeCompare(b.venue ?? ""),
        (a.targetStatus ?? "").localeCompare(b.targetStatus ?? ""),
        a.reason.localeCompare(b.reason),
      ].find((value) => value !== 0) ?? 0,
    )
    .map((row) => ({
      section: row.section,
      venue: row.venue,
      targetStatus: row.targetStatus,
      reason: row.reason,
      markets: String(row.markets),
      oldest: dateToString(row.oldest),
      newest: dateToString(row.newest),
    }));
}

function formatSampleRow(row: ValidationRow): Record<string, string | null> {
  return {
    marketId: row.market_id,
    venue: row.venue,
    currentStatus: row.current_status,
    targetStatus: row.target_status,
    reason: row.reason,
    eventId: row.event_id,
    terminalAt: dateToString(row.terminal_at),
    title: row.title,
  };
}

function buildReport(args: Args, validations: ValidationRow[]) {
  const repairable = validations.filter((row) => row.target_status !== null);
  return {
    args,
    candidateCount: validations.length,
    repairableCount: repairable.length,
    skippedCount: validations.length - repairable.length,
    summary: summarizeRows(validations),
    repairableSamples: repairable.slice(0, args.sampleLimit),
    allSamples: validations.slice(0, args.sampleLimit),
  };
}

async function countTempRows(
  client: PoolClient,
  label: string,
  tableName: string,
): Promise<CountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `select count(*)::text as rows from ${tableName}`,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
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
  const repairable = validations.filter((row) => row.target_status !== null);
  const payload = JSON.stringify(
    repairable.map((row) => ({
      market_id: row.market_id,
      event_id: row.event_id,
      current_status: row.current_status,
      target_status: row.target_status,
      reason: row.reason,
    })),
  );

  await client.query(
    `
      create temp table tmp_market_active_status_repair on commit drop as
      select
        value->>'market_id' as market_id,
        value->>'event_id' as event_id,
        value->>'current_status' as current_status,
        value->>'target_status' as target_status,
        value->>'reason' as reason
      from jsonb_array_elements($1::jsonb) as value
      where value->>'target_status' is not null
    `,
    [payload],
  );

  await client.query(
    `
      create temp table tmp_market_active_status_repair_events on commit drop as
      select distinct event_id
      from tmp_market_active_status_repair
    `,
  );

  return [
    await countTempRows(
      client,
      "live_validated_repairable_markets",
      "tmp_market_active_status_repair",
    ),
    await countTempRows(
      client,
      "events_touched",
      "tmp_market_active_status_repair_events",
    ),
  ];
}

async function runUpdates(client: PoolClient): Promise<CountRow[]> {
  const marketCount = await updateAndCount(
    client,
    "unified_markets",
    `
      update unified_markets m
      set status = r.target_status::unified_status,
          updated_at_db = now()
      from tmp_market_active_status_repair r
      where m.id = r.market_id
        and m.status = r.current_status::unified_status
        and r.target_status in ('CLOSED', 'SETTLED', 'ARCHIVED')
    `,
  );

  const eventCount = await updateAndCount(
    client,
    "unified_events",
    `
      update unified_events e
      set status = agg.target_status::unified_status,
          updated_at_db = now()
      from (
        select
          touched.event_id,
          case
            when bool_or(m.status = 'ACTIVE'::unified_status) then 'ACTIVE'
            when bool_or(m.status = 'SETTLED'::unified_status) then 'SETTLED'
            when bool_or(m.status = 'CLOSED'::unified_status) then 'CLOSED'
            when bool_or(m.status = 'ARCHIVED'::unified_status) then 'ARCHIVED'
            else 'CLOSED'
          end as target_status
        from tmp_market_active_status_repair_events touched
        left join unified_markets m on m.event_id = touched.event_id
        group by touched.event_id
      ) agg
      where e.id = agg.event_id
        and e.status is distinct from agg.target_status::unified_status
    `,
  );

  return [marketCount, eventCount];
}

async function executeRepair(
  args: Args,
  validations: ValidationRow[],
): Promise<{ selectionCounts: CountRow[]; updateCounts: CountRow[] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('market_active_status_repair')) as locked",
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("ACTIVE status repair aborted: another run is active");
    }

    const selectionCounts = await materializeRepairSet(client, validations);
    const updateCounts = await runUpdates(client);

    await client.query("commit");
    return { selectionCounts, updateCounts };
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
  execution?: { selectionCounts: CountRow[]; updateCounts: CountRow[] },
) {
  const report = buildReport(args, validations);
  return {
    ...report,
    durationMs: Date.now() - startedAt,
    summary: report.summary,
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
    if (args.json) {
      console.log(JSON.stringify(jsonReport(args, validations, startedAt, execution), null, 2));
      return;
    }

    console.log("[market:active-status-repair] execute live-validated update", {
      cutoffDays: args.cutoffDays,
      limit: args.limit,
      candidateCount: validations.length,
      repairableCount: validations.filter((row) => row.target_status !== null)
        .length,
      venues: args.venues.length > 0 ? args.venues : "all",
      concurrency: args.concurrency,
      apiTimeoutSec: args.apiTimeoutSec,
      statementTimeoutSec: args.statementTimeoutSec,
    });
    logSection("summary");
    console.table(buildReport(args, validations).summary);
    logSection("selection counts");
    console.table(execution.selectionCounts);
    logSection("update counts");
    console.table(execution.updateCounts);
    console.log("[market:active-status-repair] done", {
      durationMs: Date.now() - startedAt,
      readOnly: false,
    });
    return;
  }

  const report = buildReport(args, validations);
  if (args.json) {
    console.log(JSON.stringify(jsonReport(args, validations, startedAt), null, 2));
    return;
  }

  console.log("[market:active-status-repair] live-validator dry run", {
    cutoffDays: args.cutoffDays,
    limit: args.limit,
    sampleLimit: args.sampleLimit,
    candidateCount: report.candidateCount,
    repairableCount: report.repairableCount,
    skippedCount: report.skippedCount,
    venues: args.venues.length > 0 ? args.venues : "all",
    concurrency: args.concurrency,
    apiTimeoutSec: args.apiTimeoutSec,
    statementTimeoutSec: args.statementTimeoutSec,
  });
  logSection("summary");
  console.table(report.summary);
  logSection("repairable samples");
  console.table(report.repairableSamples.map(formatSampleRow));
  logSection("all candidate samples");
  console.table(report.allSamples.map(formatSampleRow));
  console.log("[market:active-status-repair] done", {
    durationMs: Date.now() - startedAt,
    readOnly: true,
  });
}

main()
  .catch((error) => {
    console.error("[market:active-status-repair] failed", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
