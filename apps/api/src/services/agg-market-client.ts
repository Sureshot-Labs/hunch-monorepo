import { isRecord } from "../lib/type-guards.js";

export const AGG_SUPPORTED_VENUES = [
  "polymarket",
  "kalshi",
  "limitless",
] as const;

export type AggSupportedVenue = (typeof AGG_SUPPORTED_VENUES)[number];

export type AggVenueMarketOutcome = {
  id: string | null;
  externalIdentifier: string | null;
  label: string | null;
  price: number | null;
};

export type AggVenueMarket = {
  id: string;
  externalIdentifier: string | null;
  venue: string;
  question: string | null;
  status: string | null;
  volume: number | null;
  venueCount: number | null;
  conditionId: string | null;
  venueEventId: string | null;
  venueMarketOutcomes: AggVenueMarketOutcome[];
  matchedVenueMarkets: AggVenueMarket[];
};

export type AggMidpointOutcome = {
  id: string | null;
  label: string | null;
  midpoint: number | null;
  price: number | null;
  markSource: string | null;
};

export type AggMidpoint = {
  venueMarketId: string;
  venue: string | null;
  midpoint: number | null;
  price: number | null;
  spread: number | null;
  timestamp: string | null;
  markSource: string | null;
  outcomes: AggMidpointOutcome[];
};

export type AggVenueMarketsParams = {
  venue?: string;
  venueEventId?: string;
  search?: string;
  status?: string | string[];
  matchStatus?: string | string[];
  limit?: number;
  cursor?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

export type AggMarketClient = {
  getVenueMarkets(params: AggVenueMarketsParams): Promise<AggVenueMarket[]>;
  getMidpoints(venueMarketIds: string[]): Promise<AggMidpoint[]>;
};

type FetchLike = typeof fetch;

type AggMarketClientConfig = {
  appId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class AggMarketHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message);
    this.name = "AggMarketHttpError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return toStringValue(record[key]);
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  return toNumber(record[key]);
}

function normalizeOutcome(value: unknown): AggVenueMarketOutcome | null {
  if (!isRecord(value)) return null;
  const id = getString(value, "id");
  return {
    id,
    externalIdentifier: getString(value, "externalIdentifier"),
    label: getString(value, "label"),
    price: getNumber(value, "price"),
  };
}

function normalizeVenueMarket(value: unknown): AggVenueMarket | null {
  if (!isRecord(value)) return null;
  const id = getString(value, "id");
  const venue = getString(value, "venue");
  if (!id || !venue) return null;

  const outcomesRaw = Array.isArray(value.venueMarketOutcomes)
    ? value.venueMarketOutcomes
    : [];
  const matchedRaw = Array.isArray(value.matchedVenueMarkets)
    ? value.matchedVenueMarkets
    : [];

  return {
    id,
    externalIdentifier: getString(value, "externalIdentifier"),
    venue,
    question: getString(value, "question") ?? getString(value, "title"),
    status: getString(value, "status"),
    volume: getNumber(value, "volume"),
    venueCount: getNumber(value, "venueCount"),
    conditionId: getString(value, "conditionId"),
    venueEventId: getString(value, "venueEventId"),
    venueMarketOutcomes: outcomesRaw
      .map(normalizeOutcome)
      .filter((row): row is AggVenueMarketOutcome => row != null),
    matchedVenueMarkets: matchedRaw
      .map(normalizeVenueMarket)
      .filter((row): row is AggVenueMarket => row != null),
  };
}

function normalizeMidpointOutcome(value: unknown): AggMidpointOutcome | null {
  if (!isRecord(value)) return null;
  return {
    id: getString(value, "id") ?? getString(value, "venueMarketOutcomeId"),
    label: getString(value, "label"),
    midpoint: getNumber(value, "midpoint"),
    price: getNumber(value, "price"),
    markSource: getString(value, "markSource"),
  };
}

function normalizeMidpoint(value: unknown): AggMidpoint | null {
  if (!isRecord(value)) return null;
  const venueMarketId =
    getString(value, "venueMarketId") ?? getString(value, "id");
  if (!venueMarketId) return null;
  const outcomesRaw = Array.isArray(value.outcomes) ? value.outcomes : [];
  return {
    venueMarketId,
    venue: getString(value, "venue"),
    midpoint: getNumber(value, "midpoint"),
    price: getNumber(value, "price"),
    spread: getNumber(value, "spread"),
    timestamp: getString(value, "timestamp"),
    markSource: getString(value, "markSource"),
    outcomes: outcomesRaw
      .map(normalizeMidpointOutcome)
      .filter((row): row is AggMidpointOutcome => row != null),
  };
}

function appendParam(
  params: URLSearchParams,
  key: string,
  value:
    | string
    | number
    | boolean
    | Array<string | number | boolean>
    | undefined,
) {
  if (value == null) return;
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    params.append(key, String(entry));
  }
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }

  try {
    const text = await res.text();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

export function chunkAggVenueMarketIds(
  ids: string[],
  chunkSize = 200,
): string[][] {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  return chunks;
}

export function createAggMarketClient(
  config: AggMarketClientConfig,
): AggMarketClient {
  const appId = config.appId.trim();
  if (!appId) {
    throw new Error("AGG_APP_ID is required");
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://api.agg.market");
  const timeoutMs = Math.max(1, config.timeoutMs ?? 5_000);
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request(
    path: string,
    params: URLSearchParams,
  ): Promise<unknown> {
    const requestPath = path.startsWith("/") ? path : `/${path}`;
    const url = params.toString()
      ? `${baseUrl}${requestPath}?${params.toString()}`
      : `${baseUrl}${requestPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "Hunch-API/1.0",
          "x-app-id": appId,
        },
        signal: controller.signal,
      });
      const payload = await readJsonOrText(res);
      if (!res.ok) {
        throw new AggMarketHttpError(
          `AGG Market request failed with status ${res.status}`,
          res.status,
          payload,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getVenueMarkets(params) {
      const query = new URLSearchParams();
      appendParam(query, "venue", params.venue);
      appendParam(query, "venueEventId", params.venueEventId);
      appendParam(query, "search", params.search);
      appendParam(query, "status", params.status);
      appendParam(query, "matchStatus", params.matchStatus);
      appendParam(query, "limit", params.limit);
      appendParam(query, "cursor", params.cursor);
      appendParam(query, "sortBy", params.sortBy);
      appendParam(query, "sortDir", params.sortDir);

      const payload = await request("/venue-markets", query);
      const data =
        isRecord(payload) && Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload)
            ? payload
            : [];
      return data
        .map(normalizeVenueMarket)
        .filter((row): row is AggVenueMarket => row != null);
    },

    async getMidpoints(venueMarketIds) {
      const unique = [...new Set(venueMarketIds.filter(Boolean))];
      const rows: AggMidpoint[] = [];
      for (const chunk of chunkAggVenueMarketIds(unique, 200)) {
        const query = new URLSearchParams();
        appendParam(query, "venueMarketIds", chunk);
        const payload = await request("/midpoints", query);
        const data =
          isRecord(payload) && Array.isArray(payload.data)
            ? payload.data
            : Array.isArray(payload)
              ? payload
              : [];
        rows.push(
          ...data
            .map(normalizeMidpoint)
            .filter((row): row is AggMidpoint => row != null),
        );
      }
      return rows;
    },
  };
}
