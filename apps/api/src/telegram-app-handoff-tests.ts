import assert from "node:assert/strict";

import {
  buildTelegramAppHandoffStartParamForIntent,
  cancelTelegramAppHandoff,
  claimTelegramAppHandoff,
  commitTelegramAppHandoff,
  commitTelegramAppHandoffWithExecution,
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
  let authorityFingerprint = AUTHORITY_FINGERPRINT;
  let planSnapshot: Record<string, unknown> = { destination: "polymarket" };
  let planFingerprint = "b".repeat(64);
  let policyRevision = "policy-1";
  let quoteSnapshot: Record<string, unknown> = { maxSpendUsd: "2.50" };
  let tokenHash: string | null = null;
  let v2ConsentClaims = 0;
  const queries: string[] = [];
  const queryParams: unknown[][] = [];
  const row = () => ({
    authority_fingerprint: authorityFingerprint,
    cancelled_at:
      state === "cancelled" ? new Date("2026-08-17T00:01:00Z") : null,
    claimed_at: hadClaim ? new Date("2026-08-17T00:00:10Z") : null,
    claimed_by_user_id: hadClaim ? USER_ID : null,
    committed_at:
      state === "committed" ? new Date("2026-08-17T00:00:20Z") : null,
    expires_at: new Date("2026-08-17T00:10:00Z"),
    expired_at: state === "expired" ? new Date("2026-08-17T00:10:01Z") : null,
    id: HANDOFF_ID,
    plan_fingerprint: planFingerprint,
    plan_snapshot: planSnapshot,
    policy_revision: policyRevision,
    quote_snapshot: quoteSnapshot,
    state,
    telegram_user_id: TELEGRAM_USER_ID,
    trade_intent_id: INTENT_ID,
    user_id: USER_ID,
  });
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queryParams.push(params);
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      queries.push(normalized);
      if (["begin", "commit", "rollback"].includes(normalized))
        return { rows: [] };
      if (normalized === "select 'live_fence'") return { rows: [] };
      if (normalized.startsWith("insert into telegram_app_handoffs")) {
        assert.match(
          normalized,
          /on conflict do nothing/u,
          "real PostgreSQL retries must remain readable after a uniqueness conflict",
        );
        if (params[11] === true) {
          assert.match(
            normalized,
            /intent\.result -> 'apphandoffv2' -> 'plan' = \$9::jsonb/u,
            "v2 issue must seal only the plan stored on the trade intent",
          );
          assert.match(
            normalized,
            /intent\.quote_snapshot = \$8::jsonb/u,
            "v2 issue must seal only the quote stored on the trade intent",
          );
        }
        if (handoffIssued) return { rows: [] };
        handoffIssued = true;
        tokenHash = String(params[3]);
        planFingerprint = String(params[4]);
        policyRevision = String(params[5]);
        authorityFingerprint = String(params[6]);
        quoteSnapshot = JSON.parse(String(params[7])) as Record<
          string,
          unknown
        >;
        planSnapshot = JSON.parse(String(params[8])) as Record<string, unknown>;
        return { rows: [row()] };
      }
      if (normalized.startsWith("select exists("))
        return { rows: [{ exists: handoffIssued }] };
      if (
        normalized.includes("from telegram_app_handoffs") &&
        normalized.includes("where trade_intent_id = $1::uuid")
      ) {
        return {
          rows:
            params[0] === INTENT_ID && params[1] === tokenHash ? [row()] : [],
        };
      }
      if (
        normalized.startsWith(
          "update telegram_app_handoffs handoff_row set state = 'expired'",
        )
      ) {
        return { rows: [] };
      }
      if (
        normalized.startsWith(
          "update telegram_trade_intents trade_intent set status = 'expired'",
        ) ||
        normalized.startsWith(
          "update telegram_app_handoffs handoff_row set state = case",
        )
      ) {
        return { rowCount: 0, rows: [] };
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
      if (normalized.startsWith("update telegram_trade_intents intent")) {
        assert.equal(params[0], INTENT_ID);
        if (normalized.includes("set status = 'cancelled'")) {
          return { rowCount: 1, rows: [] };
        }
        if (normalized.includes("'version', 2")) {
          assert.match(
            normalized,
            /error_code = case when intent\.error_code = 'external_handoff_required' then null else intent\.error_code end/u,
            "committing v2 must clear the obsolete pre-commit routing marker",
          );
          assert.match(
            normalized,
            /error_message = case when intent\.error_code = 'external_handoff_required' then null else intent\.error_message end/u,
            "the marker message must not stop the committed Mini App execution",
          );
        }
        assert.equal(params[2], HANDOFF_ID);
        return { rowCount: 1, rows: [] };
      }
      if (
        normalized.startsWith("update telegram_trade_intents trade_intent") &&
        normalized.includes("'apphandoffconsent'")
      ) {
        assert.doesNotMatch(
          normalized,
          /set status\s*=/u,
          "claim cannot change trade status before its v2 execution marker exists",
        );
        assert.equal(params[0], INTENT_ID);
        assert.equal(params[1], USER_ID);
        assert.equal(params[3], HANDOFF_ID);
        assert.equal(params[4], TELEGRAM_USER_ID);
        assert.deepEqual(JSON.parse(String(params[5])), planSnapshot);
        assert.deepEqual(JSON.parse(String(params[6])), quoteSnapshot);
        v2ConsentClaims += 1;
        return { rowCount: 1, rows: [] };
      }
      if (normalized.includes("set state = 'cancelled'")) {
        assert.ok(
          state === "issued" || state === "claimed" || state === "committed",
        );
        state = "cancelled";
        return { rows: [row()] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release: () => undefined,
  };
  return {
    getV2ConsentClaims: () => v2ConsentClaims,
    getQueries: () => queries,
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
  assertCurrentIntent: async (client) => {
    await client.query("select 'live_fence'");
    return true;
  },
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: fixture.pool as never,
  planSnapshot: { destination: "polymarket" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
assert.ok(
  fixture.getQueries().indexOf("select 'live_fence'") <
    fixture
      .getQueries()
      .findIndex((query) =>
        query.startsWith("insert into telegram_app_handoffs"),
      ),
  "the current-intent fence runs inside the issue transaction before INSERT",
);
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
const staleAtIssue = createFakePool();
await assert.rejects(
  issueTelegramAppHandoff({
    assertCurrentIntent: async () => false,
    authorityFingerprint: AUTHORITY_FINGERPRINT,
    db: staleAtIssue.pool as never,
    planSnapshot: { destination: "polymarket" },
    policyRevision: "policy-1",
    quoteSnapshot: { maxSpendUsd: "2.50" },
    telegramUserId: TELEGRAM_USER_ID,
    tradeIntentId: INTENT_ID,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "policy_changed",
);
assert.equal(
  staleAtIssue
    .getQueries()
    .some((query) => query.startsWith("insert into telegram_app_handoffs")),
  false,
  "a stale product intent cannot mint or reuse a handoff token",
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

const deterministic = createFakePool();
const deterministicFirst = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: deterministic.pool as never,
  planSnapshot: { destination: "polymarket" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tokenSecret: "test-delivery-secret",
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
const deterministicRetry = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: deterministic.pool as never,
  planSnapshot: { destination: "polymarket" },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tokenSecret: "test-delivery-secret",
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
assert.equal(
  deterministicRetry.token,
  deterministicFirst.token,
  "delivery retries recover the same opaque token without storing it raw",
);
await assert.rejects(
  issueTelegramAppHandoff({
    authorityFingerprint: AUTHORITY_FINGERPRINT,
    db: deterministic.pool as never,
    planSnapshot: { destination: "polymarket" },
    policyRevision: "policy-1",
    quoteSnapshot: { maxSpendUsd: "2.75" },
    telegramUserId: TELEGRAM_USER_ID,
    tokenSecret: "test-delivery-secret",
    tradeIntentId: INTENT_ID,
    userId: USER_ID,
  }),
  (error: unknown) =>
    error instanceof TelegramAppHandoffError && error.code === "plan_changed",
  "an already-issued Review token cannot silently adopt a newer quote",
);
assert.equal(
  buildTelegramAppHandoffStartParamForIntent({
    telegramUserId: TELEGRAM_USER_ID,
    tokenSecret: "test-delivery-secret",
    tradeIntentId: INTENT_ID,
    userId: USER_ID,
  }),
  deterministicFirst.startParam,
  "a later Telegram card can rebuild the exact existing handoff link without storing the raw token",
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

const resolveQueryStart = fixture.getQueries().length;
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
const resolveQueries = fixture.getQueries().slice(resolveQueryStart);
assert.match(resolveQueries[1] ?? "", /for update of handoff_row/u);
assert.match(
  resolveQueries[2] ?? "",
  /^update telegram_trade_intents trade_intent/u,
  "handoff access must lock the handoff before reconciling its intent",
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
  "commit retries attach to the same consumed handoff",
);

const v2Commit = createFakePool();
const v2Issued = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: v2Commit.pool as never,
  planSnapshot: {
    kind: "funding",
    trade: { action: "buy" },
    version: 2,
  },
  policyRevision: "policy-1",
  quoteSnapshot: { maxSpendUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
await claimTelegramAppHandoff({
  db: v2Commit.pool as never,
  telegramUserId: TELEGRAM_USER_ID,
  token: v2Issued.token,
  userId: USER_ID,
});
assert.equal(
  v2Commit.getV2ConsentClaims(),
  1,
  "opening a v2 funding link atomically confirms its Buy intent",
);
let v2ExecutionCalls = 0;
const commitV2 = async () =>
  commitTelegramAppHandoffWithExecution({
    commitExecution: async () => {
      v2ExecutionCalls += 1;
      return { fundingOperationId: "00000000-0000-4000-8000-000000000004" };
    },
    currentAuthorityFingerprint: AUTHORITY_FINGERPRINT,
    currentPolicyRevision: "policy-1",
    db: v2Commit.pool as never,
    planFingerprint: v2Issued.handoff.planFingerprint,
    telegramUserId: TELEGRAM_USER_ID,
    token: v2Issued.token,
    userId: USER_ID,
  });
const v2First = await commitV2();
const v2Retry = await commitV2();
assert.equal(v2First.handoff.state, "committed");
assert.deepEqual(v2Retry.execution, v2First.execution);
assert.equal(
  v2ExecutionCalls,
  2,
  "the v2 callback runs on retry and must return the same existing operation",
);

const v2SellIssue = createFakePool();
const v2SellIssued = await issueTelegramAppHandoff({
  authorityFingerprint: AUTHORITY_FINGERPRINT,
  db: v2SellIssue.pool as never,
  planSnapshot: {
    kind: "direct_trade",
    trade: { action: "sell" },
    version: 2,
  },
  policyRevision: "policy-1",
  quoteSnapshot: { minimumReceiveUsd: "2.50" },
  telegramUserId: TELEGRAM_USER_ID,
  tradeIntentId: INTENT_ID,
  userId: USER_ID,
});
assert.deepEqual(
  v2SellIssue.queryParams.find((params) => Array.isArray(params[10]))?.[10],
  ["sell"],
  "a direct v2 Sell handoff can be issued only for a Sell intent",
);
await claimTelegramAppHandoff({
  db: v2SellIssue.pool as never,
  telegramUserId: TELEGRAM_USER_ID,
  token: v2SellIssued.token,
  userId: USER_ID,
});
assert.equal(
  v2SellIssue.getV2ConsentClaims(),
  1,
  "opening a v2 Sell link atomically records consent on its trade intent",
);
await commitTelegramAppHandoffWithExecution({
  allowedIntentActions: ["sell"],
  allowedIntentStatuses: ["previewed", "confirming", "external_handoff"],
  commitExecution: async () => ({ directTrade: true }),
  committedIntentStatus: "external_handoff",
  currentAuthorityFingerprint: AUTHORITY_FINGERPRINT,
  currentPolicyRevision: "policy-1",
  db: v2SellIssue.pool as never,
  executionKind: "direct_trade",
  planFingerprint: v2SellIssued.handoff.planFingerprint,
  telegramUserId: TELEGRAM_USER_ID,
  token: v2SellIssued.token,
  userId: USER_ID,
});
assert.equal(
  (
    await cancelTelegramAppHandoff({
      db: v2SellIssue.pool as never,
      telegramUserId: TELEGRAM_USER_ID,
      token: v2SellIssued.token,
      userId: USER_ID,
    })
  ).state,
  "cancelled",
  "a committed direct Sell stays cancellable until a direct provider claim",
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
assert.equal(
  (
    await resolveTelegramAppHandoff({
      db: cancellable.pool as never,
      telegramUserId: TELEGRAM_USER_ID,
      token: second.token,
      userId: USER_ID,
    })
  ).state,
  "cancelled",
  "a cancelled handoff remains observable so the Mini App can resume safely",
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
