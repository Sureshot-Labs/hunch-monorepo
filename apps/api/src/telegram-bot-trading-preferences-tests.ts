import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getDefaultSignalBotPolicy,
  normalizeSignalBotPolicy,
} from "./services/signal-bot-trading-policy.js";
import {
  claimTelegramBotTradingAutoSetup,
  resolveTelegramBotTradingEffectiveMaxAmountUsd,
  resolveTelegramBotTradingManagedTarget,
} from "./services/telegram-bot-trading-preferences.js";

const managedPolicy = normalizeSignalBotPolicy({
  ...getDefaultSignalBotPolicy(),
  autoEnableOnTelegramLink: true,
  autoManagedMaxAmountUsd: 5,
  autoManagedVenues: ["polymarket", "limitless"],
  maxTradeAmountUsd: 3,
  requireConfirmation: false,
  tradingEnabled: true,
  tradingVenues: ["polymarket", "limitless"],
});

assert.equal(managedPolicy.autoManagedMaxAmountUsd, 3);
assert.equal(managedPolicy.requireConfirmation, true);
assert.deepEqual(
  resolveTelegramBotTradingManagedTarget({
    policy: managedPolicy,
    policyRevision: "policy-1",
  }),
  {
    maxAmountUsd: 3,
    policyRevision: "policy-1",
    venues: ["polymarket"],
  },
);
assert.equal(
  resolveTelegramBotTradingEffectiveMaxAmountUsd({
    authorizationMaxAmountUsd: 5,
    policy: { ...managedPolicy, autoManagedMaxAmountUsd: 1 },
    signerPolicyMaxAmountUsd: 10,
  }),
  1,
);
assert.equal(
  resolveTelegramBotTradingEffectiveMaxAmountUsd({
    authorizationMaxAmountUsd: 1,
    policy: { ...managedPolicy, autoManagedMaxAmountUsd: 5 },
    signerPolicyMaxAmountUsd: 10,
  }),
  1,
);
assert.equal(
  resolveTelegramBotTradingEffectiveMaxAmountUsd({
    authorizationMaxAmountUsd: 5,
    policy: { ...managedPolicy, autoManagedMaxAmountUsd: 5 },
    signerPolicyMaxAmountUsd: 2,
  }),
  2,
);

const migration = readFileSync(
  new URL(
    "../../../packages/db/migrations/0181_telegram_bot_trading_preferences.sql",
    import.meta.url,
  ),
  "utf8",
);
const preferencesSource = readFileSync(
  new URL("./services/telegram-bot-trading-preferences.ts", import.meta.url),
  "utf8",
);
assert.match(
  migration,
  /SELECT user_id FROM user_telegram_accounts\s+UNION\s+SELECT user_id FROM telegram_bot_trading_authorizations/i,
);
assert.match(migration, /legacy_state\.desired_enabled/i);
assert.doesNotMatch(
  migration,
  /WHEN legacy_state\.desired_enabled THEN NULL\s+ELSE now\(\)/i,
);
assert.match(
  preferencesSource,
  /VALUES \(\$1, \$2, \$3, 1, NULL, now\(\), now\(\)\)/,
);

const preference = {
  applied_policy_revision: null,
  blocked_telegram_account_id: null,
  claim_decision_version: null as number | null,
  claim_expires_at: null as Date | null,
  claim_id: null as string | null,
  claim_policy_revision: null as string | null,
  claim_telegram_account_id: null as string | null,
  decision_source: "auto_link",
  decision_version: 1,
  desired_enabled: true,
  last_setup_error_code: null,
  manual_disabled_at: null,
  retry_after: null,
  retry_attempt_count: 0,
  setup_blocked: false,
  telegram_account_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000001",
};

const fakeDb = {
  query: async (sql: string, params: unknown[] = []) => {
    if (/from runtime_policies/i.test(sql)) {
      return {
        rows: [
          {
            id: "policy-1",
            payload: {
              autoEnableOnTelegramLink: true,
              autoManagedMaxAmountUsd: 1,
              autoManagedVenues: ["polymarket"],
              tradingEnabled: true,
              tradingVenues: ["polymarket"],
            },
          },
        ],
      };
    }
    if (/FOR UPDATE OF p/i.test(sql)) {
      return { rows: [{ ...preference }] };
    }
    if (/UPDATE telegram_bot_trading_preferences/i.test(sql)) {
      preference.claim_id = String(params[1]);
      preference.claim_telegram_account_id = String(params[2]);
      preference.claim_decision_version = preference.decision_version;
      preference.claim_policy_revision = String(params[3]);
      preference.claim_expires_at = new Date(Date.now() + 10 * 60_000);
      return { rowCount: 1, rows: [{ ...preference }] };
    }
    return { rows: [] };
  },
};

const firstClaimId = "00000000-0000-4000-8000-000000000010";
const claim = await claimTelegramBotTradingAutoSetup(fakeDb as never, {
  claimId: firstClaimId,
  userId: preference.user_id,
});
assert.equal(claim.claimId, firstClaimId);
assert.deepEqual(claim.target.venues, ["polymarket"]);
assert.equal(claim.target.maxAmountUsd, 1);

await assert.rejects(
  () =>
    claimTelegramBotTradingAutoSetup(fakeDb as never, {
      claimId: "00000000-0000-4000-8000-000000000011",
      userId: preference.user_id,
    }),
  /telegram_bot_trading_claim_held/,
);

const renewed = await claimTelegramBotTradingAutoSetup(fakeDb as never, {
  claimId: firstClaimId,
  userId: preference.user_id,
});
assert.equal(renewed.claimId, firstClaimId);

preference.claim_policy_revision = "policy-old";
await assert.rejects(
  () =>
    claimTelegramBotTradingAutoSetup(fakeDb as never, {
      claimId: firstClaimId,
      userId: preference.user_id,
    }),
  /telegram_bot_trading_claim_stale/,
);
preference.claim_policy_revision = "policy-1";

preference.claim_expires_at = new Date(Date.now() - 1_000);
const replacementClaimId = "00000000-0000-4000-8000-000000000011";
const replaced = await claimTelegramBotTradingAutoSetup(fakeDb as never, {
  claimId: replacementClaimId,
  userId: preference.user_id,
});
assert.equal(replaced.claimId, replacementClaimId);

console.log("[telegram-bot-trading-preferences-tests] passed");
