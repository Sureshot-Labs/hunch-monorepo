// @requires-db — committed synthetic rows in explicit disposable PG16 only.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { tx, type PoolClient } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import {
  canonicalJsonHash,
  hashOpaqueToken,
} from "./funding/persistence/canonical.js";
import { lockFundingPolicyForTransaction } from "./funding/policies/funding-policy-sidecar.js";
import { telegramAppHandoffV2CurrentScope } from "./services/telegram-bot-trading.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "./services/signal-bot-trading-policy.js";
import { telegramBotTradeAuthorityFingerprint } from "./services/telegram-bot-trade-input-context.js";
import {
  cancelTelegramAppHandoff,
  commitTelegramAppHandoffWithExecution,
  TelegramAppHandoffError,
} from "./services/telegram-app-handoff.js";
import {
  claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction as claim,
  TelegramAppHandoffV2DirectTradeError,
  type TelegramAppHandoffV2ScopeAssertion,
} from "./repos/telegram-app-handoff-v2-direct-trade-repository.js";

const pool = await createIntegrationTestPool({
  max: 6,
  options: "-c statement_timeout=8000 -c lock_timeout=6000",
});
let policyId: string | undefined;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function blocked(pid: number, blocker: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const found = await pool.query(
      "select $2::int=any(pg_blocking_pids($1::int)) as blocked",
      [pid, blocker],
    );
    if (found.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("expected real PostgreSQL lock wait was not observed");
}
const pid = async (db: PoolClient) =>
  Number((await db.query("select pg_backend_pid() as pid")).rows[0].pid);
async function fixture(side: "buy" | "sell" = "buy") {
  return tx(pool, async (db) => {
    const base = await hip4OrderTestFixture(db);
    const intentId = randomUUID(),
      handoffId = randomUUID();
    const telegramUserId = `88${BigInt(`0x${randomBytes(7).toString("hex")}`)}`;
    const token = `th1_${randomBytes(32).toString("base64url")}`;
    const fingerprint = canonicalJsonHash(handoffId);
    const privyWalletId = `offline-wallet-${randomUUID()}`;
    await db.query("update users set privy_user_id=$2 where id=$1", [
      base.userId,
      `did:privy:${base.userId}`,
    ]);
    await db.query(
      "update user_wallets set wallet_source='embedded',is_internal_wallet=true,privy_wallet_id=$2 where id=$1",
      [base.profile.controllerWalletRef, privyWalletId],
    );
    const telegramLinkId = (
      await db.query(
        "insert into user_telegram_accounts(user_id,privy_user_id,telegram_user_id) values($1,$2,$3) returning id",
        [base.userId, `did:privy:${base.userId}`, telegramUserId],
      )
    ).rows[0].id;
    const authority = {
      authorizationId: null,
      privyWalletId,
      telegramAccountLinkId: telegramLinkId,
      userId: base.userId,
      walletAddress: base.profile.address,
      walletChain: "ethereum" as const,
    };
    const authorityFingerprint =
      telegramBotTradeAuthorityFingerprint(authority);
    const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
    const plan = {
      version: 2,
      executionContractVersion: 2,
      kind: "direct_trade",
      trade: {
        action: side,
        venue: "polymarket",
        marketId: base.request.marketId,
        eventId: base.request.marketId,
        outcomeTokenId: "offline-yes-token",
        side: "YES",
        maxSlippageBps: 100,
        controllerWalletAddress: base.profile.address,
        ...(side === "buy"
          ? { amountUsd: 1, maxSpendUsd: 1.5, minReceiveShares: null }
          : { sharesRaw: "1000000", minimumReceiveRaw: "100000" }),
      },
    };
    await db.query(
      `insert into telegram_trade_intents(id,telegram_user_id,user_id,action,venue,market_id,event_id,side,shares_raw,amount_usd,status,result,expires_at,idempotency_key,delivery_mode)
      values($1,$2,$3,$4,'polymarket',$5,$5,'YES',$6,$7,'external_handoff',$8::jsonb,clock_timestamp()+interval '30 minutes',$9,'app_handoff')`,
      [
        intentId,
        telegramUserId,
        base.userId,
        side,
        base.request.marketId,
        side === "sell" ? "1000000" : null,
        side === "buy" ? "1.00" : null,
        {
          telegramAuthority: { ...authority, version: 1 },
          appHandoffV2: { version: 2, plan },
          appHandoffExecution: {
            version: 2,
            kind: "direct_trade",
            handoffId,
            committedAt: new Date().toISOString(),
          },
        },
        `offline-lock:${intentId}`,
      ],
    );
    await db.query(
      `insert into telegram_app_handoffs(id,trade_intent_id,user_id,telegram_user_id,token_hash,state,plan_fingerprint,policy_revision,authority_fingerprint,quote_snapshot,plan_snapshot,issued_at,expires_at,claimed_at,claimed_by_user_id,committed_at)
      values($1,$2,$3,$4,$5,'committed',$6,$8,$9,'{}'::jsonb,$7::jsonb,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp(),$3,clock_timestamp())`,
      [
        handoffId,
        intentId,
        base.userId,
        telegramUserId,
        hashOpaqueToken(token),
        fingerprint,
        plan,
        policyState.policyRevision,
        authorityFingerprint,
      ],
    );
    return {
      userId: base.userId,
      intentId,
      handoffId,
      token,
      telegramUserId,
      marketId: base.request.marketId,
      controllerWalletRef: base.profile.controllerWalletRef,
      telegramLinkId,
      authorityFingerprint,
      policyRevision: policyState.policyRevision,
      binding: { handoffId, planFingerprint: fingerprint },
      submission: {
        action: side,
        venue: "polymarket" as const,
        executionKind: "clob" as const,
        marketId: base.request.marketId,
        outcomeTokenId: "offline-yes-token",
        signer: base.profile.address,
        spendRaw: "1000000",
        receiveRaw: "2000000",
      },
      reconcileKeys: {
        tradeType: "clob" as const,
        orderHash: `0x${fingerprint}`,
      },
    };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const status = async (f: Fixture) =>
  (
    await pool.query("select status from telegram_trade_intents where id=$1", [
      f.intentId,
    ])
  ).rows[0].status;
async function claimOn(
  db: PoolClient,
  f: Fixture,
  validate: TelegramAppHandoffV2ScopeAssertion["validate"] = telegramAppHandoffV2CurrentScope.validate,
) {
  return claim(db, {
    userId: f.userId,
    binding: f.binding,
    submission: f.submission,
    reconcileKeys: f.reconcileKeys,
    recoveryPayload: {},
    // Production locks and validation run unchanged, except explicit race/replay
    // hooks below. No bot authorization or provider call is created.
    assertCurrentScope: {
      lockAuthority: telegramAppHandoffV2CurrentScope.lockAuthority,
      validate,
    },
    readSellPositionAvailableRaw: async () => "10000000",
  });
}
async function assertHandoffAndIntentUnlocked(f: Fixture) {
  const inspector = await pool.connect();
  try {
    await inspector.query("begin");
    await inspector.query(
      "select id from telegram_app_handoffs where id=$1 for update nowait",
      [f.handoffId],
    );
    await inspector.query(
      "select id from telegram_trade_intents where id=$1 for update nowait",
      [f.intentId],
    );
  } finally {
    await inspector.query("rollback");
    inspector.release();
  }
}

try {
  policyId = (
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
      [
        {
          miniAppHandoffMode: "always",
          miniAppHandoffContractVersion: 2,
          buyContinuationEnabled: true,
          fundingReceiveEnabled: true,
          tradingEnabled: true,
          tradingActions: ["buy", "sell"],
        },
      ],
    )
  ).rows[0].id;
  for (const side of ["buy", "sell"] as const) {
    const f = await fixture(side);
    assert.equal(
      await tx(pool, (db) =>
        telegramAppHandoffV2CurrentScope.validate({
          action: side,
          authorityFingerprint: f.authorityFingerprint,
          db: { query: db.query.bind(db) },
          policyRevision: f.policyRevision,
          telegramUserId: f.telegramUserId,
          tradeIntentId: f.intentId,
          userId: f.userId,
          venue: "polymarket",
        }),
      ),
      true,
      "the complete live legacy authority must pass before any race",
    );
    const issuer = await pool.connect(),
      consumer = await pool.connect();
    try {
      await issuer.query("begin");
      await consumer.query("begin");
      // Review issuance uses this existing namespace before its authority and
      // intent write, without acquiring global funding policy.
      await issuer.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`telegram-bot-trade:${f.telegramUserId}:${f.marketId}`],
      );
      const consumerPid = await pid(consumer),
        issuerPid = await pid(issuer);
      const work = claimOn(consumer, f);
      await blocked(consumerPid, issuerPid);
      await assertHandoffAndIntentUnlocked(f);
      // Issuer can finish U → I while the financial consumer is waiting at M.
      await issuer.query("select id from users where id=$1 for update nowait", [
        f.userId,
      ]);
      await issuer.query(
        "select id from telegram_trade_intents where id=$1 for update nowait",
        [f.intentId],
      );
      await issuer.query("commit");
      await work;
      await consumer.query("commit");
      assert.equal(await status(f), "executing");
      await tx(pool, (db) =>
        claimOn(db, f, async () => {
          assert.fail("durable exact replay must not revalidate eligibility");
        }),
      );
    } finally {
      await issuer.query("rollback");
      await consumer.query("rollback");
      issuer.release();
      consumer.release();
    }

    const cancelled = await fixture(side);
    const cancelLocked = barrier(),
      continueCancel = barrier();
    let cancelPid = 0;
    const cancelPool = {
      connect: async () => {
        const db = await pool.connect();
        cancelPid = await pid(db);
        return {
          release: () => db.release(),
          query: async (sql: string, values?: never) => {
            const result = await db.query(sql, values);
            if (sql.includes("limit 1 for update of handoff_row")) {
              cancelLocked.resolve();
              await continueCancel.promise;
            }
            return result;
          },
        };
      },
    };
    const cancellation = cancelTelegramAppHandoff({
      db: cancelPool as never,
      userId: cancelled.userId,
      telegramUserId: cancelled.telegramUserId,
      token: cancelled.token,
    });
    await cancelLocked.promise;
    const racing = await pool.connect();
    try {
      await racing.query("begin");
      const racingPid = await pid(racing);
      const work = claimOn(racing, cancelled);
      await blocked(racingPid, cancelPid);
      // Cancel already owns H. It must still be able to lock I immediately.
      const inspect = await pool.connect();
      try {
        await inspect.query("begin");
        await inspect.query(
          "select id from telegram_trade_intents where id=$1 for update nowait",
          [cancelled.intentId],
        );
        for (const [query, id] of [
          [
            "select id from user_wallets where id=$1::uuid for update nowait",
            cancelled.controllerWalletRef,
          ],
          [
            "select id from user_telegram_accounts where id=$1::uuid for update nowait",
            cancelled.telegramLinkId,
          ],
        ] as const) {
          await inspect.query("savepoint held_authority_row");
          await assert.rejects(
            inspect.query(query, [id]),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "55P03",
            "production wallet/link authority must already be locked before H/I",
          );
          await inspect.query("rollback to savepoint held_authority_row");
        }
      } finally {
        await inspect.query("rollback");
        inspect.release();
      }
      continueCancel.resolve();
      assert.equal((await cancellation).state, "cancelled");
      await assert.rejects(
        work,
        (error: unknown) =>
          error instanceof TelegramAppHandoffV2DirectTradeError,
      );
      await racing.query("rollback");
      assert.equal(await status(cancelled), "cancelled");
    } finally {
      continueCancel.resolve();
      await racing.query("rollback");
      racing.release();
    }

    const accepted = await fixture(side),
      validating = barrier(),
      continueClaim = barrier();
    let claimingPid = 0;
    const claimed = tx(pool, async (db) => {
      claimingPid = await pid(db);
      return claimOn(db, accepted, async () => {
        validating.resolve();
        await continueClaim.promise;
        return true;
      });
    });
    await validating.promise;
    const cancelStarted = barrier();
    let losingCancelPid = 0;
    const losingCancelPool = {
      connect: async () => {
        const db = await pool.connect();
        losingCancelPid = await pid(db);
        cancelStarted.resolve();
        return db;
      },
    };
    const losingCancel = cancelTelegramAppHandoff({
      db: losingCancelPool as never,
      userId: accepted.userId,
      telegramUserId: accepted.telegramUserId,
      token: accepted.token,
    });
    await cancelStarted.promise;
    await blocked(losingCancelPid, claimingPid);
    continueClaim.resolve();
    await claimed;
    await assert.rejects(
      losingCancel,
      (error: unknown) =>
        error instanceof TelegramAppHandoffError &&
        error.code === "not_cancellable",
    );
    assert.equal(await status(accepted), "executing");
  }

  const changed = await fixture(),
    changingReview = await pool.connect(),
    changedConsumer = await pool.connect();
  try {
    await changingReview.query("begin");
    await changedConsumer.query("begin");
    await changingReview.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`telegram-bot-trade:${changed.telegramUserId}:${changed.marketId}`],
    );
    const changedConsumerPid = await pid(changedConsumer),
      changingPid = await pid(changingReview);
    const work = claimOn(changedConsumer, changed);
    await blocked(changedConsumerPid, changingPid);
    await changingReview.query(
      "update telegram_trade_intents set result=result||$2::jsonb where id=$1::uuid",
      [
        changed.intentId,
        {
          telegramFundingHandoff: {
            version: 1,
            fundingContextId: randomUUID(),
            policyRevision: changed.policyRevision,
            returnRevision: 1,
          },
        },
      ],
    );
    await changingReview.query("commit");
    await assert.rejects(
      work,
      (error: unknown) =>
        error instanceof TelegramAppHandoffError &&
        error.code === "plan_changed",
    );
    await changedConsumer.query("rollback");
    assert.equal(await status(changed), "external_handoff");
    // Restore the synthetic Review's original source; the next ordinary claim
    // succeeds without deleting handoffs, clearing caches or waiting cooldowns.
    await pool.query(
      "update telegram_trade_intents set result=result-'telegramFundingHandoff' where id=$1::uuid",
      [changed.intentId],
    );
    await tx(pool, (db) => claimOn(db, changed));
    assert.equal(await status(changed), "executing");
  } finally {
    await changingReview.query("rollback");
    await changedConsumer.query("rollback");
    changingReview.release();
    changedConsumer.release();
  }

  const merging = await fixture(),
    merge = await pool.connect(),
    mergingConsumer = await pool.connect();
  try {
    await merge.query("begin");
    await mergingConsumer.query("begin");
    await merge.query("select id from users where id=$1 for update", [
      merging.userId,
    ]);
    const mergingConsumerPid = await pid(mergingConsumer),
      mergePid = await pid(merge);
    const work = claimOn(
      mergingConsumer,
      merging,
      telegramAppHandoffV2CurrentScope.validate,
    );
    await blocked(mergingConsumerPid, mergePid);
    await assertHandoffAndIntentUnlocked(merging);
    await merge.query("update users set is_active=false where id=$1", [
      merging.userId,
    ]);
    await merge.query("commit");
    await assert.rejects(
      work,
      (error: unknown) =>
        error instanceof TelegramAppHandoffV2DirectTradeError &&
        error.code === "plan_changed",
    );
    await mergingConsumer.query("rollback");
    assert.equal(await status(merging), "external_handoff");
  } finally {
    await merge.query("rollback");
    await mergingConsumer.query("rollback");
    merge.release();
    mergingConsumer.release();
  }

  const committed = await fixture(),
    native = await pool.connect();
  try {
    await native.query("begin");
    await lockFundingPolicyForTransaction(native);
    await native.query("select id from users where id=$1 for update", [
      committed.userId,
    ]);
    let materializerPid = 0;
    const materializerPool = {
      connect: async () => {
        const db = await pool.connect();
        materializerPid = await pid(db);
        return db;
      },
    };
    const scope = {
      action: committed.submission.action,
      authorityFingerprint: committed.authorityFingerprint,
      policyRevision: committed.policyRevision,
      telegramUserId: committed.telegramUserId,
      tradeIntentId: committed.intentId,
      venue: "polymarket" as const,
      userId: committed.userId,
    };
    const started = barrier();
    const originalConnect = materializerPool.connect;
    materializerPool.connect = async () => {
      const db = await originalConnect();
      started.resolve();
      return db;
    };
    const work = commitTelegramAppHandoffWithExecution({
      db: materializerPool as never,
      token: committed.token,
      telegramUserId: committed.telegramUserId,
      userId: committed.userId,
      currentAuthorityFingerprint: committed.authorityFingerprint,
      currentPolicyRevision: committed.policyRevision,
      planFingerprint: committed.binding.planFingerprint,
      allowedIntentActions: ["buy"],
      allowedIntentStatuses: ["external_handoff"],
      committedIntentStatus: "external_handoff",
      executionKind: "direct_trade",
      lockExecutionAuthority: (db) =>
        telegramAppHandoffV2CurrentScope.lockAuthority({
          ...scope,
          db: { query: db.query.bind(db) },
        }),
      commitExecution: async () => "same-existing-continuation",
    });
    await started.promise;
    await blocked(materializerPid, await pid(native));
    await assertHandoffAndIntentUnlocked(committed);
    await native.query("commit");
    assert.equal((await work).execution, "same-existing-continuation");
  } finally {
    await native.query("rollback");
    native.release();
  }
  const emptyGeneration = await fixture();
  await tx(pool, async (db) => {
    const contextId = randomUUID();
    await db.query(
      "update telegram_trade_intents set result=result||$2::jsonb where id=$1::uuid",
      [
        emptyGeneration.intentId,
        {
          telegramFundingReturn: {
            version: 1,
            continuationId: randomUUID(),
            fundingContextId: contextId,
            generation: 1,
            policyRevision: emptyGeneration.policyRevision,
            returnRevision: 1,
          },
        },
      ],
    );
    let generationSql: string | undefined;
    const query = (async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      if (
        sql.includes(
          "select generation from telegram_funding_buy_resume_generations",
        )
      )
        generationSql = sql;
      return result;
    }) as typeof db.query;
    await telegramAppHandoffV2CurrentScope.lockAuthority({
      action: "buy",
      authorityFingerprint: emptyGeneration.authorityFingerprint,
      db: { query },
      policyRevision: emptyGeneration.policyRevision,
      telegramUserId: emptyGeneration.telegramUserId,
      tradeIntentId: emptyGeneration.intentId,
      userId: emptyGeneration.userId,
      venue: "polymarket",
    });
    assert.ok(
      generationSql,
      "execute the new generation-lock SQL even on an empty tail",
    );
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare handoff_generation_lock_probe(uuid,integer) as ${generationSql}`,
    );
    const plan = (
      await db.query(
        `explain (analyze,buffers,format json) execute handoff_generation_lock_probe('${contextId}',1)`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const planText = JSON.stringify(plan);
    assert.match(planText, /"Node Type":"Index Scan"/u);
    assert.match(planText, /telegram_funding_session_id = \$1/u);
    assert.match(planText, /generation = \$2/u);
    assert.doesNotMatch(planText, /"Node Type":"Seq Scan"/u);
    assert.equal(plan.Plan["Actual Rows"], 0);
    console.log(
      "PASS PG16 actual generation empty-tail generic plan",
      JSON.stringify({
        ms: plan["Execution Time"],
        buffers: plan.Plan["Shared Hit Blocks"],
      }),
    );
    await db.query("deallocate handoff_generation_lock_probe");
  });
  console.log(
    "PASS PG16 shared handoff lock envelope: live legacy authority baseline, Review M/U/I, observed Cancel waits both winners BUY/SELL, replay without eligibility, deactivation U-before-H/I, direct commit P-before-H/I; native/funded/merge activation not claimed",
  );
} finally {
  if (policyId)
    await pool.query(
      "delete from runtime_policies where id=$1::uuid and policy_key='signal_bot'",
      [policyId],
    );
  await pool.end();
}
