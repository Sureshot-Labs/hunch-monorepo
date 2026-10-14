// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { buildRelayPlanningQuote } from "../../../funding-providers/relay/operation-plan.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
} from "../../persistence/funding-operation-repository.js";
import {
  startFundingStepAttemptForUserInTransaction,
  finishFundingStepAttemptForUserInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
} from "../../persistence/funding-evidence-repository.js";
import {
  admitNativeFundingAuthInTransaction,
  finishNativeFundingAuthInTransaction,
  nativeFundingPreparationInTransaction,
  closeNativeFundingUnsubmittedInTransaction,
} from "../../execution/hypercore-auth-attempt.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../../lifecycle/funding-lifecycle-projector.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";
import { DEFAULT_FUNDING_INTENT_POLICY } from "../../policies/funding-policy-v2.js";
import { fundingStartedSourceActionHoldSql } from "../../persistence/source-reservation-hold.js";
import { reduceFundingOperationInTransaction } from "../../reconciliation/funding-reducer.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const client = await pool.connect();
const wallet = Wallet.createRandom(); // Ephemeral OFFLINE test signer, never funded or sent.
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
      [`native-auth-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  const now = new Date();
  const fixture = hypercorePlanTestFixture(now, userId, wallet.address);
  const profile = fixture.input.profile;
  await client.query(
    `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,is_internal_wallet,wallet_source,privy_wallet_id,privy_profile_updated_at)
    values($1,$2,$3,'ethereum',true,true,'embedded',$4,clock_timestamp())`,
    [profile.walletId, userId, profile.address, profile.serverWalletRef],
  );
  const plan = (await buildRelayPlanningQuote(fixture.input)).commitPlan;
  const consentToken = randomUUID();
  assert.ok(plan.operation.sourceSnapshot);
  const quote = await createFundingQuoteInTransaction(client, {
    userId,
    discoveryProjectionId: randomUUID(),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "test-native-policy",
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
  const auth = rows[0],
    send = rows[1];
  assert.ok(auth && send);
  const { pair } = await nativeFundingPreparationInTransaction(
    client,
    operationId,
    auth.id,
  );
  const typed = pair.validated.authorization.typedData;
  const signature = await wallet.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
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
  const start = () =>
    startFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId,
      stepId: auth.id,
      canonicalActionFingerprint: auth.action_fingerprint,
      executorId: auth.executor_id,
      nativeSubmissionProtocol: true,
    });
  const projection = async () => {
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      { operationId, now: new Date() },
    );
    assert.ok(facts);
    return deriveFundingLifecycle(facts);
  };
  const hold = async () =>
    (
      await client.query(
        `select ${fundingStartedSourceActionHoldSql("reservation")} as held from balance_reservations reservation where operation_id=$1`,
        [operationId],
      )
    ).rows[0].held;
  const negativeReport = (attemptId: string) =>
    finishFundingStepAttemptForUserInTransaction(client, {
      userId,
      operationId,
      stepId: auth.id,
      attemptId,
      outcome: "cancelled",
      broadcastMayHaveOccurred: false,
      referenceKind: null,
      receiptRefCiphertext: null,
      receiptRefLookupHmac: null,
      lookupKeyVersion: null,
      actualCosts: {
        nativeSubmission: { phase: "closed", reason: "authorized" },
        retryableProviderFailure: true,
      },
    });
  async function scenario(name: string, run: () => Promise<void>) {
    await client.query("savepoint auth_scenario");
    await run();
    await client.query("rollback to savepoint auth_scenario");
    console.log(`PASS ${name}`);
  }
  await scenario("prepare/admit/duplicate/report protection/ACK", async () => {
    const { attempt } = await start();
    assert.equal(
      await hold(),
      false,
      "verified auth does not prolong cash hold beyond quote",
    );
    const input = {
      userId,
      operationId,
      stepId: auth.id,
      attemptId: attempt.id,
      signature,
    };
    const admitted = await admitNativeFundingAuthInTransaction(
      client,
      input,
      policy,
    );
    assert.equal(admitted.admitted, true);
    assert.ok(admitted.requestFingerprint);
    assert.equal(
      (await admitNativeFundingAuthInTransaction(client, input, policy))
        .admitted,
      false,
      "duplicate never gets POST authority",
    );
    assert.equal(
      (await negativeReport(attempt.id)).attempt.outcome,
      "started",
      "browser cannot cancel admitted server work",
    );
    assert.equal(
      await finishNativeFundingAuthInTransaction(client, {
        ...input,
        requestFingerprint: admitted.requestFingerprint,
        authorized: true,
      }),
      true,
    );
    assert.equal(
      (await projection()).actions.find((action) => action.actionId === send.id)
        ?.actionable,
      true,
    );
    assert.equal(
      await hold(),
      false,
      "successful mapping is not a native debit",
    );
    assert.equal(
      await finishNativeFundingAuthInTransaction(client, {
        ...input,
        requestFingerprint: admitted.requestFingerprint,
        authorized: false,
      }),
      false,
      "finished ACK cannot be rewritten",
    );
  });
  await scenario(
    "journal recovery closes never-admitted auth and fences a late signed request",
    async () => {
      const { attempt } = await start();
      const recovered = await finishFundingStepAttemptForUserInTransaction(
        client,
        {
          userId,
          operationId,
          stepId: auth.id,
          attemptId: attempt.id,
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
      assert.equal(recovered.attempt.outcome, "cancelled");
      assert.equal(recovered.attempt.broadcastMayHaveOccurred, false);
      assert.equal(
        (
          await admitNativeFundingAuthInTransaction(
            client,
            {
              userId,
              operationId,
              stepId: auth.id,
              attemptId: attempt.id,
              signature,
            },
            policy,
          )
        ).admitted,
        false,
      );
      assert.equal(await hold(), false);
    },
  );
  await scenario(
    "unknown registration is retryable; old ACK fenced",
    async () => {
      const { attempt } = await start();
      const input = {
        userId,
        operationId,
        stepId: auth.id,
        attemptId: attempt.id,
        signature,
      };
      const admitted = await admitNativeFundingAuthInTransaction(
        client,
        input,
        policy,
      );
      assert.ok(admitted.requestFingerprint);
      await finishNativeFundingAuthInTransaction(client, {
        ...input,
        requestFingerprint: admitted.requestFingerprint,
        authorized: false,
      });
      const state = await projection();
      assert.equal(state.safety.terminal, false);
      assert.equal(state.actions[0]?.actionable, true);
      const retry = await start();
      assert.notEqual(retry.attempt.id, attempt.id);
      assert.equal(
        await finishNativeFundingAuthInTransaction(client, {
          ...input,
          requestFingerprint: admitted.requestFingerprint,
          authorized: true,
        }),
        false,
      );
      const retryAdmitted = await admitNativeFundingAuthInTransaction(
        client,
        { ...input, attemptId: retry.attempt.id },
        policy,
      );
      assert.equal(retryAdmitted.admitted, true);
    },
  );
  await scenario(
    "cancel while authorize HTTP pending releases through common reducer",
    async () => {
      const { attempt } = await start();
      const input = {
        userId,
        operationId,
        stepId: auth.id,
        attemptId: attempt.id,
        signature,
      };
      const admitted = await admitNativeFundingAuthInTransaction(
        client,
        input,
        policy,
      );
      assert.ok(admitted.requestFingerprint);
      const cancelled = await recordSafeFundingActionCancellationsInTransaction(
        client,
        { operationId, now: new Date() },
      );
      assert.equal(cancelled.unsafeStepIds.length, 0);
      assert.ok(cancelled.cancelledStepIds.length > 0);
      await reduceFundingOperationInTransaction(client, {
        operationId,
        now: new Date(),
      });
      assert.equal((await projection()).status, "cancelled");
      assert.equal(
        (
          await client.query(
            "select state from balance_reservations where operation_id=$1",
            [operationId],
          )
        ).rows[0].state,
        "released",
      );
      assert.equal(
        await finishNativeFundingAuthInTransaction(client, {
          ...input,
          requestFingerprint: admitted.requestFingerprint,
          authorized: true,
        }),
        false,
      );
    },
  );
  await scenario(
    "expired admitted auth is closed without provider calls",
    async () => {
      const { attempt } = await start();
      await admitNativeFundingAuthInTransaction(
        client,
        {
          userId,
          operationId,
          stepId: auth.id,
          attemptId: attempt.id,
          signature,
        },
        policy,
      );
      assert.equal(
        (
          await closeNativeFundingUnsubmittedInTransaction(
            client,
            operationId,
            now,
            "expired",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await closeNativeFundingUnsubmittedInTransaction(
            client,
            operationId,
            new Date(now.getTime() + 120000),
            "expired",
          )
        ).length,
        1,
      );
      assert.equal(await hold(), false);
    },
  );
  await scenario("auth close never releases ambiguous SendAsset", async () => {
    const { attempt } = await start();
    await admitNativeFundingAuthInTransaction(
      client,
      {
        userId,
        operationId,
        stepId: auth.id,
        attemptId: attempt.id,
        signature,
      },
      policy,
    );
    await client.query(
      `insert into funding_operation_step_attempts(step_id,attempt_number,canonical_action_fingerprint,executor_id,outcome,broadcast_may_have_occurred,finished_at)
      values($1,1,$2,$3,'ambiguous',true,clock_timestamp())`,
      [send.id, send.action_fingerprint, send.executor_id],
    );
    await closeNativeFundingUnsubmittedInTransaction(
      client,
      operationId,
      new Date(now.getTime() + 120000),
      "expired",
    );
    await reduceFundingOperationInTransaction(client, {
      operationId,
      now: new Date(),
    });
    assert.equal(await hold(), true);
    assert.equal(
      (
        await client.query(
          "select state from balance_reservations where operation_id=$1",
          [operationId],
        )
      ).rows[0].state,
      "active",
    );
  });
  await scenario(
    "arbitrary started metadata updates remain rejected",
    async () => {
      const { attempt } = await start();
      await client.query("savepoint rejected_update");
      await assert.rejects(
        client.query(
          "update funding_operation_step_attempts set actual_costs=actual_costs || '{\"anything\":true}' where id=$1",
          [attempt.id],
        ),
        /started funding operation attempt/,
      );
      await client.query("rollback to savepoint rejected_update");
      await negativeReport(attempt.id);
      assert.equal((await projection()).status, "cancelled");
    },
  );
  console.log(
    "Native auth PG16 scenarios passed; no external POST or live signing",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
