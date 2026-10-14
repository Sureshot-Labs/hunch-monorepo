// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import type { Pool, PoolClient } from "pg";
import { hypercorePlanTestFixture } from "./funding-providers/relay/hypercore-plan-test-fixture.js";
import {
  buildRelayPlanningQuote,
  relayRefundLocationSnapshot,
} from "./funding-providers/relay/operation-plan.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "./funding/lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "./funding/lifecycle/funding-lifecycle-projector.js";
import { reconcileRelayDestinationReceipts } from "./funding/reconciliation/relay-destination-receipts.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  HYPERCORE_MAINNET_USDC,
  hypercoreLocationDex,
} from "./funding/domain/hypercore-identity.js";
import { sameAccountAddress } from "./funding/domain/asset-identity.js";
import type { JsonObject } from "./funding/domain/types.js";
import type { ResolvedRouteDestination } from "./funding/planner/destination-adapters.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { claimHyperliquidFundingNonceInTransaction } from "./funding/execution/hyperliquid-nonce-claims.js";
import { reduceFundingOperationInTransaction } from "./funding/reconciliation/funding-reducer.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  allocateFundingObservationInTransaction,
  type FundingCommitPlan,
} from "./funding/persistence/funding-operation-repository.js";
import { normalizeRelayHypercoreInboundWalletQuote } from "./funding-providers/relay/wallet-adapter.js";
import { resolveRelayHypercoreContracts } from "./funding-providers/relay/hypercore-quote.js";
import { relayHexOrderId } from "./funding-providers/relay/order-hash.js";
import {
  RELAY_ROUTE_SPECS,
  relayRuntimeRoute,
} from "./funding-providers/relay/mappings.js";
import {
  startFundingStepAttemptInTransaction,
  finishFundingStepAttemptInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
  recordFundingOperationCancellationDecisionInTransaction,
} from "./funding/persistence/funding-evidence-repository.js";
import { applyFundingStepReceiptEvidenceInTransaction } from "./funding/persistence/funding-step-receipt-repository.js";
import { nativeSourceDebitPendingSql } from "./funding/persistence/source-reservation-hold.js";
import {
  classifyOwnedRouteCanonicalDestinationEvents,
  recordOwnedRouteCanonicalDestinationCredit,
  OwnedRouteDestinationObserver,
} from "./funding/reconciliation/owned-route-destination-observer.js";
import {
  hypercoreDestinationEvent,
  verifyRelayHypercoreTransfer,
} from "./funding-providers/relay/hypercore-transfer-evidence.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const client = await pool.connect();
try {
  await client.query("begin");
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  const cases = [
    [
      "hyperliquid:mainnet",
      `0x${"Ab".repeat(20)}`,
      `0x${"ab".repeat(20)}`,
      true,
    ],
    [
      "hyperliquid:testnet",
      `0x${"Ab".repeat(16)}`,
      `0x${"ab".repeat(16)}`,
      true,
    ],
    [
      "hyperliquid:mainnet",
      `0x${"Ab".repeat(20)}`,
      `0x${"ab".repeat(16)}`,
      false,
    ],
    [
      "hypercore:mainnet",
      `0x${"Ab".repeat(20)}`,
      `0x${"ab".repeat(20)}`,
      false,
    ],
    ["solana:mainnet", "Abc", "abc", false],
    ["evm:8453", `0x${"Ab".repeat(20)}`, `0x${"ab".repeat(20)}`, true],
    ["evm:8453", `0x${"Ab".repeat(16)}`, `0x${"ab".repeat(16)}`, false],
    ["hyperliquid:mainnet", "not-an-address", "NOT-AN-ADDRESS", false],
  ] as const;
  for (const [network, left, right, expected] of cases) {
    const { rows } = await client.query(
      "select funding_account_identifier_equal($1,$2,$3) as matches",
      [network, left, right],
    );
    assert.equal(rows[0].matches, expected);
    // SQL function is used for asset IDs as well as owners; account TS parser
    // intentionally accepts only 40 hex characters, asset parser handles 32.
    if (left.length !== 34 && right.length !== 34)
      assert.equal(rows[0].matches, sameAccountAddress(network, left, right));
  }

  const userId = (
    await client.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`hip4-funding-${randomUUID()}@example.com`],
    )
  ).rows[0].id as string;
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/hip4/relay-receipts-20261012.json", import.meta.url),
      "utf8",
    ),
  );
  const route = fixture.routes[0];
  const result = verifyRelayHypercoreTransfer({
    expected: {
      asset: HYPERCORE_MAINNET_USDC,
      owner: route.owner,
      dex: "spot",
      direction: "credit",
      transactionHash: route.nativeTx.txHash,
      actualRaw: route.routeActual.destination.amount,
    },
    nativeTransaction: {
      ...route.nativeTx,
      data: {
        hash: route.nativeTx.txHash,
        error: null,
        user: route.nativeActionUser,
        action: route.nativeAction,
      },
    },
    ledger: route.nativeLedger.matches,
  });
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") throw new Error("Missing fixture proof");
  const now = new Date();
  const event = hypercoreDestinationEvent(result.evidence, now);
  const identity = [
    event.networkId,
    event.transactionHash,
    event.eventIndex,
  ].join(":");
  const asset = {
    ...HYPERCORE_MAINNET_USDC,
    assetId: `0x${HYPERCORE_MAINNET_USDC.assetId.slice(2).toUpperCase()}`,
  };
  const money = (raw: string) => ({ asset, raw });
  const source = {
    kind: "owned_location",
    locationId: randomUUID(),
    componentId: randomUUID(),
  };
  const target = {
    kind: "venue_account",
    location: {
      kind: "venue_account",
      asset,
      details: {
        address: route.owner,
        venueId: "hyperliquid",
        environment: "mainnet",
        nativeSourceDex: "spot",
      },
    },
  };
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "wallet_route",
      sourceSnapshot: source,
      destinationTargetSnapshot: target,
      externalRecipientId: null,
      venueId: "hyperliquid",
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: money(event.rawAmount),
      requestedDestinationAmount: money(event.rawAmount),
      supportMetadata: { test: true },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "synthetic-native-receipt",
        adapterVersion: 1,
        segmentKind: "cross_network_transfer",
        status: "planned",
        sourceSnapshot: source,
        destinationTargetSnapshot: target,
        quotedInput: money(event.rawAmount),
        quotedExpectedOutput: money(event.rawAmount),
        quotedMinOutput: money(event.rawAmount),
        providerQuoteRefCiphertext: null,
        providerQuoteRefLookupHmac: null,
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: source,
        quoteExpiresAt: new Date(now.getTime() + 60000).toISOString(),
      },
    ],
    steps: [
      {
        ordinal: 0,
        segmentOrdinal: 0,
        stepKind: "transaction",
        state: "planned",
        actionFingerprint: canonicalJsonHash({ fixture: "source-step" }),
        executorId: "fixture-only",
        payerRequirement: "none",
        dependsOnOrdinal: null,
        normalizedAction: { fixture: true },
        actionValidationResult: { fixture: true },
      },
    ],
    reservations: [],
  };
  const commit = async (fixtureUserId: string, fixturePlan = plan) => {
    const consentToken = randomUUID();
    assert.ok(fixturePlan.operation.sourceSnapshot);
    const quote = await createFundingQuoteInTransaction(client, {
      userId: fixtureUserId,
      discoveryProjectionId: randomUUID(),
      selectedSourceOptionSnapshot: fixturePlan.operation.sourceSnapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot:
        fixturePlan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: fixturePlan,
      policyVersion: 1,
      policyRevision: "native-test",
      canonicalRequest: { test: true },
      consentToken,
      expiresAt: new Date(now.getTime() + 60000),
    });
    return commitFundingOperationInTransaction(client, {
      userId: fixtureUserId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: randomUUID(),
      plan: fixturePlan,
      subjectLookupHmac: "a".repeat(64),
      subjectLookupKeyVersion: 1,
    });
  };
  const committed = await commit(userId);
  const operationId = committed.operation.id;
  assert.deepEqual(
    await new OwnedRouteDestinationObserver().pollOperation(
      client as unknown as Pool,
      operationId,
      now,
    ),
    {
      destinationsPolled: 0,
      destinationSatisfied: false,
    },
    "native target with an actual source step bypasses legacy balance/baseline readers",
  );
  const segmentId = (
    await client.query(
      "select id from funding_operation_segments where operation_id=$1",
      [operationId],
    )
  ).rows[0].id as string;
  const referenceCodec = { fingerprint: canonicalJsonHash };
  await client.query(
    "update funding_operation_segments set raw_status='success', support_metadata=$2::jsonb where id=$1",
    [
      segmentId,
      {
        relayStatusCategory: "provider_success",
        destinationTransactionReferenceCount: 1,
        relayTransactionReferenceFingerprints: [
          referenceCodec.fingerprint(event.transactionHash),
        ],
      },
    ],
  );
  const classify = (db: Pick<PoolClient, "query"> = client) =>
    classifyOwnedRouteCanonicalDestinationEvents(db, {
      userId,
      events: [event],
      referenceCodec,
    });
  const match = (await classify()).get(identity);
  assert.equal(match?.kind, "internal");
  if (match?.kind !== "internal") throw new Error("Missing native match");
  assert.equal(match.operationId, operationId);

  // Generic plans and an empty tail must execute the exact runtime statement.
  await client.query("set local plan_cache_mode=force_generic_plan");
  const plans: unknown[] = [];
  let runtimeSql = "";
  let runtimeValues: unknown[] = [];
  const explainedDb = {
    query: async (sql: string, values: unknown[]) => {
      runtimeSql = sql;
      runtimeValues = values;
      plans.push(
        (
          await client.query(
            `explain (analyze, buffers, format json) ${sql}`,
            values,
          )
        ).rows[0]["QUERY PLAN"],
      );
      return client.query(sql, values);
    },
  } as Pick<PoolClient, "query">;
  assert.equal((await classify(explainedDb)).get(identity)?.kind, "internal");
  // Exact parity with P2's canonical location and supported legacy envelopes.
  // Never infer spot from absent data or ignore contradictory legacy fields.
  const dexCases: readonly JsonObject[] = [
    {},
    { balanceClass: null },
    { balanceClass: "unknown" },
    { balanceClass: "perp" },
    { balanceClass: "spot" },
    { nativeSourceDex: "spot" },
    { nativeSourceDex: "spot", balanceClass: "spot" },
    { nativeSourceDex: "spot", balanceClass: "perp" },
    { nativeSourceDex: "spot", balanceClass: null },
    { nativeSourceDex: null, balanceClass: "spot" },
    { nativeSourceDex: "", balanceClass: "spot" },
    { nativeSourceDex: "spot", environment: "testnet" },
    { nativeSourceDex: "spot", venueId: "polymarket" },
  ];
  for (const dexDetails of dexCases) {
    const invalidUser = (
      await client.query(
        "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
        [`hip4-invalid-dex-${randomUUID()}@example.com`],
      )
    ).rows[0].id as string;
    const invalidTarget = {
      ...target,
      location: {
        ...target.location,
        details: {
          address: route.owner,
          venueId: "hyperliquid",
          environment: "mainnet",
          ...dexDetails,
        },
      },
    };
    const invalidPlan = {
      ...plan,
      operation: {
        ...plan.operation,
        destinationTargetSnapshot: invalidTarget,
      },
      segments: plan.segments.map((segment) => ({
        ...segment,
        destinationTargetSnapshot: invalidTarget,
      })),
    };
    const invalidOperation = await commit(invalidUser, invalidPlan);
    await client.query(
      "update funding_operation_segments set raw_status='success', support_metadata=$2 where operation_id=$1",
      [
        invalidOperation.operation.id,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: 1,
          relayTransactionReferenceFingerprints: [
            referenceCodec.fingerprint(event.transactionHash),
          ],
        },
      ],
    );
    assert.equal(
      (
        await classifyOwnedRouteCanonicalDestinationEvents(client, {
          userId: invalidUser,
          events: [event],
          referenceCodec,
        })
      ).get(identity)?.kind,
      hypercoreLocationDex(invalidTarget.location) === "spot"
        ? "internal"
        : "external",
      `SQL and canonical P2 DEX resolver must agree: ${JSON.stringify(dexDetails)}`,
    );
    const receiptRead = () =>
      reconcileRelayDestinationReceipts(
        client as unknown as Pool,
        {
          operationId: invalidOperation.operation.id,
          segmentId: invalidSegmentId,
          transactionHashes: [event.transactionHash],
          now,
          referenceCodec,
          requestId: route.requestId,
          status: route.relayStatus,
        },
        async (read) => {
          assert.equal(
            read.native?.dex,
            hypercoreLocationDex(invalidTarget.location),
          );
          return [];
        },
      );
    const invalidSegmentId = (
      await client.query(
        "select id from funding_operation_segments where operation_id=$1",
        [invalidOperation.operation.id],
      )
    ).rows[0].id as string;
    if (hypercoreLocationDex(invalidTarget.location) === null)
      await assert.rejects(receiptRead(), /native_destination_context_missing/);
    else await receiptRead();
  }
  const wrongClassEvent = hypercoreDestinationEvent(
    { ...result.evidence, destinationDex: "" },
    now,
  );
  assert.equal(
    (
      await classifyOwnedRouteCanonicalDestinationEvents(client, {
        userId,
        events: [wrongClassEvent],
        referenceCodec,
      })
    ).get(identity)?.kind,
    "external",
    "perps does not satisfy a spot destination",
  );
  assert.equal(
    (
      await classifyOwnedRouteCanonicalDestinationEvents(client, {
        userId: randomUUID(),
        events: [event],
        referenceCodec,
      })
    ).get(identity)?.kind,
    "external",
  );
  assert.equal(
    (
      await classifyOwnedRouteCanonicalDestinationEvents(client, {
        userId,
        events: [],
        referenceCodec,
      })
    ).size,
    0,
  );
  await recordOwnedRouteCanonicalDestinationCredit(client, {
    event,
    match,
    now,
  });
  await recordOwnedRouteCanonicalDestinationCredit(client, {
    event: hypercoreDestinationEvent(
      { ...result.evidence, providerBlock: result.evidence.providerBlock + 1 },
      new Date(now.getTime() + 1),
    ),
    match,
    now,
  });
  const observations = await client.query(
    "select raw_amount, block_hash, ledger_height, finality_status, metadata from funding_observations where operation_id=$1",
    [operationId],
  );
  assert.equal(
    observations.rowCount,
    1,
    "changed corroboration is not a second transfer",
  );
  assert.equal(observations.rows[0].raw_amount, event.rawAmount);
  assert.equal(observations.rows[0].block_hash, null);
  assert.equal(observations.rows[0].ledger_height, null);
  assert.equal(observations.rows[0].metadata.nativeDestinationDex, "spot");
  assert.equal(observations.rows[0].finality_status, "finalized");
  // Exercise the shared worker's exact known-hash and diagnostics statements.
  // Empty observation intentionally avoids opening a nested transaction on this
  // rolled-back fixture client; allocation itself was executed above.
  await reconcileRelayDestinationReceipts(
    client as unknown as Pool,
    {
      operationId,
      segmentId,
      transactionHashes: [event.transactionHash],
      now,
      referenceCodec,
      requestId: route.requestId,
      status: route.relayStatus,
    },
    async (input) => {
      assert.equal(input.native?.dex, "spot");
      assert.deepEqual(input.native?.knownTransactionHashes, [
        event.transactionHash,
      ]);
      return {
        events: [],
        pendingReason: "native_ledger_missing",
        ledgerAfterSecond: 1791381318,
      };
    },
  );
  const diagnostics = (
    await client.query(
      "select support_metadata from funding_operation_segments where operation_id=$1 and id=$2",
      [operationId, segmentId],
    )
  ).rows[0].support_metadata.nativeDestinationReceipts[
    referenceCodec.fingerprint(route.requestId)
  ];
  assert.equal(diagnostics.reason, "native_ledger_missing");
  assert.equal(diagnostics.checkedAt, now.toISOString());
  assert.equal(diagnostics.ledgerAfterSecond, 1791381318);
  await reconcileRelayDestinationReceipts(
    client as unknown as Pool,
    {
      operationId,
      segmentId,
      transactionHashes: [event.transactionHash],
      now,
      referenceCodec,
      requestId: route.requestId,
      status: route.relayStatus,
    },
    async (input) => {
      assert.equal(input.native?.ledgerAfterSecond, 1791381318);
      return { events: [], pendingReason: null };
    },
  );
  await Promise.all(
    ["sibling-request-one", "sibling-request-two"].map((requestId, index) =>
      reconcileRelayDestinationReceipts(
        client as unknown as Pool,
        {
          operationId,
          segmentId,
          transactionHashes: [event.transactionHash],
          now,
          referenceCodec,
          requestId,
          status: { ...route.relayStatus, requestId },
        },
        async (input) => {
          assert.equal(
            input.native?.ledgerAfterSecond,
            undefined,
            "another request cannot inherit parent's cursor",
          );
          return {
            events: [],
            pendingReason: "native_ledger_missing",
            ledgerAfterSecond: 1791381418 + index,
          };
        },
      ),
    ),
  );
  const persistedCursors = (
    await client.query(
      "select support_metadata from funding_operation_segments where id=$1",
      [segmentId],
    )
  ).rows[0].support_metadata.nativeDestinationReceipts;
  assert.equal(
    persistedCursors[referenceCodec.fingerprint(route.requestId)]
      .ledgerAfterSecond,
    1791381318,
    "no admitted read does not erase durable progress",
  );
  assert.equal(
    persistedCursors[referenceCodec.fingerprint("sibling-request-one")]
      .ledgerAfterSecond,
    1791381418,
  );
  assert.equal(
    persistedCursors[referenceCodec.fingerprint("sibling-request-two")]
      .ledgerAfterSecond,
    1791381419,
  );
  const nativeFixture = hypercorePlanTestFixture(now, userId);
  assert.equal(nativeFixture.input.destination.target.kind, "owned_location");
  assert.equal(nativeFixture.input.source.source.kind, "owned_location");
  if (
    nativeFixture.input.destination.target.kind !== "owned_location" ||
    nativeFixture.input.source.source.kind !== "owned_location"
  )
    throw new Error("Missing owned fixture targets");
  const dualRefundSnapshot = relayRefundLocationSnapshot({
    sourceLocation: nativeFixture.input.destination.target.location,
    sourceAmount: nativeFixture.input.quote.candidate.expectedOutput,
    destination: { target: nativeFixture.input.source.source },
    minimumOutput: nativeFixture.input.quote.sourceAmount,
    nativeRefundLocation: nativeFixture.input.quote.nativeRefundLocation,
    routeShape: "relay-depository-v2-hypercore",
  });
  const dualRefundOperation = await commit(userId, {
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
      refundLocationSnapshot: dualRefundSnapshot,
    })),
  });
  assert.deepEqual(
    (
      await client.query(
        "select refund_location_snapshot from funding_operation_segments where operation_id=$1",
        [dualRefundOperation.operation.id],
      )
    ).rows[0].refund_location_snapshot,
    dualRefundSnapshot,
  );
  await client.query("savepoint native_refund_immutability");
  await assert.rejects(
    client.query(
      `update funding_operation_segments
    set refund_location_snapshot=jsonb_set(refund_location_snapshot,
      '{alternativeRefundLocations,locations,0,details,address}',to_jsonb($2::text))
    where operation_id=$1`,
      [dualRefundOperation.operation.id, `0x${"f".repeat(40)}`],
    ),
    /immutable/,
  );
  await client.query("rollback to savepoint native_refund_immutability");
  await client.query("release savepoint native_refund_immutability");
  // Actual normalized quote -> common plan -> receipt -> exactly one durable
  // EVM source debit. Native destination/refund may arrive before that receipt.
  const inboundCapture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/hip4/relay-native-routes-20261014.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const [index, replacementKind] of (
    ["destination_credit", "refund_credit"] as const
  ).entries()) {
    const wire = structuredClone(inboundCapture.routes[index].response.body);
    const spec =
      RELAY_ROUTE_SPECS[
        index === 0
          ? "base-usdc-to-hypercore-spot-usdc"
          : "polygon-usdc-to-hypercore-spot-usdc"
      ];
    const deadline = Math.floor(now.getTime() / 1000) + 86400;
    wire.protocol.v2.orderData.output.deadline = deadline;
    for (const refund of wire.protocol.v2.orderData.inputs[0].refunds)
      refund.deadline = deadline;
    wire.protocol.v2.orderId = relayHexOrderId(wire.protocol.v2.orderData);
    wire.steps[1].items[0].data.data = new Interface([
      "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
    ]).encodeFunctionData("depositErc20", [
      wire.details.sender,
      wire.details.currencyIn.currency.address,
      wire.details.currencyIn.amount,
      wire.protocol.v2.orderId,
    ]);
    const evmSource = {
      kind: "owned_location" as const,
      location: {
        ...nativeFixture.input.destination.target.location,
        asset: spec.source,
        details: {
          address: wire.details.sender,
          walletId: "inbound-controller",
        },
      },
    };
    const nativeDestination: ResolvedRouteDestination = {
      ...nativeFixture.input.destination,
      requiredAsset: spec.destination,
      target: nativeFixture.input.source.source,
      destinationLocationPatternId: "hypercore-spot-usdc",
      venueId: "hyperliquid",
    };
    assert.equal(nativeDestination.target.kind, "owned_location");
    if (nativeDestination.target.kind !== "owned_location")
      throw new Error("Missing owned destination");
    assert.equal(
      String(nativeDestination.target.location.details.address).toLowerCase(),
      wire.details.recipient.toLowerCase(),
    );
    const normalized = normalizeRelayHypercoreInboundWalletQuote({
      validation: {
        quote: wire,
        contracts: resolveRelayHypercoreContracts(
          { chains: inboundCapture.chains },
          index === 0 ? 8453 : 137,
        ),
        contractsObservedAt: now,
        maximumContractAgeMs: 60000,
        owner: wire.details.sender,
        recipient: wire.details.recipient,
        amountMode: "exact_input",
        authorizedSourceRaw: "10000000",
        minimumOutputRaw: "850000000",
        expectedOutputTargetRaw: "850000000",
        maximumFeeRaw: "1500000",
        now,
        deadline: new Date(now.getTime() + 60000),
        maximumQuoteTtlMs: 60000,
      },
      source: evmSource,
      destination: nativeDestination,
      nativeRefundLocation: nativeFixture.quoteInput.nativeRefundLocation,
      actorWalletId: "inbound-controller",
    });
    const inboundPlan = await buildRelayPlanningQuote({
      ...nativeFixture.input,
      quote: normalized,
      destination: nativeDestination,
      source: {
        ...nativeFixture.input.source,
        componentId: randomUUID(),
        source: evmSource,
        quoteInputAmount: normalized.sourceAmount,
        maximumSourceRaw: normalized.sourceAmount.raw,
      },
      profile: {
        ...nativeFixture.input.profile,
        walletId: "inbound-controller",
        controllerWalletRef: "inbound-controller",
        networkId: spec.source.networkId,
        source: "external",
        signingModes: ["web_client"],
        serverWalletRef: null,
      },
      route: relayRuntimeRoute(spec, {
        sourceLocationPatternId: "evm-source",
        destinationLocationPatternId: "hypercore-spot-usdc",
      }),
    });
    const approve = async (operationId: string) => {
      const step = (
        await client.query(
          "select id from funding_operation_steps where operation_id=$1 and action_validation_result->>'relayStepKind'='approve'",
          [operationId],
        )
      ).rows[0];
      assert.ok(step);
      const approvalAttempt = await startFundingStepAttemptInTransaction(
        client,
        {
          operationId,
          stepId: step.id,
          canonicalActionFingerprint:
            inboundPlan.commitPlan.steps[0].actionFingerprint,
          executorId: "wallet_profile_evm_v1",
          now,
        },
      );
      const approvalHash = `0x${canonicalJsonHash({ operationId, approval: true })}`;
      await finishFundingStepAttemptInTransaction(client, {
        attemptId: approvalAttempt.id,
        outcome: "submitted",
        broadcastMayHaveOccurred: true,
        referenceKind: "transaction",
        receiptRefCiphertext: "cipher:offline-approval",
        receiptRefLookupHmac: canonicalJsonHash(approvalHash),
        lookupKeyVersion: 1,
        actualCosts: {},
        now,
      });
      await applyFundingStepReceiptEvidenceInTransaction(client, {
        operationId,
        stepId: step.id,
        attemptId: approvalAttempt.id,
        networkId: spec.source.networkId,
        receipt: {
          status: "finalized",
          actionMatch: true,
          ledgerHeight: "259",
          blockHash: `0x${"b".repeat(64)}`,
          canonical: true,
          failureCode: null,
          evidence: { transactionHash: approvalHash },
        },
        now,
      });
      const facts = await loadFundingLifecycleFactsForOperationInTransaction(
        client,
        { operationId, now },
      );
      assert.ok(facts);
      assert.deepEqual(
        facts.actions.map((a) => a.mayMoveMoney),
        [false, true],
      );
      const lifecycle = deriveFundingLifecycle(facts);
      assert.equal(lifecycle.safety.moneyMayHaveMoved, false);
      assert.equal(lifecycle.safety.cancelAllowed, true);
      assert.equal(
        (
          await client.query(
            "select count(*)::text as count from funding_observations where operation_id=$1 and kind='source_debit'",
            [operationId],
          )
        ).rows[0].count,
        "0",
      );
    };
    const cancelledInbound = await commit(userId, inboundPlan.commitPlan);
    await approve(cancelledInbound.operation.id);
    const cancellation =
      await recordSafeFundingActionCancellationsInTransaction(client, {
        operationId: cancelledInbound.operation.id,
        now,
      });
    assert.equal(cancellation.unsafeStepIds.length, 0);
    await recordFundingOperationCancellationDecisionInTransaction(client, {
      operationId: cancelledInbound.operation.id,
      now,
    });
    await reduceFundingOperationInTransaction(client, {
      operationId: cancelledInbound.operation.id,
      now,
    });
    assert.deepEqual(
      (
        await client.query(
          `select operation_row.status, reservation.state from funding_operations operation_row
       join balance_reservations reservation on reservation.operation_id=operation_row.id
       where operation_row.id=$1`,
          [cancelledInbound.operation.id],
        )
      ).rows,
      [{ status: "cancelled", state: "released" }],
      "unstarted native inbound cancellation releases its source immediately",
    );
    const inbound = await commit(userId, inboundPlan.commitPlan);
    await approve(inbound.operation.id);
    const inboundIds = (
      await client.query(
        "select id,segment_id from funding_operation_steps where operation_id=$1 and action_validation_result->>'relayStepKind'='deposit'",
        [inbound.operation.id],
      )
    ).rows[0];
    const pendingDebit = async () =>
      (
        await client.query(
          `select ${nativeSourceDebitPendingSql("reservation")} as pending from balance_reservations reservation where operation_id=$1`,
          [inbound.operation.id],
        )
      ).rows[0].pending;
    assert.equal(
      await pendingDebit(),
      false,
      "unstarted deposit has no irreversible hold",
    );
    const initialFacts =
      await loadFundingLifecycleFactsForOperationInTransaction(client, {
        operationId: inbound.operation.id,
        now,
      });
    assert.ok(initialFacts?.actions[1].requiresSourceDebitEvidence);
    const attempt = await startFundingStepAttemptInTransaction(client, {
      operationId: inbound.operation.id,
      stepId: inboundIds.id,
      canonicalActionFingerprint:
        inboundPlan.commitPlan.steps[1].actionFingerprint,
      executorId: "wallet_profile_evm_v1",
      now,
    });
    const txHash = `0x${String(index + 4).repeat(64)}`;
    await finishFundingStepAttemptInTransaction(client, {
      attemptId: attempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "cipher:offline-inbound",
      receiptRefLookupHmac: canonicalJsonHash(txHash),
      lookupKeyVersion: 1,
      actualCosts: {},
      now,
    });
    await client.query(
      "update funding_operation_steps set state='submitted' where id=$1",
      [inboundIds.id],
    );
    await allocateFundingObservationInTransaction(client, {
      operationId: inbound.operation.id,
      segmentId: inboundIds.segment_id,
      kind: replacementKind,
      networkId: spec.destination.networkId,
      assetId: spec.destination.assetId,
      assetDecimals: 8,
      txHash: `0x${String(index + 6).repeat(64)}`,
      eventIndex: "0",
      fromAddress: `0x${"f".repeat(40)}`,
      toAddress: wire.details.recipient,
      rawAmount: normalized.candidate.minimumOutput.raw,
      observedAt: now,
      ledgerHeight: null,
      blockHash: null,
      finalityStatus: "finalized",
      finalizedAt: now,
      metadata: {},
    });
    await reduceFundingOperationInTransaction(client, {
      operationId: inbound.operation.id,
      now,
    });
    assert.equal(
      await pendingDebit(),
      true,
      `${replacementKind} cannot prove a source debit`,
    );
    assert.equal(
      (
        await client.query(
          "select state from balance_reservations where operation_id=$1",
          [inbound.operation.id],
        )
      ).rows[0].state,
      "active",
    );
    const applyReceipt = () =>
      applyFundingStepReceiptEvidenceInTransaction(client, {
        operationId: inbound.operation.id,
        stepId: inboundIds.id,
        attemptId: attempt.id,
        networkId: spec.source.networkId,
        receipt: {
          status: "finalized",
          actionMatch: true,
          ledgerHeight: "260",
          blockHash: `0x${"e".repeat(64)}`,
          canonical: true,
          failureCode: null,
          evidence: {
            attributedSourceRaw: "10000000",
            sourceDebitEventIndex: "7",
            transactionHash: txHash,
          },
        },
        now,
      });
    await applyReceipt();
    await applyReceipt();
    assert.equal(await pendingDebit(), false);
    assert.deepEqual(
      (
        await client.query(
          "select count(*)::text as count,min(raw_amount)::text as raw from funding_observations where operation_id=$1 and kind='source_debit'",
          [inbound.operation.id],
        )
      ).rows,
      [{ count: "1", raw: "10000000" }],
    );
    assert.equal(
      (
        await client.query(
          "select state from balance_reservations where operation_id=$1",
          [inbound.operation.id],
        )
      ).rows[0].state,
      "released",
    );
  }
  const nativePlan = await buildRelayPlanningQuote(nativeFixture.input);
  const nativeCommitted = await commit(userId, nativePlan.commitPlan);
  const nativeFacts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    { operationId: nativeCommitted.operation.id, now },
  );
  assert.ok(nativeFacts);
  assert.deepEqual(
    nativeFacts.actions.map((action) => action.mayMoveMoney),
    [false, true],
  );
  assert.equal(
    deriveFundingLifecycle(nativeFacts).safety.moneyMayHaveMoved,
    false,
  );
  const nativeRows = await client.query(
    "select step_kind, payer_requirement, depends_on_step_id, action_expires_at from funding_operation_steps where operation_id=$1 order by ordinal",
    [nativeCommitted.operation.id],
  );
  assert.deepEqual(
    nativeRows.rows.map((row) => [
      row.step_kind,
      row.payer_requirement,
      Boolean(row.depends_on_step_id),
    ]),
    [
      ["signature", "none", false],
      ["external_handoff", "none", true],
    ],
  );
  assert.equal(
    nativeRows.rows[0].action_expires_at.toISOString(),
    nativeFixture.input.quote.candidate.expiresAt,
  );
  const nativeReservations = await client.query(
    "select raw_amount::text, mode from balance_reservations where operation_id=$1",
    [nativeCommitted.operation.id],
  );
  assert.deepEqual(nativeReservations.rows, [
    { raw_amount: "1000000000", mode: "subtract_available" },
  ]);
  const nativeSegments = await client.query(
    "select refund_location_snapshot, provider_quote_ref_ciphertext from funding_operation_segments where operation_id=$1",
    [nativeCommitted.operation.id],
  );
  assert.equal(
    nativeSegments.rows[0].refund_location_snapshot.details.balanceClass,
    "perp",
  );
  assert.equal(
    nativeFixture.input.codec.decrypt(
      nativeSegments.rows[0].provider_quote_ref_ciphertext,
    ),
    nativeFixture.input.quote.requestId,
  );
  const nativeSend = nativeFacts.actions[1];
  assert.ok(nativeSend);
  const sendStepId = nativeSend.actionId;
  await claimHyperliquidFundingNonceInTransaction(client, sendStepId);
  const claims = await client.query(
    "select environment, signer_address, nonce::text from hyperliquid_nonce_claims where funding_step_id=$1",
    [sendStepId],
  );
  assert.deepEqual(claims.rows, [
    {
      environment: "mainnet",
      signer_address: nativeFixture.input.profile.address.toLowerCase(),
      nonce: String(now.getTime()),
    },
  ]);
  await client.query("savepoint competing_nonce");
  const competingFixture = hypercorePlanTestFixture(now, userId);
  const competingPlan = await buildRelayPlanningQuote(competingFixture.input);
  await assert.rejects(
    commit(userId, competingPlan.commitPlan),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "quote_invalidated",
  );
  await client.query("rollback to savepoint competing_nonce");

  // Regression: a harmless failed/cancelled sibling must not override the
  // unresolved SendAsset's reservation, even before any canonical debit exists.
  await client.query(
    `insert into funding_operation_step_attempts
       (step_id, attempt_number, canonical_action_fingerprint, executor_id,
        outcome, broadcast_may_have_occurred, actual_costs, started_at, finished_at)
     select id, 1, action_fingerprint, executor_id,
            case when ordinal=0 then 'cancelled' else 'ambiguous' end,
            ordinal=1, '{}', $2, $2
       from funding_operation_steps where operation_id=$1`,
    [nativeCommitted.operation.id, now],
  );
  await reduceFundingOperationInTransaction(client, {
    operationId: nativeCommitted.operation.id,
    now,
  });
  assert.deepEqual(
    (
      await client.query(
        "select state from balance_reservations where operation_id=$1",
        [nativeCommitted.operation.id],
      )
    ).rows,
    [{ state: "active" }],
    "cancelled authorization cannot release ambiguous native send",
  );
  // Shadow only operations in this rollback-only session. Same indexes as the
  // real table; unrelated users and sparse targets must not become a full scan.
  await client.query(`create temporary table funding_operations
    (like public.funding_operations including all) on commit drop`);
  await client.query(
    "insert into funding_operations select * from public.funding_operations where id=$1",
    [operationId],
  );
  await client.query(
    `insert into funding_operations
    select copied_operation.* from public.funding_operations operation_row
      cross join generate_series(1,50000) fixture_count
      cross join lateral jsonb_populate_record(null::funding_operations,
      to_jsonb(operation_row) || jsonb_build_object(
        'id',gen_random_uuid(), 'quote_id',gen_random_uuid(),
        'user_id',gen_random_uuid(), 'idempotency_key',fixture_count::text
      )) copied_operation
      where operation_row.id=$1`,
    [operationId],
  );
  await client.query(
    `insert into funding_operations
    select copied_operation.* from public.funding_operations operation_row
      cross join generate_series(1,100) fixture_count
      cross join lateral jsonb_populate_record(null::funding_operations,
      to_jsonb(operation_row) || jsonb_build_object(
        'id',gen_random_uuid(), 'quote_id',gen_random_uuid(),
        'idempotency_key',fixture_count::text,
        'destination_target_snapshot',jsonb_set(operation_row.destination_target_snapshot,
          '{location,asset,networkId}','"evm:8453"'::jsonb)
      )) copied_operation
      where operation_row.id=$1`,
    [operationId],
  );
  await client.query("analyze funding_operations");
  await client.query(
    `prepare native_destination_plan(uuid,jsonb) as ${runtimeSql}`,
  );
  const planMetrics: unknown[] = [];
  const literal = (value: unknown) =>
    `'${String(value).replaceAll("'", "''")}'`;
  for (const [fixtureUser, eventInput, expectedRows] of [
    [userId, runtimeValues[1], 1],
    [randomUUID(), runtimeValues[1], 0],
    [userId, "[]", 0],
  ] as const) {
    const explanation = (
      await client.query(`explain(analyze,buffers,format json)
      execute native_destination_plan(${literal(fixtureUser)},${literal(eventInput)})`)
    ).rows[0]["QUERY PLAN"][0];
    assert.equal(explanation.Plan["Actual Rows"], expectedRows);
    const operationNodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "funding_operations")
        operationNodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visit(child);
    };
    visit(explanation.Plan);
    assert.ok(operationNodes.length > 0);
    assert.ok(operationNodes.every((node) => node["Node Type"] !== "Seq Scan"));
    planMetrics.push({
      rows: expectedRows,
      executionMs: explanation["Execution Time"],
      localBlocks:
        explanation.Plan["Local Hit Blocks"] +
        explanation.Plan["Local Read Blocks"],
      operationNodes: operationNodes.map((node) => ({
        type: node["Node Type"],
        rows: node["Actual Rows"],
        removed: node["Rows Removed by Filter"] ?? 0,
      })),
    });
  }
  await client.query("deallocate native_destination_plan");
  console.log(
    JSON.stringify({
      suite: "hip4-funding-receipt-pg16",
      identityCases: cases.length,
      allocations: observations.rowCount,
      explainPlans: plans.length,
      nativeCommitSteps: nativeRows.rowCount,
      dexCases: dexCases.length,
      unrelatedOperations: 50000,
      planMetrics,
    }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
