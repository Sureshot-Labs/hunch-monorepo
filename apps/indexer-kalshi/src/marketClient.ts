// apps/indexer-kalshi/src/marketsClient.ts
import { KalshiClient } from "./kalshiClient.js";
import type { z } from "zod";
import { KalshiEvent, KalshiEventsPage } from "./types.js";

const c = new KalshiClient();
type KalshiEventType = z.infer<typeof KalshiEvent>;

// Stream events with nested markets page-by-page to avoid loading everything into memory
// If status is provided, fetches only that status; otherwise fetches all statuses
export async function* iterateEventsWithMarkets(
  status?: "open" | "closed" | "settled",
) {
  let cursor: string | null = null;
  let page = 0;

  const statusLabel = status || "all";
  console.log(`[Kalshi] Starting to fetch ${statusLabel} events...`);

  while (true) {
    page++;
    const params: Record<string, string | number> = {
      with_nested_markets: "true",
      limit: 200,
      ...(cursor ? { cursor } : {}),
    };
    // Only include status parameter if explicitly provided
    if (status) {
      params.status = status;
    }

    const j = await c.get("/trade-api/v2/events", params);
    const parsed = KalshiEventsPage.parse(j);
    yield parsed.events; // ✅ yield one page

    cursor = parsed.cursor ?? null;
    if (!cursor || parsed.events.length === 0) break;
  }

  console.log(
    `[Kalshi] Fetch complete: ${page} pages for ${statusLabel} events`,
  );
}

// Keep for backward compatibility if needed elsewhere
export async function fetchAllEventsWithNestedMarkets(
  status?: "open" | "closed" | "settled",
) {
  const out: KalshiEventType[] = [];
  for await (const events of iterateEventsWithMarkets(status)) {
    out.push(...events);
  }
  return out;
}
