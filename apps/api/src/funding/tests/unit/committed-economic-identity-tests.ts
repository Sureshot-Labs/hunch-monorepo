import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readCommittedFundingIdentity,
  refundSnapshotAccountIds,
} from "../../domain/committed-economic-identity.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import { readRefundNativeDestination } from "../../reconciliation/relay-refund-destination-settlement.js";

const original = "original-economic-owner",
  current = "current-relational-owner";
const location = {
  kind: "venue_account",
  locationId: "native-source-location",
  accountId: original,
  asset: HYPERCORE_MAINNET_USDC,
  details: {
    venueId: "hyperliquid",
    environment: "mainnet",
    nativeSourceDex: "spot",
    address: `0x${"ab".repeat(20)}`,
  },
};
const source = { kind: "owned_location", location };
const identity = {
  currentOwnerUserId: current,
  originalEconomicAccountId: original,
};

test("committed operation source preserves the economic subject while authorization belongs to current relational owner", () => {
  for (const operationSourceSnapshot of [
    source,
    location,
    { kind: "venue_cash", source },
    {
      kind: "composite",
      source: { kind: "composite", legCount: 2 },
      sourceLegs: [{ source }, { source }],
    },
  ]) {
    assert.deepEqual(
      readCommittedFundingIdentity({
        currentOwnerUserId: current,
        operationSourceSnapshot,
        accountIds: [original, original],
      }),
      identity,
    );
    assert.equal(
      readCommittedFundingIdentity({
        currentOwnerUserId: current,
        operationSourceSnapshot,
        accountIds: [original, "third-owner"],
      }),
      null,
    );
    assert.equal(
      readCommittedFundingIdentity({
        currentOwnerUserId: current,
        operationSourceSnapshot,
        accountIds: [current, current],
      }),
      null,
    );
  }
  assert.equal(source.location.accountId, original);
});

test("misbound segment source and refunds cannot create their own merge authority", () => {
  const anchor = { ...source, location: { ...location, accountId: current } };
  assert.equal(
    readCommittedFundingIdentity({
      currentOwnerUserId: current,
      operationSourceSnapshot: anchor,
      accountIds: [original, original],
    }),
    null,
  );
  for (const operationSourceSnapshot of [
    undefined,
    {},
    {
      support_metadata: {
        userMergeAudit: [
          { recordedAt: new Date().toISOString(), accountId: original },
        ],
      },
    },
  ]) {
    assert.equal(
      readCommittedFundingIdentity({
        currentOwnerUserId: current,
        operationSourceSnapshot,
        accountIds: [original],
      }),
      null,
    );
    assert.deepEqual(
      readCommittedFundingIdentity({
        currentOwnerUserId: current,
        operationSourceSnapshot,
        accountIds: [current],
      }),
      { currentOwnerUserId: current, originalEconomicAccountId: current },
    );
  }
  const mixed = {
    source: { kind: "composite", legCount: 2 },
    sourceLegs: [{ source }, { source: anchor }],
  };
  assert.equal(
    readCommittedFundingIdentity({
      currentOwnerUserId: current,
      operationSourceSnapshot: mixed,
      accountIds: [original],
    }),
    null,
  );
  const shadowed = {
    ...mixed,
    sourceLegs: [
      { source },
      {
        source: {
          ...anchor,
          source: { kind: "external_ingress" },
        },
      },
    ],
  };
  assert.equal(
    readCommittedFundingIdentity({
      currentOwnerUserId: current,
      operationSourceSnapshot: shadowed,
      accountIds: [original],
    }),
    null,
  );
  assert.equal(
    readCommittedFundingIdentity({
      currentOwnerUserId: current,
      operationSourceSnapshot: { ...source, location: { accountId: current } },
      accountIds: [current],
    }),
    null,
  );
});

test("alternative refunds and native settlement use the same frozen original subject without rewriting it", () => {
  const snapshot = {
    ...location,
    alternativeRefundLocations: { version: 1, locations: [location] },
  };
  const before = JSON.stringify(snapshot);
  assert.deepEqual(refundSnapshotAccountIds(snapshot), [original, original]);
  assert.equal(
    refundSnapshotAccountIds({ ...snapshot, alternativeRefundLocations: {} }),
    null,
  );
  assert.equal(
    refundSnapshotAccountIds({
      ...snapshot,
      alternativeRefundLocations: { locations: [null] },
    }),
    null,
  );
  const target = {
    userId: current,
    operationSourceSnapshot: source,
    destination: { kind: "owned_location", location },
    minimum: { asset: HYPERCORE_MAINNET_USDC, raw: "980000000" },
  };
  assert.ok(readRefundNativeDestination(target));
  assert.equal(
    readRefundNativeDestination({
      ...target,
      operationSourceSnapshot: undefined,
    }),
    null,
  );
  assert.equal(
    readRefundNativeDestination({
      ...target,
      destination: {
        kind: "owned_location",
        location: { ...location, accountId: "third-owner" },
      },
    }),
    null,
  );
  assert.equal(JSON.stringify(snapshot), before);
});
