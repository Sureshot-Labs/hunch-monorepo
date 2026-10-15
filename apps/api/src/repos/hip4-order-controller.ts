import type { Pool } from "@hunch/infra";
import { z } from "zod";
import { ExistingFactsOwnershipResolver } from "../account-value/ownership-resolver.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";

// Exact controller PK, not an inventory/account-history load. Native identity
// below is built by the same ownership mapper used by AccountValue/funding.
export const HIP4_ORDER_CONTROLLER_SQL = `select wallet.wallet_address,
    wallet.wallet_source, wallet.privy_wallet_id
  from user_wallets wallet join users app_user on app_user.id=wallet.user_id
  where wallet.id=$1::uuid and wallet.user_id=$2::uuid
    and coalesce(app_user.is_active,true) and wallet.is_verified=true
    and wallet.wallet_type='ethereum'
    and ((wallet.wallet_source='external' and wallet.is_internal_wallet=false and wallet.privy_wallet_id is null)
      or (wallet.wallet_source='embedded' and wallet.is_internal_wallet=true and wallet.privy_wallet_id is not null))`;

export async function readHip4OrderController(
  pool: Pick<Pool, "query">,
  input: { userId: string; controllerWalletRef: string },
) {
  const userId = z.string().uuid().parse(input.userId).toLowerCase();
  const controllerWalletRef = z
    .string()
    .uuid()
    .parse(input.controllerWalletRef)
    .toLowerCase();
  const found = await pool.query<{
    wallet_address: string;
    wallet_source: "external" | "embedded";
    privy_wallet_id: string | null;
  }>(HIP4_ORDER_CONTROLLER_SQL, [controllerWalletRef, userId]);
  const wallet = found.rows[0];
  if (!wallet || !/^0x[\da-fA-F]{40}$/u.test(wallet.wallet_address))
    throw new Error("hip4_controller_unavailable");
  const address = wallet.wallet_address.toLowerCase();
  const ownership = await new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address,
        linkedAddress: address,
        walletType: "ethereum",
        source: wallet.wallet_source,
        serverWalletRef: wallet.privy_wallet_id,
        controllerWalletRef,
      },
    ],
    venueBindings: [
      {
        venueId: "hyperliquid",
        controllerAddress: address,
        executionAddress: address,
        accountRef: address,
        settlementAsset: HYPERCORE_MAINNET_USDC,
        signingMode: "web_client",
      },
    ],
  }).resolve(userId);
  const profile = ownership.wallets.find(
    (row) => row.networkId === HYPERCORE_MAINNET_USDC.networkId,
  );
  if (!profile || !profile.signingModes.includes("web_client"))
    throw new Error("hip4_controller_unavailable");
  return profile;
}
