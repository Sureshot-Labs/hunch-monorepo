import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { canonicalJsonHash } from "../persistence/canonical.js";
import type { AssetRef } from "../domain/types.js";
import {
  canonicalAccountAddress,
  sameAccountAddress,
  sameAsset,
} from "../domain/asset-identity.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  loadPolymarketWrapExecutionConfiguration,
  polymarketWrapExecutionConfigurationReady,
  polymarketWrapExecutorEnvironmentReady,
  type PolymarketWrapExecutionConfiguration,
  loadRelayEvmExecutionConfiguration,
  relayEvmExecutionConfigurationReady,
  type RelayEvmExecutionConfiguration,
} from "./delegated-funding-config.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "./delegated-funding-profile-ids.js";
import type { DelegatedFundingSecurityClass } from "./delegated-funding-profile-ids.js";
import type { DelegatedFundingPreBroadcastDecision } from "./delegated-funding-capability.js";
import {
  PrivyDelegatedFundingDriver,
  type PrivyWalletProfileInspection,
} from "./privy-delegated-funding-driver.js";
import { lockTelegramFundingLinkLifecycle } from "./telegram-funding-link-lifecycle-lock.js";
import { resolveTelegramFundingProvisionWallet } from "./telegram-funding-managed-wallet.js";
import { RELAY_ROUTE_SPECS } from "../../funding-providers/relay/mappings.js";
import { RELAY_EVM_FUNDING_PROFILE_SPECS } from "./relay-evm-profile-specs.js";

export {
  resolveTelegramFundingProvisionWallet,
  type TelegramFundingProvisionWallet,
} from "./telegram-funding-managed-wallet.js";

class TelegramFundingAuthorizationIdentityNotCurrentError extends Error {}
class TelegramFundingAuthorizationGenerationChangedError extends Error {}

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
  securityClass: DelegatedFundingSecurityClass;
  maxSourceRaw: string | null;
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
  security_class: DelegatedFundingSecurityClass;
  max_source_raw: string | null;
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
    walletAddress: canonicalAccountAddress("evm:1", row.wallet_address),
    walletChain: row.wallet_chain,
    profileId: row.profile_id,
    securityClass: row.security_class,
    maxSourceRaw: row.max_source_raw,
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
  "max_source_raw",
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
    venueId?: "limitless" | "polymarket";
    expectedAuthorizationId?: string;
    profileId?: string;
    securityClass?: DelegatedFundingSecurityClass;
    sourceAsset?: AssetRef;
    destinationAsset?: AssetRef;
    now?: Date;
    lock?: boolean;
    requireTradingEnabled?: boolean;
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
       and funding_account_identifier_equal(
             funding_authorization.wallet_chain,
             wallet.wallet_address,
             funding_authorization.wallet_address
           )
      join telegram_bot_trading_authorizations trading_authorization
        on trading_authorization.user_id = funding_authorization.user_id
       and trading_authorization.telegram_user_id = funding_authorization.telegram_user_id
       and trading_authorization.wallet_chain = 'ethereum'
       and trading_authorization.privy_wallet_id = funding_authorization.privy_wallet_id
       and funding_account_identifier_equal(
             trading_authorization.wallet_chain,
             trading_authorization.wallet_address,
             funding_authorization.wallet_address
           )
       and ($11::boolean = false or trading_authorization.enabled = true)
       and (
         $17 = 'limitless'
         or $17 = any(trading_authorization.enabled_venues)
       )
      where funding_authorization.user_id = $1
        and funding_authorization.telegram_account_id = $2::uuid
        and funding_authorization.telegram_user_id = $3
        and funding_authorization.profile_id = $4
        and funding_authorization.security_class = $12
        and ($5::text is null or funding_authorization.id::text = $5)
        and funding_authorization.venue_id = $17
        and funding_authorization.destination_option_id = $6
        and funding_authorization.venue_binding_option_id = $7
        and funding_authorization.source_network_id = $13
        and funding_account_identifier_equal(
              funding_authorization.source_network_id,
              funding_authorization.source_asset_id,
              $8
            )
        and funding_authorization.source_asset_decimals = $14
        and funding_authorization.destination_network_id = $15
        and funding_account_identifier_equal(
              funding_authorization.destination_network_id,
              funding_authorization.destination_asset_id,
              $9
            )
        and funding_authorization.destination_asset_decimals = $16
        and funding_authorization.revoked_at is null
        and (
          funding_authorization.expires_at is null
          or funding_authorization.expires_at >
               greatest($10::timestamptz, clock_timestamp())
        )
      limit 1
      ${input.lock ? "for update of funding_authorization, app_user, account, wallet, trading_authorization" : ""}
    `,
    [
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      input.profileId ?? POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
      input.expectedAuthorizationId ?? null,
      input.destinationOptionId,
      input.venueBindingOptionId,
      input.sourceAsset?.assetId ??
        fundingSidecarRuntimeConfig.polymarketUsdceAddress,
      input.destinationAsset?.assetId ??
        fundingSidecarRuntimeConfig.polymarketPusdAddress,
      input.now ?? new Date(),
      input.requireTradingEnabled ?? true,
      input.securityClass ?? "closed_destination_transform",
      input.sourceAsset?.networkId ?? "evm:137",
      input.sourceAsset?.decimals ?? 6,
      input.destinationAsset?.networkId ?? "evm:137",
      input.destinationAsset?.decimals ?? 6,
      input.venueId ?? "polymarket",
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
    maxSourceRaw: authorization.maxSourceRaw,
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
    configuration: Pick<
      PolymarketWrapExecutionConfiguration,
      "signerId" | "signerFingerprint" | "policyId" | "policyFingerprint"
    >;
    profileId?: string;
    securityClass?: DelegatedFundingSecurityClass;
    sourceAsset?: AssetRef;
    destinationAsset?: AssetRef;
    venueId?: "limitless" | "polymarket";
    maxSourceRaw?: string | null;
    expectedAuthorizationId?: string;
    expectedAuthorizationFingerprint?: string;
    now?: Date;
    lock?: boolean;
  }>,
): Promise<CurrentTelegramFundingAuthorityDecision> {
  const preference = await db.query<{
    desired_enabled: boolean;
    funding_operator_revoked_at: Date | null;
  }>(
    `
      select desired_enabled, funding_operator_revoked_at
      from telegram_bot_trading_preferences
      where user_id = $1
      ${input.lock ? "for update" : ""}
    `,
    [input.userId],
  );
  if (preference.rows[0]?.funding_operator_revoked_at) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    };
  }
  const automationEnabled = preference.rows[0]?.desired_enabled === true;
  const authorization = await loadActiveTelegramFundingAuthorization(db, {
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    expectedAuthorizationId: input.expectedAuthorizationId,
    profileId: input.profileId,
    securityClass: input.securityClass,
    sourceAsset: input.sourceAsset,
    destinationAsset: input.destinationAsset,
    venueId: input.venueId,
    now: input.now,
    lock: input.lock,
    requireTradingEnabled: automationEnabled,
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
  if (
    input.configuration.signerId.length < 3 ||
    input.configuration.signerFingerprint.length < 32 ||
    input.configuration.policyId.length < 3 ||
    input.configuration.policyFingerprint.length < 32
  ) {
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
  if (!automationEnabled) {
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
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    const now = input.now ?? new Date();
    const result = await client.query(
      `
        update telegram_funding_authorizations
        set revoked_at = greatest(granted_at, $3),
            updated_at = greatest(granted_at, $3)
        where id = $1
          and user_id = $2
          and revoked_at is null
      `,
      [input.authorizationId, input.userId, now],
    );
    if (result.rowCount === 1) {
      const preference = await client.query(
        `update telegram_bot_trading_preferences
            set funding_operator_revoked_at = greatest(
                  coalesce(funding_operator_revoked_at, '-infinity'::timestamptz),
                  $2
                ),
                updated_at = greatest(updated_at, $2)
          where user_id = $1`,
        [input.userId, now],
      );
      if (preference.rowCount !== 1) {
        throw new Error("funding authorization preference was not found");
      }
    }
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
    configuration: Pick<
      PolymarketWrapExecutionConfiguration,
      "signerId" | "signerFingerprint" | "policyId" | "policyFingerprint"
    >;
    profileId?: string;
    securityClass?: DelegatedFundingSecurityClass;
    sourceAsset?: AssetRef;
    destinationAsset?: AssetRef;
    venueId?: "limitless" | "polymarket";
    maxSourceRaw?: string | null;
    expiresAt?: Date | null;
    now?: Date;
    replaceExisting?: boolean;
    expectedActiveAuthorizationIds?: readonly string[];
    operatorOverride?: boolean;
  }>,
): Promise<TelegramFundingAuthorization> {
  if (
    input.configuration.signerId.length < 3 ||
    input.configuration.signerFingerprint.length < 32 ||
    input.configuration.policyId.length < 3 ||
    input.configuration.policyFingerprint.length < 32
  ) {
    throw new Error("funding authorization profile is not fully configured");
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(input.walletAddress)) {
    throw new Error("funding authorization wallet address is invalid");
  }
  const profileId = input.profileId ?? POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
  const securityClass = input.securityClass ?? "closed_destination_transform";
  const sourceAsset = input.sourceAsset ?? {
    networkId: "evm:137",
    assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
    decimals: 6,
  };
  const destinationAsset = input.destinationAsset ?? {
    networkId: "evm:137",
    assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
    decimals: 6,
  };
  const maxSourceRaw = input.maxSourceRaw ?? null;
  const venueId = input.venueId ?? "polymarket";
  if (
    securityClass === "routed_value_movement" &&
    (maxSourceRaw == null || !/^[1-9][0-9]*$/u.test(maxSourceRaw))
  ) {
    throw new Error("routed funding authorization requires a positive cap");
  }
  const now = input.now ?? new Date();
  return tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [
        `telegram-funding-authorization:${input.userId}:${profileId}:${venueId}`,
      ],
    );
    const preference = await client.query<{
      funding_operator_revoked_at: Date | null;
    }>(
      `select funding_operator_revoked_at
         from telegram_bot_trading_preferences
        where user_id = $1
        for update`,
      [input.userId],
    );
    if (
      preference.rows[0]?.funding_operator_revoked_at &&
      !input.operatorOverride
    ) {
      throw new TelegramFundingAuthorizationGenerationChangedError(
        "funding authorization was revoked by an operator",
      );
    }
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
           and funding_account_identifier_equal(
                 'ethereum',
                 wallet.wallet_address,
                 $6
               )
          join telegram_bot_trading_authorizations trading_authorization
            on trading_authorization.user_id = app_user.id
           and trading_authorization.telegram_user_id = account.telegram_user_id
           and trading_authorization.wallet_chain = 'ethereum'
           and trading_authorization.privy_wallet_id = wallet.privy_wallet_id
           and funding_account_identifier_equal(
                 trading_authorization.wallet_chain,
                 trading_authorization.wallet_address,
                 wallet.wallet_address
               )
           and trading_authorization.enabled = true
           and (
             $7 = 'limitless'
             or $7 = any(trading_authorization.enabled_venues)
           )
          join telegram_bot_trading_preferences preference
            on preference.user_id = app_user.id
           and preference.desired_enabled = true
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
        venueId,
      ],
    );
    if (!exactAuthority.rows[0]?.ready) {
      throw new TelegramFundingAuthorizationIdentityNotCurrentError(
        "funding authorization identity is not current",
      );
    }
    const existing = await client.query<TelegramFundingAuthorizationRow>(
      `
        select ${authorizationColumns("funding_authorization")}
        from telegram_funding_authorizations funding_authorization
        where funding_authorization.user_id = $1
          and funding_authorization.profile_id = $2
          and funding_authorization.venue_id = $3
          and funding_authorization.revoked_at is null
        order by funding_authorization.id
        for update of funding_authorization
      `,
      [input.userId, profileId, venueId],
    );
    const current = existing.rows.map(telegramFundingAuthorizationFromRow);
    const generationMatches =
      input.expectedActiveAuthorizationIds === undefined ||
      (input.expectedActiveAuthorizationIds.length === current.length &&
        input.expectedActiveAuthorizationIds.every(
          (id, index) => current[index]?.id === id,
        ));
    const expiredIds = current
      .filter(
        (authorization) =>
          authorization.expiresAt != null &&
          new Date(authorization.expiresAt).getTime() <= now.getTime(),
      )
      .map((authorization) => authorization.id);
    const active = current.filter(
      (authorization) => !expiredIds.includes(authorization.id),
    );
    const exactReplay = active.find(
      (authorization) =>
        authorization.telegramAccountId === input.telegramAccountId &&
        authorization.telegramUserId === input.telegramUserId &&
        authorization.userWalletId === input.userWalletId &&
        authorization.privyWalletId === input.privyWalletId &&
        sameAccountAddress(
          "evm:1",
          authorization.walletAddress,
          input.walletAddress,
        ) &&
        authorization.signerId === input.configuration.signerId &&
        authorization.signerFingerprint ===
          input.configuration.signerFingerprint &&
        authorization.policyId === input.configuration.policyId &&
        authorization.policyFingerprint ===
          input.configuration.policyFingerprint &&
        authorization.destinationOptionId === input.destinationOptionId &&
        authorization.venueBindingOptionId === input.venueBindingOptionId &&
        authorization.expiresAt === (input.expiresAt?.toISOString() ?? null) &&
        authorization.profileId === profileId &&
        authorization.venueId === venueId &&
        authorization.securityClass === securityClass &&
        authorization.maxSourceRaw === maxSourceRaw &&
        sameAsset(authorization.sourceAsset, sourceAsset) &&
        sameAsset(authorization.destinationAsset, destinationAsset),
    );
    if (input.operatorOverride) {
      await client.query(
        `update telegram_bot_trading_preferences
            set funding_operator_revoked_at = null,
                updated_at = greatest(updated_at, $2)
          where user_id = $1`,
        [input.userId, now],
      );
    }
    if (exactReplay && active.length === 1) return exactReplay;
    if (!generationMatches) {
      throw new TelegramFundingAuthorizationGenerationChangedError(
        "funding authorization generation changed during inspection",
      );
    }
    if (expiredIds.length > 0) {
      await client.query(
        `update telegram_funding_authorizations
            set revoked_at = greatest(granted_at, $2),
                updated_at = greatest(granted_at, $2)
          where id = any($1::uuid[]) and revoked_at is null`,
        [expiredIds, now],
      );
    }
    if (active.length > 0 && !input.replaceExisting) {
      throw new Error(
        "a different active funding authorization already exists",
      );
    }
    if (active.length > 0) {
      await client.query(
        `update telegram_funding_authorizations
            set revoked_at = greatest(granted_at, $2),
                updated_at = greatest(granted_at, $2)
          where id = any($1::uuid[]) and revoked_at is null`,
        [active.map((authorization) => authorization.id), now],
      );
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
          max_source_raw,
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
          $1, $2, $3, $4, $5,
          case
            when $6 ~ '^0x[0-9a-fA-F]{40}$' then lower($6)
            else $6
          end,
          'ethereum', $7, $8, $9,
          $10, $11, $12, $13,
          $24, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $22, $22
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
        profileId,
        securityClass,
        maxSourceRaw,
        input.configuration.signerId,
        input.configuration.signerFingerprint,
        input.configuration.policyId,
        input.configuration.policyFingerprint,
        input.destinationOptionId,
        input.venueBindingOptionId,
        sourceAsset.networkId,
        sourceAsset.assetId,
        sourceAsset.decimals,
        destinationAsset.networkId,
        destinationAsset.assetId,
        destinationAsset.decimals,
        now,
        input.expiresAt ?? null,
        venueId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("funding authorization insert returned no row");
    return telegramFundingAuthorizationFromRow(row);
  });
}

async function revokeTelegramFundingAuthorizationForRoute(
  pool: Pool,
  input: Readonly<{
    authorizationIds: readonly string[];
    userId: string;
    venueBindingOptionId: string;
    now: Date;
  }>,
): Promise<void> {
  if (input.authorizationIds.length === 0) return;
  await tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    await client.query(
      `update telegram_funding_authorizations
          set revoked_at = greatest(granted_at, $5),
              updated_at = greatest(granted_at, $5)
        where user_id = $1
          and profile_id = $2
          and venue_binding_option_id = $3
          and id = any($4::uuid[])
          and revoked_at is null`,
      [
        input.userId,
        POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
        input.venueBindingOptionId,
        input.authorizationIds,
        input.now,
      ],
    );
  });
}

async function loadTelegramFundingAuthorizationGeneration(
  pool: Pick<Pool, "query">,
  input: Readonly<{ userId: string; venueBindingOptionId: string }>,
): Promise<
  Readonly<{
    activeIds: readonly string[];
    operatorRevoked: boolean;
    routeIds: readonly string[];
  }>
> {
  const { rows } = await pool.query<{
    id: string;
    venue_binding_option_id: string;
  }>(
    `select id, venue_binding_option_id
       from telegram_funding_authorizations
      where user_id = $1
        and profile_id = $2
        and revoked_at is null
      order by id`,
    [input.userId, POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID],
  );
  const preference = await pool.query<{
    funding_operator_revoked_at: Date | null;
  }>(
    `select funding_operator_revoked_at
       from telegram_bot_trading_preferences
      where user_id = $1`,
    [input.userId],
  );
  return {
    activeIds: rows.map((row) => row.id),
    operatorRevoked: preference.rows[0]?.funding_operator_revoked_at != null,
    routeIds: rows
      .filter(
        (row) => row.venue_binding_option_id === input.venueBindingOptionId,
      )
      .map((row) => row.id),
  };
}

export type EnsureTelegramFundingAuthorizationDependencies = Readonly<{
  configuration?: PolymarketWrapExecutionConfiguration;
  environment?: Readonly<Record<string, string | undefined>>;
  environmentReady?: boolean;
  inspectWalletProfile?: (input: {
    walletAddress: string;
    walletId: string;
  }) => Promise<PrivyWalletProfileInspection>;
}>;

/**
 * Provision the application-side route authority after ordinary managed
 * trading setup has already attached the shared signer and combined policy.
 * Missing capability stays a direct-funding fallback; database failures still
 * surface instead of pretending provisioning succeeded.
 */
export async function ensureTelegramFundingAuthorization(
  pool: Pool,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    controllerWalletId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    venueId?: "limitless" | "polymarket";
    now?: Date;
  }>,
  dependencies: EnsureTelegramFundingAuthorizationDependencies = {},
): Promise<TelegramFundingAuthorization | null> {
  const environment = dependencies.environment ?? process.env;
  const configuration =
    dependencies.configuration ??
    loadPolymarketWrapExecutionConfiguration(environment);
  if (
    !polymarketWrapExecutionConfigurationReady(configuration) ||
    !(
      dependencies.environmentReady ??
      polymarketWrapExecutorEnvironmentReady(environment)
    )
  ) {
    return null;
  }
  const provisioningState = await tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    const generation = await loadTelegramFundingAuthorizationGeneration(
      client,
      input,
    );
    const candidate = await resolveTelegramFundingProvisionWallet(
      client,
      input,
    );
    return { candidate, generation };
  });
  if (provisioningState.generation.operatorRevoked) return null;
  const candidate = provisioningState.candidate;
  if (!candidate) return null;
  if (candidate.controllerWalletId !== input.controllerWalletId) {
    await revokeTelegramFundingAuthorizationForRoute(pool, {
      authorizationIds: provisioningState.generation.routeIds,
      userId: input.userId,
      venueBindingOptionId: input.venueBindingOptionId,
      now: input.now ?? new Date(),
    });
    return null;
  }
  let inspectWalletProfile = dependencies.inspectWalletProfile;
  if (!inspectWalletProfile) {
    const relayConfiguration = loadRelayEvmExecutionConfiguration(environment);
    const driver = new PrivyDelegatedFundingDriver({
      appId: environment.PRIVY_APP_ID?.trim() ?? "",
      appSecret: environment.PRIVY_APP_SECRET?.trim() ?? "",
      authorizationPrivateKey:
        environment.PRIVY_WALLET_AUTHORIZATION_KEY?.trim() ?? "",
      configuration: {
        ...configuration,
        relayMaxSourceRaw: relayConfiguration.maxSourceRaw,
      },
    });
    inspectWalletProfile = (wallet) => driver.inspectWalletProfile(wallet);
  }
  let inspection: PrivyWalletProfileInspection = "unavailable";
  try {
    inspection = await inspectWalletProfile({
      walletId: candidate.privyWalletId,
      walletAddress: candidate.walletAddress,
    });
  } catch {
    inspection = "unavailable";
  }
  if (inspection === "unavailable") return null;
  if (inspection === "invalid") {
    await revokeTelegramFundingAuthorizationForRoute(pool, {
      authorizationIds: provisioningState.generation.routeIds,
      userId: input.userId,
      venueBindingOptionId: input.venueBindingOptionId,
      now: input.now ?? new Date(),
    });
    return null;
  }
  try {
    return await grantTelegramFundingAuthorization(pool, {
      ...input,
      ...candidate,
      configuration,
      expectedActiveAuthorizationIds: provisioningState.generation.activeIds,
      replaceExisting: true,
    });
  } catch (error) {
    if (
      error instanceof TelegramFundingAuthorizationIdentityNotCurrentError ||
      error instanceof TelegramFundingAuthorizationGenerationChangedError
    ) {
      return null;
    }
    throw error;
  }
}

export async function ensureTelegramRelayEvmFundingAuthorization(
  pool: Pool,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    controllerWalletId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    venueId?: "limitless" | "polymarket";
    now?: Date;
  }>,
  dependencies: Readonly<{
    configuration?: RelayEvmExecutionConfiguration;
    environment?: Readonly<Record<string, string | undefined>>;
    inspectWalletProfile?: (input: {
      walletAddress: string;
      walletId: string;
      profileId: string;
    }) => Promise<PrivyWalletProfileInspection>;
  }> = {},
): Promise<TelegramFundingAuthorization | null> {
  const environment = dependencies.environment ?? process.env;
  const configuration =
    dependencies.configuration ??
    loadRelayEvmExecutionConfiguration(environment);
  if (!relayEvmExecutionConfigurationReady(configuration)) return null;
  const venueId = input.venueId ?? "polymarket";
  const candidate = await resolveTelegramFundingProvisionWallet(pool, {
    ...input,
    controllerNetworkId:
      venueId === "limitless" ? "evm:8453" : "evm:137",
  });
  if (!candidate || candidate.controllerWalletId !== input.controllerWalletId) {
    return null;
  }
  let inspect = dependencies.inspectWalletProfile;
  if (!inspect) {
    const driver = new PrivyDelegatedFundingDriver({
      appId: environment.PRIVY_APP_ID?.trim() ?? "",
      appSecret: environment.PRIVY_APP_SECRET?.trim() ?? "",
      authorizationPrivateKey:
        environment.PRIVY_WALLET_AUTHORIZATION_KEY?.trim() ?? "",
      configuration: {
        ...configuration,
        relayMaxSourceRaw: configuration.maxSourceRaw,
      },
    });
    inspect = (wallet) => driver.inspectWalletProfileForProfile(wallet);
  }
  const profiles = Object.values(RELAY_EVM_FUNDING_PROFILE_SPECS).filter(
    (profile) => profile.venueIds.includes(venueId),
  );
  const granted: TelegramFundingAuthorization[] = [];
  for (const profile of profiles) {
    const inspection = await inspect({
      walletId: candidate.privyWalletId,
      walletAddress: candidate.walletAddress,
      profileId: profile.profileId,
    }).catch(() => "unavailable" as const);
    if (inspection !== "valid") continue;
    const route = profile.routeIds
      .map((routeId) => RELAY_ROUTE_SPECS[routeId])
      .find(
        (candidateRoute) =>
          candidateRoute?.destination.networkId ===
          (venueId === "limitless" ? "evm:8453" : "evm:137"),
      );
    if (!route) continue;
    granted.push(
      await grantTelegramFundingAuthorization(pool, {
        ...input,
        ...candidate,
        configuration,
        profileId: profile.profileId,
        securityClass: "routed_value_movement",
        maxSourceRaw: configuration.maxSourceRaw,
        sourceAsset: profile.sourceAsset,
        destinationAsset: route.destination,
        replaceExisting: true,
      }),
    );
  }
  return granted[0] ?? null;
}
