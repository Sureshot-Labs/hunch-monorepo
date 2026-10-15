import { readPolymarketIndexedAssets } from "./polymarket-protocol.js";

// Gamma transport/lifecycle only. No service env, DB or API imports: also used
// by the indexer and maintenance sidecars.
export type GammaVersion = "v1" | "v2";
export const GAMMA_MAX_PAGE_SIZE = 100;
export function gammaPageSize(value = GAMMA_MAX_PAGE_SIZE): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(GAMMA_MAX_PAGE_SIZE, Math.trunc(value)))
    : GAMMA_MAX_PAGE_SIZE;
}

export type GammaRequestOptions = {
  baseUrl: string;
  timeoutMs?: number;
  attempts?: number;
  retryBaseMs?: number;
};

export class GammaHttpError extends Error {
  readonly bodySnippet: string;
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    const snippet = body.trim().slice(0, 1000);
    super(`Gamma ${status} ${url}${snippet ? `: ${snippet}` : ""}`);
    this.name = "GammaHttpError";
    this.bodySnippet = snippet;
  }
}

export function gammaUrl(options: GammaRequestOptions, path: string): URL {
  return new URL(`${options.baseUrl.replace(/\/+$/, "")}/${path}`);
}

export function isTransientGammaError(error: unknown): boolean {
  return error instanceof GammaHttpError
    ? error.status === 429 || error.status >= 500
    : error instanceof TypeError ||
        (error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name));
}

export async function fetchGammaJson(
  url: URL,
  options: GammaRequestOptions,
): Promise<unknown> {
  const attempts = Math.max(1, options.attempts ?? 1);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (!response.ok) {
        throw new GammaHttpError(
          response.status,
          String(url),
          await response.text(),
        );
      }
      return await response.json();
    } catch (error) {
      if (!isTransientGammaError(error) || attempt >= attempts) throw error;
      const delay = (options.retryBaseMs ?? 250) * attempt;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// null means confirmed absence, NOT an HTTP/parse failure. Never accept an
// unrelated first result from a list endpoint as the requested contract.
export async function fetchGammaEntityById(
  options: GammaRequestOptions,
  entity: "markets" | "events",
  id: string,
  listFallback = true,
): Promise<Record<string, unknown> | null> {
  const urls = [gammaUrl(options, `${entity}/${encodeURIComponent(id)}`)];
  if (listFallback) {
    for (const version of ["v1", "v2"] as const) {
      const url = gammaUrl(options, entity);
      url.search = new URLSearchParams({
        id,
        version,
        limit: "1",
        offset: "0",
      }).toString();
      urls.push(url);
    }
  }
  let failure: unknown;
  for (const url of urls) {
    try {
      const payload = await fetchGammaJson(url, options);
      const rows = Array.isArray(payload)
        ? payload
        : record(payload) && Array.isArray(payload[entity])
          ? (payload[entity] as unknown[])
          : record(payload) && Array.isArray(payload.data)
            ? payload.data
            : record(payload) && payload.id != null
              ? [payload]
              : null;
      if (!rows) throw new Error(`Invalid Gamma ${entity} response for ${id}`);
      const match = rows.find((row) => record(row) && String(row.id) === id);
      if (record(match)) {
        if (
          entity === "markets" &&
          (typeof match.question !== "string" ||
            !match.question.trim() ||
            typeof match.active !== "boolean" ||
            typeof match.closed !== "boolean" ||
            !("outcomes" in match) ||
            (match.version !== "v2" && !("clobTokenIds" in match)) ||
            (match.version === "v2" &&
              (typeof match.resolutionStatus !== "string" ||
                !readPolymarketIndexedAssets(match).protocol)))
        )
          throw new Error(`Incomplete Gamma market response for ${id}`);
        return match;
      }
      if (rows.length) throw new Error(`Gamma ${entity} ID mismatch for ${id}`);
    } catch (error) {
      if (!(error instanceof GammaHttpError && error.status === 404))
        failure = error;
    }
  }
  if (failure) throw failure;
  return null;
}

export type GammaLifecycle = {
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  resolvedOutcome: "YES" | "NO" | null;
  reason: string;
};

export function normalizeGammaLifecycle(
  market: Record<string, unknown>,
): GammaLifecycle {
  const v2 = market.version === "v2";
  const resolved = v2 && market.resolutionStatus === "resolved";
  const status: GammaLifecycle["status"] = resolved
    ? "SETTLED"
    : market.archived === true
      ? "ARCHIVED"
      : market.closed === true ||
          market.active === false ||
          (market.acceptingOrders ?? market.accepting_orders) === false ||
          (v2 && market.resolutionStatus === "inactive")
        ? "CLOSED"
        : "ACTIVE";
  const reason = resolved
    ? "gamma_resolved"
    : market.archived === true
      ? "gamma_archived"
      : market.closed === true
        ? "gamma_closed"
        : market.active === false ||
            (v2 && market.resolutionStatus === "inactive")
          ? "gamma_inactive"
          : status === "CLOSED"
            ? "gamma_not_accepting_orders"
            : "gamma_active";
  let resolvedOutcome: GammaLifecycle["resolvedOutcome"] = null;
  // V1 keeps its existing closed/archived + binary-price inference. V2 requires
  // an explicit resolution, not a near-terminal quote or an inactive book.
  if (
    status !== "ACTIVE" &&
    (resolved || market.version == null || market.version === "v1")
  ) {
    try {
      const raw = market.outcomePrices ?? market.outcome_prices;
      const prices: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(prices) && prices.length === 2) {
        const values = prices.map((price: unknown) =>
          typeof price === "number" ||
          (typeof price === "string" && price.trim() !== "")
            ? Number(price)
            : NaN,
        );
        if (
          values.every(
            (price) => Number.isFinite(price) && price >= 0 && price <= 1,
          )
        ) {
          const [yes = NaN, no = NaN] = values;
          if (yes >= 0.999 && no <= 0.001) resolvedOutcome = "YES";
          if (no >= 0.999 && yes <= 0.001) resolvedOutcome = "NO";
        }
      }
    } catch {
      /* Unknown/partial prices cannot establish a winner. */
    }
  }
  return { status, resolvedOutcome, reason };
}
