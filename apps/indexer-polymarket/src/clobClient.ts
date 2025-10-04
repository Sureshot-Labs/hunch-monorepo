// clobClient.ts
import { env } from "./env";
import { redis } from "./redis";
import { createExchangeRateLimiters, RateLimitError, parseRetryAfter } from "@hunch/shared";

export type Book = {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  min_order_size?: string;
  neg_risk?: boolean;
  tick_size?: string;
};

const CHUNK = 20; // be nice to the API; docs don't state a limit

let rateLimiters: ReturnType<typeof createExchangeRateLimiters> | null = null;

async function getRateLimiters() {
  if (!rateLimiters) {
    // Redis is already imported and available
    rateLimiters = createExchangeRateLimiters(redis);
  }
  return rateLimiters;
}

function toBookParams(ids: string[]) {
  // normalize, validate
  return ids
    .filter((id) => typeof id === "string" && /^\d+$/.test(id))
    .map((id) => ({ token_id: id }));
}

export async function postBooks(tokenIds: string[]): Promise<Book[]> {
  const out: Book[] = [];
  const ids = tokenIds.slice(); // copy
  const limiters = await getRateLimiters();
  
  while (ids.length) {
    const batch = ids.splice(0, CHUNK);
    
    // Wait for rate limit token
    await limiters.polymarket.waitForTokens(1, 'clob');
    
    const body = JSON.stringify(toBookParams(batch));
    
    try {
      const r = await fetch(`${env.clobBase}/books`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
      
      if (r.status === 429) {
        const retryAfterMs = parseRetryAfter(r.headers.get('Retry-After'));
        throw new RateLimitError(retryAfterMs || 60000, 'polymarket-clob');
      }
      
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`books ${r.status}: ${text}`);
      }
      const j = (await r.json()) as Book[];
      out.push(...j);
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.warn(`Rate limited by Polymarket CLOB. Waiting ${error.retryAfterMs}ms`);
        await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
        // Put batch back and retry
        ids.unshift(...batch);
      } else {
        throw error;
      }
    }
  }
  return out;
}

export async function postBooksOnce(tokenIds: string[]): Promise<Book[]> {
  const body = JSON.stringify(toBookParams(tokenIds));
  const r = await fetch(`${env.clobBase}/books`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`books ${r.status}: ${text}`);
  }
  return (await r.json()) as Book[];
}

export async function getBook(tokenId: string): Promise<Book> {
  const url = new URL(`${env.clobBase}/book`);
  url.searchParams.set("token_id", String(tokenId));
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`book ${r.status}: ${await r.text()}`);
  return (await r.json()) as Book;
}
