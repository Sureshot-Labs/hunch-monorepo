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

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Gamma ${r.status}`);
  const j = await r.json();

  const parsed = GammaEventsResponse.parse(j); // schema (value)
  const events: GammaEvent[] = (parsed.events ?? parsed.data)!; // type
  return { events };
}

export async function fetchAllEvents() {
  const out: GammaEvent[] = [];
  let offset = 0;
  const page = 500; // Increased page size for efficiency

  console.log("Fetching all Polymarket events...");
  
  while (true) {
    const { events } = await fetchEventsPage(offset, page);
    console.log(`${events.length} events at offset ${offset}`);
    
    if (!events.length) {
      console.log("No more events found, stopping pagination");
      break;
    }
    
    out.push(...events);
    offset += events.length;
    
    // Small delay to be respectful to the API
    await new Promise((res) => setTimeout(res, 100));
  }
  
  console.log(`Total events fetched: ${out.length}`);
  return out;
}
