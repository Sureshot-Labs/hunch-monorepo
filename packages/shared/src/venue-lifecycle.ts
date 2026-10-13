import { z } from "zod";

export const HUNCH_VENUES = [
  "polymarket",
  "limitless",
  "kalshi",
  "hyperliquid",
] as const;

export type HunchVenue = (typeof HUNCH_VENUES)[number];
export type VenueLifecycleMode = "active" | "exit-only" | "unreleased";
export type VenueIndexerMode = "full" | "maintenance" | "off";

export const venueLifecycleCapabilitiesSchema = z.object({
  accountRead: z.boolean(),
  automation: z.boolean(),
  cancel: z.boolean(),
  discovery: z.boolean(),
  fundMaintenance: z.boolean(),
  fundTrading: z.boolean(),
  increaseExposure: z.boolean(),
  reconciliation: z.boolean(),
  redeem: z.boolean(),
  reduceExposure: z.boolean(),
  signalDelivery: z.boolean(),
  signalSource: z.boolean(),
  walletAccess: z.boolean(),
  walletWithdrawal: z.boolean(),
});
export type VenueLifecycleCapabilities = z.infer<
  typeof venueLifecycleCapabilitiesSchema
>;
export type VenueLifecycleCapability = keyof VenueLifecycleCapabilities;

export type VenueLifecyclePolicyEntry = {
  lifecycle: VenueLifecycleMode;
  indexerMode: VenueIndexerMode;
};

export type VenueLifecyclePolicy = {
  version: 1;
  venues: Record<HunchVenue, VenueLifecyclePolicyEntry>;
};

const venueLifecycleModeSchema = z.enum(["active", "exit-only", "unreleased"]);
const venueIndexerModeSchema = z.enum(["full", "maintenance", "off"]);
const venueLifecycleEntrySchema = z
  .object({
    lifecycle: venueLifecycleModeSchema,
    indexerMode: venueIndexerModeSchema,
  })
  .strict();

export const venueLifecyclePolicySchema = z
  .object({
    version: z.literal(1),
    venues: z
      .object({
        polymarket: venueLifecycleEntrySchema,
        limitless: venueLifecycleEntrySchema,
        kalshi: venueLifecycleEntrySchema,
        hyperliquid: venueLifecycleEntrySchema,
      })
      .strict(),
  })
  .strict();

export const DEFAULT_VENUE_LIFECYCLE_POLICY: VenueLifecyclePolicy = {
  version: 1,
  venues: {
    polymarket: { lifecycle: "active", indexerMode: "full" },
    limitless: { lifecycle: "active", indexerMode: "full" },
    kalshi: { lifecycle: "exit-only", indexerMode: "maintenance" },
    hyperliquid: { lifecycle: "unreleased", indexerMode: "off" },
  },
};

const CAPABILITIES_BY_LIFECYCLE: Record<
  VenueLifecycleMode,
  VenueLifecycleCapabilities
> = {
  active: {
    accountRead: true,
    automation: true,
    cancel: true,
    discovery: true,
    fundMaintenance: true,
    fundTrading: true,
    increaseExposure: true,
    reconciliation: true,
    redeem: true,
    reduceExposure: true,
    signalDelivery: true,
    signalSource: true,
    walletAccess: true,
    walletWithdrawal: true,
  },
  "exit-only": {
    accountRead: true,
    automation: false,
    cancel: true,
    discovery: false,
    fundMaintenance: true,
    fundTrading: false,
    increaseExposure: false,
    reconciliation: true,
    redeem: true,
    reduceExposure: true,
    signalDelivery: false,
    signalSource: false,
    walletAccess: true,
    walletWithdrawal: true,
  },
  unreleased: {
    accountRead: false,
    automation: false,
    cancel: false,
    discovery: false,
    fundMaintenance: false,
    fundTrading: false,
    increaseExposure: false,
    reconciliation: false,
    redeem: false,
    reduceExposure: false,
    signalDelivery: false,
    signalSource: false,
    walletAccess: false,
    walletWithdrawal: false,
  },
};

export function normalizeHunchVenue(value: unknown): HunchVenue | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "dflow") return "kalshi";
  return HUNCH_VENUES.includes(normalized as HunchVenue)
    ? (normalized as HunchVenue)
    : null;
}

export function parseVenueLifecyclePolicy(
  payload: unknown,
): VenueLifecyclePolicy | null {
  const parsed = venueLifecyclePolicySchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function getVenueLifecycleCapabilities(
  policy: VenueLifecyclePolicy,
  venue: unknown,
): VenueLifecycleCapabilities | null {
  const normalized = normalizeHunchVenue(venue);
  if (!normalized) return null;
  const capabilities =
    CAPABILITIES_BY_LIFECYCLE[policy.venues[normalized].lifecycle];
  // Lifecycle activation enables the implemented read surfaces. Financial and
  // signal integrations are not implemented yet; an admin policy toggle cannot
  // grant those capabilities ahead of their execution/accounting contracts.
  // Automation remains unsupported even after future interactive trading.
  return normalized === "hyperliquid"
    ? {
        ...capabilities,
        automation: false,
        increaseExposure: false,
        reduceExposure: false,
        cancel: false,
        redeem: false,
        signalDelivery: false,
        signalSource: false,
        fundMaintenance: false,
        fundTrading: false,
        walletWithdrawal: false,
      }
    : capabilities;
}

// Admin draft previews and public capability DTOs use the same implementation
// ceiling as request authorization, not a second client-owned lifecycle table.
export function getVenueLifecycleCapabilityMatrix() {
  return Object.fromEntries(
    HUNCH_VENUES.map((venue) => [
      venue,
      Object.fromEntries(
        (["active", "exit-only", "unreleased"] as const).map((lifecycle) => [
          lifecycle,
          getVenueLifecycleCapabilities(
            {
              ...DEFAULT_VENUE_LIFECYCLE_POLICY,
              venues: {
                ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
                [venue]: { lifecycle, indexerMode: "off" },
              },
            },
            venue,
          )!,
        ]),
      ),
    ]),
  ) as Record<
    HunchVenue,
    Record<VenueLifecycleMode, VenueLifecycleCapabilities>
  >;
}

export function venueHasLifecycleCapability(
  policy: VenueLifecyclePolicy,
  venue: unknown,
  capability: VenueLifecycleCapability,
): boolean {
  return getVenueLifecycleCapabilities(policy, venue)?.[capability] === true;
}

export function venueHasIndexerMode(
  policy: VenueLifecyclePolicy,
  venue: unknown,
  mode: VenueIndexerMode,
): boolean {
  const normalized = normalizeHunchVenue(venue);
  return normalized != null && policy.venues[normalized].indexerMode === mode;
}

export function filterVenuesByIndexerMode(
  policy: VenueLifecyclePolicy,
  venues: readonly unknown[],
  mode: VenueIndexerMode,
): HunchVenue[] {
  const seen = new Set<HunchVenue>();
  const filtered: HunchVenue[] = [];
  for (const value of venues) {
    const venue = normalizeHunchVenue(value);
    if (
      !venue ||
      seen.has(venue) ||
      !venueHasIndexerMode(policy, venue, mode)
    ) {
      continue;
    }
    seen.add(venue);
    filtered.push(venue);
  }
  return filtered;
}

export function filterVenuesByLifecycleCapability(
  policy: VenueLifecyclePolicy,
  venues: readonly unknown[],
  capability: VenueLifecycleCapability,
): HunchVenue[] {
  const seen = new Set<HunchVenue>();
  const filtered: HunchVenue[] = [];
  for (const value of venues) {
    const venue = normalizeHunchVenue(value);
    if (
      !venue ||
      seen.has(venue) ||
      !venueHasLifecycleCapability(policy, venue, capability)
    ) {
      continue;
    }
    seen.add(venue);
    filtered.push(venue);
  }
  return filtered;
}

export function getVenuesWithLifecycleCapability(
  policy: VenueLifecyclePolicy,
  capability: VenueLifecycleCapability,
): HunchVenue[] {
  return filterVenuesByLifecycleCapability(policy, HUNCH_VENUES, capability);
}

export function buildVenueLifecyclePolicyRevision(
  effectiveAt: Date | string | null | undefined,
): string {
  if (!effectiveAt) return "defaults-v1";
  const date =
    effectiveAt instanceof Date ? effectiveAt : new Date(effectiveAt);
  return Number.isNaN(date.getTime())
    ? "defaults-v1"
    : `db-${date.toISOString()}`;
}
