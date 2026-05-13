import { sleep } from "@hunch/shared";
import PQueue from "p-queue";

import { env } from "./env.js";
import { log } from "./log.js";
import {
  LimitlessMarket,
  LimitlessOrderbook,
  parseLimitlessActivePayload,
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

function logActivePageParseIssues(
  page: number,
  url: string,
  validMarkets: number,
  invalidMarkets: ReturnType<
    typeof parseLimitlessActivePayload
  >["invalidMarkets"],
) {
  if (invalidMarkets.length === 0) return;

  const totalMarkets = validMarkets + invalidMarkets.length;
  log.warn("Limitless active page skipped malformed markets", {
    page,
    url,
    validMarkets,
    skippedMarkets: invalidMarkets.length,
    totalMarkets,
    samples: invalidMarkets.slice(0, 10),
    omittedSamples: Math.max(0, invalidMarkets.length - 10),
  });

  const malformedShare =
    totalMarkets > 0 ? invalidMarkets.length / totalMarkets : 0;
  if (invalidMarkets.length >= 10 || malformedShare >= 0.2) {
    log.warn("Limitless active page malformed market rate is elevated", {
      page,
      skippedMarkets: invalidMarkets.length,
      totalMarkets,
      malformedShare,
    });
  }
}

async function getJson(url: string) {
  return requestQueue.add(async () => {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        env.limitlessHttpTimeoutMs,
      );
      try {
        const r = await fetch(url, {
          headers: defaultHeaders,
          signal: controller.signal,
        });
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
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          (error.name === "AbortError" ||
            /aborted|timeout/i.test(error.message));
        if (isTimeout && attempt < env.limitlessHttpMaxRetries) {
          const backoff =
            env.limitlessHttpBackoffMs * 2 ** attempt +
            Math.floor(Math.random() * 250);
          attempt += 1;
          if (backoff > 0) await sleep(backoff);
          continue;
        }
        if (isTimeout) {
          throw new Error(
            `Limitless timeout ${env.limitlessHttpTimeoutMs}ms ${url}`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
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
  const j = await getJson(url);
  const parsed = parseLimitlessActivePayload(j);
  logActivePageParseIssues(
    page,
    url,
    parsed.response.data.length,
    parsed.invalidMarkets,
  );

  if (parsed.invalidMarkets.length > 0 && parsed.response.data.length === 0) {
    throw new Error(
      `Limitless active page ${page} returned only malformed markets (${parsed.invalidMarkets.length})`,
    );
  }

  return parsed.response;
}

export async function fetchAllActive(
  maxPages: number,
  pageSize: number,
  options?: {
    onPage?: (info: {
      page: number;
      totalPages: number | null;
      pageMarkets: number;
      fetchedMarkets: number;
    }) => void;
  },
) {
  const out: TLimitlessMarket[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchActivePage(p, pageSize, "newest");
    if (!res.data.length) break;
    out.push(...res.data);
    const totalCount = res.totalMarketsCount;
    const totalPages =
      res.totalPages ??
      (typeof totalCount === "number" && Number.isFinite(totalCount)
        ? Math.ceil(totalCount / pageSize)
        : undefined);
    options?.onPage?.({
      page: p,
      totalPages: totalPages ?? null,
      pageMarkets: res.data.length,
      fetchedMarkets: out.length,
    });
    // cheap throttling
    await sleep(150);
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
