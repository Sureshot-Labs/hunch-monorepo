import {
  sleep,
  fetchGammaJson,
  fetchGammaEntityById,
  gammaUrl,
  gammaPageSize,
  isTransientGammaError,
  type GammaVersion,
} from "@hunch/shared";
import { env } from "./env.js";
import { GammaEvent } from "./types.js";
import type { TEvent as GammaEventType } from "./types.js";
import { z } from "zod";

// Validate the page envelope/identity here, not all nested markets at once.
// processEvents validates each row and durably queues malformed IDs before
// the page checkpoint advances. Keep every row for correct offset accounting.
const GammaPageEventSchema = z.object({ id: z.string().min(1) }).passthrough();
export type GammaPageEvent = z.infer<typeof GammaPageEventSchema>;
const GammaEventsListResponse = z.array(GammaPageEventSchema);
const GammaEventsPageResponse = z
  .object({
    events: GammaEventsListResponse.optional(),
    data: GammaEventsListResponse.optional(),
  })
  .refine((value) => Array.isArray(value.events) || Array.isArray(value.data));

export { GammaHttpError } from "@hunch/shared";

function requestOptions() {
  return {
    baseUrl: env.gammaBase,
    attempts: env.gammaRetryAttempts,
    retryBaseMs: env.gammaRetryBaseMs,
  };
}

export type GammaEventsQuery = {
  version: GammaVersion;
  offset: number;
  limit: number;
  order?: string;
  ascending?: boolean;
  id?: number[];
  active?: boolean;
  archived?: boolean;
  closed?: boolean;
  tag_id?: number;
  exclude_tag_id?: number[];
  tag_slug?: string;
  related_tags?: boolean;
  start_date_min?: string;
  start_date_max?: string;
  end_date_min?: string;
  end_date_max?: string;
};

export type GammaEventsByIdsResult = {
  events: GammaEventType[];
  failedIds: string[];
  missingIds: string[];
};

function setOptionalBool(
  sp: URLSearchParams,
  k: string,
  v: boolean | undefined,
): void {
  if (v == null) return;
  sp.set(k, v ? "true" : "false");
}

function setOptionalNumber(
  sp: URLSearchParams,
  k: string,
  v: number | undefined,
): void {
  if (v == null) return;
  sp.set(k, String(v));
}

function setOptionalArrayParam(
  sp: URLSearchParams,
  k: string,
  v: number[] | undefined,
): void {
  if (!v || v.length === 0) return;
  for (const item of v) {
    sp.append(k, String(item));
  }
}

function setOptionalString(
  sp: URLSearchParams,
  k: string,
  v: string | undefined,
): void {
  if (!v) return;
  sp.set(k, v);
}

export async function fetchEventsPage(q: GammaEventsQuery) {
  const url = gammaUrl(requestOptions(), "events");
  url.searchParams.set("version", q.version);
  url.searchParams.set("limit", String(gammaPageSize(q.limit)));
  url.searchParams.set("offset", String(q.offset));
  setOptionalString(url.searchParams, "order", q.order);
  setOptionalBool(url.searchParams, "ascending", q.ascending);
  setOptionalArrayParam(url.searchParams, "id", q.id);
  setOptionalBool(url.searchParams, "active", q.active);
  setOptionalBool(url.searchParams, "archived", q.archived);
  setOptionalBool(url.searchParams, "closed", q.closed);
  setOptionalNumber(url.searchParams, "tag_id", q.tag_id);
  setOptionalString(url.searchParams, "tag_slug", q.tag_slug);
  setOptionalBool(url.searchParams, "related_tags", q.related_tags);
  if (q.exclude_tag_id?.length) {
    url.searchParams.set("exclude_tag_id", q.exclude_tag_id.join(","));
  }
  setOptionalString(url.searchParams, "start_date_min", q.start_date_min);
  setOptionalString(url.searchParams, "start_date_max", q.start_date_max);
  setOptionalString(url.searchParams, "end_date_min", q.end_date_min);
  setOptionalString(url.searchParams, "end_date_max", q.end_date_max);

  const j = await fetchGammaJson(url, requestOptions());

  let events: GammaPageEvent[];
  if (Array.isArray(j)) {
    events = GammaEventsListResponse.parse(j);
  } else {
    const parsed = GammaEventsPageResponse.parse(j);
    events = parsed.events ?? parsed.data ?? [];
  }
  return { events };
}

export type GammaEventsPage = {
  offset: number;
  events: GammaPageEvent[];
};

export type GammaEventPaginationOptions = {
  label?: string;
  startOffset?: number;
  pageSize?: number;
  maxPages?: number; // 0 = unlimited
  maxOffset?: number;
} & Omit<GammaEventsQuery, "offset" | "limit">;

// Streaming generator: yields events page-by-page to avoid loading everything into memory
export async function* iterateEventPages(
  opts: GammaEventPaginationOptions,
): AsyncGenerator<GammaEventsPage> {
  let offset = opts.startOffset ?? 0;
  const pageSize = gammaPageSize(opts.pageSize ?? env.pageSize);
  const maxPages = opts.maxPages ?? 0;
  const maxOffset = opts.maxOffset;

  const {
    label,
    startOffset: _startOffset,
    pageSize: _pageSize,
    maxPages: _maxPages,
    maxOffset: _maxOffset,
    ...query
  } = opts;

  console.log(
    `Fetching Polymarket Gamma events${label ? ` [${label}]` : ""} (order=${query.order}, ascending=${query.ascending}, closed=${query.closed})`,
  );

  let pages = 0;
  while (true) {
    if (maxPages > 0 && pages >= maxPages) break;
    if (maxOffset != null && offset > maxOffset) {
      console.log(
        `Stopping Polymarket Gamma events${label ? ` [${label}]` : ""}: offset ${offset} exceeds configured maxOffset ${maxOffset}`,
      );
      break;
    }

    const { events } = await fetchEventsPage({
      offset,
      limit: pageSize,
      ...query,
    });
    console.log(
      `Gamma ${query.version}: ${events.length} events at offset ${offset}`,
    );

    if (!events.length) {
      console.log("No more events found, stopping pagination");
      break;
    }

    yield { offset, events };

    offset += events.length;
    pages += 1;

    // Small delay to be respectful to the API
    await sleep(100);
  }
}

export async function* iterateEvents(
  opts: GammaEventPaginationOptions = { version: "v1" },
) {
  for await (const page of iterateEventPages(opts)) yield page.events;
}

// Keep for backward compatibility if needed elsewhere
export async function fetchAllEvents() {
  const out: GammaPageEvent[] = [];
  for await (const events of iterateEvents()) {
    out.push(...events);
  }
  console.log(`Total events fetched: ${out.length}`);
  return out;
}

export async function fetchEventsByIds(
  ids: Array<number | string>,
): Promise<GammaEventType[]> {
  const result = await fetchEventsByIdsDetailed(ids);
  if (result.failedIds.length > 0 && result.events.length === 0) {
    throw new Error(
      `Gamma event fetch failed for ${result.failedIds.length} id(s)`,
    );
  }
  return result.events;
}

async function fetchEventsByIdsChunk(
  ids: number[],
  version: GammaVersion,
): Promise<GammaEventsByIdsResult & { transientIds: string[] }> {
  if (ids.length === 0)
    return { events: [], failedIds: [], missingIds: [], transientIds: [] };

  try {
    const { events } = await fetchEventsPage({
      version,
      offset: 0,
      limit: ids.length,
      id: ids,
    });
    const requested = new Set(ids.map(String));
    const matched: GammaEventType[] = [];
    const invalidIds: string[] = [];
    for (const event of events) {
      if (!requested.has(event.id)) continue;
      const parsed = GammaEvent.safeParse(event);
      if (parsed.success) matched.push(parsed.data);
      else invalidIds.push(event.id);
    }
    const found = new Set(matched.map((event) => String(event.id)));
    return {
      events: matched,
      failedIds: invalidIds,
      missingIds: ids
        .map(String)
        .filter((id) => !found.has(id) && !invalidIds.includes(id)),
      transientIds: [],
    };
  } catch (error) {
    // Splitting a provider outage into singleton requests amplifies downtime.
    // Only isolate bad IDs/schema rows; transient retries were already spent.
    if (ids.length <= 1 || isTransientGammaError(error)) {
      return {
        events: [],
        failedIds: ids.map(String),
        missingIds: [],
        transientIds: isTransientGammaError(error) ? ids.map(String) : [],
      };
    }

    const splitAt = Math.ceil(ids.length / 2);
    const left = await fetchEventsByIdsChunk(ids.slice(0, splitAt), version);
    const right = await fetchEventsByIdsChunk(ids.slice(splitAt), version);
    return {
      events: [...left.events, ...right.events],
      failedIds: [...left.failedIds, ...right.failedIds],
      missingIds: [...left.missingIds, ...right.missingIds],
      transientIds: [...left.transientIds, ...right.transientIds],
    };
  }
}

export async function fetchEventsByIdsDetailed(
  ids: Array<number | string>,
): Promise<GammaEventsByIdsResult> {
  const cleaned = [
    ...new Set(
      ids
        .map((id) => Number(String(id).trim()))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
  if (cleaned.length === 0)
    return { events: [], failedIds: [], missingIds: [] };

  const eventsById = new Map<string, GammaEventType>();
  const failedIds: string[] = [];
  const missingIds: string[] = [];
  const chunkSize = gammaPageSize(env.pageSize);

  for (let i = 0; i < cleaned.length; i += chunkSize) {
    const chunk = cleaned.slice(i, i + chunkSize);
    const failures = new Map<string, number>();
    for (const version of ["v1", "v2"] as const) {
      const remaining = chunk.filter((id) => !eventsById.has(String(id)));
      const result = await fetchEventsByIdsChunk(remaining, version);
      for (const event of result.events)
        eventsById.set(String(event.id), event);
      for (const id of result.transientIds)
        failures.set(id, (failures.get(id) ?? 0) + 1);
    }
    // Sequential, at most one direct request (with existing bounded retries)
    // per missing ID. A failed list request is never evidence of deletion.
    let directUnavailable = false;
    for (const id of chunk.map(String).filter((id) => !eventsById.has(id))) {
      if (directUnavailable || failures.get(id) === 2) {
        failedIds.push(id);
        continue;
      }
      try {
        const payload = await fetchGammaEntityById(
          requestOptions(),
          "events",
          id,
          false,
        );
        if (payload) eventsById.set(id, GammaEvent.parse(payload));
        else missingIds.push(id);
      } catch (error) {
        failedIds.push(id);
        directUnavailable = isTransientGammaError(error);
      }
    }
  }
  if (failedIds.length || missingIds.length) {
    console.warn("Gamma event lookup incomplete", {
      requested: cleaned.length,
      found: eventsById.size,
      failedIds,
      missingIds,
    });
  }
  return { events: Array.from(eventsById.values()), failedIds, missingIds };
}

export async function fetchMarketById(
  marketId: string,
): Promise<Record<string, unknown> | null> {
  return fetchGammaEntityById(requestOptions(), "markets", marketId);
}
