#!/usr/bin/env tsx

import { pool } from "./db.js";

type AuditRow = {
  net_flow_usd: string | number | null;
  position_usd: string | number | null;
  price_move_cents: string | number | null;
  story_kind: string | null;
  subject_source: string | null;
  visible_length: string | number | null;
};

function parseDays(argv: string[]): number {
  const raw = argv.find((value) => value.startsWith("--days="))?.slice(7);
  const days = Number(raw ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }
  return days;
}

function number(value: string | number | null): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentiles(values: Array<number | null>) {
  const sorted = values
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right);
  const at = (quantile: number) => {
    if (sorted.length === 0) return null;
    return sorted[Math.round((sorted.length - 1) * quantile)] ?? null;
  };
  return {
    count: sorted.length,
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
  };
}

function rate(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

async function main() {
  const days = parseDays(process.argv.slice(2));
  const { rows } = await pool.query<AuditRow>(
    `
      select
        nullif(metrics #>> '{netSignalSideFlowUsd}', '') as net_flow_usd,
        nullif(metrics #>> '{priceMoveCents}', '') as price_move_cents,
        nullif(metrics #>> '{delivery,view,holder,positionUsd}', '') as position_usd,
        nullif(metrics #>> '{copy,notification,headline,storyKind}', '') as story_kind,
        nullif(metrics #>> '{copy,notification,subject,source}', '') as subject_source,
        nullif(metrics #>> '{copy,notification,headline,visibleLength}', '') as visible_length
      from signal_bot_messages
      where sent_at >= now() - $1::int * interval '1 day'
        and coalesce(metrics->>'status', 'sent') = 'sent'
    `,
    [days],
  );
  const storyDistribution = Object.fromEntries(
    [...new Set(rows.map((row) => row.story_kind).filter(Boolean))]
      .sort()
      .map((story) => [
        story,
        rows.filter((row) => row.story_kind === story).length,
      ]),
  );
  const total = rows.length;
  const fallback = rows.filter((row) =>
    ["safe_full_title", "safe_fallback"].includes(row.subject_source ?? ""),
  ).length;
  const over80 = rows.filter(
    (row) => (number(row.visible_length) ?? 0) > 80,
  ).length;
  const cooling = rows.filter((row) => row.story_kind === "cooling").length;
  const divergence = rows.filter(
    (row) => row.story_kind === "divergence",
  ).length;

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowDays: days,
        deliveries: total,
        percentiles: {
          netFlowUsd: percentiles(rows.map((row) => number(row.net_flow_usd))),
          positionUsd: percentiles(rows.map((row) => number(row.position_usd))),
          priceMoveCents: percentiles(
            rows.map((row) => number(row.price_move_cents)),
          ),
        },
        storyDistribution,
        rates: {
          cooling: rate(cooling, total),
          divergence: rate(divergence, total),
          fallbackSubject: rate(fallback, total),
          over80Graphemes: rate(over80, total),
        },
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await pool.end();
}
