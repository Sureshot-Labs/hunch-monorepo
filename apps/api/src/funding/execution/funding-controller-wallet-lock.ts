import type { PoolClient } from "@hunch/infra";

import type { WalletExecutionProfile } from "../domain/types.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";

/**
 * Freeze the durable controller row used by a provider-derived wallet profile.
 * Provider/RPC inspection belongs before the transaction; this exact DB check
 * is the short commit/action boundary that detects ownership changes.
 */
export async function lockFundingControllerWallet(
  client: PoolClient,
  userId: string,
  profile: WalletExecutionProfile,
): Promise<void> {
  if (!profile.controllerWalletRef) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "funding controller wallet is missing",
    );
  }
  const walletType =
    profile.networkId === "solana:mainnet" ? "solana" : "ethereum";
  const { rows } = await client.query<{ id: string }>(
    `
      select wallet.id
      from users app_user
      join user_wallets wallet on wallet.user_id = app_user.id
      where app_user.id = $1::uuid
        and coalesce(app_user.is_active, true) = true
        and wallet.id = $2::uuid
        and wallet.wallet_type = $3
        and wallet.is_verified = true
        and wallet.is_internal_wallet = $4
        and wallet.wallet_source = $5
        and wallet.privy_wallet_id is not distinct from $6
        and funding_account_identifier_equal(
              $7,
              wallet.wallet_address,
              $8
            )
      for update of app_user, wallet
    `,
    [
      userId,
      profile.controllerWalletRef,
      walletType,
      profile.source !== "external",
      profile.source,
      profile.serverWalletRef,
      profile.networkId,
      profile.address,
    ],
  );
  if (rows.length !== 1) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "funding controller wallet changed before the durable boundary",
    );
  }
}
