import { env } from "./env";
import { GammaEventsResponse } from "./types";
import type { TEvent as GammaEvent } from "./types"; // <-- this is the type

export async function fetchEventsPage(offset: number, limit: number) {
  const url = new URL(`${env.gammaBase}/events/pagination`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("active", "true");
  url.searchParams.set("archived", "false");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("offset", String(offset));

  console.log("Fetching events page", url.toString());
  const r = await fetch(url, { headers: { accept: "application/json" } });
  console.log("Response", r.status, r.statusText);
  if (!r.ok) throw new Error(`Gamma ${r.status}`);
  const j = await r.json();

  const parsed = GammaEventsResponse.parse(j); // schema (value)
  const events: GammaEvent[] = (parsed.events ?? parsed.data)!; // type
  return { events };
}

export async function fetchAllEvents(max: number) {
  const out: GammaEvent[] = [];
  let offset = 0;
  const page = 50;

  while (out.length < max) {
    const { events } = await fetchEventsPage(offset, page);
    console.log(events.length, "events at offset", offset);
    if (!events.length) break;
    out.push(...events);
    offset += events.length;
    await new Promise((res) => setTimeout(res, 150));
  }
  return out.slice(0, max);
}
