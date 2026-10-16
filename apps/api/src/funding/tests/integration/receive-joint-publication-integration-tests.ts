// @api-integration — disposable PostgreSQL 16, no provider or wallet actions.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import bs58 from "bs58";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { createRelayReferenceCodec } from "../../../funding-providers/relay/reference-codec.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";
import { syntheticCanonicalAnchor } from "../recorded-role-observer-fixture.js";
import {
  createOrReuseFundingReceiveSession,
  quarantineFundingReceiveCanonicalInternalEvent,
  stageFundingReceiveClassificationBatch,
  lockFundingReceiveCanonicalEvents,
  lockFundingReceiveSessionScope,
  finishFundingReceiveClassificationRetry,
} from "../../persistence/funding-receive-session-repository.js";
import {
  advanceReceiveRefundScan,
  checkpointReceiveRoleArbitrationInTransaction,
} from "../../receive/receive-refund-scan.js";
import { SOLANA_RETAINED_USDC_ASSET } from "../../receive/retained-solana-assets.js";
import { relayDestinationReferenceIdentity } from "../../../funding-providers/relay/destination-reference.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import { buildFundingReceiveTargets } from "../../planner/receive-targets.js";
import {
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
} from "../../reconciliation/direct-ingress-observer.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000 -c lock_timeout=8000",
});
const key = {
  encryptionKey: Buffer.alloc(32, 47),
  lookupHmacKey: "joint-receive-fixture-not-a-secret-12345678",
  keyVersion: 1,
};
const transactionReferenceCodec = createFundingTransactionReferenceCodec(key);
const relayReferenceCodec = createRelayReferenceCodec(key);
const codecs = { transactionReferenceCodec, relayReferenceCodec };
const hex = (length: number) => `0x${randomBytes(length).toString("hex")}`;
const users: string[] = [],
  hashes: string[] = [];

async function fixture(
  count = 2,
  extraVariant?: DirectIngressObservationVariant,
) {
  const now = new Date(),
    userId = randomUUID(),
    address = hex(20);
  users.push(userId);
  await pool.query(
    "insert into users(id,email,is_active,is_verified) values($1,$2,true,true)",
    [userId, `${userId}@example.com`],
  );
  const asset = {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  };
  const variant = parseDirectIngressObservationVariant({
    variantId: `variant_${userId}`,
    networkId: asset.networkId,
    asset,
    destinationAddress: address,
    destinationLocationId: `location_${userId}`,
    baselineRaw: "0",
    baselineRevision: `baseline_${userId}`,
    observation: {
      adapterId: "owned_wallet_liquid_balances_v1",
      payload: {
        eventCursorBlock: "100",
        eventIdentity: "evm_erc20_transfer_v1",
      },
    },
    completion: { kind: "child_funding_operation" },
  });
  const variants = [variant, ...(extraVariant ? [extraVariant] : [])];
  const targets = buildFundingReceiveTargets(variants);
  const opened = await createOrReuseFundingReceiveSession(pool, {
    userId,
    venueId: "hyperliquid",
    ownerChannel: "web",
    destinationOptionId: `destination_${userId}`,
    venueBindingOptionId: `binding_${userId}`,
    destinationAsset: asset,
    destinationTargetSnapshot: {},
    venueBindingSnapshot: {},
    methods: [
      {
        methodId: `method_${userId}`,
        kind: "manual",
        safeLabel: "Test receive",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: targets,
          recommendedReceiveTargetId: targets[0].receiveTargetId,
          destinationOptionId: `destination_${userId}`,
          destinationAddress: address,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(now.getTime() + 60000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets: targets,
    selectedReceiveTargetId: targets[0].receiveTargetId,
    observationVariants: variants,
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "joint_fixture_policy_revision",
    ownershipRevision: "joint_fixture_ownership_revision",
    expiresAt: new Date(now.getTime() + 60000),
    observeUntil: new Date(now.getTime() + 120000),
    now,
  });
  const transactionHash = hex(32),
    blockHash = hex(32),
    sourceAddress = hex(20);
  hashes.push(transactionHash);
  const events = Array.from({ length: count }, (_, index) => ({
    variant,
    transactionHash,
    eventIndex: String(index),
    blockNumber: "101",
    blockHash,
    sourceAddress,
    destinationAddress: address,
    rawAmount: "2000000",
    observedAt: new Date(now.getTime() + 100).toISOString(),
  }));
  const scan = async (
    requestedVariants?: readonly DirectIngressObservationVariant[],
  ) => {
    if (
      requestedVariants &&
      !requestedVariants.some((entry) => entry.variantId === variant.variantId)
    )
      return { events: [], variants: requestedVariants, cursorAdvanced: false };
    return {
      events: [...events].reverse().concat(events[0]),
      variants: [
        {
          ...variant,
          observation: {
            ...variant.observation,
            payload: {
              ...variant.observation.payload,
              eventCursorBlock: "101",
            },
          },
        },
        ...(extraVariant ? [extraVariant] : []),
      ],
      cursorAdvanced: true,
    };
  };
  const sessionId = opened.snapshot.session.receiveSessionId;
  const state = async () => ({
    session: (
      await pool.query(
        "select status,version,observation_variants from funding_receive_sessions where id=$1",
        [sessionId],
      )
    ).rows[0],
    receipts: (
      await pool.query(
        "select status,evidence from funding_receive_receipts where receive_session_id=$1 order by event_index",
        [sessionId],
      )
    ).rows,
    events: (
      await pool.query(
        "select id,allocation_status,allocation_error_code,classification_lease_token,classification_retry_at from funding_receive_canonical_events where tx_hash=$1 order by event_index",
        [transactionHash],
      )
    ).rows,
  });
  return {
    now,
    userId,
    asset,
    address,
    variant,
    sessionId,
    transactionHash,
    scan,
    state,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Warm only durable derived pages through real readers. No receipt/effect is
 * published here; the public observer below must still arbitrate and fence. */
async function prepareRoleScans(f: Fixture) {
  const scope = {
    userId: f.userId,
    destinationOptionId: `destination_${f.userId}`,
    venueBindingOptionId: `binding_${f.userId}`,
  };
  const events = (await f.scan()).events.map((event) => ({
    ...event,
    networkId: event.variant.networkId,
    asset: event.variant.asset,
    ledgerHeight: event.blockNumber,
    observedAt: new Date(event.observedAt),
    now: f.now,
  }));
  const staged = await stageFundingReceiveClassificationBatch(pool, {
    scope,
    events,
    retryDelayMs: 1000,
    now: f.now,
  });
  const dependencies = new Set<string>();
  for (const item of staged) {
    assert.equal(item.kind, "claimed");
    if (item.kind !== "claimed") throw Error("fixture claim missing");
    let retry = item.retry;
    let ready = false;
    let lastProgress: unknown, lastDecision: unknown;
    for (let page = 0; page < 20 && !ready; page++) {
      lastProgress = await advanceReceiveRefundScan(pool, {
        retry,
        userId: f.userId,
        limit: 100,
        transactionReferenceCodec,
        referenceCodec: relayReferenceCodec,
      });
      const decision = await tx(pool, async (db) => {
        await lockFundingReceiveSessionScope(db, scope);
        await lockFundingReceiveCanonicalEvents(db, events);
        return checkpointReceiveRoleArbitrationInTransaction(db, {
          retry,
          userId: f.userId,
          limit: 100,
          transactionReferenceCodec,
          referenceCodec: relayReferenceCodec,
        });
      });
      lastDecision = decision;
      if (decision.kind === "ready_for_fence") {
        assert.equal(
          decision.classification.kind,
          "external",
          JSON.stringify(decision.classification),
        );
        decision.dependencies.forEach((facts) =>
          dependencies.add(facts.operationId),
        );
        ready = true;
      }
      if (!ready) {
        await tx(pool, async (db) => {
          await lockFundingReceiveSessionScope(db, scope);
          await lockFundingReceiveCanonicalEvents(db, events);
          await finishFundingReceiveClassificationRetry(db, {
            retry,
            receiveSessionId: f.sessionId,
            receiptsRecorded: 0,
          });
        });
        f.now = new Date(f.now.getTime() + 1000);
        const [next] = await stageFundingReceiveClassificationBatch(pool, {
          scope,
          events: events
            .filter((event) => event.eventIndex === retry.eventIndex)
            .slice(0, 1),
          retryDelayMs: 1000,
          now: f.now,
        });
        assert.equal(next.kind, "claimed");
        if (next.kind !== "claimed") throw Error("fixture next lease missing");
        retry = next.retry;
      }
    }
    assert.ok(
      ready,
      `real role pages must converge within fixture bound: ${JSON.stringify({ lastProgress, lastDecision })}`,
    );
  }
  assert.equal((await f.state()).receipts.length, 0);
  return dependencies;
}
const poll = (observer: FundingReceiveSessionObserver, f: Fixture, db = pool) =>
  observer.pollBatch(db, {
    limit: 100,
    minimumPollIntervalMs: 0,
    classificationRetryDelayMs: 1000,
    now: new Date(f.now.getTime() + 1000),
  });

/** A real persisted exact-reference NEGATIVE witness, not a fake classifier.
 * The approval has no economic debit and cannot establish an internal receive.
 */
async function negativeWitness(
  f: Fixture,
  legacyDestination?: DirectIngressObservationVariant,
) {
  return tx(pool, async (db) => {
    const location = {
      kind: "wallet" as const,
      accountId: f.userId,
      locationId: randomUUID(),
      asset: f.asset,
      details: { address: f.address },
    };
    const snapshot = { kind: "owned_location", location };
    const destinationSnapshot = legacyDestination
      ? {
          kind: "owned_location",
          location: {
            ...location,
            asset: legacyDestination.asset,
            details: { address: legacyDestination.destinationAddress },
          },
        }
      : {
          kind: "owned_location",
          location: { ...location, details: { address: hex(20) } },
        };
    const plan: FundingCommitPlan = {
      operation: {
        purpose: "add_funds",
        initialState: { status: "in_progress", stage: "committed" },
        experienceMode: "prepare_first",
        planKind: "wallet_route",
        sourceSnapshot: snapshot,
        destinationTargetSnapshot: destinationSnapshot,
        externalRecipientId: null,
        venueId: "hyperliquid",
        marketId: null,
        marketContextSnapshot: null,
        venueBindingSnapshot: null,
        walletExecutionSnapshot: null,
        placementSnapshot: {},
        requestedSourceAmount: { asset: f.asset, raw: "2000000" },
        requestedDestinationAmount: {
          asset: legacyDestination?.asset ?? f.asset,
          raw: "2000000",
        },
        supportMetadata: { test: true },
      },
      segments: [
        {
          providerId: "relay",
          adapterId: "joint-fixture",
          adapterVersion: 1,
          segmentKind: "cross_network_transfer",
          status: "planned",
          sourceSnapshot: snapshot,
          destinationTargetSnapshot: destinationSnapshot,
          quotedInput: { asset: f.asset, raw: "2000000" },
          quotedExpectedOutput: {
            asset: legacyDestination?.asset ?? f.asset,
            raw: "2000000",
          },
          quotedMinOutput: {
            asset: legacyDestination?.asset ?? f.asset,
            raw: "2000000",
          },
          providerQuoteRefCiphertext: null,
          providerQuoteRefLookupHmac: null,
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: null,
          quoteExpiresAt: new Date(f.now.getTime() + 60000).toISOString(),
          supportMetadata: legacyDestination
            ? {
                relaySuccessfulDestinationReferenceHashesV1: [
                  relayDestinationReferenceIdentity(f.transactionHash),
                ],
              }
            : {},
        },
      ],
      steps: [],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: randomUUID(),
          locationId: location.locationId,
          networkId: f.asset.networkId,
          assetId: f.asset.assetId,
          assetDecimals: f.asset.decimals,
          rawAmount: "2000000",
          mode: "subtract_available",
          expiresAt: new Date(f.now.getTime() + 60000).toISOString(),
        },
      ],
    };
    const consentToken = randomUUID();
    const quote = await createFundingQuoteInTransaction(db, {
      userId: f.userId,
      discoveryProjectionId: randomUUID(),
      selectedSourceOptionSnapshot: snapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot: destinationSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "fixture",
      canonicalRequest: { test: true },
      consentToken,
      expiresAt: new Date(f.now.getTime() + 60000),
    });
    const operation = await commitFundingOperationInTransaction(db, {
      userId: f.userId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: randomUUID(),
      plan,
      subjectLookupHmac: "a".repeat(64),
      subjectLookupKeyVersion: 1,
    });
    const operationId = operation.operation.id;
    const stepId = (
      await db.query(
        `insert into funding_operation_steps(operation_id,segment_id,ordinal,step_kind,action_fingerprint,executor_id,payer_requirement,normalized_action,action_validation_result)
      values($1,(select id from funding_operation_segments where operation_id=$1 and ordinal=0),0,'approval',$2,'fixture','none','{"kind":"approval"}','{}') returning id`,
        [operationId, "b".repeat(64)],
      )
    ).rows[0].id as string;
    await db.query(
      `insert into funding_operation_step_attempts(step_id,attempt_number,canonical_action_fingerprint,executor_id,outcome,broadcast_may_have_occurred,reference_kind,receipt_ref_ciphertext,receipt_ref_lookup_hmac,lookup_key_version,finished_at)
      values($1,1,$2,'fixture','submitted',true,'transaction',$3,$4,1,now())`,
      [
        stepId,
        "b".repeat(64),
        transactionReferenceCodec.encrypt(f.transactionHash),
        transactionReferenceCodec.fingerprint(f.transactionHash),
      ],
    );
    return { operationId, stepId };
  });
}

type Hook = (
  sql: string,
  values: unknown[] | undefined,
  db: PoolClient,
) => Promise<void>;
function intercepted(before: Hook, statements: string[] = []): Pool {
  const wrapped = Object.create(pool) as Pool;
  wrapped.query = pool.query.bind(pool);
  wrapped.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, name) {
        if (name === "query")
          return async (sql: string, values?: unknown[]) => {
            statements.push(sql.trim());
            try {
              await before(sql, values, target);
              const result = await target.query(sql, values);
              return result;
            } catch (error) {
              console.error(
                "Synthetic PG fixture statement failed:",
                sql.slice(0, 100),
                error,
              );
              throw error;
            }
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  return wrapped;
}

try {
  assert.equal(
    (
      await pool.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  const initial = await fixture();
  const statements: string[] = [];
  const observed = await poll(
    new FundingReceiveSessionObserver({
      ...codecs,
      scanCanonicalEvents: initial.scan,
    }),
    initial,
    intercepted(async () => {}, statements),
  );
  assert.equal(observed.retryableErrors, 0);
  assert.equal(observed.receiptsRecorded, 2);
  const first = await initial.state();
  assert.deepEqual(
    first.receipts.map((r) => r.status),
    ["observed", "observed"],
    "fresh conversion must not inherit historical retry semantics",
  );
  assert.equal(
    first.session.observation_variants[0].observation.payload.eventCursorBlock,
    "101",
  );
  assert.ok(
    first.events.every(
      (e) =>
        e.allocation_status === "allocated" &&
        e.classification_lease_token === null,
    ),
  );
  const fence = statements.findIndex((sql) =>
    sql.includes("select funding_classification_fence"),
  );
  assert.ok(fence > 0);
  assert.equal(
    statements[fence + 1],
    "commit",
    "nothing may intervene between F and COMMIT",
  );
  // Immutable allocations don't acquire new codec/evidence dependencies.
  const replay = await poll(
    new FundingReceiveSessionObserver({ scanCanonicalEvents: initial.scan }),
    initial,
  );
  assert.equal(replay.retryableErrors, 0);
  assert.equal(replay.receiptsRecorded, 0);
  assert.equal((await initial.state()).receipts.length, 2);
  console.log(
    "PASS joint initial publication, duplicate/reverse events, normal conversion, F immediately COMMIT, allocated replay without codecs",
  );

  const pending = await fixture(1);
  assert.equal(
    (
      await poll(
        new FundingReceiveSessionObserver({
          scanCanonicalEvents: pending.scan,
        }),
        pending,
      )
    ).receiptsRecorded,
    0,
  );
  const waiting = await pending.state();
  assert.equal(
    waiting.events[0].allocation_error_code,
    "exact_refund_correlation_pending",
  );
  assert.equal(waiting.events[0].classification_lease_token, null);
  assert.equal(
    waiting.session.observation_variants[0].observation.payload
      .eventCursorBlock,
    "101",
    "staged unknown evidence survives cursor advance",
  );
  const retryObserver = new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: syntheticCanonicalAnchor,
    ...codecs,
    scanCanonicalEvents: async () => {
      throw Error("retry must not scan the chain");
    },
  });
  const recovered = await retryObserver.pollKnownCanonicalRetryBatch(pool, {
    limit: 100,
    retryDelayMs: 1000,
    now: new Date(pending.now.getTime() + 3000),
  });
  assert.equal(recovered.retryableErrors, 0);
  assert.equal(recovered.receiptsRecorded, 1);
  const repaired = await pending.state();
  assert.equal(
    repaired.receipts[0].status,
    "recovery_required",
    "historical evidence must not restart automatic conversion",
  );
  assert.deepEqual(
    repaired.session.observation_variants,
    waiting.session.observation_variants,
  );
  assert.equal(repaired.session.status, waiting.session.status);
  console.log(
    "PASS missing codec → durable pending → existing retry recovery, no rescan or automatic conversion",
  );

  const unbound = await fixture(1);
  const unboundEvent = (await unbound.scan()).events[0];
  await tx(pool, (db) =>
    quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...unboundEvent,
      networkId: unboundEvent.variant.networkId,
      asset: unboundEvent.variant.asset,
      ledgerHeight: unboundEvent.blockNumber,
      observedAt: new Date(unboundEvent.observedAt),
      now: unbound.now,
      reason: "exact_refund_correlation_pending",
    }),
  );
  assert.equal(
    (
      await pool.query(
        "select classification_receive_session_id from funding_receive_canonical_events where tx_hash=$1",
        [unbound.transactionHash],
      )
    ).rows[0].classification_receive_session_id,
    null,
  );
  const boundRetry = await retryObserver.pollKnownCanonicalRetryBatch(pool, {
    limit: 100,
    retryDelayMs: 1000,
    now: new Date(unbound.now.getTime() + 1000),
  });
  assert.equal(boundRetry.retryableErrors, 0);
  assert.equal(boundRetry.receiptsRecorded, 1);
  assert.equal((await unbound.state()).receipts[0].status, "recovery_required");
  const frozen = (
    await pool.query(
      "select classification_receive_session_id,classification_variant_id from funding_receive_canonical_events where tx_hash=$1",
      [unbound.transactionHash],
    )
  ).rows[0];
  assert.equal(frozen.classification_receive_session_id, unbound.sessionId);
  assert.equal(frozen.classification_variant_id, unbound.variant.variantId);
  console.log(
    "PASS historical unbound event freezes real selected session before scan and repairs without automatic conversion",
  );

  const changed = await fixture();
  const negative = await negativeWitness(changed);
  assert.deepEqual(
    [...(await prepareRoleScans(changed))],
    [negative.operationId],
  );
  let changedFacts = false,
    publicationReachedFence = false;
  const failed = await poll(
    new FundingReceiveSessionObserver({
      ...codecs,
      scanCanonicalEvents: changed.scan,
    }),
    changed,
    intercepted(async (sql, values, db) => {
      if (
        !changedFacts &&
        sql
          .trimStart()
          .startsWith("select id,user_id from funding_operations") &&
        (values?.[0] as string[])?.includes(negative.operationId)
      ) {
        assert.deepEqual(
          values?.[0],
          [negative.operationId],
          "negative witness participates in union operation lock",
        );
        // Real committed facts mutation after classification, before O/F. Neither
        // the decision nor the fence is mocked. Both batched events must roll back.
        const before = (
          await pool.query(
            "select revision::text from funding_classification_revisions where operation_id=$1",
            [negative.operationId],
          )
        ).rows[0].revision;
        await pool.query(
          "update funding_operation_segments set raw_status='pending' where operation_id=$1",
          [negative.operationId],
        );
        const after = (
          await pool.query(
            "select revision::text from funding_classification_revisions where operation_id=$1",
            [negative.operationId],
          )
        ).rows[0].revision;
        assert.equal(BigInt(after), BigInt(before) + 1n);
        changedFacts = true;
      }
      if (
        changedFacts &&
        sql.startsWith("select funding_classification_fence") &&
        String(values?.[0]).includes(negative.operationId)
      ) {
        const count = await db.query(
          "select count(*)::int as total from funding_receive_receipts where receive_session_id=$1",
          [changed.sessionId],
        );
        assert.equal(
          count.rows[0].total,
          2,
          "both effects reached final fence before rollback",
        );
        publicationReachedFence = true;
      }
    }),
  );
  assert.ok(
    changedFacts,
    `test must observe a real nonempty dependency set: ${JSON.stringify({ failed, state: await changed.state() })}`,
  );
  assert.equal(failed.retryableErrors, 1);
  assert.ok(
    publicationReachedFence,
    "failure must be the final revision fence, not a fixture or SQL error",
  );
  assert.equal(failed.receiptsRecorded, 0);
  const rolledBack = await changed.state();
  assert.equal(rolledBack.receipts.length, 0);
  assert.equal(
    rolledBack.session.observation_variants[0].observation.payload
      .eventCursorBlock,
    "100",
  );
  assert.ok(
    rolledBack.events.every(
      (e) =>
        e.allocation_status === "recovery_required" &&
        e.classification_lease_token !== null,
    ),
  );
  let retriedReceipts = 0;
  for (let tick = 3; tick < 23 && retriedReceipts < 2; tick++) {
    const retried = await retryObserver.pollKnownCanonicalRetryBatch(pool, {
      limit: 100,
      retryDelayMs: 1000,
      now: new Date(changed.now.getTime() + tick * 1000),
    });
    assert.equal(retried.retryableErrors, 0);
    retriedReceipts += retried.receiptsRecorded;
  }
  assert.equal(retriedReceipts, 2);
  assert.equal((await changed.state()).receipts.length, 2);
  console.log(
    "PASS real negative witness revision race rolls back both receipts/cursor/ack, ordinary bounded retries rebuild facts and recover once",
  );

  const legacyRefund = await fixture(1);
  const legacyEvent = (await legacyRefund.scan()).events[0];
  await tx(pool, (db) =>
    quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...legacyEvent,
      networkId: legacyEvent.variant.networkId,
      asset: legacyEvent.variant.asset,
      ledgerHeight: legacyEvent.blockNumber,
      observedAt: new Date(legacyEvent.observedAt),
      now: legacyRefund.now,
      reason: "internal_exact_refund_suppressed",
    }),
  );
  const legacyRecheck = await poll(
    new FundingReceiveSessionObserver({
      ...codecs,
      scanCanonicalEvents: legacyRefund.scan,
    }),
    legacyRefund,
  );
  assert.equal(legacyRecheck.retryableErrors, 0);
  assert.equal(legacyRecheck.receiptsRecorded, 0);
  assert.equal(
    (await legacyRefund.state()).events[0].allocation_error_code,
    "internal_exact_refund_suppressed",
    "unmarked legacy owned suppression is NOT a missing exact refund and cannot be released",
  );
  console.log(
    "PASS legacy owned refund suppression preserved across re-observation",
  );

  const solVariant = parseDirectIngressObservationVariant({
    variantId: randomUUID(),
    networkId: SOLANA_RETAINED_USDC_ASSET.networkId,
    asset: SOLANA_RETAINED_USDC_ASSET,
    destinationAddress: bs58.encode(randomBytes(32)),
    destinationLocationId: randomUUID(),
    baselineRaw: "0",
    baselineRevision: "mixed_fixture_baseline",
    observation: {
      adapterId: "owned_wallet_liquid_balances_v1",
      payload: { eventIdentity: "solana_transfer_v1", eventCursorSlot: "100" },
    },
    completion: { kind: "retained_owned_source_credit" },
  });
  const mixed = await fixture(1, solVariant);
  const jointOwner = await negativeWitness(mixed);
  const mixedDependencies = await prepareRoleScans(mixed);
  assert.deepEqual([...mixedDependencies], [jointOwner.operationId]);
  const solHash = bs58.encode(randomBytes(64));
  hashes.push(solHash);
  const legacyOwner = await negativeWitness(
    { ...mixed, transactionHash: solHash },
    solVariant,
  );
  assert.ok(
    !mixedDependencies.has(legacyOwner.operationId),
    "legacy effect owner is not a joint source dependency",
  );
  let unionChecked = false,
    effectLocksChecked = false,
    mixedFenceChecked = false;
  const mixedResult = await poll(
    new FundingReceiveSessionObserver({
      ...codecs,
      scanCanonicalEvents: async (variants) => {
        const scanned = await mixed.scan(variants);
        if (!scanned.events.length) return scanned;
        return {
          ...scanned,
          events: [
            ...scanned.events,
            {
              variant: solVariant,
              transactionHash: solHash,
              eventIndex: "0",
              blockNumber: "101",
              blockHash: bs58.encode(randomBytes(32)),
              sourceAddress: bs58.encode(randomBytes(32)),
              destinationAddress: solVariant.destinationAddress,
              rawAmount: "2000000",
              observedAt: new Date(mixed.now.getTime() + 100).toISOString(),
            },
          ],
        };
      },
    }),
    mixed,
    intercepted(async (sql, values) => {
      if (
        sql.startsWith("select funding_classification_fence") &&
        String(values?.[0]).includes(jointOwner.operationId)
      ) {
        const facts = JSON.parse(String(values?.[0])) as {
          operationId: string;
        }[];
        assert.ok(
          facts.some((entry) => entry.operationId === jointOwner.operationId),
        );
        assert.ok(
          !facts.some((entry) => entry.operationId === legacyOwner.operationId),
          "legacy lock-only owner must not enter joint facts through the source scan",
        );
        mixedFenceChecked = true;
      }
      if (
        sql
          .trimStart()
          .startsWith("select id,user_id from funding_operations") &&
        (values?.[0] as string[])?.some(
          (id) =>
            id === jointOwner.operationId || id === legacyOwner.operationId,
        )
      ) {
        assert.deepEqual(
          [...(values?.[0] as string[])].sort(),
          [jointOwner.operationId, legacyOwner.operationId].sort(),
        );
        assert.match(sql, /order by id for update/);
        unionChecked = true;
      }
      if (sql.includes("insert into funding_observations")) {
        assert.ok(unionChecked);
        for (const operationId of [
          jointOwner.operationId,
          legacyOwner.operationId,
        ]) {
          const probe = await pool.connect();
          try {
            await probe.query("begin");
            await assert.rejects(
              probe.query(
                "select id from funding_operations where id=$1 for update nowait",
                [operationId],
              ),
              (error: unknown) => (error as { code?: string }).code === "55P03",
            );
          } finally {
            await probe.query("rollback");
            probe.release();
          }
        }
        effectLocksChecked = true;
      }
    }),
  );
  assert.equal(
    mixedResult.retryableErrors,
    0,
    JSON.stringify({
      mixedResult,
      unionChecked,
      effectLocksChecked,
      state: await mixed.state(),
    }),
  );
  assert.equal(mixedResult.receiptsRecorded, 1);
  assert.ok(
    unionChecked && effectLocksChecked && mixedFenceChecked,
    "both real operations must be locked before the real Solana destination effect",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as total from funding_observations where operation_id=$1 and kind='destination_credit'",
        [legacyOwner.operationId],
      )
    ).rows[0].total,
    1,
  );
  console.log(
    "PASS mixed Base/Solana batch: real exact destination, union sorted O, both owners locked before any destination credit",
  );
} finally {
  // Exact generated fixture scope; no application data or application lifecycle.
  await tx(pool, async (db) => {
    await db.query("set local session_replication_role=replica");
    await db.query(
      "delete from funding_operation_step_attempts where step_id in(select id from funding_operation_steps where operation_id in(select id from funding_operations where user_id=any($1::uuid[])))",
      [users],
    );
    for (const table of [
      "funding_operation_steps",
      "funding_operation_segments",
      "funding_reconciliation_jobs",
      "funding_observations",
      "balance_reservations",
      "funding_classification_revisions",
    ] as const)
      await db.query(
        `delete from ${table} where operation_id in(select id from funding_operations where user_id=any($1::uuid[]))`,
        [users],
      );
    await db.query(
      "delete from funding_receive_refund_candidates where event_id in(select event_id from funding_receive_refund_scans where user_id=any($1::uuid[]))",
      [users],
    );
    for (const table of [
      "funding_receive_refund_scans",
      "funding_receive_open_idempotency",
      "funding_receive_receipts",
      "funding_receive_sessions",
      "funding_operations",
      "funding_quotes",
      "notifications",
    ] as const)
      await db.query(`delete from ${table} where user_id=any($1::uuid[])`, [
        users,
      ]);
    await db.query(
      "delete from funding_receive_canonical_events where tx_hash=any($1::text[])",
      [hashes],
    );
    await db.query("delete from users where id=any($1::uuid[])", [users]);
  });
  await pool.end();
}
