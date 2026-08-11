import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { canonicalJsonHash } from "../persistence/canonical.js";
import type { AssetRef } from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import type { PolymarketWrapExecutionConfiguration } from "./delegated-funding-config.js";
import { polymarketWrapProfileConfigured } from "./delegated-funding-config.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import type { DelegatedFundingPreBroadcastDecision } from "./delegated-funding-capability.js";
import { lockTelegramFundingLinkLifecycle } from "./telegram-funding-link-lifecycle-lock.js";

export type TelegramFundingAuthorization = Readonly<{
  id: string;
  userId: string;
  telegramAccountId: string;
  telegramUserId: string;
  userWalletId: string;
  privyWalletId: string;
  walletAddress: string;
  walletChain: "ethereum";
  profileId: string;
  securityClass: "closed_destination_transform";
  signerId: string;
  signerFingerprint: string;
  policyId: string;
  policyFingerprint: string;
  venueId: string;
  destinationOptionId: string;
  venueBindingOptionId: string;
  sourceAsset: AssetRef;
  destinationAsset: AssetRef;
  grantedAt: string;
  expiresAt: string | null;
}>;

export type TelegramFundingAuthorizationRow = Readonly<{
  id: string;
  user_id: string;
  telegram_account_id: string;
  telegram_user_id: string;
  user_wallet_id: string;
  privy_wallet_id: string;
  wallet_address: string;
  wallet_chain: "ethereum";
  profile_id: string;
  security_class: "closed_destination_transform";
  signer_id: string;
  signer_fingerprint: string;
  policy_id: string;
  policy_fingerprint: string;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  source_network_id: string;
  source_asset_id: string;
  source_asset_decimals: number;
  destination_network_id: string;
  destination_asset_id: string;
  destination_asset_decimals: number;
  granted_at: Date;
  expires_at: Date | null;
}>;

export function telegramFundingAuthorizationFromRow(
  row: TelegramFundingAuthorizationRow,
): TelegramFundingAuthorization {
  return {
    id: row.id,
    userId: row.user_id,
    telegramAccountId: row.telegram_account_id,
    telegramUserId: row.telegram_user_id,
    userWalletId: row.user_wallet_id,
    privyWalletId: row.privy_wallet_id,
    walletAddress: row.wallet_address.toLowerCase(),
    walletChain: row.wallet_chain,
    profileId: row.profile_id,
    securityClass: row.security_class,
    signerId: row.signer_id,
    signerFingerprint: row.signer_fingerprint,
    policyId: row.policy_id,
    policyFingerprint: row.policy_fingerprint,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    sourceAsset: {
      networkId: row.source_network_id,
      assetId: row.source_asset_id,
      decimals: row.source_asset_decimals,
    },
    destinationAsset: {
      networkId: row.destination_network_id,
      assetId: row.destination_asset_id,
      decimals: row.destination_asset_decimals,
    },
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

const authorizationColumnNames = [
  "id",
  "user_id",
  "telegram_account_id",
  "telegram_user_id",
  "user_wallet_id",
  "privy_wallet_id",
  "wallet_address",
  "wallet_chain",
  "profile_id",
  "security_class",
  "signer_id",
  "signer_fingerprint",
  "policy_id",
  "policy_fingerprint",
  "venue_id",
  "destination_option_id",
  "venue_binding_option_id",
  "source_network_id",
  "source_asset_id",
  "source_asset_decimals",
  "destination_network_id",
  "destination_asset_id",
  "destination_asset_decimals",
  "granted_at",
  "expires_at",
] as const;

function authorizationColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return authorizationColumnNames
    .map((column) => `${prefix}${column}`)
    .join(",\n");
}

export async function loadActiveTelegramFundingAuthorization(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    expectedAuthorizationId?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<TelegramFundingAuthorization | null> {
  const { rows } = await db.query<TelegramFundingAuthorizationRow>(
    `
      select ${authorizationColumns("funding_authorization")}
      from telegram_funding_authorizations funding_authorization
      join users app_user
        on app_user.id = funding_authorization.user_id
       and coalesce(app_user.is_active, true) = true
      join user_telegram_accounts account
        on account.id = funding_authorization.telegram_account_id
       and account.user_id = funding_authorization.user_id
       and account.telegram_user_id = funding_authorization.telegram_user_id
      join user_wallets wallet
        on wallet.id = funding_authorization.user_wallet_id
       and wallet.user_id = funding_authorization.user_id
       and wallet.is_verified = true
       and wallet.is_internal_wallet = true
       and wallet.privy_wallet_id = funding_authorization.privy_wallet_id
       and lower(wallet.wallet_address) = lower(funding_authorization.wallet_address)
      where funding_authorization.user_id = $1
        and funding_authorization.telegram_account_id = $2::uuid
        and funding_authorization.telegram_user_id = $3
        and funding_authorization.profile_id = $4
        and funding_authorization.security_class = 'closed_destination_transform'
        and ($5::text is null or funding_authorization.id::text = $5)
        and funding_authorization.venue_id = 'polymarket'
        and funding_authorization.destination_option_id = $6
        and funding_authorization.venue_binding_option_id = $7
        and funding_authorization.source_network_id = 'evm:137'
        and lower(funding_authorization.source_asset_id) = lower($8)
        and funding_authorization.source_asset_decimals = 6
        and funding_authorization.destination_network_id = 'evm:137'
        and lower(funding_authorization.destination_asset_id) = lower($9)
        and funding_authorization.destination_asset_decimals = 6
        and funding_authorization.revoked_at is null
        and (
          funding_authorization.expires_at is null
          or funding_authorization.expires_at > $10
        )
      limit 1
      ${input.lock ? "for update of funding_authorization, app_user, account, wallet" : ""}
    `,
    [
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
      input.expectedAuthorizationId ?? null,
      input.destinationOptionId,
      input.venueBindingOptionId,
      fundingSidecarRuntimeConfig.polymarketUsdceAddress,
      fundingSidecarRuntimeConfig.polymarketPusdAddress,
      input.now ?? new Date(),
    ],
  );
  return rows[0] ? telegramFundingAuthorizationFromRow(rows[0]) : null;
}

export function telegramFundingAuthorizationFingerprint(
  authorization: TelegramFundingAuthorization,
): string {
  return canonicalJsonHash({
    id: authorization.id,
    userId: authorization.userId,
    telegramAccountId: authorization.telegramAccountId,
    telegramUserId: authorization.telegramUserId,
    userWalletId: authorization.userWalletId,
    privyWalletId: authorization.privyWalletId,
    walletAddress: authorization.walletAddress,
    walletChain: authorization.walletChain,
    profileId: authorization.profileId,
    securityClass: authorization.securityClass,
    signerId: authorization.signerId,
    signerFingerprint: authorization.signerFingerprint,
    policyId: authorization.policyId,
    policyFingerprint: authorization.policyFingerprint,
    venueId: authorization.venueId,
    destinationOptionId: authorization.destinationOptionId,
    venueBindingOptionId: authorization.venueBindingOptionId,
    sourceAsset: authorization.sourceAsset,
    destinationAsset: authorization.destinationAsset,
    grantedAt: authorization.grantedAt,
    expiresAt: authorization.expiresAt,
  });
}

export type CurrentTelegramFundingAuthorityDecision =
  | Readonly<{
      kind: "allowed";
      authorization: TelegramFundingAuthorization;
    }>
  | Exclude<
      DelegatedFundingPreBroadcastDecision,
      Readonly<{ kind: "allowed" }>
    >;

/**
 * Resolve and, at the broadcast boundary, lock the complete current user
 * authority. `desired_enabled` is a resumable preference; identity, grant,
 * wallet, and fingerprint drift are hard invalidations.
 */
export async function resolveCurrentTelegramFundingAuthority(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    configuration: PolymarketWrapExecutionConfiguration;
    expectedAuthorizationId?: string;
    expectedAuthorizationFingerprint?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<CurrentTelegramFundingAuthorityDecision> {
  const authorization = await loadActiveTelegramFundingAuthorization(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    expectedAuthorizationId: input.expectedAuthorizationId,
    now: input.now,
    lock: input.lock,
  });
  if (
    !authorization ||
    (input.expectedAuthorizationId !== undefined &&
      authorization.id !== input.expectedAuthorizationId) ||
    (input.expectedAuthorizationFingerprint !== undefined &&
      telegramFundingAuthorizationFingerprint(authorization) !==
        input.expectedAuthorizationFingerprint)
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    };
  }
  if (!polymarketWrapProfileConfigured(input.configuration)) {
    return {
      kind: "soft_paused",
      reasonCode: "delegated_profile_unavailable",
    };
  }
  if (
    authorization.signerId !== input.configuration.signerId ||
    authorization.signerFingerprint !== input.configuration.signerFingerprint ||
    authorization.policyId !== input.configuration.policyId ||
    authorization.policyFingerprint !== input.configuration.policyFingerprint
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    };
  }
  const preference = await db.query<{ desired_enabled: boolean }>(
    `
      select desired_enabled
      from telegram_bot_trading_preferences
      where user_id = $1
      ${input.lock ? "for update" : ""}
    `,
    [input.userId],
  );
  if (preference.rows[0]?.desired_enabled !== true) {
    return {
      kind: "soft_paused",
      reasonCode: "telegram_automation_disabled",
    };
  }
  return { kind: "allowed", authorization };
}

export async function revokeTelegramFundingAuthorization(
  pool: Pool,
  input: Readonly<{ authorizationId: string; userId: string; now?: Date }>,
): Promise<boolean> {
  return tx(pool, async (client) => {
    const result = await client.query(
      `
        update telegram_funding_authorizations
        set revoked_at = $3,
            updated_at = $3
        where id = $1
          and user_id = $2
          and revoked_at is null
      `,
      [input.authorizationId, input.userId, input.now ?? new Date()],
    );
    return result.rowCount === 1;
  });
}

export async function grantTelegramFundingAuthorization(
  pool: Pool,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    userWalletId: string;
    privyWalletId: string;
    walletAddress: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    configuration: PolymarketWrapExecutionConfiguration;
    expiresAt?: Date | null;
    now?: Date;
  }>,
): Promise<TelegramFundingAuthorization> {
  if (!polymarketWrapProfileConfigured(input.configuration)) {
    throw new Error("funding authorization profile is not fully configured");
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress)) {
    throw new Error("funding authorization wallet address is invalid");
  }
  const now = input.now ?? new Date();
  return tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [
        `telegram-funding-authorization:${input.userId}:${POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID}:${input.venueBindingOptionId}`,
      ],
    );
    const exactAuthority = await client.query<{ ready: boolean }>(
      `
        select exists (
          select 1
          from users app_user
          join user_telegram_accounts account
            on account.id = $2::uuid
           and account.user_id = app_user.id
           and account.telegram_user_id = $3
          join user_wallets wallet
            on wallet.id = $4::uuid
           and wallet.user_id = app_user.id
           and wallet.is_verified = true
           and wallet.is_internal_wallet = true
           and wallet.privy_wallet_id = $5
           and lower(wallet.wallet_address) = lower($6)
          where app_user.id = $1::uuid
            and coalesce(app_user.is_active, true) = true
        ) as ready
      `,
      [
        input.userId,
        input.telegramAccountId,
        input.telegramUserId,
        input.userWalletId,
        input.privyWalletId,
        input.walletAddress,
      ],
    );
    if (!exactAuthority.rows[0]?.ready) {
      throw new Error("funding authorization identity is not current");
    }
    const existing = await client.query<TelegramFundingAuthorizationRow>(
      `
        select ${authorizationColumns("funding_authorization")}
        from telegram_funding_authorizations funding_authorization
        where funding_authorization.user_id = $1
          and funding_authorization.profile_id = $2
          and funding_authorization.venue_binding_option_id = $3
          and funding_authorization.revoked_at is null
        for update of funding_authorization
      `,
      [
        input.userId,
        POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
        input.venueBindingOptionId,
      ],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      const current = telegramFundingAuthorizationFromRow(existingRow);
      if (
        current.expiresAt &&
        new Date(current.expiresAt).getTime() <= now.getTime()
      ) {
        await client.query(
          `
            update telegram_funding_authorizations
            set revoked_at = $2,
                updated_at = $2
            where id = $1 and revoked_at is null
          `,
          [current.id, now],
        );
      } else {
        const exactReplay =
          current.telegramAccountId === input.telegramAccountId &&
          current.telegramUserId === input.telegramUserId &&
          current.userWalletId === input.userWalletId &&
          current.privyWalletId === input.privyWalletId &&
          current.walletAddress === input.walletAddress.toLowerCase() &&
          current.signerId === input.configuration.signerId &&
          current.signerFingerprint === input.configuration.signerFingerprint &&
          current.policyId === input.configuration.policyId &&
          current.policyFingerprint === input.configuration.policyFingerprint &&
          current.destinationOptionId === input.destinationOptionId &&
          current.expiresAt === (input.expiresAt?.toISOString() ?? null);
        if (exactReplay) return current;
        throw new Error(
          "a different active funding authorization already exists",
        );
      }
    }
    const { rows } = await client.query<TelegramFundingAuthorizationRow>(
      `
        insert into telegram_funding_authorizations (
          user_id,
          telegram_account_id,
          telegram_user_id,
          user_wallet_id,
          privy_wallet_id,
          wallet_address,
          wallet_chain,
          profile_id,
          security_class,
          signer_id,
          signer_fingerprint,
          policy_id,
          policy_fingerprint,
          venue_id,
          destination_option_id,
          venue_binding_option_id,
          source_network_id,
          source_asset_id,
          source_asset_decimals,
          destination_network_id,
          destination_asset_id,
          destination_asset_decimals,
          granted_at,
          expires_at,
          created_at,
          updated_at
        ) values (
          $1, $2, $3, $4, $5, lower($6), 'ethereum', $7,
          'closed_destination_transform', $8, $9, $10, $11,
          'polymarket', $12, $13, 'evm:137', $14, 6,
          'evm:137', $15, 6, $16, $17, $16, $16
        )
        returning ${authorizationColumns()}
      `,
      [
        input.userId,
        input.telegramAccountId,
        input.telegramUserId,
        input.userWalletId,
        input.privyWalletId,
        input.walletAddress,
        POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
        input.configuration.signerId,
        input.configuration.signerFingerprint,
        input.configuration.policyId,
        input.configuration.policyFingerprint,
        input.destinationOptionId,
        input.venueBindingOptionId,
        fundingSidecarRuntimeConfig.polymarketUsdceAddress,
        fundingSidecarRuntimeConfig.polymarketPusdAddress,
        now,
        input.expiresAt ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("funding authorization insert returned no row");
    return telegramFundingAuthorizationFromRow(row);
  });
}
