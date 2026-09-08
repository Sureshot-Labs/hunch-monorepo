const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const marketDeposit = new RegExp(
  `^deposit:(polymarket|limitless):(${UUID})(?::([yn]))?$`,
  "i",
);

/** Public market navigation only; never an authorization or a Buy intent. */
export function parseTelegramMarketDeposit(route: string) {
  const match = marketDeposit.exec(route);
  const venue = match?.[1]?.toLowerCase();
  const marketId = match?.[2]?.toLowerCase();
  if (!marketId || (venue !== "polymarket" && venue !== "limitless"))
    return null;
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
  const base = `deposit:${input.venue}:${input.marketId}:${input.side === "NO" ? "n" : "y"}`;
  return parseTelegramMarketDeposit(base) && `hm:v1:${base}`.length <= 64
    ? `hm:v1:${base}`
    : `hm:v1:deposit:${input.venue}`;
}
