export function canonicalMarketUpdatedAt(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function matchesCanonicalMarketIdentity(
  intent: Readonly<{ venueId: string; marketId: string }>,
  market: Readonly<{ id: string; venue: string }>,
): boolean {
  return intent.venueId === market.venue && intent.marketId === market.id;
}
