import assert from "node:assert/strict";
import {
  inspectTelegramOnboardingReadiness,
  telegramOnboardingReadinessSchema,
} from "./services/telegram-onboarding-readiness.js";
import {
  getDefaultSignalBotPolicy,
  normalizeSignalBotPolicy,
} from "./services/signal-bot-trading-policy.js";
import { stableWalletOpaqueId } from "./account-value/canonical.js";
import type { FundingDestinationOption } from "./funding/domain/types.js";
import type { DbQuery } from "./db.js";
import { ensureTelegramBotTradingPreferenceForLink } from "./services/telegram-bot-trading-preferences.js";
import { deliverTelegramBotOnboardingActions } from "./services/telegram-bot-onboarding-delivery.js";

const address = "0x1111111111111111111111111111111111111111";
const now = new Date();
const policy = normalizeSignalBotPolicy({
  ...getDefaultSignalBotPolicy(),
  tradingEnabled: true,
  fundingReceiveEnabled: true,
  miniAppHandoffMode: "always",
  miniAppHandoffContractVersion: 2,
  tradingVenues: ["polymarket"],
});
type Input = Parameters<typeof inspectTelegramOnboardingReadiness>[0];
const controllerWalletId = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:137",
  address,
});
const option: FundingDestinationOption = {
  destinationOptionId: "destination_test",
  venueId: "polymarket",
  venueBindingId: "binding_test",
  venueBindingOptionId: "option_test",
  controllerWalletId,
  safeLabel: "Polymarket",
  requiredAsset: {
    networkId: "evm:137",
    assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    decimals: 6,
  },
  networkLabel: "Polygon",
  readinessClass: "internal_managed",
  preparationStatus: "ready",
  preparationPurpose: "fund",
  executionMode: "venue_relayer",
  marketClass: null,
  topology: "deposit_wallet",
  inspectionRevision: "inspection_test",
  recommended: true,
  selectable: true,
  reasonCodes: [],
};
function fixture() {
  let walletReads = 0;
  const queries: string[] = [];
  const state = {
    revision: "revision-1",
    linked: true,
    wallets: 1,
    changeWallet: false,
    failBuy: false,
    failReceive: false,
    solanaWallet: true,
    solanaEnabled: true,
    missingClass: false,
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      assert.ok(
        !/^\s*(?:insert|update|delete|begin)/i.test(sql),
        "readiness must be read-only",
      );
      if (
        sql.includes("runtime_policies") &&
        params[0] === "funding_control_plane"
      )
        return {
          rows: [
            {
              id: "funding",
              payload: {
                version: 2,
                venues: ["polymarket"],
                paused: false,
                receive: {
                  assets: state.solanaEnabled
                    ? ["solana:sol", "solana:usdc", "polygon:pusd"]
                    : ["polygon:pusd"],
                  privy: false,
                },
              },
            },
          ],
        };
      if (sql.includes("runtime_policies"))
        return { rows: [{ id: state.revision, payload: policy }] };
      if (sql.includes("as available"))
        return { rows: [{ available: state.solanaWallet }] };
      if (sql.includes("select id, linked_at from user_telegram_accounts"))
        return { rows: state.linked ? [{ id: "link", linked_at: now }] : [] };
      if (sql.includes("select wallet.id as user_wallet_id")) {
        walletReads++;
        return {
          rows: Array.from({ length: state.wallets }, () => ({
            privy_wallet_id: "privy",
            user_wallet_id:
              state.changeWallet && walletReads > 1 ? "changed" : "wallet",
            wallet_address: address,
          })),
        };
      }
      throw new Error("unexpected read: " + sql);
    },
  } as unknown as DbQuery;
  const input: Input = {
    db,
    now,
    userId: "user",
    policyState: { policy, policyRevision: "revision-1" },
    status: {
      userId: "user",
      telegramUserId: "123",
      linked: true,
      preference: null,
      authorizations: [],
      managedSetup: {
        state: "pending",
        reason: null,
        leaseExpiresAt: null,
        retryAfter: null,
      },
    },
    runtime: {
      capabilities: async () => ({
        fundingApiVersion: 1,
        receiveSessionsVersion: 1,
        creationMode: "on",
        destinationVenues: ["polymarket"],
        supportedActionKinds: [
          "add_funds",
          "trade_shortfall",
          "convert_asset",
          "withdrawal",
          "redeem",
        ],
      }),
      destinations: async (_userId, request) => {
        assert.equal(request.controllerWalletRef, "wallet");
        if (state.missingClass && request.marketClass === "neg_risk") return [];
        return [
          {
            ...option,
            preparationPurpose: request.purpose,
            marketClass: request.marketClass ?? null,
            selectable:
              request.purpose === "fund" ? !state.failReceive : !state.failBuy,
          },
        ];
      },
    },
  };
  return { input, queries, state };
}
{
  const { input, state } = fixture();
  state.solanaWallet = false;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).reasonCode,
    "receive_wallet_ambiguous",
  );
  state.solanaEnabled = false;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
    "disabled Solana receive must not require a Solana wallet",
  );
  state.missingClass = true;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).reasonCode,
    "trade_preparation_unavailable",
    "partial venue coverage cannot certify readiness",
  );
}

{
  const { input } = fixture();
  const ready = await inspectTelegramOnboardingReadiness(input);
  assert.deepEqual(telegramOnboardingReadinessSchema.parse(ready), {
    version: 1,
    state: "ready",
    mode: "mini_app",
    policyRevision: "revision-1",
    walletAddress: address,
    walletChain: "ethereum",
    reasonCode: null,
    message: null,
  });
  input.status.preference = {
    desiredEnabled: false,
  } as Input["status"]["preference"];
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
    "opt out cannot block Mini App",
  );
}
for (const key of ["failBuy", "failReceive"] as const) {
  const { input, state } = fixture();
  state[key] = true;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "pending",
  );
  input.now = new Date(now.getTime() + 61_000);
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "blocked",
    "no indefinite pending without a job",
  );
  state[key] = false;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
    "fresh recovery needs no toggle",
  );
}
for (const count of [0, 2]) {
  const { input, state } = fixture();
  state.wallets = count;
  assert.notEqual(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
  );
}
for (const mutation of ["changeWallet", "revision", "linked"] as const) {
  const { input, state } = fixture();
  if (mutation === "revision") state.revision = "changed";
  else if (mutation === "linked") state.linked = false;
  else state.changeWallet = true;
  assert.notEqual(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
  );
}
{
  const { input, state } = fixture();
  input.policyState.policy = { ...policy, miniAppHandoffMode: "off" };
  input.status.preference = {
    desiredEnabled: false,
  } as Input["status"]["preference"];
  state.failBuy = true;
  const result = await inspectTelegramOnboardingReadiness(input);
  assert.equal(result.mode, "account_only");
  assert.equal(result.state, "ready");
  input.status.preference = {
    desiredEnabled: true,
  } as Input["status"]["preference"];
  state.failBuy = false;
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).reasonCode,
    "bot_setup_required",
  );
  input.status.managedSetup = {
    state: "in_progress",
    reason: null,
    retryAfter: null,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "pending",
  );
  input.status.authorizations = [
    {
      authorizationId: "authorization-test",
      directExecutionReady: false,
      enabled: true,
      enabledVenues: ["polymarket"],
      maxAmountUsd: 10,
      privyWalletId: "privy",
      signerStatus: { state: "ready" } as NonNullable<
        Input["status"]["authorizations"][number]["signerStatus"]
      >,
      setupIssue: null,
      venueStatuses: [],
      walletAddress: address,
      walletChain: "ethereum",
    },
  ];
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
    "zero funds/directExecutionReady=false is not a setup failure",
  );
  const currentAuthorization = input.status.authorizations[0];
  assert.ok(currentAuthorization);
  currentAuthorization.privyWalletId = "foreign";
  assert.notEqual(
    (await inspectTelegramOnboardingReadiness(input)).state,
    "ready",
    "another wallet's signer is not readiness evidence",
  );
  input.policyState.policy = { ...policy, miniAppHandoffContractVersion: 1 };
  assert.equal(
    (await inspectTelegramOnboardingReadiness(input)).reasonCode,
    "setup_policy_unavailable",
  );
}
{
  const inserts: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("runtime_policies"))
        return { rows: [{ id: "r", payload: policy }] };
      assert.match(sql, /ON CONFLICT \(user_id\) DO NOTHING/);
      inserts.push(params);
      return { rows: [] };
    },
  } as unknown as DbQuery;
  await ensureTelegramBotTradingPreferenceForLink(db, {
    userId: "new",
    isNewLink: true,
  });
  assert.equal(
    inserts[0]?.[1],
    false,
    "always must not auto-request delegated access",
  );
}
{
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("with candidates as"))
        return {
          rows: [
            {
              id: "outbox",
              user_id: "user",
              telegram_account_id: "link",
              telegram_user_id: "123",
              attempt_count: 1,
            },
          ],
        };
      if (sql.includes("select account.telegram_user_id"))
        return { rows: [{ telegram_user_id: "123" }] };
      return { rows: [] };
    },
  } as unknown as DbQuery;
  const result = await deliverTelegramBotOnboardingActions({
    db,
    config: {
      adminUserIds: new Set(),
      appBaseUrl: "https://app.hunch.trade",
      telegramMiniAppLinkBase: null,
    },
    isReady: async () => false,
    telegram: {
      sendMessage: async () => {
        throw new Error("must not send");
      },
    },
  });
  assert.equal(result.sent, 0);
  assert.ok(
    queries.some(
      (query) =>
        query.includes("onboarding_not_ready") &&
        query.includes("interval '24 hours'"),
    ),
  );
}
console.log(
  "[telegram-onboarding-readiness-tests] identity, modes, bounded failure, recovery, policy, preferences and Welcome passed",
);
