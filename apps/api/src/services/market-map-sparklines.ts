import type { Pool } from "pg";

import {
  type MarketMapActivitySparklines,
  type MarketMapEventSummary,
  type MarketMapMetricSparkline,
  type MarketMapSparklineMetric,
  type MarketMapSparklinePoint,
} from "./market-map.js";
import { eventVenueKey } from "./market-map-representative.js";

type NormalizedSparklineEvent = {
  eventId: string;
  venue: string;
  tokenYes: string | null;
};

type ActivitySparklineRow = {
  event_id: string;
  venue: string;
  bucket_start: Date | string;
  volume_value: string | number | null;
  liquidity_value: string | number | null;
};

type MovementSparklineRow = {
  event_id: string;
  venue: string;
  bucket_start: Date | string;
  movement_value: string | number | null;
};

export type MarketMapSparklineOptions = {
  includeVolume: boolean;
  includeLiquidity: boolean;
  includeMovement: boolean;
  windowHours: number;
  bucketHours?: number | null;
  asOf?: Date;
};

type ResolvedSparklineWindow = {
  windowHours: number;
  bucketHours: number;
  asOf: Date;
  start: Date;
  end: Date;
  bucketStarts: string[];
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export function resolveMarketMapSparklineBucketHours(
  windowHours: number,
  requestedBucketHours?: number | null,
): number {
  const normalizedWindow = Math.max(1, Math.trunc(windowHours));
  if (requestedBucketHours != null) {
    const normalizedBucket = Math.max(1, Math.trunc(requestedBucketHours));
    return Math.min(normalizedWindow, normalizedBucket);
  }
  if (normalizedWindow <= 24) return 1;
  if (normalizedWindow <= 48) return 2;
  if (normalizedWindow <= 96) return 4;
  if (normalizedWindow <= 168) return 6;
  return 24;
}

function resolveSparklineWindow(
  input: Pick<
    MarketMapSparklineOptions,
    "windowHours" | "bucketHours" | "asOf"
  >,
): ResolvedSparklineWindow {
  const windowHours = Math.max(1, Math.trunc(input.windowHours));
  const bucketHours = resolveMarketMapSparklineBucketHours(
    windowHours,
    input.bucketHours,
  );
  const asOf = input.asOf ?? new Date();
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const endMs = Math.floor(asOf.getTime() / bucketMs) * bucketMs;
  const rawStartMs = asOf.getTime() - windowHours * 60 * 60 * 1000;
  const startMs = Math.floor(rawStartMs / bucketMs) * bucketMs;
  const bucketStarts: string[] = [];
  for (
    let bucketStartMs = startMs;
    bucketStartMs <= endMs;
    bucketStartMs += bucketMs
  ) {
    bucketStarts.push(new Date(bucketStartMs).toISOString());
  }
  return {
    windowHours,
    bucketHours,
    asOf,
    start: new Date(startMs),
    end: new Date(endMs),
    bucketStarts,
  };
}

function buildMetricSparkline(
  metric: MarketMapSparklineMetric,
  window: ResolvedSparklineWindow,
  valuesByBucket: ReadonlyMap<string, number | null>,
): MarketMapMetricSparkline {
  let previousValue: number | null = null;
  const points: MarketMapSparklinePoint[] = window.bucketStarts.map(
    (bucketStart) => {
      const value = valuesByBucket.has(bucketStart)
        ? (valuesByBucket.get(bucketStart) ?? null)
        : null;
      const delta =
        value != null && previousValue != null ? value - previousValue : null;
      const changePct =
        delta != null && previousValue != null && previousValue !== 0
          ? delta / previousValue
          : null;
      previousValue = value;
      return {
        bucketStart,
        value,
        delta,
        changePct,
      };
    },
  );

  return {
    metric,
    windowHours: window.windowHours,
    bucketHours: window.bucketHours,
    points,
  };
}

function normalizeEvents(
  events: MarketMapEventSummary[],
): NormalizedSparklineEvent[] {
  const byKey = new Map<string, NormalizedSparklineEvent>();
  for (const event of events) {
    const eventId = event.eventId.trim();
    const venue = event.venue.trim().toLowerCase();
    if (!eventId || !venue) continue;
    const key = eventVenueKey(eventId, venue);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      eventId,
      venue,
      tokenYes: event.tokenYes?.trim() || null,
    });
  }
  return [...byKey.values()];
}

function addMetricValues(
  target: Map<string, Map<string, number | null>>,
  key: string,
  bucketStart: Date | string,
  value: string | number | null,
): void {
  const bucketValues = target.get(key) ?? new Map<string, number | null>();
  bucketValues.set(toIsoString(bucketStart), toNumber(value));
  target.set(key, bucketValues);
}

async function loadActivitySparklineValues(
  pool: Pool,
  events: NormalizedSparklineEvent[],
  window: ResolvedSparklineWindow,
): Promise<{
  volumeByEvent: Map<string, Map<string, number | null>>;
  liquidityByEvent: Map<string, Map<string, number | null>>;
}> {
  const volumeByEvent = new Map<string, Map<string, number | null>>();
  const liquidityByEvent = new Map<string, Map<string, number | null>>();
  if (events.length === 0) return { volumeByEvent, liquidityByEvent };

  const rows = await pool.query<ActivitySparklineRow>(
    `
      with event_set as (
        select *
        from unnest($1::text[], $2::text[]) as es(event_id, venue)
      ),
      market_bucket_rows as (
        select distinct on (
          s.event_id,
          s.venue,
          s.market_id,
          floor(extract(epoch from s.bucket) / ($5::int * 3600))::bigint
        )
          s.event_id,
          s.venue,
          s.market_id,
          floor(extract(epoch from s.bucket) / ($5::int * 3600))::bigint as bucket_index,
          s.bucket,
          s.volume_total,
          s.liquidity
        from unified_market_activity_snapshots_1h s
        join event_set es
          on es.event_id = s.event_id
         and es.venue = s.venue
        where s.bucket >= $3::timestamptz
          and s.bucket <= $4::timestamptz
        order by
          s.event_id,
          s.venue,
          s.market_id,
          bucket_index,
          s.bucket desc
      )
      select
        event_id,
        venue,
        timestamptz 'epoch'
          + (bucket_index * $5::int * 3600) * interval '1 second'
            as bucket_start,
        sum(volume_total)::text as volume_value,
        sum(liquidity)::text as liquidity_value
      from market_bucket_rows
      group by event_id, venue, bucket_index
      order by event_id, venue, bucket_start
    `,
    [
      events.map((event) => event.eventId),
      events.map((event) => event.venue),
      window.start,
      window.end,
      window.bucketHours,
    ],
  );

  for (const row of rows.rows) {
    const key = eventVenueKey(row.event_id, row.venue);
    addMetricValues(volumeByEvent, key, row.bucket_start, row.volume_value);
    addMetricValues(
      liquidityByEvent,
      key,
      row.bucket_start,
      row.liquidity_value,
    );
  }

  return { volumeByEvent, liquidityByEvent };
}

async function loadMovementSparklineValues(
  pool: Pool,
  events: NormalizedSparklineEvent[],
  window: ResolvedSparklineWindow,
): Promise<Map<string, Map<string, number | null>>> {
  const movementByEvent = new Map<string, Map<string, number | null>>();
  const tokenEvents = events.filter((event) => event.tokenYes != null);
  if (tokenEvents.length === 0) return movementByEvent;

  const rows = await pool.query<MovementSparklineRow>(
    `
      with token_set as (
        select *
        from unnest($1::text[], $2::text[], $3::text[]) as ts(event_id, venue, token_id)
      ),
      token_bucket_rows as (
        select distinct on (
          ts.event_id,
          ts.venue,
          floor(extract(epoch from ubh.bucket) / ($6::int * 3600))::bigint
        )
          ts.event_id,
          ts.venue,
          floor(extract(epoch from ubh.bucket) / ($6::int * 3600))::bigint as bucket_index,
          ubh.bucket,
          ubh.avg_mid
        from unified_book_top_1h ubh
        join token_set ts
          on ts.token_id = ubh.token_id
         and ts.venue = ubh.venue
        where ubh.bucket >= $4::timestamptz
          and ubh.bucket <= $5::timestamptz
        order by
          ts.event_id,
          ts.venue,
          bucket_index,
          ubh.bucket desc
      )
      select
        event_id,
        venue,
        timestamptz 'epoch'
          + (bucket_index * $6::int * 3600) * interval '1 second'
            as bucket_start,
        avg_mid::text as movement_value
      from token_bucket_rows
      order by event_id, venue, bucket_start
    `,
    [
      tokenEvents.map((event) => event.eventId),
      tokenEvents.map((event) => event.venue),
      tokenEvents.map((event) => event.tokenYes),
      window.start,
      window.end,
      window.bucketHours,
    ],
  );

  for (const row of rows.rows) {
    const key = eventVenueKey(row.event_id, row.venue);
    addMetricValues(movementByEvent, key, row.bucket_start, row.movement_value);
  }

  return movementByEvent;
}

export async function fetchMarketMapEventSparklines(
  pool: Pool,
  events: MarketMapEventSummary[],
  options: MarketMapSparklineOptions,
): Promise<Map<string, MarketMapActivitySparklines>> {
  const normalizedEvents = normalizeEvents(events);
  const byEvent = new Map<string, MarketMapActivitySparklines>();
  if (
    normalizedEvents.length === 0 ||
    (!options.includeVolume &&
      !options.includeLiquidity &&
      !options.includeMovement)
  ) {
    return byEvent;
  }

  const window = resolveSparklineWindow(options);
  const [{ volumeByEvent, liquidityByEvent }, movementByEvent] =
    await Promise.all([
      options.includeVolume || options.includeLiquidity
        ? loadActivitySparklineValues(pool, normalizedEvents, window)
        : Promise.resolve({
            volumeByEvent: new Map<string, Map<string, number | null>>(),
            liquidityByEvent: new Map<string, Map<string, number | null>>(),
          }),
      options.includeMovement
        ? loadMovementSparklineValues(pool, normalizedEvents, window)
        : Promise.resolve(new Map<string, Map<string, number | null>>()),
    ]);

  for (const event of normalizedEvents) {
    const key = eventVenueKey(event.eventId, event.venue);
    const sparklines: MarketMapActivitySparklines = {};
    if (options.includeVolume) {
      sparklines.volume = buildMetricSparkline(
        "volume",
        window,
        volumeByEvent.get(key) ?? new Map(),
      );
    }
    if (options.includeLiquidity) {
      sparklines.liquidity = buildMetricSparkline(
        "liquidity",
        window,
        liquidityByEvent.get(key) ?? new Map(),
      );
    }
    if (options.includeMovement) {
      sparklines.movement = buildMetricSparkline(
        "movement",
        window,
        movementByEvent.get(key) ?? new Map(),
      );
    }
    byEvent.set(key, sparklines);
  }

  return byEvent;
}
