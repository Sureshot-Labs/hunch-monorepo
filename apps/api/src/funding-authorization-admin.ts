#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool } from "./db.js";
import { env } from "./env.js";
import {
  loadPolymarketWrapExecutionConfiguration,
  loadRelayEvmExecutionConfiguration,
  polymarketWrapProfileConfigured,
} from "./funding/execution/delegated-funding-config.js";
import { PrivyDelegatedFundingDriver } from "./funding/execution/privy-delegated-funding-driver.js";
import {
  grantTelegramFundingAuthorization,
  revokeTelegramFundingAuthorization,
} from "./funding/execution/telegram-funding-authorization.js";

const GRANT_CONFIRMATION = "GRANT POLYMARKET USDC.E WRAP";
const REVOKE_CONFIRMATION = "REVOKE POLYMARKET USDC.E WRAP";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (hasFlag("revoke")) {
    const plan = {
      execute: hasFlag("execute"),
      action: "revoke",
      authorizationId: argument("authorization-id"),
      userId: argument("user-id"),
    } as const;
    if (!plan.execute) {
      console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
      return;
    }
    if (argument("confirm") !== REVOKE_CONFIRMATION) {
      throw new Error(
        `--confirm must exactly equal ${JSON.stringify(REVOKE_CONFIRMATION)}`,
      );
    }
    const revoked = await revokeTelegramFundingAuthorization(pool, plan);
    if (!revoked) {
      throw new Error("active funding authorization was not found");
    }
    console.log(
      JSON.stringify({ ok: true, dryRun: false, revoked: true, plan }, null, 2),
    );
    return;
  }
  const configuration = loadPolymarketWrapExecutionConfiguration();
  if (!polymarketWrapProfileConfigured(configuration)) {
    throw new Error(
      "Polymarket automation signer/policy fingerprints are incomplete",
    );
  }
  const input = {
    userId: argument("user-id"),
    telegramAccountId: argument("telegram-account-id"),
    telegramUserId: argument("telegram-user-id"),
    userWalletId: argument("user-wallet-id"),
    privyWalletId: argument("privy-wallet-id"),
    walletAddress: argument("wallet-address"),
    destinationOptionId: argument("destination-option-id"),
    venueBindingOptionId: argument("venue-binding-option-id"),
    configuration,
  } as const;
  const driver = new PrivyDelegatedFundingDriver({
    appId: env.privyAppId,
    appSecret: env.privyAppSecret,
    authorizationPrivateKey: env.privyWalletAuthorizationKey,
    configuration: {
      ...configuration,
      relayAllowedDepositors:
        loadRelayEvmExecutionConfiguration().allowedDepositors,
      relayMaxSourceRaw: loadRelayEvmExecutionConfiguration().maxSourceRaw,
    },
  });
  const liveProfileValid = await driver.verifyWalletProfile({
    walletId: input.privyWalletId,
    walletAddress: input.walletAddress,
  });
  if (!liveProfileValid) {
    throw new Error(
      "The wallet does not have the exact configured automation signer/quorum/policy",
    );
  }
  const plan = {
    execute: hasFlag("execute"),
    profileId: configuration.profileId,
    userId: input.userId,
    telegramAccountId: input.telegramAccountId,
    userWalletId: input.userWalletId,
    privyWalletId: input.privyWalletId,
    walletAddress: input.walletAddress.toLowerCase(),
    destinationOptionId: input.destinationOptionId,
    venueBindingOptionId: input.venueBindingOptionId,
    liveProfileValid,
  };
  if (!hasFlag("execute")) {
    console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
    return;
  }
  if (argument("confirm") !== GRANT_CONFIRMATION) {
    throw new Error(
      `--confirm must exactly equal ${JSON.stringify(GRANT_CONFIRMATION)}`,
    );
  }
  const authorization = await grantTelegramFundingAuthorization(pool, {
    ...input,
    operatorOverride: true,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: false,
        authorization: {
          id: authorization.id,
          profileId: authorization.profileId,
          userId: authorization.userId,
          venueBindingOptionId: authorization.venueBindingOptionId,
          grantedAt: authorization.grantedAt,
        },
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}
