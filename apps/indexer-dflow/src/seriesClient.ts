import { sleep } from "@hunch/shared";

import { env } from "./env.js";
import { log } from "./log.js";
import { DflowSeriesResponse, type TDflowSeries } from "./types.js";

export type DflowSeriesInfo = {
  title?: string;
  category?: string;
  tags?: string[];
};

type SeriesPage = {
  series: TDflowSeries[];
  nextCursor: number | null;
};

let seriesCache: Map<string, DflowSeriesInfo> | null = null;
let seriesCacheAt = 0;
let seriesFetchPromise: Promise<Map<string, DflowSeriesInfo>> | null = null;

const SERIES_TTL_MS = env.seriesRefreshHours * 60 * 60 * 1000;

function shouldRefresh(now: number): boolean {
  if (!seriesCache) return true;
  if (!Number.isFinite(seriesCacheAt) || seriesCacheAt <= 0) return true;
  return now - seriesCacheAt >= SERIES_TTL_MS;
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

async function fetchSeriesPage(cursor?: number | null): Promise<SeriesPage> {
  const base = env.dflowPredictionMarketsBase.replace(/\/+$/, "");
  const url = new URL(`${base}/api/v1/series`);
  if (env.seriesPageSize) {
    url.searchParams.set("limit", String(env.seriesPageSize));
  }
  if (cursor != null) url.searchParams.set("cursor", String(cursor));

  const headers: Record<string, string> = { accept: "application/json" };
  if (env.dflowApiKey) headers["x-api-key"] = env.dflowApiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DFlow series ${res.status}: ${text.slice(0, 500)}`);
  }

  const raw = (await res.json()) as unknown;
  const parsed = DflowSeriesResponse.parse(raw);
  const series = (parsed.series ?? []) as TDflowSeries[];
  const nextCursor =
    normalizeCursor(parsed.nextCursor) ?? normalizeCursor(parsed.cursor);
  return { series, nextCursor };
}

async function fetchSeriesLookup(): Promise<Map<string, DflowSeriesInfo>> {
  const map = new Map<string, DflowSeriesInfo>();
  let cursor: number | null = null;
  let pages = 0;
  const maxPages = env.seriesMaxPages;

  while (true) {
    const { series, nextCursor } = await fetchSeriesPage(cursor);
    for (const s of series) {
      if (!s?.ticker) continue;
      map.set(s.ticker, {
        title: typeof s.title === "string" ? s.title : undefined,
        category: typeof s.category === "string" ? s.category : undefined,
        tags: Array.isArray(s.tags) ? s.tags : undefined,
      });
    }

    pages += 1;
    if (!nextCursor) break;
    if (maxPages > 0 && pages >= maxPages) break;
    if (nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(50);
  }

  return map;
}

export async function getSeriesLookup(): Promise<Map<string, DflowSeriesInfo>> {
  const now = Date.now();
  if (!shouldRefresh(now) && seriesCache) return seriesCache;
  if (seriesFetchPromise) return seriesFetchPromise;

  seriesFetchPromise = fetchSeriesLookup()
    .then((map) => {
      seriesCache = map;
      seriesCacheAt = Date.now();
      log.info("DFlow series lookup refreshed", {
        series: map.size,
        ttlHours: env.seriesRefreshHours,
      });
      return map;
    })
    .catch((err) => {
      log.warn("DFlow series lookup failed", err);
      if (seriesCache) return seriesCache;
      return new Map();
    })
    .finally(() => {
      seriesFetchPromise = null;
    });

  return seriesFetchPromise;
}
