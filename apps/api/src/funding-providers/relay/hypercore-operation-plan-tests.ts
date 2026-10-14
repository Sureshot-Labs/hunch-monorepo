import assert from "node:assert/strict";
import { test } from "node:test";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import { buildRelayPlanningQuote } from "./operation-plan.js";
import { normalizeRelayHypercoreWalletQuote } from "./wallet-adapter.js";
import {
  RELAY_HYPERCORE_AUTH,
  RELAY_HYPERCORE_SEND,
} from "./hypercore-operation-plan.js";
import type { ExternalHandoffAction } from "../../funding/domain/types.js";
import { hypercoreSpotAccountLocation } from "../../account-value/canonical.js";

test("P2 physical spot location enters the native common plan without a new reserve pool", async () => {
  const { input, quoteInput } = hypercorePlanTestFixture();
  if (input.source.source.kind !== "owned_location")
    throw new Error("source fixture");
  const location = hypercoreSpotAccountLocation({
    accountId: input.source.source.location.accountId,
    address: input.profile.address,
    controllerWalletId: input.profile.walletId,
  }).location;
  const source = { kind: "owned_location" as const, location };
  const quote = normalizeRelayHypercoreWalletQuote({ ...quoteInput, source });
  const result = await buildRelayPlanningQuote({
    ...input,
    quote,
    source: { ...input.source, source },
  });
  assert.equal(
    result.commitPlan.reservations[0].locationId,
    location.locationId,
  );
  assert.deepEqual(result.commitPlan.operation.sourceSnapshot, source);
  assert.throws(() =>
    normalizeRelayHypercoreWalletQuote({
      ...quoteInput,
      source: {
        kind: "owned_location",
        location: {
          ...location,
          details: { ...location.details, balanceClass: "perp" },
        },
      },
    }),
  );
  await assert.rejects(
    buildRelayPlanningQuote({
      ...input,
      source: {
        ...input.source,
        source: {
          kind: "owned_location",
          location: {
            ...location,
            details: { ...location.details, balanceClass: "perp" },
          },
        },
      },
    }),
  );
});

test("native quote uses the common plan: one reservation, two dependent steps, exact encrypted request and perps refund", async () => {
  const { input } = hypercorePlanTestFixture();
  const result = await buildRelayPlanningQuote(input);
  const plan = result.commitPlan;
  assert.equal(result.executionPlan.kind, "wallet_route");
  assert.deepEqual(
    plan.steps.map((step) => [
      step.stepKind,
      step.payerRequirement,
      step.dependsOnOrdinal,
      step.actionValidationResult.valueMoving,
    ]),
    [
      ["signature", "none", null, false],
      ["external_handoff", "none", 0, true],
    ],
  );
  assert.equal(
    plan.steps[0]?.normalizedAction.handoffKind,
    RELAY_HYPERCORE_AUTH,
  );
  assert.equal(
    plan.steps[1]?.normalizedAction.handoffKind,
    RELAY_HYPERCORE_SEND,
  );
  assert.equal(
    plan.steps[0]?.actionValidationResult.nativePairFingerprint,
    plan.steps[1]?.actionValidationResult.nativePairFingerprint,
  );
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.reservations[0]?.rawAmount, "1000000000");
  assert.equal(
    plan.reservations[0]?.locationId,
    input.source.source.kind === "owned_location"
      ? input.source.source.location.locationId
      : null,
  );
  assert.equal(
    plan.segments[0]?.refundLocationSnapshot?.locationId,
    input.quote.nativeRefundLocation?.locationId,
  );
  const cipher = plan.segments[0]?.providerQuoteRefCiphertext;
  assert.ok(cipher);
  assert.equal(input.codec.decrypt(cipher), input.quote.requestId);
  assert.equal(
    JSON.stringify(plan).includes(input.quote.requestId),
    false,
    "no plaintext provider request in actions or snapshots",
  );
});

test("native actions preserve signed bytes and cannot be regrouped as EVM transactions", async () => {
  const { input, wire } = hypercorePlanTestFixture();
  const result = await buildRelayPlanningQuote(input);
  const send = result.commitPlan.steps[1]
    ?.normalizedAction as unknown as ExternalHandoffAction;
  assert.deepEqual(send.payload.data, wire.steps[1].items[0].data);
  await assert.rejects(
    buildRelayPlanningQuote({
      ...input,
      serverExecutionProfileId: "delegated",
    }),
    /user-authorized/,
  );
  await assert.rejects(
    buildRelayPlanningQuote({
      ...input,
      route: { ...input.route, networkExecutorId: "wallet_profile_evm_v1" },
    }),
    /native_commit/,
  );
});

test("native common builder binds owner, amount, network, source class, request, expiry and signing custody", async () => {
  const { input } = hypercorePlanTestFixture();
  const invalid: (typeof input)[] = [
    { ...input, profile: { ...input.profile, address: `0x${"a".repeat(40)}` } },
    { ...input, profile: { ...input.profile, walletId: "other" } },
    { ...input, profile: { ...input.profile, networkId: "evm:1337" } },
    { ...input, profile: { ...input.profile, source: "smart" } },
    {
      ...input,
      profile: { ...input.profile, signingModes: ["privy_delegated"] },
    },
    { ...input, profile: { ...input.profile, serverWalletRef: null } },
    { ...input, quote: { ...input.quote, requestId: "another-request-id" } },
    {
      ...input,
      quote: {
        ...input.quote,
        sourceAmount: { ...input.quote.sourceAmount, raw: "999999999" },
      },
    },
    {
      ...input,
      quote: {
        ...input.quote,
        candidate: {
          ...input.quote.candidate,
          minimumOutput: { ...input.quote.candidate.minimumOutput, raw: "1" },
        },
      },
    },
    {
      ...input,
      quote: {
        ...input.quote,
        candidate: {
          ...input.quote.candidate,
          expiresAt: new Date(input.now.getTime() + 120000).toISOString(),
        },
      },
    },
    { ...input, now: new Date(input.now.getTime() + 60000) },
  ];
  for (const candidate of invalid)
    await assert.rejects(buildRelayPlanningQuote(candidate));
});

test("reordered, missing, extra or mutated native action pairs cannot enter common commit", async () => {
  const { input } = hypercorePlanTestFixture();
  const [auth, send] = input.quote.actions;
  assert.ok(auth && send && send.kind === "external_handoff");
  for (const actions of [
    [send, auth],
    [auth],
    [auth, send, send],
    [auth, { ...send, payload: { ...send.payload, unexpected: "field" } }],
    [
      auth,
      {
        ...send,
        payload: {
          ...send.payload,
          expiresAt: new Date(input.now.getTime() + 30000).toISOString(),
        },
      },
    ],
  ])
    await assert.rejects(
      buildRelayPlanningQuote({ ...input, quote: { ...input.quote, actions } }),
    );
});

test("external sign-only profile is supported without inventing Privy custody", async () => {
  const { input } = hypercorePlanTestFixture();
  const result = await buildRelayPlanningQuote({
    ...input,
    profile: {
      ...input.profile,
      source: "external",
      serverWalletRef: null,
      signingModes: ["web_client"],
    },
  });
  assert.equal(
    result.commitPlan.steps[0]?.actionValidationResult.signingMode,
    "web_client",
  );
});

test("native normalizer rejects another account, destination asset, source class and recipient", () => {
  const { quoteInput } = hypercorePlanTestFixture();
  assert.equal(quoteInput.destination.target.kind, "owned_location");
  if (quoteInput.destination.target.kind !== "owned_location")
    throw new Error("fixture target");
  const location = quoteInput.source.location;
  for (const source of [
    { ...location, accountId: "other" },
    { ...location, kind: "wallet" },
    { ...location, details: { ...location.details, balanceClass: "perp" } },
    {
      ...location,
      details: { ...location.details, controllerWalletId: "other" },
    },
  ])
    assert.throws(
      () =>
        normalizeRelayHypercoreWalletQuote({
          ...quoteInput,
          source: { kind: "owned_location", location: source },
        }),
      /owned_location/,
    );
  const destinationLocation = quoteInput.destination.target.location;
  for (const target of [
    {
      ...destinationLocation,
      asset: { ...destinationLocation.asset, decimals: 8 },
    },
    {
      ...destinationLocation,
      details: {
        ...destinationLocation.details,
        address: `0x${"a".repeat(40)}`,
      },
    },
  ])
    assert.throws(
      () =>
        normalizeRelayHypercoreWalletQuote({
          ...quoteInput,
          destination: {
            ...quoteInput.destination,
            target: { kind: "owned_location", location: target },
          },
        }),
      /owned_location/,
    );
});

test("native external withdrawal binds the resolved recipient and keeps refunds owned", async () => {
  const { input, quoteInput } = hypercorePlanTestFixture();
  const recipient = {
    recipientId: "external-recipient",
    accountId: quoteInput.source.location.accountId,
    networkId: input.destination.requiredAsset.networkId,
    asset: input.destination.requiredAsset,
    addressFingerprint: "resolved-recipient-hmac",
    validatedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 60000).toISOString(),
    validationPolicyVersion: 1,
  };
  const destination = {
    ...input.destination,
    externalRecipientId: recipient.recipientId,
    target: { kind: "external_recipient" as const, recipient },
    recipientAddress: input.profile.address,
  };
  const quote = normalizeRelayHypercoreWalletQuote({
    ...quoteInput,
    destination,
  });
  const plan = await buildRelayPlanningQuote({ ...input, quote, destination });
  assert.equal(plan.commitPlan.operation.purpose, "withdrawal");
  assert.equal(
    plan.commitPlan.operation.externalRecipientId,
    recipient.recipientId,
  );
  assert.equal(
    plan.commitPlan.segments[0]?.refundLocationSnapshot?.accountId,
    recipient.accountId,
  );
  for (const invalid of [
    { ...destination, recipientAddress: `0x${"a".repeat(40)}` },
    { ...destination, recipientAddress: null },
    { ...destination, externalRecipientId: "different" },
    {
      ...destination,
      target: {
        ...destination.target,
        recipient: { ...recipient, expiresAt: input.now.toISOString() },
      },
    },
  ])
    assert.throws(
      () =>
        normalizeRelayHypercoreWalletQuote({
          ...quoteInput,
          destination: invalid,
        }),
      /owned_location/,
    );
  await assert.rejects(
    buildRelayPlanningQuote({
      ...input,
      quote,
      destination: { ...destination, recipientAddress: `0x${"a".repeat(40)}` },
    }),
    /native_commit/,
  );
});

test("in-place quote mutation cannot rewrite either immutable action comparator", async () => {
  for (const field of ["raw", "asset", "destination"]) {
    const { input } = hypercorePlanTestFixture();
    const candidate = input.quote.candidate as unknown as {
      minimumOutput: { raw: string; asset: { decimals: number } };
      destination: { location: { details: { address: string } } };
    };
    if (field === "raw") candidate.minimumOutput.raw = "1";
    else if (field === "asset") candidate.minimumOutput.asset.decimals = 8;
    else candidate.destination.location.details.address = `0x${"a".repeat(40)}`;
    await assert.rejects(buildRelayPlanningQuote(input));
  }
  const { input } = hypercorePlanTestFixture();
  const [auth, send] = input.quote.actions as readonly ExternalHandoffAction[];
  assert.ok(auth && send);
  assert.notEqual(auth.payload.minimumOutput, send.payload.minimumOutput);
  assert.notEqual(auth.payload.binding, send.payload.binding);
  assert.notEqual(
    auth.payload.destinationTarget,
    send.payload.destinationTarget,
  );
});
