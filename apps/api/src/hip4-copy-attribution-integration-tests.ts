// @requires-db — disposable PG16, rollback-only, offline ephemeral signing and fake transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "@hunch/infra";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4Identity,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { Wallet } from "ethers";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction } from "./repos/hip4-order-preparation.js";
import {
  admitHip4OrderActionInTransaction,
  type Hip4OrderSubmitRequest,
} from "./repos/hip4-order-admission.js";
import { submitHip4OrderAction } from "./services/hip4-order-submission.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { buildHip4CopyPreparedTrade } from "./services/hip4-copy-attribution.js";
import { buildHip4SocialInstrument } from "./services/hip4-social-instrument.js";
import { hip4SocialPurchaseKey } from "./services/hip4-social-evidence.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { factsFromEvidence } from "./services/verified-buy.js";
import {
  recoverCopyPurchaseLinks,
  retainCopyBeforeSubmissionInTransaction,
} from "./services/social-copy.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import type { SocialSourceRef } from "./schemas/social-trade.js";

const publicFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000 -c lock_timeout=2000",
});
const db = await pool.connect();
let nestedDepth = 0;
const nestedQuery = async (sql: string, parameters: unknown[] = []) => {
  if (sql.toLowerCase() === "begin")
    return db.query(`savepoint native_copy_tx_${++nestedDepth}`);
  if (sql.toLowerCase() === "commit")
    return db.query(`release savepoint native_copy_tx_${nestedDepth--}`);
  if (sql.toLowerCase() === "rollback") {
    const result = await db.query(
      `rollback to savepoint native_copy_tx_${nestedDepth}`,
    );
    await db.query(`release savepoint native_copy_tx_${nestedDepth--}`);
    return result;
  }
  return db.query(sql, parameters);
};
const transactionPool = {
  query: nestedQuery,
  connect: async () => ({ query: nestedQuery, release: () => {} }),
} as unknown as Pool;
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
let posts = 0;
let nextOid = 500000;
try {
  await db.query("begin");
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "off" };
  await db.query(
    "insert into runtime_policies(policy_key,payload,effective_at) values('venue_lifecycle',$1::jsonb,now()-interval '1 second')",
    [JSON.stringify(lifecycle)],
  );
  await db.query(
    "insert into runtime_policies(policy_key,payload,effective_at) values('social',$1::jsonb,now()-interval '1 second')",
    [
      JSON.stringify({
        ...DEFAULT_SOCIAL_POLICY,
        copyVenues: [...DEFAULT_SOCIAL_POLICY.copyVenues, "hyperliquid"],
        publicationVenues: [
          ...DEFAULT_SOCIAL_POLICY.publicationVenues,
          "hyperliquid",
        ],
      }),
    ],
  );
  const wallet = Wallet.createRandom();
  const base = await hip4OrderTestFixture(db, wallet.address);
  const identity = hip4Identity(
    "mainnet",
    Number(base.request.marketId.split(":").at(-1)),
  );
  const token = identity.sides[1];
  const native = mapHip4Market({
    ...publicFixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: publicFixture.collectedAt,
    generation: "replaceable-copy-fixture",
  }).market;
  Object.assign(native, {
    marketId: identity.marketId,
    outcome: Number(base.request.marketId.split(":").at(-1)),
    status: "observed",
    fetchedAt: new Date().toISOString(),
    metadataValidUntil: new Date(Date.now() + 3600000).toISOString(),
    expiry: "2099-01-01T00:00:00.000Z",
    quoteToken: "USDC",
    quoteTokenId: HYPERCORE_MAINNET_USDC.assetId,
    quoteWeiDecimals: 8,
  });
  native.sides = native.sides.map((side, i) => ({
    ...side,
    ...identity.sides[i],
  }));
  await db.query(
    "update unified_markets set metadata=$2::jsonb,expiration_time=$3,token_yes=$4,token_no=$5 where id=$1",
    [
      identity.marketId,
      JSON.stringify({ hip4: native }),
      native.expiry,
      identity.sides[0].tokenId,
      identity.sides[1].tokenId,
    ],
  );
  const instrument = buildHip4SocialInstrument({
    marketId: identity.marketId,
    tokenId: token.tokenId,
    outcome: "NO",
    expiry: native.expiry,
    snapshot: native,
  });
  assert.ok(instrument);
  const frozenInstrument = instrument;
  const authorId = randomUUID();
  const authorAddress = `0x${randomUUID().replaceAll("-", "")}12345678`;
  await db.query("insert into users(id,is_active) values($1,true)", [authorId]);
  async function sourceThesis(): Promise<SocialSourceRef> {
    const orderId = randomUUID(),
      thesisId = randomUUID();
    const facts = factsFromEvidence({
      canonicalPurchaseKey: hip4SocialPurchaseKey({
        environment: "mainnet",
        accountAddress: authorAddress,
        primaryOrderId: String(++nextOid),
      }),
      instrument: frozenInstrument,
      owner: authorAddress,
      notionalRaw: 200000000000000n,
      grossSharesRaw: 4000000n,
      netSharesRaw: 4000000n,
      collateralDecimals: 13,
      shareDecimals: 5,
      feesUsdRaw: 0n,
      purchasedAt: new Date(Date.now() - 60000).toISOString(),
      evidenceIds: [`fixture-prior-buy:${orderId}`],
    });
    await db.query(
      `insert into orders(id,user_id,venue,token_id,side,order_type,price,size,filled_size,status,wallet_address,signer_address,verified_buy_state,verified_buy_facts)
      values($1,$2,'hyperliquid',$3,'BUY','IOC',0.5,40,40,'filled',$4,$4,'verified',$5::jsonb)`,
      [orderId, authorId, token.tokenId, authorAddress, JSON.stringify(facts)],
    );
    await db.query(
      `insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,expiry,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,published_at)
      values($1,$2,$3,$4,$5,$5,$6,'NO',$7,$8,'Prior verified source thesis',$9::jsonb,'fixture',20,$10,$11,now()-interval '30 seconds')`,
      [
        thesisId,
        authorId,
        facts.canonicalPurchaseKey,
        orderId,
        identity.marketId,
        token.tokenId,
        facts.instrument.generation,
        facts.instrument.expiry,
        JSON.stringify(facts),
        randomUUID(),
        "1".repeat(64),
      ],
    );
    return { kind: "thesis", id: thesisId };
  }
  const sourceRef = await sourceThesis();
  const secondSource = await sourceThesis();
  type Attribution = { sourceRef: SocialSourceRef; copyIdempotencyKey: string };
  async function prepareOrder(attribution?: Attribution, quantity = "3") {
    const prepared = await persistHip4OrderPreparationInTransaction(db, {
      ...base,
      nonce: Date.now() - 10,
      expiresAfter: Date.now() + 60000,
      feeCapRaw: "0",
      request: {
        ...base.request,
        requestKey: randomUUID(),
        limitPrice: "0.5",
        quantity,
        consentedDebitCapRaw: quantity === "2" ? "100000000" : "150000000",
        ...attribution,
      },
    });
    const typed = prepareHip4TradeSigning(prepared.envelope).typedData;
    const signature = await wallet.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    );
    const submission = {
      userId: base.userId,
      actionId: prepared.actionId,
      signature,
      actor: "web_app",
      ...attribution,
      context: {
        profile: base.profile,
        feeCapRaw: "0",
        capacity: {
          assetId: HYPERCORE_MAINNET_USDC.assetId,
          decimals: 8,
          availableRaw: "100000000000",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    };
    return { prepared, submission };
  }
  function transport(
    order: Awaited<ReturnType<typeof prepareOrder>>,
    options: { reject?: boolean; beforePost?: () => Promise<void> } = {},
  ) {
    const fetcher: typeof fetch = async () => {
      posts++;
      await options.beforePost?.();
      return new Response(
        JSON.stringify({
          status: "ok",
          response: {
            type: "order",
            data: {
              statuses: [
                options.reject
                  ? { error: "Price must be divisible by tick size." }
                  : {
                      filled: {
                        oid: ++nextOid,
                        totalSz:
                          order.prepared.envelope.action.type === "order"
                            ? order.prepared.envelope.action.orders[0].s
                            : "0",
                        avgPx: "0.5",
                        cloid: order.prepared.cloid,
                      },
                    },
              ],
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    return { timeoutMs: 1000, responseMaxBytes: 10000, fetcher };
  }
  async function expectAdmissionFailure(
    submission: Parameters<typeof admitHip4OrderActionInTransaction>[1],
    pattern: RegExp,
  ) {
    await db.query("savepoint copy_expected_failure");
    await assert.rejects(
      () => admitHip4OrderActionInTransaction(db, submission, testCapability),
      pattern,
    );
    await db.query("rollback to savepoint copy_expected_failure");
    await db.query("release savepoint copy_expected_failure");
  }
  async function copyRows(key: string) {
    return (
      await db.query(
        "select * from copy_attributions where copier_user_id=$1 and idempotency_key=$2",
        [base.userId, key],
      )
    ).rows;
  }
  const ordinary = await prepareOrder(undefined, "2");
  const ordinaryResult = await submitHip4OrderAction(
    transactionPool,
    ordinary.submission,
    transport(ordinary),
    testCapability,
  );
  assert.equal(ordinaryResult.replayed, false);
  assert.equal(ordinaryResult.submission.state, "reconcile_required");
  const ordinaryRow = (
    await db.query(
      "select verified_buy_state,verified_buy_facts from orders where id=$1",
      [ordinary.prepared.orderId],
    )
  ).rows[0];
  assert.equal(ordinaryRow.verified_buy_state, "pending");
  assert.equal(ordinaryRow.verified_buy_facts, null);
  assert.equal(
    (
      await db.query("select id from copy_attributions where order_id=$1", [
        ordinary.prepared.orderId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.query("select id from user_theses where order_id=$1", [
        ordinary.prepared.orderId,
      ])
    ).rowCount,
    0,
  );
  const pair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const direct = await prepareOrder(pair);
  const copyInput = buildHip4CopyPreparedTrade({
    userId: base.userId,
    actionId: direct.prepared.actionId,
    marketId: identity.marketId,
    tokenId: token.tokenId,
    signerAddress: base.profile.address,
    cloid: direct.prepared.cloid,
    actionFingerprint: canonicalJsonHash(direct.prepared.envelope),
    envelope: direct.prepared.envelope,
    snapshot: direct.prepared.snapshot,
  });
  assert.ok(copyInput);
  await db.query("savepoint prepared_only_reference");
  await retainCopyBeforeSubmissionInTransaction(db, copyInput);
  await recoverCopyPurchaseLinks(db, 100);
  assert.equal(
    (await copyRows(pair.copyIdempotencyKey))[0].order_id,
    null,
    "prepared native order is not an admitted recoverable purchase",
  );
  await db.query("rollback to savepoint prepared_only_reference");
  await db.query("release savepoint prepared_only_reference");
  let copyBoundaryVerified = false;
  await submitHip4OrderAction(
    transactionPool,
    direct.submission,
    transport(direct, {
      beforePost: async () => {
        const retained = (await copyRows(pair.copyIdempotencyKey))[0];
        assert.ok(retained.submission_started_at);
        assert.equal(retained.order_id, direct.prepared.orderId);
        assert.equal(retained.source_thesis_id, sourceRef.id);
        assert.equal(retained.provider_reference, copyInput.providerReference);
        assert.equal(
          (
            await db.query(
              "select action_id from hip4_order_submissions where action_id=$1",
              [direct.prepared.actionId],
            )
          ).rowCount,
          1,
        );
        copyBoundaryVerified = true;
      },
    }),
    testCapability,
  );
  assert.equal(
    copyBoundaryVerified,
    true,
    "fake transport must observe retained Copy and admitted journal before POST",
  );
  assert.equal((await copyRows(pair.copyIdempotencyKey)).length, 1);
  const postsBeforeReplay = posts;
  await db.query("savepoint source_settings");
  await db.query("update user_theses set author_hidden_at=now() where id=$1", [
    sourceRef.id,
  ]);
  await db.query(
    "insert into runtime_policies(policy_key,payload,effective_at) values('social',$1::jsonb,now())",
    [JSON.stringify({ copyEnabled: false, copyVenues: [] })],
  );
  const replayed = await submitHip4OrderAction(
    transactionPool,
    direct.submission,
    transport(direct),
    testCapability,
  );
  assert.equal(replayed.replayed, true);
  assert.equal(posts, postsBeforeReplay);
  for (const changed of [
    { ...direct.submission, sourceRef: secondSource },
    { ...direct.submission, copyIdempotencyKey: randomUUID() },
    {
      ...direct.submission,
      sourceRef: undefined,
      copyIdempotencyKey: undefined,
    },
  ])
    await assert.rejects(
      () =>
        submitHip4OrderAction(
          transactionPool,
          changed,
          transport(direct),
          testCapability,
        ),
      /hip4_copy_scope_changed/u,
    );
  assert.equal(posts, postsBeforeReplay);
  await db.query("rollback to savepoint source_settings");
  await db.query("release savepoint source_settings");
  const failedPair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const capacityFailure = await prepareOrder(failedPair);
  capacityFailure.submission.context.capacity.availableRaw = "1";
  await expectAdmissionFailure(
    capacityFailure.submission,
    /hip4_capacity_reserved/u,
  );
  assert.equal((await copyRows(failedPair.copyIdempotencyKey)).length, 0);
  assert.equal(
    (
      await db.query(
        "select action_id from hip4_order_submissions where action_id=$1",
        [capacityFailure.prepared.actionId],
      )
    ).rowCount,
    0,
  );
  const changedPair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const changedGeneration = await prepareOrder(changedPair);
  await db.query("savepoint changed_generation");
  const changedNative = {
    ...native,
    description: `${native.description} changed oracle`,
  };
  await db.query("update unified_markets set metadata=$2::jsonb where id=$1", [
    identity.marketId,
    JSON.stringify({ hip4: changedNative }),
  ]);
  await expectAdmissionFailure(
    changedGeneration.submission,
    /copy_generation_mismatch/u,
  );
  assert.equal((await copyRows(changedPair.copyIdempotencyKey)).length, 0);
  await db.query("rollback to savepoint changed_generation");
  await db.query("release savepoint changed_generation");
  for (const lateChange of ["policy", "metadata_expiry"] as const) {
    const latePair = { sourceRef, copyIdempotencyKey: randomUUID() };
    const late = await prepareOrder(latePair);
    await db.query("savepoint late_copy_authority");
    let reachedFinalClock = false;
    const interleaved = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.trim() === "select clock_timestamp() as checked_at") {
          reachedFinalClock = true;
          if (lateChange === "policy") {
            await db.query("insert into runtime_policies(policy_key,payload,effective_at) values('social',$1::jsonb,clock_timestamp())", [{ copyEnabled: false }]);
          } else {
            await db.query("update unified_markets set metadata=jsonb_set(metadata,'{hip4,metadataValidUntil}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=$1", [identity.marketId]);
          }
        }
        return db.query(sql, params);
      },
    } as unknown as Parameters<typeof admitHip4OrderActionInTransaction>[0];
    await assert.rejects(() => admitHip4OrderActionInTransaction(interleaved, late.submission, testCapability), lateChange === "policy" ? /copy_disabled/u : /hip4_copy_instrument_unavailable/u);
    assert.equal(reachedFinalClock, true, "capability and metadata validity must be checked after possible lock waits");
    await db.query("rollback to savepoint late_copy_authority");
    await db.query("release savepoint late_copy_authority");
    assert.equal((await copyRows(latePair.copyIdempotencyKey)).length, 0);
    assert.equal((await db.query("select action_id from hip4_order_submissions where action_id=$1", [late.prepared.actionId])).rowCount, 0);
  }
  const rejectedPair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const rejection = await prepareOrder(rejectedPair);
  await submitHip4OrderAction(
    transactionPool,
    rejection.submission,
    transport(rejection, { reject: true }),
    testCapability,
  );
  assert.equal(
    (await copyRows(rejectedPair.copyIdempotencyKey))[0].state,
    "failed",
  );
  const fundedPair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const funding = await hip4FundedOrderTestFixture(db, {
    userId: base.userId,
    profile: base.profile,
    marketId: identity.marketId,
    tokenId: token.tokenId,
    ...fundedPair,
  });
  assert.deepEqual(funding.confirmedIntent.sourceRef, sourceRef);
  assert.equal(
    funding.confirmedIntent.copyIdempotencyKey,
    fundedPair.copyIdempotencyKey,
  );
  const missing = await prepareOrder();
  await expectAdmissionFailure(
    { ...missing.submission, funding },
    /hip4_funding_scope_changed/u,
  );
  const changedKeyPair = { sourceRef, copyIdempotencyKey: randomUUID() };
  const changedKey = await prepareOrder(changedKeyPair);
  await expectAdmissionFailure(
    { ...changedKey.submission, funding },
    /hip4_funding_scope_changed/u,
  );
  assert.equal((await copyRows(changedKeyPair.copyIdempotencyKey)).length, 0);
  const changedSourcePair = {
    sourceRef: secondSource,
    copyIdempotencyKey: fundedPair.copyIdempotencyKey,
  };
  const changedSource = await prepareOrder(changedSourcePair);
  await expectAdmissionFailure(
    { ...changedSource.submission, funding },
    /hip4_funding_scope_changed/u,
  );
  const funded = await prepareOrder(fundedPair);
  const fundedInput: Hip4OrderSubmitRequest & {
    context: typeof funded.submission.context;
  } = { ...funded.submission, funding };
  await submitHip4OrderAction(
    transactionPool,
    fundedInput,
    transport(funded),
    testCapability,
  );
  const fundedAttribution = (await copyRows(fundedPair.copyIdempotencyKey))[0];
  assert.equal(fundedAttribution.order_id, funded.prepared.orderId);
  assert.ok(fundedAttribution.submission_started_at);
  assert.equal(
    (
      await db.query(
        "select funding_trade_attempt_id from hip4_order_submissions where action_id=$1",
        [funded.prepared.actionId],
      )
    ).rows[0].funding_trade_attempt_id !== null,
    true,
  );
  assert.equal(nestedDepth, 0);
  console.log(
    JSON.stringify({
      test: "hip4-copy-attribution-pg16",
      posts,
      cases: [
        "one-dollar ordinary BUY no publication",
        "custom amount below publication threshold",
        "prepared-only exact reference unlinked",
        "atomic attribution before POST",
        "replay after hide/disable without POST",
        "changed/missing replay scope rejected",
        "capacity rollback no detached Copy",
        "generation mismatch",
        "provider rejection failed attribution",
        "funded saved pair rejects missing/changed source/key",
        "funded exact pair admitted",
      ],
    }),
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
