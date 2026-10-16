import { hip4ReadMarketSchema, hip4RawUnits } from "@hunch/shared";
import { formatUnits } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import { hip4NativeMarketOpen as hip4SocialMarketOpen } from "./hip4-native-instrument.js";

export { hip4SocialMarketOpen };

/** Use the selected native book, never YES-complement synthesis or legacy top
 * rows belonging to another protocol. Missing/expired/empty/crossed is null. */
export function hip4SocialMark(input: {
  metadata: unknown;
  tokenId: string;
  maxAgeSeconds: number | null;
  now?: number;
}): string | null {
  const now = input.now ?? Date.now();
  if (
    !input.maxAgeSeconds ||
    !Number.isFinite(input.maxAgeSeconds) ||
    input.maxAgeSeconds <= 0 ||
    !hip4SocialMarketOpen(input.metadata, now)
  )
    return null;
  const parsed = hip4ReadMarketSchema.safeParse(
    isRecord(input.metadata) ? input.metadata.hip4 : null,
  );
  if (!parsed.success) return null;
  const side = parsed.data.sides.find((row) => row.tokenId === input.tokenId);
  if (
    !side ||
    side.bookState !== "fresh" ||
    side.bid === null ||
    side.ask === null ||
    !Number.isFinite(Date.parse(side.bookAt ?? "")) ||
    Date.parse(side.bookAt ?? "") > now ||
    Date.parse(side.bookAt ?? "") + input.maxAgeSeconds * 1000 <= now ||
    !Number.isFinite(Date.parse(side.bookValidUntil ?? "")) ||
    Date.parse(side.bookValidUntil ?? "") <= now
  )
    return null;
  const decimals = Math.max(
    side.bid.split(".")[1]?.length ?? 0,
    side.ask.split(".")[1]?.length ?? 0,
  );
  if (decimals > 37) return null;
  const bid = hip4RawUnits(side.bid, decimals),
    ask = hip4RawUnits(side.ask, decimals);
  if (bid <= 0n || ask >= 10n ** BigInt(decimals) || bid >= ask) return null;
  // An extra decimal represents division by two exactly, without rounding.
  return formatUnits((bid + ask) * 5n, decimals + 1);
}
