import assert from "node:assert/strict";
import { positionActionSubmissionReportSchema } from "../../../schemas/position-actions.js";
import {
  positionActionPrivyReference,
  resolvePositionActionPrivyHash,
} from "../../position-actions/privy-submission-reference.js";

const reference = "privy-transaction-v1:d0498c04-5dec-482d-90e6-e2196cf34f5b";
const hash = `0x${"ab".repeat(32)}`;
for (const value of [reference, `privy-user-operation-v1:${hash}`]) {
  assert.equal(
    positionActionSubmissionReportSchema.safeParse({
      attemptNumber: 1,
      outcome: "ambiguous",
      submissionFingerprint: value,
      errorCode: null,
    }).success,
    true,
  );
  assert.ok(positionActionPrivyReference(value, "privy_authorization"));
  for (const mode of ["venue_relayer", "web_client", "privy_delegated"])
    assert.equal(positionActionPrivyReference(value, mode), null);
  for (const chainId of [137, 8453]) {
    let calls = 0;
    const input = {
      reference: value,
      executionMode: "privy_authorization",
      chainId,
      resolve: async (_reference: unknown, network: string) => {
        calls++;
        assert.equal(network, `evm:${chainId}`);
        return { kind: "submitted" as const, transactionReference: hash };
      },
    };
    assert.equal(await resolvePositionActionPrivyHash(input), hash);
    assert.equal(calls, 1);
    assert.equal(
      await resolvePositionActionPrivyHash({
        ...input,
        executionMode: "web_client",
      }),
      null,
    );
    assert.equal(calls, 1);
    assert.equal(
      await resolvePositionActionPrivyHash({
        ...input,
        resolve: async () => ({ kind: "pending" }),
      }),
      null,
    );
    assert.equal(
      await resolvePositionActionPrivyHash({
        ...input,
        resolve: async () => ({
          kind: "submitted",
          transactionReference: reference,
        }),
      }),
      null,
    );
  }
}
for (const invalid of [
  "privy-transaction-v1:",
  "privy-transaction-v1:../foo",
  "privy-user-operation-v1:bad",
]) {
  assert.equal(
    positionActionSubmissionReportSchema.safeParse({
      attemptNumber: 1,
      outcome: "ambiguous",
      submissionFingerprint: invalid,
      errorCode: null,
    }).success,
    false,
  );
}
