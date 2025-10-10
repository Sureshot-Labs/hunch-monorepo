// apps/indexer-kalshi/src/marketsClient.ts
import { KalshiClient } from "./kalshiClient";
import { KalshiEventsPage, KalshiMarketsPage } from "./types";

const c = new KalshiClient();

// Fetch all events with nested markets until no more are available
export async function fetchAllEventsWithNestedMarkets(
  status: "open" | "closed" | "settled" = "open"
) {
  const out: any[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let totalMarkets = 0;
  
  console.log(`[Kalshi] Starting to fetch all ${status} events...`);
  
  while (true) {
    pageCount++;
    const j = await c.get("/trade-api/v2/events", {
      with_nested_markets: "true",
      status,
      limit: 200, // Maximum allowed by Kalshi API (confirmed by testing)
      ...(cursor ? { cursor } : {}),
    });
    const parsed = KalshiEventsPage.parse(j); // markets are parsed via KalshiEvent.markets
    
    const eventsInPage = parsed.events.length;
    const marketsInPage = parsed.events.reduce((sum, event) => sum + (event.markets?.length || 0), 0);
    
    out.push(...parsed.events);
    totalMarkets += marketsInPage;
    
    console.log(`[Kalshi] Page ${pageCount}: ${eventsInPage} events, ${marketsInPage} markets (Total: ${out.length} events, ${totalMarkets} markets)`);
    
    cursor = parsed.cursor ?? null;
    
    // If no cursor or no events returned, we've reached the end
    if (!cursor || parsed.events.length === 0) break;
  }
  
  console.log(`[Kalshi] Fetch complete: ${out.length} events, ${totalMarkets} markets across ${pageCount} pages`);
  return out;
}
