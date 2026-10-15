// @requires-db — explicit disposable PG16 only. Scenario writes roll back;
// the final two-session race retains one uniquely named fixture in this DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { buildRelayPlanningQuote } from "../../../funding-providers/relay/operation-plan.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  allocateFundingObservationInTransaction,
} from "../../persistence/funding-operation-repository.js";
import {
  applyFundingStepReceiptEvidenceInTransaction,
  listFundingStepReceiptTargets,
} from "../../persistence/funding-step-receipt-repository.js";
import { inspectNativeFundingSend } from "../../execution/hypercore-send-receipt.js";
import type { Pool } from "@hunch/infra";
import {
  startFundingStepAttemptForUserInTransaction,
  finishFundingStepAttemptForUserInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  admitNativeFundingAuthInTransaction,
  admitNativeFundingSendInTransaction,
  finishNativeFundingAuthInTransaction,
  nativeFundingPreparationInTransaction,
  closeNativeFundingUnsubmittedInTransaction,
} from "../../execution/hypercore-auth-attempt.js";
import { nativeSendCapacityCheck } from "../../execution/hypercore-send-capacity.js";
import { submitNativeFundingSend } from "../../execution/hypercore-send-submission.js";
import { boundNativeSourceProof } from "../../execution/hypercore-send-receipt.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import { nativeFundingActionReference } from "../../execution/hypercore-signed-request.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";
import { DEFAULT_FUNDING_INTENT_POLICY } from "../../policies/funding-policy-v2.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../../lifecycle/funding-lifecycle-projector.js";
import { reduceFundingOperationInTransaction } from "../../reconciliation/funding-reducer.js";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { hip4OrderTestFixture } from "../../../hip4-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction } from "../../../repos/hip4-order-preparation.js";
import { admitHip4OrderActionInTransaction } from "../../../repos/hip4-order-admission.js";
import { prepareHip4TradeSigning } from "../../../services/hip4-trade-signing.js";
import { recordHip4SubmissionReplyInTransaction } from "../../../services/hip4-order-submission.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const wallet = Wallet.createRandom(); // Ephemeral OFFLINE test signer; HTTP is mocked.
const codec = createFundingTransactionReferenceCodec({
  encryptionKey: Buffer.alloc(32, 7),
  lookupHmacKey: "offline-native-send-test-key-at-least-32-chars",
  keyVersion: 1,
});
const policy = {
  policy: DEFAULT_FUNDING_INTENT_POLICY,
  runtime: {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    creationMode: "on" as const,
    gates: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.gates,
      startUnsubmittedAction: true,
      emergencyBroadcastPause: false,
    },
  },
  revision: "test-native-policy",
  invalidStoredPolicy: false,
};
let fixtureCommitted = false;
try {
  await client.query("begin");
  assert.equal(
    (
      await client.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  const userId = (
    await client.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`native-send-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  const fixture = hypercorePlanTestFixture(new Date(), userId, wallet.address);
  const profile = fixture.input.profile;
  await client.query(
    `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,is_internal_wallet,wallet_source,privy_wallet_id,privy_profile_updated_at) values($1,$2,$3,'ethereum',true,true,'embedded',$4,clock_timestamp())`,
    [profile.walletId, userId, profile.address, profile.serverWalletRef],
  );
  const plan = (await buildRelayPlanningQuote(fixture.input)).commitPlan;
  assert.ok(plan.operation.sourceSnapshot);
  const consentToken = randomUUID();
  const quote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: randomUUID(),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: policy.revision,
    canonicalRequest: { test: true },
    consentToken,
    expiresAt: new Date(fixture.input.quote.candidate.expiresAt),
  });
  const committed = await commitFundingOperationInTransaction(client, {
    userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: randomUUID(),
    plan,
    subjectLookupHmac: "b".repeat(64),
    subjectLookupKeyVersion: 1,
  });
  const operationId = committed.operation.id;
  const rows = (
    await client.query(
      "select id,action_fingerprint,executor_id from funding_operation_steps where operation_id=$1 order by ordinal",
      [operationId],
    )
  ).rows;
  const [auth, send] = rows;
  assert.ok(auth && send);
  const { pair } = await nativeFundingPreparationInTransaction(
    client,
    operationId,
    send.id,
  );
  const typed = pair.validated.authorization.typedData;
  const authAttempt = await startFundingStepAttemptForUserInTransaction(
    client,
    {
      userId,
      operationId,
      stepId: auth.id,
      canonicalActionFingerprint: auth.action_fingerprint,
      executorId: auth.executor_id,
      nativeSubmissionProtocol: true,
    },
  );
  const authInput = {
    userId,
    operationId,
    stepId: auth.id,
    attemptId: authAttempt.attempt.id,
    signature: await wallet.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    ),
  };
  const admitted = await admitNativeFundingAuthInTransaction(
    client,
    authInput,
    policy,
  );
  assert.equal(admitted.admitted, true);
  assert.ok(admitted.requestFingerprint);
  await finishNativeFundingAuthInTransaction(client, {
    ...authInput,
    requestFingerprint: admitted.requestFingerprint,
    authorized: true,
  });
  const sendTyped = pair.validated.transfer.typedData;
  const signature = await wallet.signTypedData(
    sendTyped.domain,
    sendTyped.types,
    sendTyped.message,
  );
  const start = async () => {
    const { attempt } = await startFundingStepAttemptForUserInTransaction(
      client,
      {
        userId,
        operationId,
        stepId: send.id,
        canonicalActionFingerprint: send.action_fingerprint,
        executorId: send.executor_id,
        nativeSubmissionProtocol: true,
      },
    );
    return {
      userId,
      operationId,
      stepId: send.id,
      attemptId: attempt.id,
      signature,
    };
  };
  const check = (
    availableRaw = "1000000000",
    observedAt = new Date().toISOString(),
  ) =>
    nativeSendCapacityCheck(async () => ({
      availableRaw,
      observedAt,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }));
  const state = async (attemptId: string) =>
    (
      await client.query(
        "select * from funding_operation_step_attempts where id=$1",
        [attemptId],
      )
    ).rows[0];
  const reservationState = async () =>
    (
      await client.query(
        "select state from balance_reservations where operation_id=$1",
        [operationId],
      )
    ).rows[0].state;
  async function scenario(name: string, run: () => Promise<void>) {
    await client.query("savepoint send_scenario");
    await run();
    await client.query("rollback to savepoint send_scenario");
    console.log(`PASS ${name}`);
  }

  await scenario(
    "HIP BUY and native send share physical cash holds; definitive rejection restores send capacity",
    async () => {
      const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
      lifecycle.venues.hyperliquid = {
        lifecycle: "active",
        indexerMode: "off",
      };
      await client.query(
        "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',clock_timestamp(),$1)",
        [lifecycle],
      );
      const orderFixture = await hip4OrderTestFixture(client, wallet.address, {
        userId,
        profile,
      });
      orderFixture.nonce -= 5000;
      const order = await persistHip4OrderPreparationInTransaction(
        client,
        orderFixture,
      );
      const signing = prepareHip4TradeSigning(order.envelope).typedData;
      const orderSignature = await wallet.signTypedData(
        signing.domain,
        signing.types,
        signing.message,
      );
      const allowImplementation: typeof venueHasLifecycleCapability = (
        current,
        _venue,
        capability,
      ) =>
        venueHasLifecycleCapability(
          {
            ...current,
            venues: {
              ...current.venues,
              polymarket: current.venues.hyperliquid,
            },
          },
          "polymarket",
          capability,
        );
      const orderInput = {
        userId,
        actionId: order.actionId,
        actor: "web_app",
        signature: orderSignature,
        context: {
          profile,
          policy: orderFixture.policy,
          feeCapRaw: orderFixture.feeCapRaw,
          capacity: {
            assetId: HYPERCORE_MAINNET_USDC.assetId,
            decimals: 8,
            availableRaw: "1000000000",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      };
      await client.query("savepoint cash_rejection");
      await assert.rejects(
        () =>
          admitHip4OrderActionInTransaction(
            client,
            orderInput,
            allowImplementation,
          ),
        /capacity_reserved/u,
      );
      await client.query("rollback to savepoint cash_rejection");
      await admitHip4OrderActionInTransaction(
        client,
        {
          ...orderInput,
          context: {
            ...orderInput.context,
            capacity: {
              ...orderInput.context.capacity,
              availableRaw: "1140000000",
            },
          },
        },
        allowImplementation,
      );
      const sendInput = await start();
      await client.query("savepoint send_cash_rejection");
      await assert.rejects(
        () =>
          admitNativeFundingSendInTransaction(
            client,
            sendInput,
            policy,
            check("1000000000"),
            codec,
          ),
        /no longer covers/u,
      );
      await client.query("rollback to savepoint send_cash_rejection");
      for (const terminal of [false, true]) {
        await client.query("savepoint terminal_order_send_capacity");
        const barrierAt = Date.now() - 2;
        await client.query(
          "update hip4_order_submissions set order_observation=$2::jsonb where action_id=$1",
          [
            order.actionId,
            {
              status: terminal ? "canceled" : "open",
              terminal,
              balanceBarrier: {
                state: terminal ? "terminal_observed" : "accepted_observed",
                responseAt: barrierAt,
              },
            },
          ],
        );
        await client.query("savepoint old_native_capacity");
        await assert.rejects(
          () =>
            admitNativeFundingSendInTransaction(
              client,
              sendInput,
              policy,
              check("1000000000", new Date(barrierAt).toISOString()),
              codec,
            ),
          /no longer covers/u,
        );
        await client.query("rollback to savepoint old_native_capacity");
        if (!terminal) {
          await client.query("savepoint open_fee_capacity");
          await assert.rejects(
            () =>
              admitNativeFundingSendInTransaction(
                client,
                sendInput,
                policy,
                check("1000000000", new Date(barrierAt + 1).toISOString()),
                codec,
              ),
            /no longer covers/u,
          );
          await client.query("rollback to savepoint open_fee_capacity");
        }
        assert.equal(
          (
            await admitNativeFundingSendInTransaction(
              client,
              sendInput,
              policy,
              check(
                terminal ? "1000000000" : "1001000000",
                new Date(barrierAt + 1).toISOString(),
              ),
              codec,
            )
          ).admitted,
          true,
          "native funding send shares open/terminal inclusion and retains the frozen BUY fee reserve",
        );
        await client.query(
          "rollback to savepoint terminal_order_send_capacity",
        );
      }
      await recordHip4SubmissionReplyInTransaction(client, {
        userId,
        actionId: order.actionId,
        body: {
          status: "ok",
          response: {
            type: "order",
            data: {
              statuses: [
                { error: "Order has insufficient spot balance to trade" },
              ],
            },
          },
        },
      });
      assert.equal(
        (
          await admitNativeFundingSendInTransaction(
            client,
            sendInput,
            policy,
            check("1000000000"),
            codec,
          )
        ).admitted,
        true,
      );
    },
  );

  await scenario(
    "journal recovery fences an unadmitted send; a delayed signed POST cannot acquire authority",
    async () => {
      const input = await start();
      const recovered = await finishFundingStepAttemptForUserInTransaction(
        client,
        {
          ...input,
          outcome: "ambiguous",
          broadcastMayHaveOccurred: true,
          referenceKind: null,
          receiptRefCiphertext: null,
          receiptRefLookupHmac: null,
          lookupKeyVersion: null,
          actualCosts: {
            networkFeeRaw: null,
            reasonCode: "client_execution_failed",
          },
        },
      );
      assert.equal(recovered.stepState, "cancelled");
      assert.equal(recovered.attempt.broadcastMayHaveOccurred, false);
      assert.equal(
        (
          await admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            async () => {
              throw new Error("closed attempt must not recheck capacity");
            },
            codec,
          )
        ).admitted,
        false,
      );
      await reduceFundingOperationInTransaction(client, { operationId });
      assert.equal(await reservationState(), "released");
    },
  );

  await scenario(
    "exact own hold; durable ambiguity/ref before POST; duplicate no POST authority",
    async () => {
      const input = await start();
      const result = await admitNativeFundingSendInTransaction(
        client,
        input,
        policy,
        check(),
        codec,
      );
      assert.equal(result.admitted, true);
      const row = await state(input.attemptId);
      assert.equal(row.outcome, "ambiguous");
      assert.equal(row.broadcast_may_have_occurred, true);
      assert.equal(
        codec.decrypt(row.receipt_ref_ciphertext),
        nativeFundingActionReference(pair.validated),
      );
      assert.equal(row.reference_kind, "external_handoff");
      const repeat = await admitNativeFundingSendInTransaction(
        client,
        input,
        policy,
        async () => {
          throw new Error("duplicate reread");
        },
        codec,
      );
      assert.equal(repeat.admitted, false);
      const cancelled = await finishFundingStepAttemptForUserInTransaction(
        client,
        {
          ...input,
          outcome: "cancelled",
          broadcastMayHaveOccurred: false,
          referenceKind: null,
          receiptRefCiphertext: null,
          receiptRefLookupHmac: null,
          lookupKeyVersion: null,
          actualCosts: {},
        },
      );
      assert.equal(cancelled.attempt.outcome, "ambiguous");
      const afterExpiry = new Date(
        Date.parse(fixture.input.quote.candidate.expiresAt) + 1,
      );
      assert.deepEqual(
        await closeNativeFundingUnsubmittedInTransaction(
          client,
          operationId,
          afterExpiry,
          "expired",
        ),
        [],
      );
      const facts = await loadFundingLifecycleFactsForOperationInTransaction(
        client,
        { operationId, now: afterExpiry },
      );
      assert.ok(facts);
      const projection = deriveFundingLifecycle(facts);
      assert.equal(projection.safety.reservationsMayRelease, false);
      assert.equal(projection.recoveryMode, "automatic_evidence");
      await reduceFundingOperationInTransaction(client, {
        operationId,
        now: afterExpiry,
      });
      assert.equal(await reservationState(), "active");
    },
  );
  await scenario(
    "insufficient fresh capacity never admits and recovers on retry",
    async () => {
      const input = await start();
      await assert.rejects(
        () =>
          admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            check("999999999"),
            codec,
          ),
        /balance no longer covers/,
      );
      assert.equal((await state(input.attemptId)).outcome, "started");
      assert.equal(
        (
          await admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            check(),
            codec,
          )
        ).admitted,
        true,
      );
    },
  );
  await scenario(
    "same physical source alias reservation cannot be spent",
    async () => {
      const input = await start();
      await client.query(
        `insert into balance_reservations(user_id,operation_id,segment_id,component_id,location_id,network_id,asset_id,asset_decimals,raw_amount,mode,state,expires_at)
      select user_id,operation_id,null,component_id||'-alias',location_id,network_id,asset_id,asset_decimals,'1',mode,state,expires_at from balance_reservations where operation_id=$1`,
        [operationId],
      );
      await assert.rejects(
        () =>
          admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            check(),
            codec,
          ),
        /balance no longer covers/,
      );
      assert.equal(
        (
          await admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            check("1000000001"),
            codec,
          )
        ).admitted,
        true,
      );
    },
  );
  await scenario(
    "prepared send cancellation releases immediately, not after lease",
    async () => {
      const input = await start();
      await recordSafeFundingActionCancellationsInTransaction(client, {
        operationId,
        now: new Date(),
      });
      assert.equal((await state(input.attemptId)).outcome, "cancelled");
      await reduceFundingOperationInTransaction(client, {
        operationId,
        now: new Date(),
      });
      assert.equal(await reservationState(), "released");
      assert.equal(
        (
          await admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            async () => {
              throw new Error("cancelled capacity read");
            },
            codec,
          )
        ).admitted,
        false,
      );
    },
  );
  await scenario(
    "prepared send expiry releases without making a provider request",
    async () => {
      const input = await start();
      const afterExpiry = new Date(
        Date.parse(fixture.input.quote.candidate.expiresAt) + 1,
      );
      assert.deepEqual(
        await closeNativeFundingUnsubmittedInTransaction(
          client,
          operationId,
          afterExpiry,
          "expired",
        ),
        [input.attemptId],
      );
      await reduceFundingOperationInTransaction(client, {
        operationId,
        now: afterExpiry,
      });
      assert.equal(await reservationState(), "released");
    },
  );
  await scenario("policy pause and wrong signature do not admit", async () => {
    const input = await start();
    await assert.rejects(
      () =>
        admitNativeFundingSendInTransaction(
          client,
          input,
          {
            ...policy,
            runtime: {
              ...policy.runtime,
              gates: { ...policy.runtime.gates, emergencyBroadcastPause: true },
            },
          },
          check(),
          codec,
        ),
      /policy changed/,
    );
    await assert.rejects(() =>
      admitNativeFundingSendInTransaction(
        client,
        { ...input, signature: authInput.signature },
        policy,
        check(),
        codec,
      ),
    );
    assert.equal((await state(input.attemptId)).outcome, "started");
  });
  await scenario(
    "stale capacity and revoked controller do not admit",
    async () => {
      const input = await start();
      await assert.rejects(
        () =>
          admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            nativeSendCapacityCheck(async () => ({
              availableRaw: "1000000000",
              observedAt: new Date(Date.now() - 10000).toISOString(),
              expiresAt: new Date(Date.now() - 1).toISOString(),
            })),
            codec,
          ),
        /not fresh/,
      );
      await client.query(
        "update user_wallets set is_verified=false where id=$1",
        [profile.walletId],
      );
      await assert.rejects(
        () =>
          admitNativeFundingSendInTransaction(
            client,
            input,
            policy,
            check(),
            codec,
          ),
        /controller wallet changed/,
      );
    },
  );
  for (const creditKind of ["destination_credit", "refund_credit"] as const)
    await scenario(
      `${creditKind}-before-source retains hold; exact native source proof releases once`,
      async () => {
        const input = await start();
        await admitNativeFundingSendInTransaction(
          client,
          input,
          policy,
          check(),
          codec,
        );
        const segmentId = pair.send.segment_id;
        assert.ok(segmentId);
        const sourceHash = `0x${"91".repeat(32)}`;
        const target = (
          await listFundingStepReceiptTargets(client, operationId)
        ).find((row) => row.stepId === send.id);
        assert.ok(target);
        const destination = fixture.input.destination.requiredAsset;
        assert.ok(fixture.input.destination.recipientAddress);
        const creditAsset =
          creditKind === "refund_credit"
            ? fixture.input.source.quoteInputAmount.asset
            : destination;
        await allocateFundingObservationInTransaction(client, {
          operationId,
          segmentId,
          kind: creditKind,
          networkId: creditAsset.networkId,
          assetId: creditAsset.assetId,
          assetDecimals: creditAsset.decimals,
          txHash: `0x${"92".repeat(32)}`,
          eventIndex: "0",
          fromAddress: `0x${"12".repeat(20)}`,
          toAddress:
            creditKind === "refund_credit"
              ? profile.address
              : fixture.input.destination.recipientAddress,
          rawAmount:
            creditKind === "refund_credit"
              ? pair.validated.binding.sourceRaw
              : "10000000",
          observedAt: new Date(),
          ledgerHeight: "123",
          blockHash: `0x${"93".repeat(32)}`,
          finalityStatus: "finalized",
          finalizedAt: new Date(),
          metadata: { test: true },
        });
        await reduceFundingOperationInTransaction(client, {
          operationId,
          now: new Date(),
        });
        assert.equal(
          await reservationState(),
          "active",
          "destination proof cannot restore old source capacity",
        );
        const requestId = fixture.wire.steps[0].requestId;
        const binding = pair.validated.binding;
        const time = Date.now();
        const parameters = pair.validated.transfer.action;
        const ledger = [
          {
            hash: sourceHash,
            time,
            delta: {
              type: "send",
              user: binding.owner,
              destination: binding.depository,
              sourceDex: binding.sourceDex,
              destinationDex: binding.destinationDex,
              token: "USDC",
              amount: parameters.amount,
              usdcValue: parameters.amount,
              fee: "0",
              nativeTokenFee: "0",
              nonce: binding.nonce,
              feeToken: "USDC",
            },
          },
        ];
        const request = {
          id: requestId,
          status: "success",
          user: binding.owner,
          sender: binding.owner,
          recipient: fixture.input.destination.recipientAddress,
          data: {
            inTxs: [
              {
                txHash: sourceHash,
                chainId: 1337,
                status: "success",
                block: 123,
                timestamp: Math.floor(time / 1000),
                data: {
                  hash: sourceHash,
                  error: null,
                  user: binding.owner,
                  action: parameters,
                },
              },
            ],
            route: {
              actual: {
                origin: {
                  inputCurrency: {
                    amount: binding.sourceRaw,
                    currency: {
                      chainId: 1337,
                      address:
                        fixture.input.source.quoteInputAmount.asset.assetId,
                      decimals: 8,
                    },
                  },
                },
                destination: {
                  outputCurrency: {
                    amount: "10000000",
                    currency: {
                      chainId: 8453,
                      address: destination.assetId,
                      decimals: 6,
                    },
                  },
                },
              },
            },
          },
        };
        const actualTransfer = request.data.inTxs[0];
        assert.ok(actualTransfer);
        request.data.inTxs.unshift({
          ...actualTransfer,
          timestamp: actualTransfer.timestamp - 1,
          block: 122,
        });
        let ledgerReads = 0;
        const receipt = await inspectNativeFundingSend(
          client as unknown as Pool,
          {
            status: async () => ({
              status: "success",
              requestId,
              inTxHashes: [sourceHash],
              txHashes: [],
              originChainId: 1337,
              destinationChainId: 8453,
            }),
            requestEvidence: async () => request,
          },
          fixture.input.codec,
          target,
          codec.decrypt(target.receiptRefCiphertext),
          async (url, init) => {
            assert.equal(url, "https://api.hyperliquid.xyz/info");
            const body = JSON.parse(String(init?.body));
            assert.equal(body.type, "userNonFundingLedgerUpdates");
            assert.equal(body.user.toLowerCase(), binding.owner.toLowerCase());
            ledgerReads++;
            return new Response(
              JSON.stringify(
                body.startTime === actualTransfer.timestamp * 1000
                  ? ledger
                  : [],
              ),
            );
          },
        );
        assert.equal(receipt.status, "finalized", JSON.stringify(receipt));
        assert.equal(
          ledgerReads,
          2,
          "same-hash corroboration at a different second must recover",
        );
        const proof = receipt.evidence.nativeSourceProof as Record<
          string,
          unknown
        >;
        for (const change of [
          { nonce: binding.nonce + 1 },
          { rawAmount: "1" },
          { owner: `0x${"ee".repeat(20)}` },
          { destinationAddress: `0x${"ee".repeat(20)}` },
          { sourceDex: "" },
          { destinationDex: "spot" },
        ]) {
          const fact: Record<string, unknown> = { ...proof, ...change };
          delete fact.evidenceFingerprint;
          const wrong = {
            ...fact,
            evidenceFingerprint: canonicalJsonHash(fact),
          };
          assert.equal(boundNativeSourceProof(binding, wrong), null);
        }
        const invalid = {
          ...receipt,
          evidence: {
            ...receipt.evidence,
            nativeSourceProof: { ...proof, nonce: binding.nonce + 1 },
          },
        };
        await applyFundingStepReceiptEvidenceInTransaction(client, {
          operationId,
          stepId: send.id,
          attemptId: input.attemptId,
          networkId: "hyperliquid:mainnet",
          receipt: invalid,
        });
        assert.equal(
          (
            await client.query(
              "select id from funding_observations where operation_id=$1 and kind='source_debit'",
              [operationId],
            )
          ).rowCount,
          0,
        );
        assert.equal(await reservationState(), "active");
        await applyFundingStepReceiptEvidenceInTransaction(client, {
          operationId,
          stepId: send.id,
          attemptId: input.attemptId,
          networkId: "hyperliquid:mainnet",
          receipt,
        });
        await applyFundingStepReceiptEvidenceInTransaction(client, {
          operationId,
          stepId: send.id,
          attemptId: input.attemptId,
          networkId: "hyperliquid:mainnet",
          receipt,
        });
        const debits = (
          await client.query(
            "select raw_amount,ledger_height,block_hash from funding_observations where operation_id=$1 and kind='source_debit'",
            [operationId],
          )
        ).rows;
        assert.equal(debits.length, 1);
        assert.equal(debits[0].raw_amount, binding.sourceRaw);
        assert.equal(debits[0].ledger_height, null);
        assert.equal(debits[0].block_hash, null);
        assert.equal(await reservationState(), "released");
      },
    );
  const raceInput = await start();
  // A committed fixture is necessary for distinct backend sessions to see the
  // same prepared attempt. Never run this against a shared/local/live DB.
  await client.query("commit");
  client.release();
  fixtureCommitted = true;
  const peerPool = await createIntegrationTestPool({
    max: 1,
    options: "-c statement_timeout=15000",
  });
  try {
    await assert.rejects(
      () =>
        submitNativeFundingSend(pool, raceInput, codec, {
          admissionPolicy: policy,
          observe: async () => {
            throw new Error("provider private URL must not leak");
          },
        }),
      /Native source capacity is unavailable; refresh and retry/,
    );
    let releaseObservations!: () => void;
    const bothObserved = new Promise<void>((resolve) => {
      releaseObservations = resolve;
    });
    const pids = new Set<number>();
    let reads = 0,
      posts = 0;
    const observe = async (readPool: Pool) => {
      // This query requires the sole connection. Moving provider/budget IO
      // back under the funding transaction would deadlock this actual pool.
      const pid = (await readPool.query("select pg_backend_pid() as pid"))
        .rows[0].pid;
      pids.add(pid);
      if (++reads === 2) releaseObservations();
      await bothObserved;
      return {
        capacity: {
          availableRaw: "1000000000",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        timeoutMs: 1000,
        responseMaxBytes: 4096,
      };
    };
    const fetcher: typeof fetch = async (url) => {
      assert.equal(url, "https://api.hyperliquid.xyz/exchange");
      posts++;
      const durable = (
        await pool.query(
          "select outcome,broadcast_may_have_occurred,receipt_ref_ciphertext from funding_operation_step_attempts where id=$1",
          [raceInput.attemptId],
        )
      ).rows[0];
      assert.equal(durable.outcome, "ambiguous");
      assert.equal(durable.broadcast_may_have_occurred, true);
      assert.equal(
        codec.decrypt(durable.receipt_ref_ciphertext),
        nativeFundingActionReference(pair.validated),
      );
      return new Response('{"status":"ok"}');
    };
    const results = await Promise.all(
      [pool, peerPool].map((db) =>
        submitNativeFundingSend(db, raceInput, codec, {
          admissionPolicy: policy,
          observe,
          fetcher,
        }),
      ),
    );
    assert.equal(pids.size, 2);
    assert.equal(reads, 2);
    assert.equal(posts, 1);
    assert.ok(
      results.every(
        (result) => result.submissionStatus === "reconcile_required",
      ),
    );
    await submitNativeFundingSend(pool, raceInput, codec, {
      admissionPolicy: policy,
      observe: async () => {
        throw new Error("replay reread");
      },
      fetcher: async () => {
        throw new Error("replay resend");
      },
    });
    assert.equal(posts, 1);
    console.log(
      "PASS actual two-session admission; max=1 prefetch; one POST; durable replay",
    );
    // Exercise the real HTTP report runtime, not just its repository fence.
    // API config import follows construction of both disposable pools.
    const { FundingOperationActionRuntime } =
      await import("../../execution/operation-action-runtime.js");
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY =
      "offline-native-send-test-key-at-least-32-chars";
    process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION = "1";
    const runtime = new FundingOperationActionRuntime(pool);
    for (const outcome of ["ambiguous", "failed"] as const) {
      const reported = await runtime.report(userId, {
        operationId,
        stepId: send.id,
        attemptId: raceInput.attemptId,
        outcome,
        transactionReference: null,
        failureCode: outcome === "ambiguous" ? "client_execution_failed" : null,
        actualCosts: { networkFeeRaw: null },
      });
      assert.equal(reported.accepted, true);
      assert.equal(reported.stepState, "reconcile_required");
    }
    assert.equal(posts, 1);
    console.log(
      "PASS actual common runtime reports preserve native admitted ambiguity without resending",
    );
  } finally {
    await peerPool.end();
  }
} finally {
  if (!fixtureCommitted) {
    await client.query("rollback");
    client.release();
  }
  await pool.end();
}
