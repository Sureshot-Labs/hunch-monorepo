// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";
import {
  assertTelegramBotTradingSetupClaim,
  blockTelegramBotTradingLinkGeneration,
  claimTelegramBotTradingAutoSetup,
  loadTelegramBotTradingPreference,
  setTelegramBotTradingDesiredEnabled,
} from "./services/telegram-bot-trading-preferences.js";

const suffix = crypto.randomUUID();
const userId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const policyId = crypto.randomUUID();
const privyUserId = `did:privy:managed-telegram-${suffix}`;
const telegramUserId = `managed-telegram-${suffix}`;

try {
  await pool.query(
    `INSERT INTO users (id, privy_user_id, is_active, is_verified)
     VALUES ($1, $2, true, true)`,
    [userId, privyUserId],
  );
  await pool.query(
    `INSERT INTO user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id
     ) VALUES ($1, $2, $3, $4)`,
    [accountId, userId, privyUserId, telegramUserId],
  );
  await pool.query(
    `INSERT INTO telegram_bot_trading_preferences (
       user_id, desired_enabled, decision_source, decision_version
     ) VALUES ($1, true, 'auto_link', 1)`,
    [userId],
  );
  await pool.query(
    `INSERT INTO runtime_policies (
       id, policy_key, effective_at, payload, created_by
     ) VALUES ($1, 'signal_bot', now(), $2::jsonb, $3)`,
    [
      policyId,
      JSON.stringify({
        autoEnableOnTelegramLink: true,
        autoManagedMaxAmountUsd: 1,
        autoManagedVenues: ["polymarket"],
        tradingEnabled: true,
        tradingVenues: ["polymarket"],
      }),
      userId,
    ],
  );

  const claimIds = [crypto.randomUUID(), crypto.randomUUID()];
  const concurrent = await Promise.allSettled(
    claimIds.map((claimId) =>
      claimTelegramBotTradingAutoSetup(pool, { claimId, userId }),
    ),
  );
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrent.filter((result) => result.status === "rejected").length,
    1,
  );
  const winningClaim = concurrent.find(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof claimTelegramBotTradingAutoSetup>>
    > => result.status === "fulfilled",
  );
  assert.ok(winningClaim);
  assert.equal(winningClaim.value.target.maxAmountUsd, 1);
  assert.deepEqual(winningClaim.value.target.venues, ["polymarket"]);
  await assert.rejects(
    () =>
      assertTelegramBotTradingSetupClaim(pool, {
        claimId: winningClaim.value.claimId,
        policyRevision: crypto.randomUUID(),
        userId,
      }),
    /telegram_bot_trading_claim_stale/,
  );

  await setTelegramBotTradingDesiredEnabled(pool, {
    desiredEnabled: false,
    source: "manual_disable",
    userId,
  });
  await assert.rejects(
    () =>
      assertTelegramBotTradingSetupClaim(pool, {
        claimId: winningClaim.value.claimId,
        policyRevision: policyId,
        userId,
      }),
    /telegram_bot_trading_claim_stale/,
  );
  const optedOut = await loadTelegramBotTradingPreference(pool, userId);
  assert.equal(optedOut?.desiredEnabled, false);
  assert.equal(optedOut?.decisionVersion, 2);

  await setTelegramBotTradingDesiredEnabled(pool, {
    desiredEnabled: true,
    source: "manual_enable",
    userId,
  });
  const relinkClaim = await claimTelegramBotTradingAutoSetup(pool, {
    claimId: crypto.randomUUID(),
    userId,
  });
  await blockTelegramBotTradingLinkGeneration(pool, userId);
  const afterUnlinkCleanup = await loadTelegramBotTradingPreference(
    pool,
    userId,
  );
  assert.equal(afterUnlinkCleanup?.desiredEnabled, true);

  await pool.query(`DELETE FROM user_telegram_accounts WHERE user_id = $1`, [
    userId,
  ]);
  await pool.query(
    `INSERT INTO user_telegram_accounts (
       id, user_id, privy_user_id, telegram_user_id
     ) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), userId, privyUserId, `${telegramUserId}-relinked`],
  );
  await assert.rejects(
    () =>
      assertTelegramBotTradingSetupClaim(pool, {
        claimId: relinkClaim.claimId,
        policyRevision: policyId,
        userId,
      }),
    /telegram_bot_trading_claim_stale/,
  );

  await pool.query(
    `UPDATE telegram_bot_trading_preferences
        SET desired_enabled = false,
            decision_source = 'legacy_preserved',
            decision_version = 10,
            manual_disabled_at = NULL
      WHERE user_id = $1`,
    [userId],
  );
  const explicitLegacyOptOut = await setTelegramBotTradingDesiredEnabled(pool, {
    desiredEnabled: false,
    source: "manual_disable",
    userId,
  });
  assert.equal(explicitLegacyOptOut.decisionSource, "manual_disable");
  assert.equal(explicitLegacyOptOut.decisionVersion, 11);
  assert.ok(explicitLegacyOptOut.manualDisabledAt);
  const repeatedDisable = await setTelegramBotTradingDesiredEnabled(pool, {
    desiredEnabled: false,
    source: "manual_disable",
    userId,
  });
  assert.equal(repeatedDisable.decisionVersion, 11);

  await setTelegramBotTradingDesiredEnabled(pool, {
    desiredEnabled: true,
    source: "manual_enable",
    userId,
  });
  await pool.query(
    `UPDATE runtime_policies
        SET payload = $2::jsonb
      WHERE id = $1`,
    [
      policyId,
      JSON.stringify({
        autoEnableOnTelegramLink: true,
        autoManagedMaxAmountUsd: 1,
        autoManagedVenues: ["polymarket", "limitless"],
        tradingEnabled: true,
        tradingVenues: ["polymarket", "limitless"],
      }),
    ],
  );
  await assert.rejects(
    () =>
      claimTelegramBotTradingAutoSetup(pool, {
        claimId: crypto.randomUUID(),
        userId,
      }),
    /unsupported_managed_venue:limitless/,
  );

  console.log("[telegram-bot-trading-managed-integration-tests] passed");
} finally {
  await pool.query(`DELETE FROM runtime_policies WHERE id = $1`, [policyId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}
