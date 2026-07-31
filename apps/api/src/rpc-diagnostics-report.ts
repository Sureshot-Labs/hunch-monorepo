#!/usr/bin/env tsx

import {
  createRedisClient,
  decodeRpcDiagnosticField,
  ensureRedis,
  rpcDiagnosticsHourKey,
} from "@hunch/infra";
import { config } from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

config({
  path: resolve(import.meta.dirname, "../../../.env"),
  override: false,
});

type ReportRow = {
  service: string;
  network: string;
  method: string;
  source: string;
  logical: number;
  attempts: number;
  dedup: number;
  retries: number | null;
  rateLimited: number;
  errors: number;
  averageMs: number;
};

function readPositiveIntFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function rpcDiagnosticsReportWindow(
  hours: number,
  now = new Date(),
): Readonly<{
  hours: number;
  windowKind: "utc_hour_buckets";
  fromHour: string;
  throughHour: string;
  currentBucketPartial: true;
  keys: readonly string[];
}> {
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const keys = Array.from({ length: hours }, (_, index) =>
    rpcDiagnosticsHourKey(
      new Date(currentHour.getTime() - index * 60 * 60 * 1_000),
    ),
  );
  const fromHour = new Date(
    currentHour.getTime() - (hours - 1) * 60 * 60 * 1_000,
  );
  return {
    hours,
    windowKind: "utc_hour_buckets",
    fromHour: fromHour.toISOString(),
    throughHour: currentHour.toISOString(),
    currentBucketPartial: true,
    keys,
  };
}

export function rpcDiagnosticRetryCount(
  input: Readonly<{
    logical: number;
    attempts: number;
    dedup: number;
  }>,
): number | null {
  return input.logical > 0
    ? Math.max(0, input.attempts - (input.logical - input.dedup))
    : null;
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error("REDIS_URL is required");
  const hours = Math.min(30, readPositiveIntFlag("hours", 24));
  const window = rpcDiagnosticsReportWindow(hours);
  const asJson = process.argv.slice(2).includes("--json");
  const redis = createRedisClient({ url: redisUrl });
  await ensureRedis(redis);
  try {
    const grouped = new Map<
      string,
      Omit<ReportRow, "averageMs" | "retries"> & { durationMs: number }
    >();
    for (const key of window.keys) {
      const fields = await redis.hGetAll(key);
      for (const [field, rawValue] of Object.entries(fields)) {
        const dimensions = decodeRpcDiagnosticField(field);
        const value = Number(rawValue);
        if (!dimensions || !Number.isFinite(value) || value < 0) continue;
        const groupKey = JSON.stringify([
          dimensions.service,
          dimensions.network,
          dimensions.method,
          dimensions.source,
        ]);
        const row = grouped.get(groupKey) ?? {
          service: dimensions.service,
          network: dimensions.network,
          method: dimensions.method,
          source: dimensions.source,
          logical: 0,
          attempts: 0,
          dedup: 0,
          rateLimited: 0,
          errors: 0,
          durationMs: 0,
        };
        if (dimensions.metric === "logical") row.logical += value;
        if (dimensions.metric === "dedup") row.dedup += value;
        if (dimensions.metric === "duration_ms") row.durationMs += value;
        if (dimensions.metric === "attempt") {
          row.attempts += value;
          if (
            dimensions.outcome === "http_429" ||
            dimensions.outcome === "rpc_429"
          ) {
            row.rateLimited += value;
          }
          if (dimensions.outcome !== "ok") row.errors += value;
        }
        grouped.set(groupKey, row);
      }
    }
    const rows: ReportRow[] = Array.from(grouped.values())
      .map((row) => ({
        service: row.service,
        network: row.network,
        method: row.method,
        source: row.source,
        logical: row.logical,
        attempts: row.attempts,
        dedup: row.dedup,
        retries: rpcDiagnosticRetryCount(row),
        rateLimited: row.rateLimited,
        errors: row.errors,
        averageMs:
          row.attempts > 0 ? Math.round(row.durationMs / row.attempts) : 0,
      }))
      .sort(
        (left, right) =>
          right.attempts - left.attempts ||
          right.rateLimited - left.rateLimited ||
          left.source.localeCompare(right.source),
      );
    if (asJson) {
      const { keys: _keys, ...publicWindow } = window;
      console.log(JSON.stringify({ ...publicWindow, rows }, null, 2));
      return;
    }
    console.log(
      `RPC diagnostics — ${hours} UTC hour buckets, current partial bucket included (${rows.length} sources)`,
    );
    if (rows.length === 0) {
      console.log(
        "No samples found. Restart instrumented processes and wait at least 10 seconds.",
      );
      return;
    }
    console.table(
      rows.map((row) => ({
        service: row.service,
        network: row.network,
        method: row.method,
        source: row.source,
        logical: row.logical,
        attempts: row.attempts,
        retries: row.retries ?? "n/a",
        dedup: row.dedup,
        "429": row.rateLimited,
        errors: row.errors,
        avgMs: row.averageMs,
      })),
    );
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
