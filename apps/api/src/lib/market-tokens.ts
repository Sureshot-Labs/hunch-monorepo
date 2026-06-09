import type { TokenPair } from "../server-types.js";

type ResolveMarketTokenPairInput = {
  venue?: unknown;
  clobTokenIds?: unknown;
  tokenYes?: unknown;
  tokenNo?: unknown;
};

function toTokenString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
}

function parseClobTokenIds(value: unknown): TokenPair {
  if (!value) return { yes: null, no: null };

  let parsed: unknown;
  if (Array.isArray(value)) {
    parsed = value;
  } else {
    try {
      parsed = JSON.parse(String(value));
    } catch {
      return { yes: null, no: null };
    }
  }

  if (!Array.isArray(parsed)) return { yes: null, no: null };
  return {
    yes: toTokenString(parsed[0]),
    no: toTokenString(parsed[1]),
  };
}

export function resolveMarketTokenPair(
  input: ResolveMarketTokenPairInput,
): TokenPair {
  const fallback = {
    yes: toTokenString(input.tokenYes),
    no: toTokenString(input.tokenNo),
  };

  const venue =
    typeof input.venue === "string" ? input.venue.toLowerCase() : null;
  if (venue !== "polymarket") return fallback;

  const clob = parseClobTokenIds(input.clobTokenIds);
  return {
    yes: clob.yes ?? fallback.yes,
    no: clob.no ?? fallback.no,
  };
}
