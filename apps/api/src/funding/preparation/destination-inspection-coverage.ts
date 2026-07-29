export type DestinationInspectionOutcome<T> = Readonly<{
  venueId: string;
  internalWallet: boolean;
  outcome: PromiseSettledResult<T>;
}>;

export type DestinationInspectionCoverage<T> = Readonly<{
  values: readonly T[];
  incompleteVenueIds: readonly string[];
}>;

export function supportsDestinationMarketClass(
  supportedMarketClasses: readonly string[],
  requestedMarketClass: string | null,
): boolean {
  return (
    requestedMarketClass == null ||
    supportedMarketClasses.includes(requestedMarketClass)
  );
}

export function isDestinationDriverApplicable(input: {
  driverVenueId: string;
  supportedMarketClasses: readonly string[];
  requestedMarketClass: string | null;
  targetVenueId: string | null;
}): boolean {
  return (
    (input.targetVenueId == null ||
      input.driverVenueId === input.targetVenueId) &&
    supportsDestinationMarketClass(
      input.supportedMarketClasses,
      input.requestedMarketClass,
    )
  );
}

/**
 * A venue snapshot is complete when at least one relevant wallet inspection
 * succeeds. Internal wallets take precedence because those are the
 * destinations exposed by Hunch's venue-first funding UI.
 */
export function collectDestinationInspectionCoverage<T>(
  outcomes: readonly DestinationInspectionOutcome<T>[],
): DestinationInspectionCoverage<T> {
  const byVenue = new Map<string, DestinationInspectionOutcome<T>[]>();
  for (const outcome of outcomes) {
    const venueOutcomes = byVenue.get(outcome.venueId) ?? [];
    venueOutcomes.push(outcome);
    byVenue.set(outcome.venueId, venueOutcomes);
  }

  const incompleteVenueIds: string[] = [];
  for (const [venueId, venueOutcomes] of byVenue) {
    const internalOutcomes = venueOutcomes.filter(
      (outcome) => outcome.internalWallet,
    );
    const requiredOutcomes =
      internalOutcomes.length > 0 ? internalOutcomes : venueOutcomes;
    if (
      requiredOutcomes.every((outcome) => outcome.outcome.status === "rejected")
    ) {
      incompleteVenueIds.push(venueId);
    }
  }

  return {
    values: outcomes.flatMap((outcome) =>
      outcome.outcome.status === "fulfilled" ? [outcome.outcome.value] : [],
    ),
    incompleteVenueIds: incompleteVenueIds.sort(),
  };
}
