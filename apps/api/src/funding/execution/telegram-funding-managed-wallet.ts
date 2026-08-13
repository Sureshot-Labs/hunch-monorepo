import type { Pool } from "@hunch/infra";

import { stableWalletOpaqueId } from "../../account-value/canonical.js";

export type TelegramFundingProvisionWallet = Readonly<{
  controllerWalletId: string;
  privyWalletId: string;
  userWalletId: string;
  walletAddress: string;
}>;

async function resolveTelegramFundingManagedWallet(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
  }>,
  requireExecutionReady: boolean,
): Promise<TelegramFundingProvisionWallet | null> {
  const { rows } = await pool.query<{
    privy_wallet_id: string;
    user_wallet_id: string;
    wallet_address: string;
  }>(
    `
      select
        wallet.id as user_wallet_id,
        wallet.privy_wallet_id,
        wallet.wallet_address
      from telegram_bot_trading_authorizations trading_authorization
      join users app_user
        on app_user.id = trading_authorization.user_id
       and coalesce(app_user.is_active, true) = true
      join user_telegram_accounts telegram_account
        on telegram_account.id = $2::uuid
       and telegram_account.user_id = trading_authorization.user_id
       and telegram_account.telegram_user_id = trading_authorization.telegram_user_id
      join telegram_bot_trading_preferences preference
        on preference.user_id = trading_authorization.user_id
      join user_wallets wallet
        on wallet.user_id = trading_authorization.user_id
       and wallet.wallet_type = 'ethereum'
       and wallet.is_verified = true
       and wallet.is_internal_wallet = true
       and wallet.privy_wallet_id = trading_authorization.privy_wallet_id
       and funding_account_identifier_equal(
             trading_authorization.wallet_chain,
             wallet.wallet_address,
             trading_authorization.wallet_address
           )
      where trading_authorization.user_id = $1::uuid
        and trading_authorization.telegram_user_id = $3
        and trading_authorization.wallet_chain = 'ethereum'
        and (
          ($4::boolean and 'polymarket' = any(trading_authorization.enabled_venues))
          or (
            not $4::boolean
            and trading_authorization.enabled_venues && array['polymarket', 'limitless']::text[]
          )
        )
        and (
          not $4::boolean
          or (
            trading_authorization.enabled = true
            and preference.desired_enabled = true
          )
        )
      limit 2
    `,
    [
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      requireExecutionReady,
    ],
  );
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  return {
    controllerWalletId: stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: "evm:137",
      address: row.wallet_address,
    }),
    privyWalletId: row.privy_wallet_id,
    userWalletId: row.user_wallet_id,
    walletAddress: row.wallet_address,
  };
}

export function resolveTelegramFundingManagedWalletIdentity(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
  }>,
): Promise<TelegramFundingProvisionWallet | null> {
  // Wallet identity survives a user/control-plane pause. Ownership checks must
  // not confuse "cannot execute now" with "this is no longer the same wallet".
  return resolveTelegramFundingManagedWallet(pool, input, false);
}

export function resolveTelegramFundingProvisionWallet(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
  }>,
): Promise<TelegramFundingProvisionWallet | null> {
  return resolveTelegramFundingManagedWallet(pool, input, true);
}

export async function isTelegramFundingReceiveControllerCurrent(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    receiveSessionId: string;
    telegramAccountId: string;
    telegramUserId: string;
    userId: string;
  }>,
): Promise<boolean> {
  const { rows } = await pool.query<{
    controller_wallet_id: string | null;
    destination_network_id: string | null;
  }>(
    `
      select destination_target_snapshot #>>
               '{location,details,controllerWalletId}' as controller_wallet_id,
             destination_asset ->> 'networkId' as destination_network_id
      from funding_receive_sessions
      where id = $1
        and user_id = $2
        and owner_channel = 'telegram'
      limit 1
    `,
    [input.receiveSessionId, input.userId],
  );
  const frozenControllerWalletId = rows[0]?.controller_wallet_id?.trim();
  const destinationNetworkId = rows[0]?.destination_network_id?.trim();
  if (
    !frozenControllerWalletId ||
    (destinationNetworkId !== "evm:137" && destinationNetworkId !== "evm:8453")
  ) {
    return false;
  }
  const currentManagedWallet =
    await resolveTelegramFundingManagedWalletIdentity(pool, input);
  return currentManagedWallet
    ? stableWalletOpaqueId({
        walletType: "ethereum",
        networkId: destinationNetworkId,
        address: currentManagedWallet.walletAddress,
      }) === frozenControllerWalletId
    : false;
}
