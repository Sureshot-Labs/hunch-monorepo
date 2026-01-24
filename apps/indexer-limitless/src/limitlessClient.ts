import { sleep } from "@hunch/shared";
import PQueue from "p-queue";

import { env } from "./env.js";
import {
  LimitlessActiveResponse,
  LimitlessMarket,
  LimitlessOrderbook,
  TLimitlessMarket,
} from "./types.js";
const defaultHeaders = {
  accept: "application/json",
  "X-API-Version": "v1",
  "user-agent": "hunch-indexer/limitless",
};

const requestQueue = new PQueue({
  concurrency: 1,
  interval: env.limitlessHttpMinDelayMs,
  intervalCap: 1,
});

function shouldRetry(status: number) {
  return status === 429 || status === 403 || status === 503;
}

async function getJson(url: string) {
  return requestQueue.add(async () => {
    let attempt = 0;
    while (true) {
      const r = await fetch(url, { headers: defaultHeaders });
      if (r.ok) {
        return r.json();
      }

      const body = await r.text().catch(() => "");
      const snippet = body.trim();
      const details =
        snippet.length > 0
          ? `: ${snippet.slice(0, 800)}${snippet.length > 800 ? "…" : ""}`
          : "";
      const message = `Limitless ${r.status} ${url}${details}`;

      if (shouldRetry(r.status) && attempt < env.limitlessHttpMaxRetries) {
        const backoff =
          env.limitlessHttpBackoffMs * 2 ** attempt +
          Math.floor(Math.random() * 250);
        attempt += 1;
        if (backoff > 0) await sleep(backoff);
        continue;
      }

      throw new Error(message);
    }
  });
}

export async function fetchActivePage(
  page: number,
  limit: number,
  sortBy = "newest",
) {
  const base = env.limitlessBase.replace(/\/+$/, "");
  const url = `${base}/markets/active?page=${page}&limit=${limit}&sortBy=${encodeURIComponent(
    sortBy,
  )}`;
  console.log("Fetching Limitless active page", page, limit, sortBy, url);
  const j = await getJson(url);
  const parsed = LimitlessActiveResponse.parse(j);
  return parsed;
}

export async function fetchAllActive(maxPages: number, pageSize: number) {
  const out: TLimitlessMarket[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchActivePage(p, pageSize, "newest");
    if (!res.data.length) break;
    out.push(...res.data);
    // cheap throttling
    await sleep(150);
    const totalCount = res.totalMarketsCount;
    const totalPages =
      res.totalPages ??
      (typeof totalCount === "number" && Number.isFinite(totalCount)
        ? Math.ceil(totalCount / pageSize)
        : undefined);
    if (totalPages && p >= totalPages) break;
  }
  return out;
}

export async function fetchMarket(slugOrAddress: string) {
  const base = env.limitlessBase.replace(/\/+$/, "");
  const safe = encodeURIComponent(slugOrAddress);
  const url = `${base}/markets/${safe}`;
  const j = await getJson(url);
  return LimitlessMarket.parse(j);
}

export async function fetchOrderbook(slug: string) {
  const base = env.limitlessBase.replace(/\/+$/, "");
  const safe = encodeURIComponent(slug);
  const url = `${base}/markets/${safe}/orderbook`;
  const j = await getJson(url);
  return LimitlessOrderbook.parse(j);
}
