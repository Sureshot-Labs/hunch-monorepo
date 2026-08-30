#!/usr/bin/env tsx

import { createInterface } from "node:readline";

const TELEMETRY_MARKERS = [
  "Polymarket event upsert stats",
  "Polymarket market upsert stats",
] as const;

type TelemetryRecord = {
  telemetryVersion: number;
  observedAt: string;
  kind: "events" | "markets";
  context: string;
  events?: number;
  markets?: number;
  unifiedInputRows?: number;
  unifiedDedupedRows?: number;
  unifiedChangedRows?: number;
  unifiedSkippedRows?: number;
  unifiedUpsertedRows?: number;
  unifiedBatches?: number;
  unifiedTokenSyncMarketCount?: number;
  polymarketInputRows?: number;
  polymarketDedupedRows?: number;
  polymarketChangedRows?: number;
  polymarketSkippedRows?: number;
  polymarketUpsertedRows?: number;
  polymarketBatches?: number;
  unifiedChangeReasons?: ReasonTelemetry;
  polymarketChangeReasons?: ReasonTelemetry;
  unifiedTimings?: Record<string, number>;
  queueWaitMs?: number;
  unifiedEventsMs?: number;
  polymarketEventsMs?: number;
  unifiedMarketsMs?: number;
  polymarketMarketsMs?: number;
  writeMs?: number;
  totalMs?: number;
  queueDepthAtEnqueue?: number;
  overlappingRowsAtEnqueue?: number;
  unifiedPayloadBytes?: number;
  polymarketPayloadBytes?: number;
  totalPayloadBytes?: number;
};

type ReasonTelemetry = {
  primary?: Record<string, number>;
};

type Group = {
  kind: TelemetryRecord["kind"];
  context: string;
  observations: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  rows: Record<string, number>;
  reasons: {
    unifiedPrimary: Record<string, number>;
    polymarketPrimary: Record<string, number>;
  };
  durationSamples: Record<string, number[]>;
  payloadBytes: Record<string, number>;
  queue: {
    maxDepthAtEnqueue: number;
    totalOverlappingRows: number;
    observationsWithOverlap: number;
  };
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addNumber(
  target: Record<string, number>,
  key: string,
  value: unknown,
): void {
  const amount = finiteNumber(value);
  if (amount == null) return;
  target[key] = (target[key] ?? 0) + amount;
}

function addReasonCounts(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  if (!source) return;
  for (const [reason, value] of Object.entries(source)) {
    addNumber(target, reason, value);
  }
}

function addDurationSample(group: Group, name: string, value: unknown): void {
  const duration = finiteNumber(value);
  if (duration == null) return;
  (group.durationSamples[name] ??= []).push(duration);
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

function percentage(
  numerator: number | undefined,
  denominator: number | undefined,
) {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function extractRecord(line: string): TelemetryRecord | null {
  const marker = TELEMETRY_MARKERS.find((candidate) =>
    line.includes(candidate),
  );
  if (!marker) return null;
  const markerIndex = line.indexOf(marker);
  const jsonStart = line.indexOf("{", markerIndex + marker.length);
  if (jsonStart < 0) throw new Error("telemetry marker has no JSON payload");
  const parsed = JSON.parse(line.slice(jsonStart)) as TelemetryRecord;
  if (
    parsed.telemetryVersion !== 1 ||
    (parsed.kind !== "events" && parsed.kind !== "markets") ||
    typeof parsed.context !== "string"
  ) {
    throw new Error("unsupported telemetry payload");
  }
  return parsed;
}

function createGroup(record: TelemetryRecord): Group {
  return {
    kind: record.kind,
    context: record.context,
    observations: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    rows: {},
    reasons: {
      unifiedPrimary: {},
      polymarketPrimary: {},
    },
    durationSamples: {},
    payloadBytes: {},
    queue: {
      maxDepthAtEnqueue: 0,
      totalOverlappingRows: 0,
      observationsWithOverlap: 0,
    },
  };
}

function addRecord(group: Group, record: TelemetryRecord): void {
  group.observations += 1;
  if (!group.firstObservedAt || record.observedAt < group.firstObservedAt) {
    group.firstObservedAt = record.observedAt;
  }
  if (!group.lastObservedAt || record.observedAt > group.lastObservedAt) {
    group.lastObservedAt = record.observedAt;
  }

  for (const field of [
    "events",
    "markets",
    "unifiedInputRows",
    "unifiedDedupedRows",
    "unifiedChangedRows",
    "unifiedSkippedRows",
    "unifiedUpsertedRows",
    "unifiedBatches",
    "unifiedTokenSyncMarketCount",
    "polymarketInputRows",
    "polymarketDedupedRows",
    "polymarketChangedRows",
    "polymarketSkippedRows",
    "polymarketUpsertedRows",
    "polymarketBatches",
  ] as const) {
    addNumber(group.rows, field, record[field]);
  }

  addReasonCounts(
    group.reasons.unifiedPrimary,
    record.unifiedChangeReasons?.primary,
  );
  addReasonCounts(
    group.reasons.polymarketPrimary,
    record.polymarketChangeReasons?.primary,
  );

  for (const field of [
    "queueWaitMs",
    "unifiedEventsMs",
    "polymarketEventsMs",
    "unifiedMarketsMs",
    "polymarketMarketsMs",
    "writeMs",
    "totalMs",
  ] as const) {
    addDurationSample(group, field, record[field]);
  }
  for (const [field, value] of Object.entries(record.unifiedTimings ?? {})) {
    addDurationSample(group, `unified.${field}`, value);
  }

  addNumber(
    group.payloadBytes,
    "unifiedPayloadBytes",
    record.unifiedPayloadBytes,
  );
  addNumber(
    group.payloadBytes,
    "polymarketPayloadBytes",
    record.polymarketPayloadBytes,
  );
  addNumber(group.payloadBytes, "totalPayloadBytes", record.totalPayloadBytes);

  const queueDepth = finiteNumber(record.queueDepthAtEnqueue) ?? 0;
  group.queue.maxDepthAtEnqueue = Math.max(
    group.queue.maxDepthAtEnqueue,
    queueDepth,
  );
  const overlappingRows = finiteNumber(record.overlappingRowsAtEnqueue) ?? 0;
  group.queue.totalOverlappingRows += overlappingRows;
  if (overlappingRows > 0) group.queue.observationsWithOverlap += 1;
}

function summarizeGroup(group: Group): Record<string, unknown> {
  const durations = Object.fromEntries(
    Object.entries(group.durationSamples)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [
        name,
        {
          samples: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: percentile(values, 1),
        },
      ]),
  );
  const ratesPct = {
    unifiedChanged: percentage(
      group.rows.unifiedChangedRows,
      group.rows.unifiedInputRows,
    ),
    unifiedSkipped: percentage(
      group.rows.unifiedSkippedRows,
      group.rows.unifiedInputRows,
    ),
    polymarketChanged: percentage(
      group.rows.polymarketChangedRows,
      group.rows.polymarketInputRows,
    ),
    polymarketSkipped: percentage(
      group.rows.polymarketSkippedRows,
      group.rows.polymarketInputRows,
    ),
    polymarketTimestampOnly: percentage(
      group.reasons.polymarketPrimary.source_timestamp_only,
      group.rows.polymarketInputRows,
    ),
    polymarketRawOnly: percentage(
      group.reasons.polymarketPrimary.raw_only,
      group.rows.polymarketInputRows,
    ),
  };
  return {
    kind: group.kind,
    context: group.context,
    observations: group.observations,
    firstObservedAt: group.firstObservedAt,
    lastObservedAt: group.lastObservedAt,
    rows: group.rows,
    ratesPct,
    reasons: group.reasons,
    durationsMs: durations,
    payloadBytes: group.payloadBytes,
    queue: group.queue,
  };
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const groups = new Map<string, Group>();
  let recordsParsed = 0;
  let malformedRecords = 0;

  for await (const line of lines) {
    try {
      const record = extractRecord(line);
      if (!record) continue;
      recordsParsed += 1;
      const key = `${record.kind}:${record.context}`;
      const group = groups.get(key) ?? createGroup(record);
      addRecord(group, record);
      groups.set(key, group);
    } catch {
      malformedRecords += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        recordsParsed,
        malformedRecords,
        groups: Array.from(groups.values())
          .sort((left, right) =>
            `${left.kind}:${left.context}`.localeCompare(
              `${right.kind}:${right.context}`,
            ),
          )
          .map(summarizeGroup),
      },
      null,
      2,
    ),
  );
}

await main();
