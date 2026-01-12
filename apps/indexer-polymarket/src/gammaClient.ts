import { env } from "./env.js";
import { GammaEvent, GammaEventsResponse } from "./types.js";
import type { TEvent as GammaEventType } from "./types.js";
import { z } from "zod";

const GammaEventsListResponse = z.array(GammaEvent);

export type GammaEventsQuery = {
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

function resolveEventsUrl(): string {
  const base = env.gammaBase.replace(/\/+$/, "");
  return `${base}/events`;
}

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
  const url = new URL(resolveEventsUrl());
  url.searchParams.set("limit", String(q.limit));
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

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Gamma ${r.status}`);
  const j = await r.json();

  let events: GammaEventType[];
  if (Array.isArray(j)) {
    events = GammaEventsListResponse.parse(j) as GammaEventType[];
  } else {
    const parsed = GammaEventsResponse.parse(j);
    events = (parsed.events ?? parsed.data ?? []) as GammaEventType[];
  }
  return { events };
}

export type GammaEventsPage = {
  offset: number;
  events: GammaEventType[];
};

export type GammaEventPaginationOptions = {
  label?: string;
  startOffset?: number;
  pageSize?: number;
  maxPages?: number; // 0 = unlimited
} & Omit<GammaEventsQuery, "offset" | "limit">;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Streaming generator: yields events page-by-page to avoid loading everything into memory
export async function* iterateEventPages(
  opts: GammaEventPaginationOptions = {},
): AsyncGenerator<GammaEventsPage> {
  let offset = opts.startOffset ?? 0;
  const pageSize = opts.pageSize ?? env.pageSize;
  const maxPages = opts.maxPages ?? 0;

  const {
    label,
    startOffset: _startOffset,
    pageSize: _pageSize,
    maxPages: _maxPages,
    ...query
  } = opts;

  console.log(
    `Fetching Polymarket Gamma events${label ? ` [${label}]` : ""} (order=${query.order}, ascending=${query.ascending}, closed=${query.closed})`,
  );

  let pages = 0;
  while (true) {
    if (maxPages > 0 && pages >= maxPages) break;

    const { events } = await fetchEventsPage({
      offset,
      limit: pageSize,
      ...query,
    });
    console.log(`${events.length} events at offset ${offset}`);

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

export async function* iterateEvents(opts: GammaEventPaginationOptions = {}) {
  for await (const page of iterateEventPages(opts)) yield page.events;
}

// Keep for backward compatibility if needed elsewhere
export async function fetchAllEvents() {
  const out: GammaEventType[] = [];
  for await (const events of iterateEvents()) {
    out.push(...events);
  }
  console.log(`Total events fetched: ${out.length}`);
  return out;
}

export async function fetchEventsByIds(
  ids: Array<number | string>,
): Promise<GammaEventType[]> {
  const cleaned = ids
    .map((id) => Number(String(id).trim()))
    .filter((id) => Number.isFinite(id));
  if (cleaned.length === 0) return [];

  const out: GammaEventType[] = [];
  const chunkSize = Math.min(env.pageSize, 200);

  for (let i = 0; i < cleaned.length; i += chunkSize) {
    const chunk = cleaned.slice(i, i + chunkSize);
    const { events } = await fetchEventsPage({
      offset: 0,
      limit: chunk.length,
      id: chunk,
    });
    out.push(...(events ?? []));
  }

  return out;
}
