import { env } from "./env.js";
import { DflowEventsResponse, DflowMarketsBatchResponse } from "./types.js";
import type { TDflowEvent } from "./types.js";
import type { TDflowMarket } from "./types.js";

export type DflowEventsQuery = {
  status?: string;
  limit?: number;
  cursor?: number;
  withNestedMarkets?: boolean;
  sort?: string;
  isInitialized?: boolean;
};

function resolveEventsUrl(): string {
  const base = env.dflowPredictionMarketsBase.replace(/\/+$/, "");
  return `${base}/api/v1/events`;
}

function resolveMarketsBatchUrl(): string {
  const base = env.dflowPredictionMarketsBase.replace(/\/+$/, "");
  return `${base}/api/v1/markets/batch`;
}

function setOptionalString(
  sp: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (!value) return;
  sp.set(key, value);
}

function setOptionalBool(
  sp: URLSearchParams,
  key: string,
  value: boolean | undefined,
): void {
  if (value == null) return;
  sp.set(key, value ? "true" : "false");
}

function setOptionalNumber(
  sp: URLSearchParams,
  key: string,
  value: number | undefined,
): void {
  if (value == null) return;
  sp.set(key, String(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCursor(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.trunc(n);
  }

  return null;
}

export async function fetchEventsPage(q: DflowEventsQuery): Promise<{
  events: TDflowEvent[];
  nextCursor: number | null;
}> {
  const url = new URL(resolveEventsUrl());
  setOptionalBool(url.searchParams, "withNestedMarkets", q.withNestedMarkets);
  setOptionalString(url.searchParams, "status", q.status);
  setOptionalNumber(url.searchParams, "limit", q.limit);
  setOptionalNumber(url.searchParams, "cursor", q.cursor);
  setOptionalString(url.searchParams, "sort", q.sort);
  setOptionalBool(url.searchParams, "isInitialized", q.isInitialized);

  const headers: Record<string, string> = { accept: "application/json" };
  if (env.dflowApiKey) headers["x-api-key"] = env.dflowApiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DFlow events ${res.status}: ${body.slice(0, 500)}`);
  }

  const raw = (await res.json()) as unknown;
  const parsed = DflowEventsResponse.parse(raw);

  const events = (parsed.events ?? []) as TDflowEvent[];
  const nextCursor =
    normalizeCursor(parsed.nextCursor) ?? normalizeCursor(parsed.cursor);

  return { events, nextCursor };
}

export type DflowMarketsBatchQuery = {
  mints?: string[];
  tickers?: string[];
};

export async function fetchMarketsBatch(
  query: DflowMarketsBatchQuery,
): Promise<TDflowMarket[]> {
  const url = resolveMarketsBatchUrl();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (env.dflowApiKey) headers["x-api-key"] = env.dflowApiKey;

  const body = JSON.stringify({
    mints: query.mints?.length ? query.mints : null,
    tickers: query.tickers?.length ? query.tickers : null,
  });

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DFlow markets batch ${res.status}: ${text.slice(0, 500)}`);
  }

  const raw = (await res.json()) as unknown;
  const parsed = DflowMarketsBatchResponse.parse(raw);
  return (parsed.markets ?? []) as TDflowMarket[];
}

export type DflowEventsPage = {
  cursor: number | null;
  nextCursor: number | null;
  events: TDflowEvent[];
};

export type DflowEventPaginationOptions = {
  label?: string;
  startCursor?: number;
  pageSize?: number;
  maxPages?: number; // 0 = unlimited
} & Omit<DflowEventsQuery, "limit" | "cursor">;

export async function* iterateEventPages(
  opts: DflowEventPaginationOptions = {},
): AsyncGenerator<DflowEventsPage> {
  let cursor: number | null = opts.startCursor ?? null;
  const pageSize = opts.pageSize ?? env.pageSize;
  const maxPages = opts.maxPages ?? 0;

  const {
    label,
    startCursor: _startCursor,
    pageSize: _pageSize,
    maxPages: _maxPages,
    ...query
  } = opts;

  console.log(
    `Fetching DFlow events${label ? ` [${label}]` : ""} (status=${query.status ?? "?"}, withNestedMarkets=${query.withNestedMarkets})`,
  );

  let pages = 0;
  while (true) {
    if (maxPages > 0 && pages >= maxPages) break;

    const { events, nextCursor } = await fetchEventsPage({
      ...query,
      limit: pageSize,
      cursor: cursor ?? undefined,
    });

    console.log(`${events.length} events at cursor ${cursor ?? "∅"}`);
    if (!events.length) break;

    yield { cursor, nextCursor, events };

    pages += 1;
    if (!nextCursor) break;
    if (nextCursor === cursor) break;
    cursor = nextCursor;

    await sleep(100);
  }
}

export async function* iterateEventsWithMarkets(
  opts: DflowEventPaginationOptions = {},
): AsyncGenerator<TDflowEvent[]> {
  for await (const page of iterateEventPages({
    status: "active",
    withNestedMarkets: true,
    isInitialized: env.isInitialized,
    ...opts,
  })) {
    yield page.events;
  }
}
