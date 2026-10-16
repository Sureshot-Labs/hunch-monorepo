import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXACT_REFUND_RECEIPTS_CONTRACT,
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
  readFundingRefundCompletionProofs,
  fundingRefundReceiptSetComplete,
  type FundingRefundSettledReceipt,
} from "../../domain/refund-settlement.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import { projectFundingRefundClaim } from "../../../account-value/funding-refund-claim.js";
import { RELAY_ROUTE_SPECS } from "../../../funding-providers/relay/mappings.js";
import { POLYGON_USDCE_LEGACY } from "../../../funding-providers/relay/rehearsal.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
} from "../../lifecycle/funding-lifecycle-projector.js";

const owner = `0x${"a".repeat(40)}`;
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const thirdId = "00000000-0000-4000-8000-000000000003";
const asset = HYPERCORE_MAINNET_USDC;
const snapshot = {
  kind: "venue_account",
  locationId: "native-perps",
  asset,
  refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
  relayProtocolOrderId: `0x${"b".repeat(64)}`,
  details: {
    address: owner,
    venueId: "hyperliquid",
    environment: "mainnet",
    nativeSourceDex: "",
  },
};
const requestBinding = {
  requestFingerprint: "a".repeat(64),
  lookupKeyVersion: 3,
};
const contract = readFundingRefundContract(snapshot, requestBinding);
assert.ok(contract);
const receiptIdentity = {
  ...requestBinding,
  version: 1 as const,
  protocolOrderId: snapshot.relayProtocolOrderId,
  refundLocationId: snapshot.locationId,
};
const proof = {
  ...receiptIdentity,
  expectedReturned: { asset, raw: "980000000" },
  observationIds: [firstId, secondId],
};
function receipts(): FundingRefundSettledReceipt[] {
  return ["400000000", "580000000"].map((raw, index) => ({
    observationId: index === 0 ? firstId : secondId,
    money: { asset, raw },
    destinationAddress: owner,
    nativeDestinationDex: "",
    identity: receiptIdentity,
    completionProofs: index === 0 ? [proof] : [],
  }));
}
function required<T>(value: T | undefined | null): T {
  assert.ok(value != null);
  return value;
}

test("account value preserves the partial refund residual and closes only the entire proven set", () => {
  const source = { asset, raw: "1000000000" };
  const project = (rows: FundingRefundSettledReceipt[]) =>
    projectFundingRefundClaim({
      source,
      contract: required(contract),
      receipts: rows,
    });
  assert.deepEqual(project([]), { kind: "pending", raw: source.raw });
  assert.deepEqual(project(receipts().slice(0, 1)), {
    kind: "pending",
    raw: "600000000",
  });
  assert.deepEqual(
    project(receipts().map((row) => ({ ...row, completionProofs: [] }))),
    { kind: "pending", raw: "20000000" },
  );
  assert.deepEqual(project(receipts()), { kind: "complete" });
  const [first] = receipts();
  assert.deepEqual(
    project([{ ...first, money: { ...source }, completionProofs: [] }]),
    { kind: "pending", raw: "0" },
  );
  assert.deepEqual(
    project(receipts().slice(1)),
    { kind: "pending", raw: "420000000" },
    "a reorged receipt is no longer in the canonical set",
  );
});

test("account value does not price unknown extra receipts, excess refunds or malformed contracts", () => {
  const source = { asset, raw: "1000000000" };
  const unknown = { kind: "unpriced", reason: "funding_refund_value_unknown" };
  const [first] = receipts();
  for (const rows of [
    [...receipts(), { ...first, observationId: thirdId, identity: null }],
    [first, first],
    [{ ...first, destinationAddress: `0x${"f".repeat(40)}` }],
    [{ ...first, nativeDestinationDex: "spot" as const }],
    [{ ...first, money: { asset, raw: "1100000000" } }],
    [
      {
        ...first,
        money: { asset, raw: Number("9800000000000001") as unknown as string },
      },
    ],
    [
      {
        ...first,
        identity: {
          ...receiptIdentity,
          protocolOrderId: `0x${"c".repeat(64)}`,
        },
      },
    ],
  ])
    assert.deepEqual(
      projectFundingRefundClaim({
        source,
        contract: required(contract),
        receipts: rows,
      }),
      unknown,
    );
  assert.deepEqual(
    projectFundingRefundClaim({
      source,
      contract: { ...required(contract), supported: false },
      receipts: [],
    }),
    unknown,
  );
});

test("account value converts registered stable-source units exactly without admitting unregistered collateral or truncation", () => {
  const base = RELAY_ROUTE_SPECS["base-usdc-to-hypercore-spot-usdc"].source;
  const source = { asset: base, raw: "10000000" };
  assert.deepEqual(
    projectFundingRefundClaim({
      source,
      contract: required(contract),
      receipts: receipts().slice(0, 1),
    }),
    { kind: "pending", raw: "6000000" },
  );
  assert.deepEqual(
    projectFundingRefundClaim({
      source,
      contract: required(contract),
      receipts: receipts(),
    }),
    { kind: "complete" },
  );
  assert.deepEqual(
    projectFundingRefundClaim({
      source,
      contract: required(contract),
      receipts: [{ ...receipts()[0], money: { asset, raw: "400000001" } }],
    }),
    { kind: "unpriced", reason: "funding_refund_value_unknown" },
  );
  assert.equal(
    projectFundingRefundClaim({
      source: {
        asset: {
          networkId: "evm:137",
          assetId: POLYGON_USDCE_LEGACY,
          decimals: 6,
        },
        raw: "10000000",
      },
      contract: required(contract),
      receipts: [],
    }).kind,
    "unpriced",
  );
  assert.deepEqual(
    projectFundingRefundClaim({
      source: {
        asset:
          RELAY_ROUTE_SPECS["hypercore-spot-usdc-to-polygon-pusd"].destination,
        raw: "10000000",
      },
      contract: required(contract),
      receipts: [],
    }),
    { kind: "pending", raw: "10000000" },
  );
});
function facts(rows = receipts()): FundingLifecycleFacts {
  const now = new Date("2026-10-14T20:00:00.000Z");
  const money = { ...asset, raw: "1000000000" };
  return {
    plan: {
      initialState: { status: "in_progress", progressStage: "routing" },
      requestedDestination: money,
      completionEvidence: "destination_credit",
      routeLegs: [
        {
          routeLegId: "leg",
          requestedSource: money,
          minimumDestination: money,
          refundContract: contract,
        },
      ],
    },
    actions: [],
    transfers: rows.map((row) => ({
      transferId: row.observationId,
      routeLegId: "leg",
      kind: "refund_credit",
      money: { ...row.money.asset, raw: row.money.raw },
      finality: "finalized",
      canonical: true,
      observedAt: now,
      reorgedAt: null,
      replacementForTransferId: null,
      refundReceipt: row.identity,
      refundCompletionProofs: row.completionProofs,
      destinationAddress: row.destinationAddress,
      nativeDestinationDex: row.nativeDestinationDex,
    })),
    reservations: [{ mode: "subtract_available", state: "active" }],
    consumer: { required: false, completed: false, unresolved: false },
    receive: null,
    now,
  };
}

test("refund contract is immutable opt-in; malformed markers never downgrade to legacy", () => {
  assert.equal(readFundingRefundContract({}), null);
  for (const marker of [
    null,
    false,
    {},
    "relay_exact_refund_receipts_v2",
    undefined,
  ]) {
    const invalid = readFundingRefundContract(
      { ...snapshot, refundEvidenceContract: marker },
      requestBinding,
    );
    assert.equal(invalid?.supported, false);
    assert.equal(
      fundingRefundReceiptSetComplete(required(invalid), receipts()),
      false,
    );
  }
  assert.equal(contract.supported, true);
  assert.equal(
    readFundingRefundContract(
      {
        ...snapshot,
        alternativeRefundLocations: { version: 1, locations: [snapshot] },
      },
      requestBinding,
    )?.supported,
    false,
  );
  assert.equal(
    readFundingRefundContract(
      { ...snapshot, details: { ...snapshot.details, nativeSourceDex: null } },
      requestBinding,
    )?.supported,
    false,
  );
  assert.equal(readFundingRefundContract(snapshot)?.supported, false);
});

test("full returned amount, not the pre-fee source nominal, completes exact canonical set", () => {
  assert.equal(fundingRefundReceiptSetComplete(contract, receipts()), true);
  const projection = deriveFundingLifecycle(facts());
  assert.equal(projection.status, "refunded");
  assert.equal(projection.safety.terminal, true);
});

test("final partial receipt remains refunding and recovers when all receipts and proof arrive", () => {
  const partial = deriveFundingLifecycle(facts(receipts().slice(0, 1)));
  assert.equal(partial.status, "reconcile_required");
  assert.equal(partial.progressStage, "refunding");
  assert.equal(partial.safety.terminal, false);
  assert.equal(partial.safety.cancelAllowed, false);
  assert.equal(partial.safety.reservationsMayRelease, false);
  assert.equal(partial.segments[0]?.status, "settling");
  assert.equal(deriveFundingLifecycle(facts()).status, "refunded");
});

test("matching total without completion proof is not provider settlement", () => {
  const rows = receipts().map((row) => ({ ...row, completionProofs: [] }));
  assert.equal(fundingRefundReceiptSetComplete(contract, rows), false);
  assert.equal(deriveFundingLifecycle(facts(rows)).safety.terminal, false);
});

for (const [label, change] of [
  [
    "wrong amount",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      money: { ...row.money, raw: "580000001" },
    }),
  ],
  [
    "wrong decimals",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      money: { ...row.money, asset: { ...asset, decimals: 6 } },
    }),
  ],
  [
    "wrong asset",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      money: { ...row.money, asset: { ...asset, assetId: "other" } },
    }),
  ],
  [
    "wrong owner",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      destinationAddress: `0x${"b".repeat(40)}`,
    }),
  ],
  [
    "wrong request",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      identity: { ...receiptIdentity, requestFingerprint: "b".repeat(64) },
    }),
  ],
  [
    "wrong key version",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      identity: { ...receiptIdentity, lookupKeyVersion: 4 },
    }),
  ],
  [
    "wrong order",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      identity: { ...receiptIdentity, protocolOrderId: `0x${"c".repeat(64)}` },
    }),
  ],
  [
    "wrong location",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      identity: { ...receiptIdentity, refundLocationId: "native-spot" },
    }),
  ],
  [
    "wrong DEX",
    (row: FundingRefundSettledReceipt) => ({
      ...row,
      nativeDestinationDex: "spot" as const,
    }),
  ],
  [
    "missing identity",
    (row: FundingRefundSettledReceipt) => ({ ...row, identity: null }),
  ],
] as const)
  test(`exact refund completion rejects ${label}`, () => {
    const rows = receipts();
    rows[1] = change(required(rows[1]));
    assert.equal(fundingRefundReceiptSetComplete(contract, rows), false);
  });

test("old proof cannot hide a new canonical refund, duplicate ID, or missing anchor", () => {
  const rows = receipts();
  assert.equal(
    fundingRefundReceiptSetComplete(contract, [
      ...rows,
      { ...required(rows[1]), observationId: thirdId },
    ]),
    false,
  );
  assert.equal(
    fundingRefundReceiptSetComplete(contract, [...rows, required(rows[1])]),
    false,
  );
  rows[0] = {
    ...required(rows[0]),
    completionProofs: [{ ...proof, observationIds: [secondId, secondId] }],
  };
  assert.equal(fundingRefundReceiptSetComplete(contract, rows), false);
});

test("append-only proof map accepts a later exact set without changing original proof", () => {
  const rows = receipts();
  rows[0] = {
    ...required(rows[0]),
    completionProofs: readFundingRefundCompletionProofs({
      ["a".repeat(64)]: { ...proof, observationIds: [firstId, thirdId] },
      ["b".repeat(64)]: proof,
    }),
  };
  assert.equal(fundingRefundReceiptSetComplete(contract, rows), true);
  for (const value of [
    null,
    true,
    [],
    { invalid: proof },
    { ["a".repeat(64)]: { ...proof, expectedReturned: { asset, raw: "-1" } } },
  ])
    assert.deepEqual(readFundingRefundCompletionProofs(value), []);
  assert.equal(
    readFundingRefundReceiptIdentity({ ...receiptIdentity, version: 2 }),
    null,
  );
});

test("internally consistent receipts from another request cannot complete this frozen leg", () => {
  for (const binding of [
    { ...requestBinding, requestFingerprint: "b".repeat(64) },
    { ...requestBinding, lookupKeyVersion: 4 },
    { ...requestBinding, protocolOrderId: `0x${"c".repeat(64)}` },
  ]) {
    const rows = receipts().map((row) => ({
      ...row,
      identity: { ...receiptIdentity, ...binding },
      completionProofs: row.completionProofs.map((item) => ({
        ...item,
        ...binding,
      })),
    }));
    assert.equal(fundingRefundReceiptSetComplete(contract, rows), false);
  }
});

test("native token and owner casing are semantic, physical DEX is not", () => {
  const rows = receipts().map((row) => ({
    ...row,
    destinationAddress: `0x${"A".repeat(40)}`,
    money: {
      ...row.money,
      asset: { ...asset, assetId: `0x${asset.assetId.slice(2).toUpperCase()}` },
    },
  }));
  assert.equal(fundingRefundReceiptSetComplete(contract, rows), true);
});

test("legacy route retains one-final-refund semantics; a marked route cannot borrow a sibling proof", () => {
  const legacy = facts(receipts().slice(0, 1));
  const legacyPlan = {
    ...legacy.plan,
    routeLegs: legacy.plan.routeLegs.map((leg) => ({
      ...leg,
      refundContract: null,
    })),
  };
  assert.equal(
    deriveFundingLifecycle({ ...legacy, plan: legacyPlan }).status,
    "refunded",
  );
  const full = facts();
  const split = {
    ...full,
    transfers: full.transfers.map((transfer, index) =>
      index ? { ...transfer, routeLegId: "another-leg" } : transfer,
    ),
  };
  assert.notEqual(deriveFundingLifecycle(split).status, "refunded");
});

test("a reorged member invalidates completion and cannot be hidden by a complete-looking proof", () => {
  const full = facts();
  const reorged = {
    ...full,
    transfers: full.transfers.map((row, index) =>
      index
        ? {
            ...row,
            canonical: false,
            finality: "reorged" as const,
            reorgedAt: full.now,
          }
        : row,
    ),
  };
  assert.equal(deriveFundingLifecycle(reorged).status, "recovery_required");
  assert.equal(deriveFundingLifecycle(reorged).safety.terminal, false);
});
