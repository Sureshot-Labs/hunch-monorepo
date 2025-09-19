// apps/indexer-kalshi/src/marketsClient.ts
import { KalshiClient } from "./kalshiClient";
import { KalshiEventsPage, KalshiMarketsPage } from "./types";

const c = new KalshiClient();

// NEW: the thing that fixes your undefined eventUuid
export async function fetchAllEventsWithNestedMarkets(
  limitMax: number,
  status: "open" | "closed" | "settled" = "open"
) {
  const out: any[] = [];
  let cursor: string | null = null;
  while (out.length < limitMax) {
    const j = await c.get("/trade-api/v2/events", {
      with_nested_markets: "true",
      status,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const parsed = KalshiEventsPage.parse(j); // markets are parsed via KalshiEvent.markets
    out.push(...parsed.events);
    cursor = parsed.cursor ?? null;
    if (!cursor) break;
  }
  return out.slice(0, limitMax);
}
