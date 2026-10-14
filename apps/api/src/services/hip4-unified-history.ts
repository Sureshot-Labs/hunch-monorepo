import type { Pool } from "pg";
import { readHip4Policy } from "./hip4-repository.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import { hip4OpenOrdersSnapshotSchema } from "./hip4-open-orders.js";

export async function readHip4OpenOrderCapability(
  db: Pick<Pool, "query">,
  userId: string,
  wallets: string[],
  venue?: string,
) {
  const capability = await readHip4HistoryCapability(db, venue);
  if (capability !== "limited")
    return { maxAgeMs: undefined, state: capability, validUntil: null };
  try {
    const { policy } = await readHip4AccountPolicy(db);
    const { rows } = await db.query<{ history: unknown }>(
      `select snapshot_row.history
      from user_wallets wallet_row join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
      left join hip4_account_snapshots snapshot_row on snapshot_row.environment='mainnet'
        and snapshot_row.account_address=lower(wallet_row.wallet_address)
      where wallet_row.user_id=$1 and wallet_row.is_verified and wallet_row.wallet_type='ethereum'
        and lower(wallet_row.wallet_address)=any($2::text[])`,
      [userId, wallets.map((value) => value.toLowerCase())],
    );
    const expiry: number[] = [];
    for (const row of rows) {
      const history = row.history as {
        openOrders?: unknown;
        openOrdersError?: unknown;
      } | null;
      const parsed = hip4OpenOrdersSnapshotSchema.safeParse(
        history?.openOrders,
      );
      if (!parsed.success || history?.openOrdersError) continue;
      const observedTime = Date.parse(parsed.data.observedAt);
      const until = observedTime + policy.snapshotMaxAgeMs;
      const now = Date.now();
      if (observedTime <= now && until > now) expiry.push(until);
    }
    return {
      maxAgeMs: policy.snapshotMaxAgeMs,
      state: !rows.length
        ? ("disabled" as const)
        : expiry.length === rows.length
          ? ("fresh" as const)
          : expiry.length
            ? ("partial" as const)
            : ("unavailable" as const),
      validUntil: expiry.length
        ? new Date(Math.min(...expiry)).toISOString()
        : null,
    };
  } catch {
    return {
      maxAgeMs: undefined,
      state: "unavailable" as const,
      validUntil: null,
    };
  }
}

/** No provider requests. Discovery/admin flags do not grant account reads. */
export async function readHip4HistoryCapability(
  db: Pick<Pool, "query">,
  venue?: string,
) {
  if (venue && venue !== "hyperliquid") return "disabled" as const;
  try {
    const { policy } = await readHip4Policy(db, "accountRead");
    return policy.enabled && policy.environment === "mainnet"
      ? ("limited" as const)
      : ("disabled" as const);
  } catch {
    // Other venue histories remain readable on a HIP configuration failure.
    return "unavailable" as const;
  }
}
