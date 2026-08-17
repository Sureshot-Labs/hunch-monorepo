import assert from "node:assert/strict";

import {
  cancelTelegramAppHandoff,
  claimTelegramAppHandoff,
  commitTelegramAppHandoff,
  issueTelegramAppHandoff,
  parseTelegramAppHandoffStartParam,
  resolveTelegramAppHandoff,
  TelegramAppHandoffError,
} from "./services/telegram-app-handoff.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const INTENT_ID = "00000000-0000-4000-8000-000000000002";
const HANDOFF_ID = "00000000-0000-4000-8000-000000000003";
const TELEGRAM_USER_ID = "42";
const AUTHORITY_FINGERPRINT = "a".repeat(64);

function createFakePool() {
  let state: "issued" | "claimed" | "committed" | "cancelled" | "expired" =
    "issued";
  let hadClaim = false;
  let handoffIssued = false;
  let tokenHash: string | null = null;
  const queryParams: unknown[][] = [];
  const row = () => ({
    authority_fingerprint: AUTHORITY_FINGERPRINT,
    cancelled_at:
      state === "cancelled" ? new Date("2026-08-17T00:01:00Z") : null,
    claimed_at: hadClaim ? new Date("2026-08-17T00:00:10Z") : null,
    claimed_by_user_id: hadClaim ? USER_ID : null,
    committed_at:
      state === "committed" ? new Date("2026-08-17T00:00:20Z") : null,
    expires_at: new Date("2026-08-17T00:10:00Z"),
    expired_at: state === "expired" ? new Date("2026-08-17T00:10:01Z") : null,
    id: HANDOFF_ID,
    plan_fingerprint: "b".repeat(64),
    plan_snapshot: { destination: "polymarket" },
    policy_revision: "policy-1",
    quote_snapshot: { maxSpendUsd: "2.50" },
    state,
    telegram_user_id: TELEGRAM_USER_ID,
    trade_intent_id: INTENT_ID,
    user_id: USER_ID,
  });
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queryParams.push(params);
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalized))
        return { rows: [] };
      if (normalized.startsWith("insert into telegram_app_handoffs")) {
        if (handoffIssued) return { rows: [] };
        handoffIssued = true;
        tokenHash = String(params[3]);
        return { rows: [row()] };
      }
      if (normalized.startsWith("select exists("))
        return { rows: [{ exists: handoffIssued }] };
      if (
        normalized.startsWith(
          "update telegram_app_handoffs handoff_row set state = 'expired'",
        )
      ) {
        return { rows: [] };
      }
      if (normalized.includes("from telegram_app_handoffs handoff_row")) {
        const requestedHash = params[0];
        const requestedUserId = params[1];
        const requestedTelegramUserId = params[2];
        return {
          rows:
            requestedHash === tokenHash &&
            requestedUserId === USER_ID &&
            requestedTelegramUserId === TELEGRAM_USER_ID
              ? [row()]
              : [],
        };
      }
      if (normalized.includes("set state = 'claimed'")) {
        assert.equal(state, "issued");
        state = "claimed";
        hadClaim = true;
        return { rows: [row()] };
      }
      if (normalized.includes("set state = 'committed'")) {
        assert.equal(state, "claimed");
        state = "committed";
        return { rows: [row()] };
      }
      if (normalized.includes("set state = 'cancelled'")) {
        assert.ok(state === "issued" || state === "claimed");
        state = "cancelled";
        return { rows: [row()] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client },
    queryParams,
    setState: (nextState: typeof state) => {
      state = nextState;
      hadClaim = nextState === "claimed" || nextState === "committed";
    },
  };
}

const fixture = createFakePool();
const issued = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: fixture.pool as never,
  planSnapshot: { destination: "polymarket" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
assert.equal(issued.handoff.state, "issued");
assert.equal(issued.startParam, `handoff_${issued.token}`);
assert.equal(
  issued.startParam.length,
  55,
  "startapp token stays below Telegram's 64-byte limit",
);
assert.equal(
  parseTelegramAppHandoffStartParam(issued.startParam),
  issued.token,
);
assert.equal(parseTelegramAppHandoffStartParam("handoff_th1_short"), null);
assert.equal(
  parseTelegramAppHandoffStartParam("b_any_other_start_param"),
  null,
);
assert.equal(
  fixture.queryParams.flat().some((value) => value === issued.token),
  false,
  "the raw startapp token must never reach SQL parameters",
);
await assert.rejects(
  issueTelegramAppHandoff({
    authorityFingerprint: AUTHORITY_FINGERPRINT,
    db: fixture.pool as never,
    planSnapshot: { destination: "polymarket" },
    policyRevision: "policy-1",
    quoteSnapshot: { maxSpendUsd: "2.50" },
    telegramUserId: TELEGRAM_USER_ID,
    tradeIntentId: INTENT_ID,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "already_issued",
);
await assert.rejects(
  resolveTelegramAppHandoff({
    db: fixture.pool as never,
    telegramUserId: TELEGRAM_USER_ID,
    token: "th1_invalid",
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "invalid_token",
);
await assert.rejects(
  resolveTelegramAppHandoff({
    db: fixture.pool as never,
    telegramUserId: TELEGRAM_USER_ID,
    token: issued.token,
    userId: "00000000-0000-4000-8000-000000000004",
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "not_found",
);

assert.equal(
  (
    await resolveTelegramAppHandoff({
      db: fixture.pool as never,
      telegramUserId: TELEGRAM_USER_ID,
      token: issued.token,
      userId: USER_ID,
    })
  ).state,
  "issued",
);
assert.equal(
  (
    await claimTelegramAppHandoff({
      db: fixture.pool as never,
      telegramUserId: TELEGRAM_USER_ID,
      token: issued.token,
      userId: USER_ID,
    })
  ).state,
  "claimed",
);
assert.equal(
  (
    await claimTelegramAppHandoff({
      db: fixture.pool as never,
      telegramUserId: TELEGRAM_USER_ID,
      token: issued.token,
      userId: USER_ID,
    })
  ).state,
  "claimed",
  "a second tab may observe, but cannot create a second claim",
);
await assert.rejects(
  commitTelegramAppHandoff({
    currentAuthorityFingerprint: AUTHORITY_FINGERPRINT,
    currentPolicyRevision: "policy-2",
    db: fixture.pool as never,
    planFingerprint: issued.handoff.planFingerprint,
    telegramUserId: TELEGRAM_USER_ID,
    token: issued.token,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "policy_changed",
);
await assert.rejects(
  commitTelegramAppHandoff({
    currentAuthorityFingerprint: AUTHORITY_FINGERPRINT,
    currentPolicyRevision: "policy-1",
    db: fixture.pool as never,
    planFingerprint: "c".repeat(64),
    telegramUserId: TELEGRAM_USER_ID,
    token: issued.token,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "plan_changed",
);
assert.equal(
  (
    await commitTelegramAppHandoff({
      currentAuthorityFingerprint: AUTHORITY_FINGERPRINT,
      currentPolicyRevision: "policy-1",
      db: fixture.pool as never,
      planFingerprint: issued.handoff.planFingerprint,
      telegramUserId: TELEGRAM_USER_ID,
      token: issued.token,
      userId: USER_ID,
    })
  ).state,
  "committed",
);

const cancellable = createFakePool();
const second = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: cancellable.pool as never,
  planSnapshot: { destination: "limitless" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "5.00" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
const cancelled = await cancelTelegramAppHandoff({
  db: cancellable.pool as never,
  telegramUserId: TELEGRAM_USER_ID,
  token: second.token,
  userId: USER_ID,
});
assert.equal(cancelled.state, "cancelled");
assert.equal(
  cancelled.claimedAt,
  null,
  "cancelling an unclaimed handoff must not manufacture a claim",
);
await assert.rejects(
  resolveTelegramAppHandoff({
    db: cancellable.pool as never,
    telegramUserId: TELEGRAM_USER_ID,
    token: second.token,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "not_claimable",
);

const expired = createFakePool();
const expiredIssued = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: expired.pool as never,
  planSnapshot: { destination: "polymarket" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "1.00" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
expired.setState("expired");
await assert.rejects(
  resolveTelegramAppHandoff({
    db: expired.pool as never,
    telegramUserId: TELEGRAM_USER_ID,
    token: expiredIssued.token,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "expired",
);

console.log("[telegram-app-handoff-tests] passed");
