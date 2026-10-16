import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { AssetLocation } from "../domain/types.js";
import { startFundingStepAttemptForUserInTransaction } from "../persistence/funding-evidence-repository.js";
import {
  prepareEmbeddedFundingSubmission,
  submitEmbeddedFundingAction,
  type EmbeddedFundingSubmissionInput,
} from "../execution/embedded-funding-submission.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { loadRefundSourceCandidatePage } from "../reconciliation/relay-refund-source-candidates.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;
type FixtureFactory = (
  existing?: { userId: string; owner: string },
  beforeCommit?: (db: PoolClient, data: Fixture) => Promise<void>,
  makeSteps?: (source: AssetLocation) => FundingCommitPlan["steps"],
) => Promise<Fixture>;

/** Real two-connection commit visibility, not a simulated provider send. The
 * source operation, steps and reservation are one transaction. Existing action
 * entry points cannot prepare/admit an uncommitted operation, so a source that
 * commits after an already persisted receive event cannot have caused it through
 * these paths. created_at is deliberately NOT treated as a commit watermark. */
export async function verifyRefundSourceMembershipPg(
  pool: Pool,
  fixture: FixtureFactory,
) {
  const anchor = await fixture();
  const owner = {
    userId: anchor.base.source.accountId,
    owner: anchor.owner,
  };
  const transactionCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 19),
    lookupHmacKey: "offline-membership-transaction-key-32chars",
    keyVersion: 1,
  });
  let scanBefore = "";
  let broadcasts = 0;
  let preparedSubmission: EmbeddedFundingSubmissionInput | undefined;
  const depositAddress = `0x${"ab".repeat(20)}`;
  const transferData = new Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]).encodeFunctionData("transfer", [depositAddress, 10000000n]);
  const operationMissing = (error: unknown) =>
    error instanceof FundingPersistenceError &&
    error.code === "operation_not_found";
  const delayed = await fixture(
    owner,
    async (writer, data) => {
      scanBefore = (
        await pool.query<{ instant: string }>(
          `select to_char(clock_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as instant`,
        )
      ).rows[0].instant;
      const identity = {
        userId: owner.userId,
        operationId: data.base.operationId,
      };
      assert.equal(await fetchFundingOperationForUser(pool, identity), null);
      assert.ok(
        !(
          await loadRefundSourceCandidatePage(pool, {
            userId: owner.userId,
            scanBefore,
            cursor: null,
            limit: 10,
          })
        ).rows.some((row) => row.operation_id === identity.operationId),
        "a page cannot see an uncommitted source even when its timestamp precedes the cutoff",
      );
      // IDs supplied out of band must not bypass the same production ownership /
      // committed-operation check used by action preparation and final admission.
      const step = (
        await writer.query<{ id: string; action_fingerprint: string }>(
          "select id,action_fingerprint from funding_operation_steps where operation_id=$1",
          [identity.operationId],
        )
      ).rows[0];
      assert.ok(step);
      const stepId = step.id;
      const startInput = {
        ...identity,
        stepId,
        canonicalActionFingerprint: step.action_fingerprint,
        executorId: "wallet_profile_evm_v1",
        embeddedSubmissionProtocol: {
          signer: owner.owner,
          payer: "privy_sponsor" as const,
        },
      };
      const started = await startFundingStepAttemptForUserInTransaction(
        writer,
        startInput,
      );
      await assert.rejects(
        tx(pool, (db) =>
          startFundingStepAttemptForUserInTransaction(db, startInput),
        ),
        operationMissing,
      );
      const submission: EmbeddedFundingSubmissionInput = {
        context: {
          operationId: identity.operationId,
          stepId,
          attemptId: started.attempt.id,
        },
        payload: {
          kind: "ethereum",
          signer: owner.owner,
          chainId: 8453,
          executionMode: "sequential",
          returnOnAccepted: true,
          transactions: [
            {
              to: data.base.source.asset.assetId,
              data: transferData,
              value: "0x0",
              gas: "0x186a0",
              sponsor: true,
            },
          ],
        },
        requests: [{ id: "offline-membership", input: {} }],
      };
      preparedSubmission = submission;
      await assert.rejects(
        prepareEmbeddedFundingSubmission(pool, owner.userId, submission),
        operationMissing,
      );
      await assert.rejects(
        submitEmbeddedFundingAction(
          pool,
          owner.userId,
          submission,
          async () => {
            broadcasts++;
            assert.fail(
              "uncommitted operation must not reach provider submission",
            );
          },
          {
            codec: transactionCodec,
            admissionPolicy: async () => undefined,
          },
        ),
        operationMissing,
      );
      assert.equal(broadcasts, 0);
    },
    (source) => {
      const action = {
        kind: "evm_transaction" as const,
        actionId: randomUUID(),
        networkId: source.asset.networkId,
        senderWalletId: randomUUID(),
        to: source.asset.assetId,
        data: transferData,
        valueRaw: "0",
        gasLimitRaw: "100000",
      };
      return [
        {
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "transaction",
          state: "action_required",
          actionFingerprint: canonicalJsonHash(action),
          executorId: "wallet_profile_evm_v1",
          payerRequirement: "privy_sponsor",
          dependsOnOrdinal: null,
          normalizedAction: action,
          actionValidationResult: { signerAddress: owner.owner },
        },
      ];
    },
  );
  assert.ok(
    await fetchFundingOperationForUser(pool, {
      userId: owner.userId,
      operationId: delayed.base.operationId,
    }),
  );
  const visible = (
    await loadRefundSourceCandidatePage(pool, {
      userId: owner.userId,
      scanBefore,
      cursor: null,
      limit: 10,
    })
  ).rows.filter((row) => row.operation_id === delayed.base.operationId);
  assert.equal(visible.length, 1, "commit exposes the exact source atomically");
  assert.ok(visible[0].reservation_created_at <= scanBefore);
  assert.ok(preparedSubmission);
  await prepareEmbeddedFundingSubmission(
    pool,
    owner.userId,
    preparedSubmission,
  );
  const submission = preparedSubmission;
  // Hold this connection out of the pool throughout submission. It cannot be
  // reused by admission, so own-transaction visibility cannot mask a missing commit.
  const observer = await pool.connect();
  try {
    const submit = async () => {
      broadcasts++;
      // Transport and policy lookup are substituted. This tests the persistence /
      // admission boundary, not API wallet authorization or policy eligibility.
      const admission = (
        await observer.query<{
          phase: string;
          broadcast_may_have_occurred: boolean;
        }>(
          `select actual_costs#>>'{embeddedSubmission,phase}' as phase,
         broadcast_may_have_occurred from funding_operation_step_attempts where id=$1`,
          [submission.context.attemptId],
        )
      ).rows[0];
      assert.equal(admission.phase, "admitted");
      assert.equal(admission.broadcast_may_have_occurred, true);
      assert.equal(
        (
          await loadRefundSourceCandidatePage(observer, {
            userId: owner.userId,
            scanBefore,
            cursor: null,
            limit: 10,
          })
        ).rows.filter((row) => row.operation_id === delayed.base.operationId)
          .length,
        1,
      );
      return { kind: "transaction" as const, value: `0x${"44".repeat(32)}` };
    };
    const dependencies = {
      codec: transactionCodec,
      admissionPolicy: async () => undefined,
    };
    const result = await submitEmbeddedFundingAction(
      pool,
      owner.userId,
      submission,
      submit,
      dependencies,
    );
    assert.equal(
      broadcasts,
      1,
      "the same prepared action is executable after commit",
    );
    assert.deepEqual(
      await submitEmbeddedFundingAction(
        pool,
        owner.userId,
        submission,
        submit,
        dependencies,
      ),
      result,
    );
    assert.equal(
      broadcasts,
      1,
      "replay uses the stored reference without another send",
    );
  } finally {
    observer.release();
  }

  let rolledBackId = "";
  await assert.rejects(
    fixture(owner, async (_db, data) => {
      rolledBackId = data.base.operationId;
      throw new Error("injected_before_source_commit");
    }),
    /injected_before_source_commit/,
  );
  assert.equal(
    await fetchFundingOperationForUser(pool, {
      userId: owner.userId,
      operationId: rolledBackId,
    }),
    null,
  );
  assert.equal(broadcasts, 1);
  console.log(
    "PASS real delayed source commit: no precommit preparation/send, postcommit source/admission visible before synthetic transport, replay and rollback",
  );
}
