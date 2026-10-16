import type { DbQuery } from "../db.js";
import { readHip4OrderHoldRaw } from "../repos/hip4-order-holds.js";
import { readHip4OrderCapacity } from "./hip4-financial-observation.js";
import type { TelegramAppHandoffNativeAuthority } from "./telegram-app-handoff-native-authority.js";

/** Same ordinary SELL capacity and snapshot-aware durable holds. This is only
 * a Review amount hint: native admission rechecks under the physical lock.
 * Callers verify current controller ownership BEFORE this provider read. */
export async function readTelegramNativeSellAvailable(
  input: {
    db: DbQuery;
    authority: TelegramAppHandoffNativeAuthority;
    marketId: string;
    side: "YES" | "NO";
  },
  capacityRead = readHip4OrderCapacity,
) {
  const capacity = await capacityRead(input.db, {
    address: input.authority.walletAddress,
    marketId: input.marketId,
    outcomeSide: input.side,
    side: "SELL",
  });
  const held = await readHip4OrderHoldRaw(
    input.db,
    input.authority.userId,
    input.authority.walletAddress,
    capacity.assetId,
    capacity.observedAt,
  );
  if (
    capacity.decimals !== 5 ||
    !Number.isFinite(Date.parse(capacity.expiresAt)) ||
    Date.parse(capacity.expiresAt) <= Date.now()
  )
    throw new Error("hip4_capacity_unavailable");
  const available = BigInt(capacity.availableRaw) - held;
  return available > 0n ? available : 0n;
}
