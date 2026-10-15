import type { PoolClient } from "pg";

export const USER_WALLET_MERGE_CONFLICT_SQL = `select
  source_wallet.id as source_wallet_id, source_wallet.wallet_type as source_wallet_type,
  target_wallet.id as target_wallet_id, target_wallet.wallet_type as target_wallet_type
  from user_wallets source_wallet
  cross join lateral (
    select id,wallet_type from user_wallets
    where user_id=$2 and wallet_address=source_wallet.wallet_address offset 0
  ) target_wallet
  where source_wallet.user_id=$1 limit 1`;

// Parent + composite-FK child must move in ONE SQL statement. PostgreSQL checks
// the existing immediate FK at statement end. No deferred FK/migration or copy
// of globally unique wallets; stable IDs and all execution-profile fields stay.
export const REPARENT_USER_WALLETS_SQL = `with moved_wallets as (
  update user_wallets set user_id=$2,is_primary=false where user_id=$1
  returning wallet_address
), moved_credentials as (
  update user_venue_credentials set user_id=$2
  where user_id=$1 and wallet_address in(select wallet_address from moved_wallets)
  returning id
) select (select count(*)::int from moved_wallets) as wallets_moved,
  (select count(*)::int from moved_credentials) as credentials_moved`;

export class WalletMergeConflictError extends Error {
  constructor(
    readonly conflict: {
      source_wallet_id: string;
      source_wallet_type: string;
      target_wallet_id: string;
      target_wallet_type: string;
    },
  ) {
    super(
      `Wallet identity conflict between ${conflict.source_wallet_id} (${conflict.source_wallet_type}) and ${conflict.target_wallet_id} (${conflict.target_wallet_type}); resolve their ownership before merging.`,
    );
    this.name = "WalletMergeConflictError";
  }
}

/** Caller holds both existing merge user locks in a transaction. A legacy exact
 * address with different wallet types is not silently normalized or deleted. */
export async function reparentUserWalletsForMerge(
  db: PoolClient,
  sourceId: string,
  targetId: string,
) {
  const conflict = (
    await db.query<WalletMergeConflictError["conflict"]>(
      USER_WALLET_MERGE_CONFLICT_SQL,
      [sourceId, targetId],
    )
  ).rows[0];
  if (conflict) throw new WalletMergeConflictError(conflict);
  const result = (
    await db.query<{ wallets_moved: number; credentials_moved: number }>(
      REPARENT_USER_WALLETS_SQL,
      [sourceId, targetId],
    )
  ).rows[0];
  if (!result) throw new Error("Wallet merge did not return its counts");
  return result;
}
