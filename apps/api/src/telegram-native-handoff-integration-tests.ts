// @requires-db — explicit disposable PG16, synthetic rows, no provider IO.
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { tx } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction } from "./repos/hip4-order-preparation.js";
import {
  claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction as claimDirect,
  claimTelegramAppHandoffV2FundedTradeAttemptInTransaction as claimFunded,
  linkTelegramAppHandoffV2DirectTradeOrderInTransaction as linkDirect,
  TelegramAppHandoffV2DirectTradeError,
} from "./repos/telegram-app-handoff-v2-direct-trade-repository.js";
import {
  telegramAppHandoffNativeTradeSchema,
  telegramAppHandoffNativeRequestedAmounts,
} from "./services/telegram-app-handoff-native-trade.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { buildFundingTradeConsumerIntent } from "./funding/persistence/funding-trade-consumer-intent.js";
import {
  buildTelegramAppHandoffNativeAuthority,
  telegramAppHandoffNativeAuthorityFingerprint,
} from "./services/telegram-app-handoff-native-authority.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "./services/signal-bot-trading-policy.js";
import {
  telegramAppHandoffV2CurrentScope,
  telegramBotTradingTestHooks,
  loadTelegramAppHandoffProjection,
  resolveTelegramAppHandoffCurrentScope,
  telegramVenueFromSealedHandoffSnapshot,
} from "./services/telegram-bot-trading.js";
import {
  resolveTelegramAppHandoffV2Execution,
  telegramAppHandoffV2FundingIdempotencyKey,
} from "./services/telegram-app-handoff-v2.js";
import type { TelegramAppHandoff } from "./services/telegram-app-handoff.js";
import {
  readTelegramNativeHandoffOrder,
  projectTelegramNativeHandoffStatusInTransaction,
} from "./repos/telegram-native-handoff-read.js";
import { submitHip4OrderAction } from "./services/hip4-order-submission.js";
import { submitHip4OrderWithCurrentContext } from "./services/hip4-order-runtime.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { lockFundingPolicyForTransaction } from "./funding/policies/funding-policy-sidecar.js";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  recordHip4OrderObservationInTransaction,
  failHip4OrderObservation,
} from "./repos/hip4-order-observation.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { checkTelegramNativeHandoffReadPlans } from "./telegram-native-handoff-read-plans-pg.js";
import { checkTelegramNativeFundedLifecyclePlans } from "./telegram-native-funded-lifecycle-plans-pg.js";
import {
  runTelegramTradeLifecycleProjectionBatchInTransaction,
  telegramTradeLifecycleProgressTestHooks,
} from "./services/telegram-trade-lifecycle-progress.js";
import {
  telegramAppHandoffClientExecutionSchema,
  telegramAppHandoffProjectionSchema,
} from "./schemas/telegram.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=10000 -c lock_timeout=5000",
});
const policyIds: string[] = [];
let readPlanFixture: Awaited<ReturnType<typeof fixture>> | undefined;
let fundedReadPlanFixture: Awaited<ReturnType<typeof fixture>> | undefined;

/** Exact current native fixture through the REAL shared selector/projector.
 * A transaction-local indexed intent clone isolates earlier synthetic runs;
 * real users, native ledger and outbox FK remain in use. No delivery runs and
 * every outbox/progress write is rolled back. */
async function lifecycleFor(
  data: Awaited<ReturnType<typeof fixture>>,
  beforeSubmissionStatus?: "cancelled" | "failed",
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      "create temporary table telegram_trade_intents(like public.telegram_trade_intents including defaults including indexes) on commit drop",
    );
    await db.query(
      "insert into telegram_trade_intents select * from public.telegram_trade_intents where id=$1",
      [data.intentId],
    );
    await db.query(
      "update telegram_trade_intents set chat_id=$2,telegram_message_id=1 where id=$1",
      [data.intentId, data.telegramUserId],
    );
    if (beforeSubmissionStatus)
      await db.query(
        "update telegram_trade_intents set order_id=null,submit_started_at=null,status=$2 where id=$1",
        [data.intentId, beforeSubmissionStatus],
      );
    assert.equal(
      (
        await runTelegramTradeLifecycleProjectionBatchInTransaction(db, {
          limit: 1,
        })
      ).created,
      1,
    );
    const saved = (
      await db.query(
        "select result->'shortfallProgress' as progress from telegram_trade_intents where id=$1",
        [data.intentId],
      )
    ).rows[0].progress;
    const progress =
      telegramTradeLifecycleProgressTestHooks.parseProgress(saved);
    assert.ok(progress?.nativeTrade);
    assert.equal(progress.nativeTrade.quantity, data.native.quantity);
    const outbox = await db.query(
      "select payload from telegram_bot_action_outbox where trade_intent_id=$1 and state_revision=1 and action='trade_funding_edit'",
      [data.intentId],
    );
    assert.equal(outbox.rowCount, 1);
    assert.deepEqual(outbox.rows[0].payload, saved);
    // Delivery changes I.updated_at. Re-reading the normalized official facts
    // must settle its watermark without another identical revision/edit.
    await db.query(
      "update telegram_trade_intents set updated_at=clock_timestamp() where id=$1",
      [data.intentId],
    );
    assert.equal(
      (
        await runTelegramTradeLifecycleProjectionBatchInTransaction(db, {
          limit: 1,
        })
      ).created,
      0,
    );
    assert.equal(
      (
        await runTelegramTradeLifecycleProjectionBatchInTransaction(db, {
          limit: 1,
        })
      ).candidates,
      0,
    );
    if (data.funding) {
      // Terminal funding can acquire later evidence/recovery facts. A cached
      // completed card must not prune this existing authoritative source gate.
      await db.query(
        "update funding_operations set version=version+1,updated_at=clock_timestamp() where id=$1",
        [data.funding.operationId],
      );
      assert.deepEqual(
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 1),
        [data.intentId],
      );
      assert.equal(
        (
          await runTelegramTradeLifecycleProjectionBatchInTransaction(db, {
            limit: 1,
          })
        ).created,
        0,
      );
      assert.deepEqual(
        await telegramTradeLifecycleProgressTestHooks.listCandidateIds(db, 1),
        [],
      );
    }
    return {
      progress,
      text: telegramTradeLifecycleProgressTestHooks.progressText(progress),
      keyboard:
        telegramTradeLifecycleProgressTestHooks.progressKeyboard(progress),
    };
  } finally {
    await db.query("rollback");
    db.release();
  }
}

async function verifyLifecycleIndexesOnLegacyRows(
  data: Awaited<ReturnType<typeof fixture>>,
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      "create temporary table telegram_trade_intents(like public.telegram_trade_intents including defaults) on commit drop",
    );
    const statements = [
      "0332_telegram_native_lifecycle_due_index.sql",
      "0333_telegram_native_order_lifecycle_index.sql",
    ].map((filename) => {
      const source = readFileSync(
        new URL(`../../../packages/db/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      const start = source.indexOf("create index concurrently");
      assert.ok(start >= 0);
      return source
        .slice(start)
        .replace("create index concurrently", "create index");
    });
    for (const sql of statements) await db.query(sql);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as row_count from telegram_trade_intents",
        )
      ).rows[0].row_count,
      0,
    );
    await db.query("drop index pg_temp.telegram_native_lifecycle_due_idx");
    await db.query("drop index pg_temp.telegram_native_order_lifecycle_idx");
    for (const invalid of [
      "invalid",
      "999999999999999999999999999999999",
      [],
      -1,
    ])
      await db.query(
        `insert into telegram_trade_intents select rewritten_row.* from public.telegram_trade_intents source_row
        cross join lateral jsonb_populate_record(null::telegram_trade_intents,to_jsonb(source_row)||jsonb_build_object(
          'result',jsonb_build_object('shortfallProgress',jsonb_build_object('version',7),
            'shortfallProgressSourceWatermark',jsonb_build_object('intentUpdatedAtUs',$2::jsonb)))) rewritten_row
        where source_row.id=$1`,
        [data.intentId, JSON.stringify(invalid)],
      );
    for (const sql of statements) await db.query(sql);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as row_count from telegram_trade_intents",
        )
      ).rows[0].row_count,
      4,
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}

async function verifyVenueMigration() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Exact migration on empty and representative legacy minimal tables. The
    // temp relation must shadow the disposable public table before any ALTER.
    await client.query(`create temporary table telegram_trade_intents(
      venue text not null,delivery_mode text not null,
      constraint telegram_trade_intents_venue_check check(venue in ('polymarket','limitless','kalshi'))
    ) on commit drop`);
    assert.equal(
      (
        await client.query(
          "select relpersistence from pg_class where oid='telegram_trade_intents'::regclass",
        )
      ).rows[0].relpersistence,
      "t",
    );
    const migration = readFileSync(
      new URL(
        "../../../packages/db/migrations/0331_telegram_native_app_handoff_venue.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query("savepoint empty_venue_fixture");
    await client.query(migration);
    await client.query(
      "insert into telegram_trade_intents values('hyperliquid','app_handoff')",
    );
    await client.query("rollback to savepoint empty_venue_fixture");
    await client.query(
      "insert into telegram_trade_intents values('polymarket','bot_submit'),('limitless','app_handoff'),('kalshi','bot_submit')",
    );
    await client.query(migration);
    assert.equal(
      (
        await client.query(
          "select count(*)::int as row_count from telegram_trade_intents",
        )
      ).rows[0].row_count,
      3,
    );
    await client.query(
      "insert into telegram_trade_intents values('hyperliquid','app_handoff')",
    );
    await client.query("savepoint rejected_native_bot");
    await assert.rejects(
      client.query(
        "insert into telegram_trade_intents values('hyperliquid','bot_submit')",
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514",
    );
    await client.query("rollback to savepoint rejected_native_bot");
    console.log(
      "PASS exact 0331 migration on empty/legacy PG16 temp targets, preserved rows and app-only new writes",
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function fixture(
  side: "BUY" | "SELL" = "BUY",
  funded = false,
  scopeSide = side,
  intentAction = side.toLowerCase(),
  signingAddress?: string,
) {
  return tx(pool, async (db) => {
    assert.equal(
      (
        await db.query("show server_version_num")
      ).rows[0].server_version_num.slice(0, 2),
      "16",
    );
    const base = await hip4OrderTestFixture(db, signingAddress);
    const feeObservation = signingAddress
      ? hip4FeeTestObservation({
          address: base.profile.address,
          marketId: base.request.marketId,
          side,
        })
      : undefined;
    const prepared = await persistHip4OrderPreparationInTransaction(db, {
      ...base,
      ...(feeObservation ? { feeObservation } : {}),
      request: {
        ...base.request,
        side,
        consentedDebitCapRaw: side === "BUY" ? "150000000" : "400000",
      },
    });
    assert.equal(
      prepared.snapshot.consentedDebitCapRaw,
      side === "BUY" ? "150000000" : "400000",
    );
    const wire =
      prepared.envelope.action.type === "order"
        ? prepared.envelope.action.orders[0]
        : null;
    assert.ok(wire);
    const native = telegramAppHandoffNativeTradeSchema.parse({
      version: "hip4-ioc-v1",
      environment: "mainnet",
      marketId: base.request.marketId,
      outcomeTokenId: (
        await db.query("select token_id from hip4_order_actions where id=$1", [
          prepared.actionId,
        ])
      ).rows[0].token_id,
      outcomeSide: base.request.outcomeSide,
      controllerWalletRef: base.request.controllerWalletRef,
      side: scopeSide,
      timeInForce: wire.t.limit.tif,
      quantity: wire.s,
      limitPrice: wire.p,
      consentedDebitCapRaw: scopeSide === "BUY" ? "150000000" : "400000",
    });
    const requested = telegramAppHandoffNativeRequestedAmounts(native);
    const intentId = randomUUID(),
      handoffId = randomUUID(),
      telegramUserId = `89${BigInt(`0x${randomBytes(7).toString("hex")}`)}`;
    const funding = funded
      ? await hip4FundedOrderTestFixture(db, {
          userId: base.userId,
          profile: base.profile,
          marketId: native.marketId,
          tokenId: native.outcomeTokenId,
          idempotencyKey: telegramAppHandoffV2FundingIdempotencyKey(handoffId),
        })
      : null;
    const fingerprint = canonicalJsonHash(handoffId);
    const plan = {
      version: 2,
      executionContractVersion: 2,
      kind: funded ? "funding" : "direct_trade",
      trade: {
        action: scopeSide.toLowerCase(),
        venue: "hyperliquid",
        side: native.outcomeSide,
        marketId: native.marketId,
        eventId: native.marketId,
        outcomeTokenId: native.outcomeTokenId,
        controllerWalletAddress: base.profile.address,
        nativeTrade: native,
      },
      ...(funded
        ? {
            funding: {
              discoveryRequest: {
                purpose: "trade_shortfall",
                requestedDestinationAmount: {
                  asset: HYPERCORE_MAINNET_USDC,
                  raw: native.consentedDebitCapRaw,
                },
                confirmedSourceAmount: null,
                marketContextId: native.outcomeTokenId.slice(
                  "hyperliquid:".length,
                ),
                consumerIntent: {
                  venueId: "hyperliquid",
                  marketId: native.marketId,
                  marketContextId: native.outcomeTokenId.slice(
                    "hyperliquid:".length,
                  ),
                  side: "BUY",
                  spend: {
                    asset: HYPERCORE_MAINNET_USDC,
                    raw: native.consentedDebitCapRaw,
                  },
                },
                destinationOptionId: null,
                withdrawalRecipientId: null,
                venueBindingOptionId: null,
                controllerWalletRef: native.controllerWalletRef,
                maxFeeUsd: "1",
                maxSlippageBps: 0,
                deadline: null,
              },
              destination: {
                controllerWalletId: native.controllerWalletRef,
                destinationOptionId: randomUUID(),
                requiredAsset: HYPERCORE_MAINNET_USDC,
                topology: "native_hypercore",
                venueBindingId: randomUUID(),
                venueBindingOptionId: randomUUID(),
                venueId: "hyperliquid",
              },
              fundingPolicyRevision: "synthetic-funding-revision",
              sourceDebits: [
                {
                  asset: HYPERCORE_MAINNET_USDC,
                  maximumRaw: native.consentedDebitCapRaw,
                  locationId: randomUUID(),
                  sourceFingerprint: "c".repeat(64),
                },
              ],
            },
          }
        : {}),
    };
    const link = await db.query<{ id: string }>(
      "insert into user_telegram_accounts(user_id,privy_user_id,telegram_user_id) values($1,$2,$3) returning id",
      [base.userId, `did:privy:${base.userId}`, telegramUserId],
    );
    const nativeAuthority = buildTelegramAppHandoffNativeAuthority({
      userId: base.userId,
      telegramAccountLinkId: link.rows[0].id,
      profile: base.profile,
    });
    const authorityFingerprint =
      telegramAppHandoffNativeAuthorityFingerprint(nativeAuthority);
    const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
    await db.query(
      `insert into telegram_trade_intents(id,telegram_user_id,user_id,action,venue,market_id,event_id,side,shares_raw,
      status,result,expires_at,idempotency_key,delivery_mode,funding_operation_id,funding_reservation_id,amount_usd)
      values($1,$2,$3,$4,'hyperliquid',$5,$5,$6,$7,$8,$9::jsonb,clock_timestamp()+interval '30 minutes',$10,'app_handoff',$11,$12,$13)`,
      [
        intentId,
        telegramUserId,
        base.userId,
        intentAction,
        native.marketId,
        native.outcomeSide,
        intentAction === "sell" ? requested.tokenRaw.toString() : null,
        funded ? "funding" : "external_handoff",
        {
          appHandoffV2: { version: 2, plan },
          appHandoffNativeAuthority: nativeAuthority,
          ...(funding
            ? {
                appHandoffFunding: {
                  version: 2,
                  handoffId,
                  operationId: funding.operationId,
                },
              }
            : {}),
          appHandoffExecution: {
            version: 2,
            kind: funded ? "funding" : "direct_trade",
            handoffId,
            committedAt: new Date().toISOString(),
          },
        },
        `offline-native-handoff:${intentId}`,
        funding?.operationId ?? null,
        funding?.reservationId ?? null,
        intentAction === "buy" ? "1.50" : null,
      ],
    );
    // Committed funding may intentionally outlive the initial handoff token.
    // Its intent/lifecycle and fresh native signing remain distinct authorities.
    await db.query(
      `insert into telegram_app_handoffs(id,trade_intent_id,user_id,telegram_user_id,token_hash,state,plan_fingerprint,
      policy_revision,authority_fingerprint,quote_snapshot,plan_snapshot,issued_at,expires_at,claimed_at,claimed_by_user_id,committed_at)
      values($1,$2,$3,$4,$5,'committed',$5,$7,$8,'{}'::jsonb,$6::jsonb,
        clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp(),$3,clock_timestamp())`,
      [
        handoffId,
        intentId,
        base.userId,
        telegramUserId,
        fingerprint,
        plan,
        policyState.policyRevision,
        authorityFingerprint,
      ],
    );
    return {
      base,
      prepared,
      native,
      requested,
      funding,
      feeObservation,
      telegramUserId,
      authorityFingerprint,
      policyRevision: policyState.policyRevision,
      intentId,
      binding: { handoffId, planFingerprint: fingerprint },
      handoff: {
        id: handoffId,
        tradeIntentId: intentId,
        authorityFingerprint,
        cancelledAt: null,
        claimedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        expiredAt: null,
        planFingerprint: fingerprint,
        planSnapshot: plan,
        policyRevision: policyState.policyRevision,
        quoteSnapshot: {},
        state: "committed",
      } satisfies TelegramAppHandoff,
      reconcileKeys: {
        tradeType: "hyperliquid" as const,
        actionId: prepared.actionId,
        orderId: prepared.orderId,
        cloid: prepared.cloid,
      },
      submission: {
        action: scopeSide.toLowerCase() as "buy" | "sell",
        executionKind: "hyperliquid_ioc" as const,
        venue: "hyperliquid" as const,
        marketId: native.marketId,
        outcomeTokenId: native.outcomeTokenId,
        signer: base.profile.address,
        nativeTrade: native,
        spendRaw:
          scopeSide === "BUY"
            ? String(requested.grossQuoteRaw + 1000000n)
            : String(requested.tokenRaw),
        receiveRaw:
          scopeSide === "BUY"
            ? String(requested.tokenRaw)
            : String(requested.grossQuoteRaw),
      },
    };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const state = async (data: Fixture) =>
  (
    await pool.query(
      "select status,order_id,prepared_snapshot,result from telegram_trade_intents where id=$1",
      [data.intentId],
    )
  ).rows[0];
const direct = (
  data: Fixture,
  submission = data.submission,
  keys = data.reconcileKeys,
) =>
  tx(pool, (db) =>
    claimDirect(db, {
      userId: data.base.userId,
      binding: data.binding,
      assertCurrentScope: {
        lockAuthority: async () => {},
        validate: async () => true,
      },
      recoveryPayload: {},
      reconcileKeys: keys,
      submission,
    }),
  );
const funded = (
  data: Fixture,
  submission = data.submission,
  consumerIntent = data.funding?.confirmedIntent,
) => {
  const funding = data.funding;
  assert.ok(funding && consumerIntent);
  return tx(pool, (db) =>
    claimFunded(db, {
      userId: data.base.userId,
      operationId: funding.operationId,
      reservationId: funding.reservationId,
      consumerIntent,
      marketId: data.native.marketId,
      executionPath: "hyperliquid_outcome",
      idempotencyKey: `native-handoff:${data.prepared.actionId}`,
      canonicalFingerprint: canonicalJsonHash(data.prepared.actionId),
      externalReference: data.prepared.cloid,
      binding: data.binding,
      submission,
      assertCurrentScope: {
        lockAuthority: async () => {},
        validate: async () => true,
      },
    }),
  );
};
const scopedError = (error: unknown) =>
  error instanceof TelegramAppHandoffV2DirectTradeError;
try {
  await verifyVenueMigration();
  for (const side of ["BUY", "SELL"] as const) {
    const data = await fixture(side);
    for (const change of [
      { nativeTrade: { ...data.native, quantity: "3" } },
      { nativeTrade: { ...data.native, limitPrice: "0.33" } },
      {
        nativeTrade: {
          ...data.native,
          consentedDebitCapRaw: side === "BUY" ? "160000000" : "500000",
        },
      },
      { nativeTrade: { ...data.native, controllerWalletRef: randomUUID() } },
      { spendRaw: "1" },
      { receiveRaw: "1" },
    ]) {
      await assert.rejects(
        direct(data, { ...data.submission, ...change }),
        scopedError,
      );
      assert.equal((await state(data)).status, "external_handoff");
    }
    await direct(data);
    const claimed = await state(data);
    await direct(data);
    assert.deepEqual(
      await state(data),
      claimed,
      "same native recovery identity replays unchanged",
    );
    await assert.rejects(
      direct(data, data.submission, {
        ...data.reconcileKeys,
        actionId: randomUUID(),
      }),
      scopedError,
    );
    await assert.rejects(
      tx(pool, (db) =>
        linkDirect(db, {
          userId: data.base.userId,
          order: { ...data.binding, ...data.submission },
          orderId: randomUUID(),
          orderStatus: "submitted",
          venueOrderId: null,
        }),
      ),
      scopedError,
      "claim A cannot link economically identical B",
    );
    await tx(pool, (db) =>
      linkDirect(db, {
        userId: data.base.userId,
        order: { ...data.binding, ...data.submission },
        orderId: data.prepared.orderId,
        orderStatus: "filled",
        venueOrderId: null,
      }),
    );
    assert.equal((await state(data)).order_id, data.prepared.orderId);
    assert.equal(
      (await state(data)).status,
      "submitted",
      "requested native IOC is not a verified full fill",
    );
  }
  const buy = await fixture("BUY", true);
  assert.ok(buy.funding);
  const confirmed = buy.funding.confirmedIntent;
  for (const change of [
    { marketContextId: `${confirmed.marketContextId}:wrong` },
    {
      spend: {
        ...confirmed.spend,
        asset: { ...confirmed.spend.asset, decimals: 6 },
      },
    },
    { spend: { ...confirmed.spend, raw: "1" } },
  ]) {
    await assert.rejects(
      funded(
        buy,
        buy.submission,
        buildFundingTradeConsumerIntent({ ...confirmed, ...change }),
      ),
      scopedError,
      "wrong native confirmed token, cash decimals, or insufficient spend bound cannot claim funding",
    );
    assert.equal((await state(buy)).status, "funding");
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as row_count from funding_trade_attempts where operation_id=$1",
          [buy.funding.operationId],
        )
      ).rows[0].row_count,
      0,
      "a rejected native scope leaves no funded attempt",
    );
  }
  assert.equal((await funded(buy)).claimed, true);
  assert.equal((await funded(buy)).claimed, false);
  assert.equal((await state(buy)).status, "executing");
  const sell = await fixture("BUY", true, "SELL");
  await assert.rejects(
    funded(sell),
    scopedError,
    "native funded SELL cannot consume a BUY reservation",
  );
  const wrongAction = await fixture("SELL", false, "BUY", "sell");
  await assert.rejects(
    direct(wrongAction),
    scopedError,
    "persisted intent action must agree with sealed action",
  );
  await assert.rejects(
    fixture("BUY", true, "BUY", "sell"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514" &&
      "constraint" in error &&
      error.constraint === "telegram_trade_intents_delivery_authority_check",
    "the shared SQL invariant already prevents a funded SELL intent from being persisted",
  );
  const prohibited = await fixture();
  await assert.rejects(
    pool.query(
      "update telegram_trade_intents set delivery_mode='bot_submit' where id=$1",
      [prohibited.intentId],
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514",
    "native storage does not grant unattended bot authority",
  );
  console.log(
    "PASS native shared handoff PG16 foundation: exact IOC/caps/units, direct BUY+SELL/replay/order binding, funded BUY/replay, invalid SELL/action, app-only storage; runtime activation remains separate",
  );
  // Connected ordinary native consumer, real production scope, offline wallet
  // and fake transport. No server signing or provider read is performed.
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "off" };
  for (const [key, payload] of [
    ["venue_lifecycle", lifecycle],
    [
      "signal_bot",
      {
        miniAppHandoffMode: "always",
        miniAppHandoffContractVersion: 2,
        buyContinuationEnabled: true,
        fundingReceiveEnabled: true,
        tradingEnabled: true,
        tradingActions: ["buy", "sell"],
      },
    ],
  ] as const)
    policyIds.push(
      (
        await pool.query(
          "insert into runtime_policies(policy_key,effective_at,payload) values($1,clock_timestamp(),$2::jsonb) returning id",
          [key, payload],
        )
      ).rows[0].id,
    );
  const testCapability: typeof venueHasLifecycleCapability = (
    policy,
    _venue,
    capability,
  ) =>
    venueHasLifecycleCapability(
      {
        ...policy,
        venues: { ...policy.venues, polymarket: policy.venues.hyperliquid },
      },
      "polymarket",
      capability,
    );
  for (const [side, isFunded] of [
    ["BUY", false],
    ["SELL", false],
    ["BUY", true],
  ] as const) {
    const wallet = Wallet.createRandom();
    const data = await fixture(
      side,
      isFunded,
      side,
      side.toLowerCase(),
      wallet.address,
    );
    if (side === "BUY" && !isFunded) readPlanFixture = data;
    if (isFunded) fundedReadPlanFixture = data;
    // Committed consent outlives the initial Telegram quote/token TTL. Fresh
    // native preparation, fees, capacity and funding lifecycle still gate POST.
    await pool.query(
      "update telegram_trade_intents set expires_at=clock_timestamp()-interval '1 hour' where id=$1::uuid",
      [data.intentId],
    );
    const signing = prepareHip4TradeSigning(data.prepared.envelope);
    const signature = await wallet.signTypedData(
      signing.typedData.domain,
      signing.typedData.types,
      signing.typedData.message,
    );
    assert.ok(data.feeObservation);
    const input = {
      userId: data.base.userId,
      actionId: data.prepared.actionId,
      actor: "web_app",
      signature,
      telegramAppHandoffId: data.binding.handoffId,
      telegramAppHandoffPlanFingerprint: data.binding.planFingerprint,
      telegramAppHandoffScope: telegramAppHandoffV2CurrentScope,
      ...(data.funding
        ? {
            funding: {
              operationId: data.funding.operationId,
              reservationId: data.funding.reservationId,
              confirmedIntent: data.funding.confirmedIntent,
            },
          }
        : {}),
      context: {
        profile: data.base.profile,
        feeCapRaw: null,
        feeObservation: data.feeObservation,
        capacity: {
          assetId:
            side === "BUY"
              ? HYPERCORE_MAINNET_USDC.assetId
              : data.native.outcomeTokenId,
          decimals: side === "BUY" ? 8 : 5,
          availableRaw: "100000000000",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    };
    assert.equal(
      await tx(pool, (db) =>
        telegramAppHandoffV2CurrentScope.validate({
          action: side === "BUY" ? "buy" : "sell",
          authorityFingerprint: data.authorityFingerprint,
          db: { query: db.query.bind(db) },
          policyRevision: data.policyRevision,
          telegramUserId: data.telegramUserId,
          tradeIntentId: data.intentId,
          userId: data.base.userId,
          venue: "hyperliquid",
        }),
      ),
      true,
      "real native controller scope must be valid before submission",
    );
    assert.equal(
      telegramVenueFromSealedHandoffSnapshot(data.handoff.planSnapshot),
      "hyperliquid",
      "HTTP reader recognizes only the versioned native IOC plan",
    );
    const routeScopeInput = {
      db: pool,
      action: side === "BUY" ? ("buy" as const) : ("sell" as const),
      telegramUserId: data.telegramUserId,
      venue: "hyperliquid" as const,
      executionContractVersion: 2 as const,
      nativeHandoff: {
        userId: data.base.userId,
        tradeIntentId: data.intentId,
        authorityFingerprint: data.authorityFingerprint,
        policyRevision: data.policyRevision,
      },
    };
    assert.deepEqual(
      await resolveTelegramAppHandoffCurrentScope(routeScopeInput),
      {
        authorityFingerprint: data.authorityFingerprint,
        policyRevision: data.policyRevision,
      },
    );
    assert.equal(
      await resolveTelegramAppHandoffCurrentScope({
        ...routeScopeInput,
        nativeHandoff: undefined,
      }),
      null,
      "native HTTP execution must carry the exact authenticated handoff scope",
    );
    assert.equal(
      await resolveTelegramAppHandoffCurrentScope({
        ...routeScopeInput,
        nativeHandoff: {
          ...routeScopeInput.nativeHandoff,
          userId: randomUUID(),
        },
      }),
      null,
      "a foreign user cannot resolve native financial authority",
    );
    assert.equal(
      await resolveTelegramAppHandoffCurrentScope({
        ...routeScopeInput,
        nativeHandoff: {
          ...routeScopeInput.nativeHandoff,
          authorityFingerprint: "0".repeat(64),
        },
      }),
      null,
    );
    assert.equal(
      await resolveTelegramAppHandoffCurrentScope({
        ...routeScopeInput,
        executionContractVersion: 1,
      }),
      null,
      "native never falls through the legacy bot executor",
    );
    let posts = 0,
      verifiedPrePost = false;
    const transport = {
      timeoutMs: 1000,
      responseMaxBytes: 10000,
      fetcher: (async () => {
        posts++;
        const persisted = await state(data);
        assert.equal(persisted.status, "submitted");
        assert.equal(persisted.order_id, data.prepared.orderId);
        const saved = (
          await pool.query(
            "select state,admission_snapshot,funding_trade_attempt_id from hip4_order_submissions where action_id=$1",
            [data.prepared.actionId],
          )
        ).rows[0];
        assert.equal(saved.state, "submission_started");
        assert.deepEqual(
          saved.admission_snapshot.telegramAppHandoff,
          data.binding,
        );
        if (data.funding) {
          assert.equal(
            persisted.result.appHandoffTradeExecution.attemptId,
            saved.funding_trade_attempt_id,
          );
          assert.equal(
            persisted.result.appHandoffTradeExecution.orderId,
            data.prepared.orderId,
          );
        } else
          assert.deepEqual(
            persisted.prepared_snapshot.reconcileKeys.actionId,
            data.prepared.actionId,
          );
        verifiedPrePost = true;
        // Simulate a response lost after POST. The existing native journal and
        // linked handoff must recover without another provider submission.
        throw new Error("offline response loss");
      }) as typeof fetch,
    };
    const beforeRejectedAdmission = await state(data);
    await assert.rejects(
      submitHip4OrderAction(
        pool,
        {
          ...input,
          context: {
            ...input.context,
            capacity: { ...input.context.capacity, availableRaw: "0" },
          },
        },
        transport,
        testCapability,
      ),
      /hip4_capacity_reserved/u,
    );
    assert.equal(posts, 0);
    assert.deepEqual(
      await state(data),
      beforeRejectedAdmission,
      "failure after sealed claim rolls back the intent claim/link",
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as row_count from hip4_order_submissions where action_id=$1",
          [data.prepared.actionId],
        )
      ).rows[0].row_count,
      0,
    );
    if (data.funding) {
      assert.equal(
        (
          await pool.query(
            "select count(*)::int as row_count from funding_trade_attempts where operation_id=$1",
            [data.funding.operationId],
          )
        ).rows[0].row_count,
        0,
        "failed capacity admission leaves no claimed funding attempt",
      );
      const { funding: _funding, ...withoutFunding } = input;
      await assert.rejects(
        submitHip4OrderAction(pool, withoutFunding, transport, testCapability),
        (error: unknown) =>
          error instanceof TelegramAppHandoffV2DirectTradeError,
      );
      assert.deepEqual(await state(data), beforeRejectedAdmission);
      assert.equal(posts, 0);
    }
    const first = await submitHip4OrderAction(
      pool,
      input,
      transport,
      testCapability,
    );
    assert.equal(first.replayed, false);
    assert.equal(
      verifiedPrePost,
      true,
      "transport catches cannot hide a failed pre-POST persistence assertion",
    );
    assert.equal(posts, 1);
    assert.equal(
      (
        await submitHip4OrderAction(
          pool,
          {
            ...input,
            context: { ...input.context, capacity: null },
            telegramAppHandoffScope: {
              lockAuthority: async () => {
                assert.fail(
                  "durable replay must not reacquire current handoff authority",
                );
              },
              validate: async () => {
                assert.fail(
                  "durable replay must not revalidate current handoff eligibility",
                );
              },
            },
          },
          transport,
          testCapability,
        )
      ).replayed,
      true,
    );
    assert.equal(posts, 1);
    const publicReference = {
      userId: input.userId,
      actionId: input.actionId,
      actor: "web_app" as const,
      signature: input.signature,
      telegramAppHandoffId: input.telegramAppHandoffId,
      telegramAppHandoffPlanFingerprint:
        input.telegramAppHandoffPlanFingerprint,
      ...(data.funding
        ? {
            funding: {
              operationId: data.funding.operationId,
              reservationId: data.funding.reservationId,
            },
          }
        : {}),
    };
    assert.equal(
      (
        await submitHip4OrderWithCurrentContext(pool, publicReference, {
          fetcher: (async () =>
            assert.fail(
              "owned public runtime replay must perform no provider IO",
            )) as typeof fetch,
        })
      ).replayed,
      true,
    );
    await assert.rejects(
      submitHip4OrderWithCurrentContext(pool, {
        ...publicReference,
        userId: randomUUID(),
      }),
      /hip4_preparation_not_found/u,
    );
    await assert.rejects(
      submitHip4OrderAction(
        pool,
        { ...input, telegramAppHandoffPlanFingerprint: "a".repeat(64) },
        transport,
        testCapability,
      ),
      /hip4_submission_conflict/u,
    );
    const {
      telegramAppHandoffId: _id,
      telegramAppHandoffPlanFingerprint: _fp,
      ...omitted
    } = input;
    await assert.rejects(
      submitHip4OrderAction(pool, omitted, transport, testCapability),
      /hip4_submission_conflict/u,
    );
    assert.equal(posts, 1);
    const readInput = {
      tradeIntentId: data.intentId,
      userId: data.base.userId,
      telegramUserId: data.telegramUserId,
    };
    const execution = () =>
      resolveTelegramAppHandoffV2Execution({
        db: pool,
        handoff: data.handoff,
        userId: data.base.userId,
      });
    const unresolved = () =>
      telegramBotTradingTestHooks.loadUnresolvedTelegramTradeIntent(pool, {
        marketId: data.native.marketId,
        telegramUserId: data.telegramUserId,
      });
    const inFlight = await execution();
    assert.equal(
      inFlight.kind,
      isFunded ? "trade_continuation_in_flight" : "direct_trade_in_flight",
    );
    assert.ok("nativeOrder" in inFlight && inFlight.nativeOrder);
    assert.equal(inFlight.nativeOrder.actionId, data.prepared.actionId);
    assert.equal(inFlight.nativeOrder.filledQuantity, null);
    assert.equal(inFlight.nativeOrder.terminalConfirmed, false);
    telegramAppHandoffClientExecutionSchema.parse({
      execution: inFlight,
      handoff: data.handoff,
    });
    assert.ok(
      await unresolved(),
      "an ACK/unknown response still blocks another Review",
    );
    assert.equal(
      await telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
        pool,
        data.telegramUserId,
      ),
      1,
    );
    assert.equal(
      (
        await telegramBotTradingTestHooks.listResolvingTelegramTradeIntents(
          pool,
          data.telegramUserId,
        )
      ).length,
      1,
    );

    assert.equal(
      await readTelegramNativeHandoffOrder(pool, {
        ...readInput,
        userId: randomUUID(),
      }),
      null,
    );
    assert.equal(
      await readTelegramNativeHandoffOrder(pool, {
        ...readInput,
        telegramUserId: "1",
      }),
      null,
    );
    assert.equal(
      await readTelegramNativeHandoffOrder(pool, {
        ...readInput,
        handoffId: randomUUID(),
      }),
      null,
    );

    const wire =
      data.prepared.envelope.action.type === "order"
        ? data.prepared.envelope.action.orders[0]
        : null;
    assert.ok(wire);
    const nativeOid = randomInt(1000000000, 10000000000);
    const orderTime = data.base.nonce;
    const response = (status: string) => ({
      status: "order",
      order: {
        status,
        statusTimestamp: orderTime,
        order: {
          coin: `#${wire.a - 100000000}`,
          oid: nativeOid,
          cloid: wire.c,
          side: side === "BUY" ? "B" : "A",
          limitPx: wire.p,
          sz: wire.s,
          origSz: wire.s,
          timestamp: orderTime,
          orderType: "Limit",
          reduceOnly: false,
          tif: "Ioc",
        },
      },
    });
    const observe = (status: string) =>
      tx(pool, async (db) => {
        const claim = (
          await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
            data.prepared.actionId,
            60000,
            60000,
          ])
        ).rows[0];
        assert.ok(claim);
        return recordHip4OrderObservationInTransaction(db, {
          claim,
          userId: data.base.userId,
          body: response(status),
          responseAt: Date.now(),
          maxRows: 20,
          retryMs: 60000,
        });
      });
    assert.equal((await observe("open")).error, "account_history_unavailable");
    assert.ok(await unresolved(), "official open is not terminal");
    const terminalStatus = isFunded ? "filled" : "canceled";
    assert.equal(
      (await observe(terminalStatus)).error,
      "account_history_unavailable",
    );
    const closedWithoutFills = await execution();
    assert.equal(closedWithoutFills.kind, "trade_terminal");
    assert.ok(
      "nativeOrder" in closedWithoutFills && closedWithoutFills.nativeOrder,
    );
    assert.equal(closedWithoutFills.nativeOrder.terminalConfirmed, true);
    assert.equal(closedWithoutFills.nativeOrder.filledQuantity, null);
    assert.equal(closedWithoutFills.nativeOrder.fullQuantityObserved, false);
    assert.equal(
      await unresolved(),
      null,
      "official terminal order permits a NEW explicit Review, not resubmission of the old one",
    );
    assert.equal(
      (await state(data)).status,
      isFunded ? "filled" : "cancelled",
      "ordinary native observation atomically projects the existing intent lifecycle",
    );
    assert.equal(
      await telegramBotTradingTestHooks.countUnresolvedTelegramTradeIntents(
        pool,
        data.telegramUserId,
      ),
      0,
    );
    assert.equal(
      (
        await telegramBotTradingTestHooks.listResolvingTelegramTradeIntents(
          pool,
          data.telegramUserId,
        )
      ).length,
      0,
    );
    const beforeFills = telegramAppHandoffProjectionSchema.parse(
      await loadTelegramAppHandoffProjection(pool, readInput),
    );
    assert.equal(
      beforeFills.canAutoClose,
      false,
      "terminal status without full execution coverage cannot auto-close as full success",
    );
    assert.equal(beforeFills.terminal, true);
    const lifecycleWithoutFills = await lifecycleFor(data);
    assert.equal(
      lifecycleWithoutFills.progress.state,
      isFunded ? "confirming_trade" : "cancelled",
    );
    assert.doesNotMatch(
      lifecycleWithoutFills.text,
      /No order was submitted|filled successfully/u,
    );
    assert.equal(
      lifecycleWithoutFills.progress.nativeTrade?.order?.nativeOrder
        .filledQuantity,
      null,
    );

    // Use the SAME P2 canonical execution ledger and ordinary order observer.
    // A partial cancelled IOC remains cancelled, with actual filled quantity.
    const quantity = isFunded ? wire.s : "2";
    const fill = {
      coin: `#${wire.a - 100000000}`,
      oid: nativeOid,
      cloid: wire.c,
      side: side === "BUY" ? "B" : "A",
      px: side === "BUY" ? "0.3" : "0.4",
      sz: quantity,
      time: orderTime,
      tid: 1,
      startPosition: "0",
      dir: side === "BUY" ? "Buy" : "Sell",
      closedPnl: "0",
      hash: `0x${"ef".repeat(32)}`,
      crossed: true,
      fee: "0",
      feeToken: "USDC",
    };
    const projected = projectHip4Execution(
      "mainnet",
      data.base.profile.address,
      fill,
    );
    await tx(pool, async (db) => {
      await db.query(
        "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1) on conflict do nothing",
        [data.base.profile.address],
      );
      await db.query(
        `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill)
        values('mainnet',$1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
        [
          data.base.profile.address,
          fill.time,
          fill.coin,
          fill.tid,
          nativeOid,
          data.native.marketId,
          projected,
          canonicalJsonHash(projected),
          fill,
        ],
      );
    });
    assert.equal((await observe(terminalStatus)).error, null);
    const closedWithFills = await execution();
    assert.equal(closedWithFills.kind, "trade_terminal");
    assert.ok("nativeOrder" in closedWithFills && closedWithFills.nativeOrder);
    assert.equal(closedWithFills.nativeOrder.filledQuantity, quantity);
    assert.equal(closedWithFills.nativeOrder.fullQuantityObserved, isFunded);
    assert.equal(
      closedWithFills.nativeOrder.executionSummary?.quantity,
      quantity,
    );
    const projection = telegramAppHandoffProjectionSchema.parse(
      await loadTelegramAppHandoffProjection(pool, readInput),
    );
    assert.equal(projection.status, isFunded ? "filled" : "cancelled");
    assert.equal(projection.canAutoClose, isFunded);
    assert.equal(projection.nativeOrder?.actionId, data.prepared.actionId);
    assert.equal(posts, 1);
    const lifecycleWithFills = await lifecycleFor(data);
    assert.equal(
      lifecycleWithFills.progress.state,
      isFunded ? "filled" : "cancelled",
    );
    assert.equal(
      lifecycleWithFills.progress.nativeTrade?.order?.nativeOrder
        .filledQuantity,
      quantity,
    );
    assert.match(lifecycleWithFills.text, /Recorded gross value/u);
    assert.doesNotMatch(lifecycleWithFills.text, /No order was submitted/u);
    if (isFunded)
      for (const status of ["cancelled", "failed"] as const) {
        const stopped = await lifecycleFor(data, status);
        assert.equal(stopped.progress.state, status);
        assert.equal(stopped.progress.canCancel, false);
        assert.equal(stopped.progress.requiresMiniAppContinuation, false);
        assert.ok(
          stopped.keyboard.inline_keyboard
            .flat()
            .some(
              (button) =>
                "callback_data" in button &&
                button.callback_data?.includes(":open_market:"),
            ),
        );
      }
    telegramAppHandoffClientExecutionSchema.parse({
      execution: closedWithFills,
      handoff: data.handoff,
    });
    assert.equal(await unresolved(), null);
    if (isFunded) {
      const previousIntentTimestamp = (
        await pool.query(
          "select updated_at from telegram_trade_intents where id=$1",
          [data.intentId],
        )
      ).rows[0].updated_at;
      await tx(pool, async (db) => {
        const claim = (
          await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
            data.prepared.actionId,
            60000,
            60000,
          ])
        ).rows[0];
        assert.ok(claim);
        assert.equal(
          await failHip4OrderObservation(
            db,
            claim,
            "execution_identity_conflict",
            60000,
          ),
          true,
        );
      });
      const gap = telegramAppHandoffProjectionSchema.parse(
        await loadTelegramAppHandoffProjection(pool, readInput),
      );
      assert.equal(
        gap.nativeOrder?.fullQuantityObserved,
        true,
        "observed ledger quantity remains monotonic",
      );
      assert.equal(gap.nativeOrder?.executionSummary, null);
      assert.equal(
        gap.canAutoClose,
        false,
        "a failed/conflicting execution recheck cannot present full success",
      );
      assert.equal(
        gap.terminal,
        true,
        "an independent history failure does not erase exact terminal status",
      );
      assert.ok(
        (
          await pool.query(
            "select updated_at from telegram_trade_intents where id=$1",
            [data.intentId],
          )
        ).rows[0].updated_at > previousIntentTimestamp,
        "failed canonical repair atomically wakes the existing lifecycle watermark",
      );
      assert.equal(
        (await lifecycleFor(data)).progress.state,
        "confirming_trade",
      );
      assert.equal((await observe(terminalStatus)).error, null);
      assert.equal(
        (await loadTelegramAppHandoffProjection(pool, readInput))?.canAutoClose,
        true,
        "ordinary successful repair restores presentation without a new order",
      );
      assert.equal((await lifecycleFor(data)).progress.state, "filled");
    } else {
      assert.equal((await observe("open")).error, "order_status_regression");
      assert.equal(
        (await state(data)).status,
        "submitted",
        "barrier invalidation restores the existing unresolved-state index",
      );
      assert.ok(
        await unresolved(),
        "contradictory native status invalidates terminal presentation and keeps the old order reconciling",
      );
      assert.equal((await observe(terminalStatus)).error, null);
      assert.equal(
        await unresolved(),
        null,
        "ordinary exact recheck repairs the invalidated native barrier",
      );
    }

    // The native terminal read is informational. Loss of current link/wallet
    // eligibility does not erase it or invoke a new order/funding commit.
    await pool.query("update user_wallets set is_verified=false where id=$1", [
      data.base.profile.walletId,
    ]);
    try {
      const currentExecution = await execution();
      assert.equal(currentExecution.kind, "trade_terminal");
      assert.ok("nativeOrder" in currentExecution);
      assert.equal(
        currentExecution.nativeOrder?.actionId,
        data.prepared.actionId,
      );
      assert.equal(currentExecution.nativeOrder?.filledQuantity, quantity);
    } finally {
      await pool.query("update user_wallets set is_verified=true where id=$1", [
        data.base.profile.walletId,
      ]);
    }
    assert.equal(posts, 1);
  }
  console.log(
    "PASS connected native ordinary admission: real external controller scope, direct BUY/SELL + funded BUY, pre-POST action/order/attempt linking and response-loss replay without duplicate POST",
  );
  assert.ok(readPlanFixture);
  assert.ok(fundedReadPlanFixture?.funding);
  await checkTelegramNativeFundedLifecyclePlans(pool, {
    intentId: fundedReadPlanFixture.intentId,
    operationId: fundedReadPlanFixture.funding.operationId,
  });
  const retainedFixture = readPlanFixture;
  await verifyLifecycleIndexesOnLegacyRows(retainedFixture);
  // Real two-connection funded contention: select this exact historical page
  // without shadowing intents (a temp clone would not share the writer's I
  // lock). All rows belong to this disposable test's synthetic user.
  for (const lockKind of ["owner", "intent"] as const) {
    const data: Awaited<ReturnType<typeof fixture>> = fundedReadPlanFixture;
    const savedCursor = (
      await pool.query(
        "select last_intent_id,prefer_history from telegram_native_lifecycle_scan where scan_name='funded_v1'",
      )
    ).rows[0];
    const precedingId: string | null =
      (
        await pool.query(
          "select id from telegram_trade_intents where venue='hyperliquid' and delivery_mode='app_handoff' and funding_operation_id is not null and id<$1 order by id desc limit 1",
          [data.intentId],
        )
      ).rows[0]?.id ?? null;
    await pool.query(
      "update telegram_trade_intents set result=result-'shortfallProgress'-'shortfallProgressSourceWatermark',updated_at=clock_timestamp() where id=$1",
      [data.intentId],
    );
    await pool.query(
      "update telegram_native_lifecycle_scan set last_intent_id=$1,prefer_history=true where scan_name='funded_v1'",
      [precedingId],
    );
    const writer = await pool.connect();
    const reader = await pool.connect();
    try {
      await writer.query("begin");
      await reader.query("begin");
      await reader.query("set local statement_timeout='5s'");
      await lockFundingPolicyForTransaction(writer);
      await writer.query(
        `select id from users where id=$1 ${lockKind === "owner" ? "for update" : "for key share"}`,
        [data.base.userId],
      );
      if (lockKind === "intent")
        await writer.query(
          "select id from telegram_trade_intents where id=$1 for update",
          [data.intentId],
        );
      const skipped =
        await runTelegramTradeLifecycleProjectionBatchInTransaction(reader, {
          limit: 1,
        });
      assert.equal(
        skipped.candidates,
        0,
        `${lockKind} lock must skip the funded source without taking I out of order`,
      );
      assert.equal(
        (
          await reader.query(
            "select last_intent_id from telegram_native_lifecycle_scan where scan_name='funded_v1'",
          )
        ).rows[0].last_intent_id,
        precedingId,
        "a locked funded source must not be acknowledged by its cursor",
      );
      if (lockKind === "owner")
        await writer.query(
          "select id from telegram_trade_intents where id=$1 for update nowait",
          [data.intentId],
        );
      await writer.query("rollback");
      const recovered =
        await runTelegramTradeLifecycleProjectionBatchInTransaction(reader, {
          limit: 1,
        });
      assert.equal(
        recovered.created,
        1,
        "the next normal tick must recover after the funded writer releases its lock",
      );
      assert.ok(
        (
          await reader.query(
            "select result->'shortfallProgress'->'nativeTrade' as native_progress from telegram_trade_intents where id=$1",
            [data.intentId],
          )
        ).rows[0].native_progress,
      );
      assert.equal(
        (
          await reader.query(
            "select last_intent_id from telegram_native_lifecycle_scan where scan_name='funded_v1'",
          )
        ).rows[0].last_intent_id,
        data.intentId,
      );
    } finally {
      await reader.query("rollback");
      reader.release();
      await writer.query("rollback");
      writer.release();
      await pool.query(
        "update telegram_native_lifecycle_scan set last_intent_id=$1,prefer_history=$2 where scan_name='funded_v1'",
        [savedCursor.last_intent_id, savedCursor.prefer_history],
      );
    }
  }
  // Short-lived handoff retention must not stop factual repair of an already
  // admitted order. This changes no authorization or financial facts.
  await tx(pool, async (db) => {
    await db.query("savepoint retained_order_test");
    await lockFundingPolicyForTransaction(db);
    await db.query("select id from users where id=$1 for update", [
      retainedFixture.base.userId,
    ]);
    await db.query("delete from telegram_app_handoffs where id=$1", [
      retainedFixture.binding.handoffId,
    ]);
    assert.equal(
      await projectTelegramNativeHandoffStatusInTransaction(db, {
        actionId: retainedFixture.prepared.actionId,
        userId: retainedFixture.base.userId,
      }),
      1,
    );
    assert.ok(
      await readTelegramNativeHandoffOrder(db, {
        tradeIntentId: retainedFixture.intentId,
        userId: retainedFixture.base.userId,
      }),
    );
    await db.query("rollback to savepoint retained_order_test");
  });
  // Owner-first shared lifecycle must skip a native writer's U and avoid I;
  // after that writer commits the next normal batch must recover it. Use two
  // real transactions and the shared selector, never a Telegram sender.
  await pool.query(
    "update telegram_trade_intents set chat_id=$2,telegram_message_id=1,updated_at=clock_timestamp() where id=$1",
    [readPlanFixture.intentId, readPlanFixture.telegramUserId],
  );
  const owner = await pool.connect();
  const lifecycleClient = await pool.connect();
  try {
    await owner.query("begin");
    await lifecycleClient.query("begin");
    await lifecycleClient.query("set local statement_timeout='5s'");
    await lockFundingPolicyForTransaction(owner);
    await owner.query("select id from users where id=$1 for update", [
      readPlanFixture.base.userId,
    ]);
    await runTelegramTradeLifecycleProjectionBatchInTransaction(
      lifecycleClient,
      { limit: 1 },
    );
    await owner.query(
      "select id from telegram_trade_intents where id=$1 for update nowait",
      [readPlanFixture.intentId],
    );
    assert.equal(
      (
        await lifecycleClient.query(
          "select count(*)::int as row_count from telegram_bot_action_outbox where trade_intent_id=$1",
          [readPlanFixture.intentId],
        )
      ).rows[0].row_count,
      0,
    );
  } finally {
    await lifecycleClient.query("rollback");
    lifecycleClient.release();
    await owner.query("rollback");
    owner.release();
  }
  await checkTelegramNativeHandoffReadPlans(pool, {
    tradeIntentId: readPlanFixture.intentId,
    actionId: readPlanFixture.prepared.actionId,
    userId: readPlanFixture.base.userId,
    telegramUserId: readPlanFixture.telegramUserId,
    marketId: readPlanFixture.native.marketId,
  });
} finally {
  if (policyIds.length)
    await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
      policyIds,
    ]);
  await pool.end();
}
