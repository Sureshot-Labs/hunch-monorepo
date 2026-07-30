export function isCanonicalUnifiedMarketId(
  venueId: string,
  marketId: string,
): boolean {
  return marketId.startsWith(`${venueId}:`);
}

export function isVenueLocalMarketContextId(
  venueId: string,
  marketContextId: string,
): boolean {
  return (
    marketContextId.length > 0 && !marketContextId.startsWith(`${venueId}:`)
  );
}

export function assertVenueLocalMarketContextId(
  venueId: string,
  marketContextId: string,
): void {
  if (!isVenueLocalMarketContextId(venueId, marketContextId)) {
    throw new Error(
      "funding trade marketContextId must be a venue-local outcome identifier",
    );
  }
}
