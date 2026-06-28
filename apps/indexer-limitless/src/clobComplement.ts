export type LimitlessClobTokenPair = {
  yesTokenId: string;
  noTokenId: string;
};

export type LimitlessClobTop = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
};

export const DEFAULT_DERIVED_SIBLING_DIRECT_PROTECTION_MS = 60_000;

type DerivedSiblingInput = {
  directTokenId: string;
  pair: LimitlessClobTokenPair;
  bestBid: number | null;
  bestAsk: number | null;
};

type DirectTopTrackerEntry = {
  directUpdatedAtMs: number;
};

let derivedSiblingTopUpdated = 0;
let derivedSiblingTopSkippedRecentDirect = 0;

function normalizeTokenId(value: string): string {
  return value.startsWith("limitless:") ? value : `limitless:${value}`;
}

function normalizePair(pair: LimitlessClobTokenPair): LimitlessClobTokenPair {
  return {
    yesTokenId: normalizeTokenId(pair.yesTokenId),
    noTokenId: normalizeTokenId(pair.noTokenId),
  };
}

function finitePrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function unitPrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

export function isLimitlessTopUsable(
  bestBid: number | null,
  bestAsk: number | null,
): boolean {
  const bid = unitPrice(bestBid);
  const ask = unitPrice(bestAsk);
  if (bid == null && ask == null) return false;
  return bid == null || ask == null || bid <= ask;
}

export function resolveLimitlessClobSiblingToken(
  directTokenId: string,
  pair: LimitlessClobTokenPair,
): string | null {
  const normalizedDirect = normalizeTokenId(directTokenId);
  const normalizedPair = normalizePair(pair);
  if (normalizedDirect === normalizedPair.yesTokenId) {
    return normalizedPair.noTokenId;
  }
  if (normalizedDirect === normalizedPair.noTokenId) {
    return normalizedPair.yesTokenId;
  }
  return null;
}

export function deriveLimitlessClobSiblingTop(
  input: DerivedSiblingInput,
): LimitlessClobTop | null {
  const bestBid = unitPrice(input.bestBid);
  const bestAsk = unitPrice(input.bestAsk);
  if (!isLimitlessTopUsable(bestBid, bestAsk)) return null;

  const siblingTokenId = resolveLimitlessClobSiblingToken(
    input.directTokenId,
    input.pair,
  );
  if (!siblingTokenId) return null;

  const siblingBid = bestAsk != null ? finitePrice(1 - bestAsk) : null;
  const siblingAsk = bestBid != null ? finitePrice(1 - bestBid) : null;
  if (siblingBid == null && siblingAsk == null) return null;
  if (siblingBid != null && siblingAsk != null && siblingBid > siblingAsk) {
    return null;
  }

  return {
    tokenId: siblingTokenId,
    bestBid: siblingBid,
    bestAsk: siblingAsk,
  };
}

export class LimitlessClobDirectTopTracker {
  private readonly directByToken = new Map<string, DirectTopTrackerEntry>();

  markDirectTop(tokenId: string, tsMs: number): void {
    const normalizedTokenId = normalizeTokenId(tokenId);
    const existing = this.directByToken.get(normalizedTokenId);
    if (existing && existing.directUpdatedAtMs > tsMs) return;
    this.directByToken.set(normalizedTokenId, { directUpdatedAtMs: tsMs });
  }

  shouldSkipDerivedTop(
    tokenId: string,
    tsMs: number,
    protectionMs = DEFAULT_DERIVED_SIBLING_DIRECT_PROTECTION_MS,
  ): boolean {
    const normalizedTokenId = normalizeTokenId(tokenId);
    const existing = this.directByToken.get(normalizedTokenId);
    if (!existing) return false;
    return tsMs - existing.directUpdatedAtMs >= 0
      ? tsMs - existing.directUpdatedAtMs < protectionMs
      : true;
  }

  clear(): void {
    this.directByToken.clear();
  }
}

export const limitlessClobDirectTopTracker =
  new LimitlessClobDirectTopTracker();

export function recordLimitlessClobDerivedSiblingTopUpdated(): void {
  derivedSiblingTopUpdated += 1;
}

export function recordLimitlessClobDerivedSiblingTopSkippedRecentDirect(): void {
  derivedSiblingTopSkippedRecentDirect += 1;
}

export function getLimitlessClobComplementStats(): {
  derivedSiblingTopUpdated: number;
  derivedSiblingTopSkippedRecentDirect: number;
} {
  return {
    derivedSiblingTopUpdated,
    derivedSiblingTopSkippedRecentDirect,
  };
}

export function diffLimitlessClobComplementStats(
  before: ReturnType<typeof getLimitlessClobComplementStats>,
): ReturnType<typeof getLimitlessClobComplementStats> {
  const after = getLimitlessClobComplementStats();
  return {
    derivedSiblingTopUpdated:
      after.derivedSiblingTopUpdated - before.derivedSiblingTopUpdated,
    derivedSiblingTopSkippedRecentDirect:
      after.derivedSiblingTopSkippedRecentDirect -
      before.derivedSiblingTopSkippedRecentDirect,
  };
}
