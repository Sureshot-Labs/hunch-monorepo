import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { assertClientExecutable } from "../../execution/operation-action-runtime.js";
import { assertNativeFundingRecipient } from "../../execution/hypercore-auth-attempt.js";
import {
  nativeFundingSignedRequest,
  nativeFundingSigningPreparation,
} from "../../execution/hypercore-signed-request.js";
import { validateRelayHypercoreQuote } from "../../../funding-providers/relay/hypercore-quote.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import {
  fundingNativeSubmitRequestSchema,
  fundingNativeSubmitResponseSchema,
  fundingOperationActionPrepareRequestSchema,
  fundingOperationActionPrepareResponseSchema,
} from "../../../schemas/funding.js";
import type {
  ExternalHandoffAction,
  ResolvedExternalRecipient,
} from "../../domain/types.js";
import { buildFundingExecutionPreflight } from "../../execution/operation-execution-preflight.js";
import type { FundingOperationStep } from "../../persistence/funding-evidence-repository.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";

const fixture = hypercorePlanTestFixture();
const action = fixture.input.quote.actions[0] as ExternalHandoffAction;
const profile = fixture.input.profile;
const executor = "relay_hypercore_native_v1";
const pair = validateRelayHypercoreQuote(fixture.quoteInput.validation).actions;
const preparation = nativeFundingSigningPreparation(pair, {
  version: 1,
  phase: "prepared",
  stage: "nonce_mapping",
  expiresAt: fixture.input.quote.candidate.expiresAt,
  pairFingerprint: pair.fingerprint,
  signer: pair.binding.owner.toLowerCase(),
  nonce: pair.binding.nonce,
});

test("native prepare accepts only exact executor/network and owned sign-only profiles", () => {
  const result = assertClientExecutable(action, executor, [profile]);
  assert.equal(result.payerRequirement, "none");
  assert.equal(result.executionMode, "venue_relayer");
  assert.equal(result.sponsorshipPolicyId, null);
  assert.doesNotThrow(() =>
    assertClientExecutable(action, executor, [
      { ...profile, source: "external", signingModes: ["web_client"] },
    ]),
  );
  for (const changed of [
    { ...profile, source: "smart" as const },
    { ...profile, serverWalletRef: null },
    { ...profile, signingModes: [] },
    { ...profile, walletId: randomUUID() },
    { ...profile, networkId: "evm:1337" },
  ])
    assert.throws(() => assertClientExecutable(action, executor, [changed]));
  assert.throws(() =>
    assertClientExecutable(action, "wallet_profile_evm_v1", [profile]),
  );
  assert.throws(() =>
    assertClientExecutable(
      { ...action, networkId: "hyperliquid:testnet" },
      executor,
      [profile],
    ),
  );
  assert.throws(() =>
    assertClientExecutable(
      { ...action, handoffKind: "relay_hypercore_anything" },
      executor,
      [profile],
    ),
  );
});

test("native API is additive, signature-only, protocol negotiated and never declares a debit from ACK", () => {
  assert.deepEqual(
    fundingOperationActionPrepareRequestSchema.parse({
      submissionProtocols: { native: 1, safe: 1 },
    }),
    { submissionProtocols: { native: 1, safe: 1 } },
  );
  assert.throws(() =>
    fundingOperationActionPrepareRequestSchema.parse({
      submissionProtocols: { native: 2 },
    }),
  );
  const submit = { attemptId: randomUUID(), signature: `0x${"ab".repeat(65)}` };
  assert.deepEqual(fundingNativeSubmitRequestSchema.parse(submit), submit);
  for (const extra of [
    { nonce: 1 },
    { request: {} },
    { stage: "send_asset" },
    { url: "https://example.com" },
    { transactionReference: "fake" },
  ])
    assert.throws(() =>
      fundingNativeSubmitRequestSchema.parse({ ...submit, ...extra }),
    );
  assert.throws(() =>
    fundingNativeSubmitResponseSchema.parse({
      stage: "send_asset",
      attemptId: submit.attemptId,
      submissionStatus: "succeeded",
    }),
  );
  assert.doesNotThrow(() =>
    fundingOperationActionPrepareResponseSchema.parse({
      ok: true,
      attemptId: submit.attemptId,
      action,
      actionFingerprint: "a".repeat(64),
      controllerWalletRef: profile.walletId,
      executorId: executor,
      executionMode: "venue_relayer",
      payerRequirement: "none",
      sponsorshipPolicyId: null,
      nativeSubmission: preparation,
    }),
  );
});

test("native signing DTO contains only reconstructed typed data bound to the immutable attempt", () => {
  assert.deepEqual(preparation.typedData, pair.authorization.typedData);
  assert.equal(preparation.digest, pair.authorization.digest);
  assert.equal("post" in preparation, false);
  const submission = {
    version: 1 as const,
    phase: "prepared" as const,
    stage: "send_asset" as const,
    expiresAt: fixture.input.quote.candidate.expiresAt,
    pairFingerprint: pair.fingerprint,
    signer: pair.binding.owner.toLowerCase(),
    nonce: pair.binding.nonce,
  };
  assert.deepEqual(
    nativeFundingSigningPreparation(pair, submission).typedData,
    pair.transfer.typedData,
  );
  for (const changed of [
    { ...submission, pairFingerprint: "a".repeat(64) },
    { ...submission, signer: `0x${"11".repeat(20)}` },
    { ...submission, nonce: submission.nonce + 1 },
    { ...submission, phase: "closed" as const, reason: "authorized" as const },
  ])
    assert.throws(() => nativeFundingSigningPreparation(pair, changed));
});

test("common execution preflight includes native controller and rejects a disguised executor", () => {
  const step = {
    state: "action_required",
    executorId: executor,
    normalizedAction: action,
    actionFingerprint: canonicalJsonHash(action),
  } as unknown as FundingOperationStep;
  const operation = { id: randomUUID(), version: 1 };
  const result = buildFundingExecutionPreflight(operation, [step], profile);
  assert.equal(result.complete, true);
  assert.deepEqual(result.requiredControllerWalletRefs, [
    profile.controllerWalletRef,
  ]);
  const changed = { ...action, handoffKind: "unknown" };
  assert.equal(
    buildFundingExecutionPreflight(
      operation,
      [
        {
          ...step,
          normalizedAction: changed,
          actionFingerprint: canonicalJsonHash(changed),
        },
      ],
      profile,
    ).complete,
    false,
  );
  assert.equal(
    buildFundingExecutionPreflight(operation, [step], null).complete,
    false,
  );
});

test("native final recipient binding cannot change recipient/account/asset/address or frozen snapshot", () => {
  assert.ok(fixture.input.destination.recipientAddress);
  const recipient: ResolvedExternalRecipient = {
    recipientId: randomUUID(),
    accountId: randomUUID(),
    networkId: "evm:8453",
    asset: fixture.input.destination.requiredAsset,
    address: fixture.input.destination.recipientAddress,
    addressFingerprint: "f".repeat(64),
    validatedAt: "2026-10-14T10:00:00Z",
    expiresAt: "2026-10-14T10:15:00Z",
    validationPolicyVersion: 1,
  };
  const { address, ...frozen } = recipient;
  const target = { kind: "external_recipient", recipient: frozen };
  const input = {
    userId: recipient.accountId,
    recipient,
    destinationTarget: target,
    actionPayload: {
      destinationTarget: structuredClone(target),
      recipientAddress: address,
    },
  };
  assert.doesNotThrow(() => assertNativeFundingRecipient(input));
  for (const changed of [
    { ...recipient, recipientId: randomUUID() },
    { ...recipient, accountId: randomUUID() },
    { ...recipient, addressFingerprint: "b".repeat(64) },
    { ...recipient, address: "0x" + "11".repeat(20) },
    { ...recipient, asset: { ...recipient.asset, decimals: 18 } },
  ])
    assert.throws(() =>
      assertNativeFundingRecipient({ ...input, recipient: changed }),
    );
  assert.throws(() =>
    assertNativeFundingRecipient({
      ...input,
      destinationTarget: { kind: "owned_location" },
    }),
  );
  assert.throws(() =>
    assertNativeFundingRecipient({
      ...input,
      actionPayload: {
        ...input.actionPayload,
        destinationTarget: {
          ...target,
          recipient: { ...frozen, expiresAt: "2027-01-01T00:00:00Z" },
        },
      },
    }),
  );
});

test("malformed native signatures never escape into error logs", () => {
  const pair = validateRelayHypercoreQuote(
    fixture.quoteInput.validation,
  ).actions;
  const bad = "0x" + "ab".repeat(65);
  assert.throws(
    () => nativeFundingSignedRequest(pair, "send_asset", bad),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid native action signature" &&
      !JSON.stringify(error).includes(bad),
  );
});
