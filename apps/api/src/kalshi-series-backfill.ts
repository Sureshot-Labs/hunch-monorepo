import { chunkArray, sleep } from "@hunch/shared";
import { pool } from "./db.js";
import { env } from "./env.js";
import { dflowRequest, extractDflowErrorMessage } from "./services/dflow-client.js";

type SeriesRow = {
  series_key: string;
  series_title: string | null;
  category: string | null;
  tags: string[] | null;
};

function parseArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length).trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tags = value.filter((v) => typeof v === "string") as string[];
  return tags.length ? tags : null;
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

async function fetchSeriesPage(cursor?: number | null, limit?: number | null) {
  const res = await dflowRequest({
    baseUrl: env.dflowPredictionMarketsBase,
    timeoutMs: 30_000,
    method: "GET",
    requestPath: "/api/v1/series",
    apiKey: env.dflowApiKey,
    query: {
      limit: limit ?? undefined,
      cursor: cursor ?? undefined,
    },
  });

  if (!res.ok) {
    const err = extractDflowErrorMessage(res.payload);
    throw new Error(
      `DFlow series ${res.status}${err ? `: ${err}` : ""}`,
    );
  }

  const payload = res.payload as Record<string, unknown> | null;
  const rawSeries = Array.isArray(payload?.series) ? payload?.series : [];
  const nextCursor =
    normalizeCursor(payload?.nextCursor) ?? normalizeCursor(payload?.cursor);

  const series: SeriesRow[] = rawSeries
    .map((row) => {
      const r = row as Record<string, unknown>;
      const ticker = normalizeString(r.ticker);
      if (!ticker) return null;
      return {
        series_key: ticker,
        series_title: normalizeString(r.title),
        category: normalizeString(r.category),
        tags: normalizeTags(r.tags),
      };
    })
    .filter(Boolean) as SeriesRow[];

  return { series, nextCursor };
}

async function fetchAllSeries(limit: number | null, delayMs: number) {
  const out: SeriesRow[] = [];
  let cursor: number | null = null;
  let pages = 0;

  while (true) {
    const { series, nextCursor } = await fetchSeriesPage(cursor, limit);
    out.push(...series);
    pages += 1;

    if (!nextCursor) break;
    if (nextCursor === cursor) break;
    cursor = nextCursor;

    if (delayMs > 0) await sleep(delayMs);
  }

  return { rows: out, pages };
}

async function main() {
  const limitRaw = parseArgValue("limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : null;
  const batch = Math.max(1, Number(parseArgValue("batch") ?? "1000"));
  const delayMs = Math.max(0, Number(parseArgValue("delay") ?? "0"));
  const dryRun = hasFlag("dry-run");

  const startedAt = Date.now();

  const seriesKeyResult = await pool.query(
    `
      update unified_events
      set series_key = metadata->>'seriesTicker'
      where venue = 'kalshi'
        and series_key is null
        and metadata ? 'seriesTicker'
    `,
  );

  const { rows, pages } = await fetchAllSeries(limit, delayMs);
  const seriesRows = rows;

  let updated = 0;
  if (!dryRun) {
    const chunks = chunkArray(seriesRows, batch);
    for (const chunk of chunks) {
      const result = await pool.query(
        `
          with data as (
            select *
            from jsonb_to_recordset($1::jsonb)
              as x(
                series_key text,
                series_title text,
                category text,
                tags jsonb
              )
          )
          update unified_events e
          set category = coalesce(e.category, x.category),
              series_title = coalesce(e.series_title, x.series_title),
              metadata = coalesce(e.metadata, '{}'::jsonb)
                || jsonb_strip_nulls(
                  jsonb_build_object(
                    'seriesCategory', x.category,
                    'seriesTags', x.tags,
                    'seriesTitle', x.series_title
                  )
                )
          from data x
          where e.venue = 'kalshi'
            and e.series_key = x.series_key
            and (
              e.category is null
              or e.series_title is null
              or (e.metadata->>'seriesCategory') is null
              or (e.metadata->>'seriesTitle') is null
            )
        `,
        [JSON.stringify(chunk)],
      );
      updated += result.rowCount ?? 0;
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log("[kalshi:series-backfill] done", {
    limit,
    batch,
    delayMs,
    dryRun,
    pages,
    seriesRows: seriesRows.length,
    updated,
    seriesKeyBackfill: seriesKeyResult.rowCount ?? 0,
    elapsedSec,
  });
}

main().catch((err) => {
  console.error("[kalshi:series-backfill] failed", err);
  process.exit(1);
});
