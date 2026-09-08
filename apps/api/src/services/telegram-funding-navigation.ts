const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const legacyUuid = new RegExp(`^${UUID}$`, "i");
const marketDeposit = new RegExp(
  `^deposit:(polymarket|limitless):(~[a-z0-9_-]+|${UUID})(?::([yn]))?$`,
  "i",
);

/** Unified IDs are venue-prefixed, not necessarily UUIDs. */
export function isTelegramFundingNavigationMarketId(value: string): boolean {
  return (
    value.length <= 180 &&
    (legacyUuid.test(value) ||
      /^(polymarket|limitless):[a-zA-Z0-9_-]+$/.test(value))
  );
}

/** Public market navigation only; never an authorization or a Buy intent. */
export function parseTelegramMarketDeposit(route: string) {
  const match = marketDeposit.exec(route);
  const venue = match?.[1]?.toLowerCase();
  const reference = match?.[2];
  if (!reference || (venue !== "polymarket" && venue !== "limitless"))
    return null;
  const marketId = reference.startsWith("~")
    ? `${venue}:${reference.slice(1)}`
    : reference.toLowerCase();
  if (!isTelegramFundingNavigationMarketId(marketId)) return null;
  return {
    venue,
    navigationMarketId: marketId,
    navigationSide:
      match?.[3]?.toLowerCase() === "n" ? ("NO" as const) : ("YES" as const),
  };
}

export function telegramMarketDepositCallback(input: {
  venue: string;
  marketId: string;
  side?: "YES" | "NO" | null;
}): string {
  // Strip the repeated venue prefix to fit Telegram's 64-byte callback limit,
  // including Limitless IDs whose venue-local reference is a UUID.
  const reference = input.marketId.startsWith(`${input.venue}:`)
    ? `~${input.marketId.slice(input.venue.length + 1)}`
    : input.marketId;
  const base = `deposit:${input.venue}:${reference}:${input.side === "NO" ? "n" : "y"}`;
  return parseTelegramMarketDeposit(base) && `hm:v1:${base}`.length <= 64
    ? `hm:v1:${base}`
    : `hm:v1:deposit:${input.venue}`;
}
