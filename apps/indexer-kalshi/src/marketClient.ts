// apps/indexer-kalshi/src/marketsClient.ts
import { KalshiClient } from "./kalshiClient";
import { KalshiEventsPage, KalshiMarketsPage } from "./types";

const c = new KalshiClient();

// Stream events with nested markets page-by-page to avoid loading everything into memory
export async function* iterateEventsWithMarkets(
  status: "open" | "closed" | "settled" = "open"
) {
  let cursor: string | null = null;
  let page = 0;
  
  console.log(`[Kalshi] Starting to fetch ${status} events...`);
  
  while (true) {
    page++;
    const j = await c.get("/trade-api/v2/events", {
      with_nested_markets: "true",
      status,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const parsed = KalshiEventsPage.parse(j);
    yield parsed.events; // ✅ yield one page
    
    cursor = parsed.cursor ?? null;
    if (!cursor || parsed.events.length === 0) break;
  }
  
  console.log(`[Kalshi] Fetch complete: ${page} pages`);
}

// Keep for backward compatibility if needed elsewhere
export async function fetchAllEventsWithNestedMarkets(
  status: "open" | "closed" | "settled" = "open"
) {
  const out: any[] = [];
  for await (const events of iterateEventsWithMarkets(status)) {
    out.push(...events);
  }
  return out;
}

