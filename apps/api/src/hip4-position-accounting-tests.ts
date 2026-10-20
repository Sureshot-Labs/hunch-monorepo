import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHip4PositionBasis } from "./services/hip4-position-accounting.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  hip4BasisLedgerEvidenceKey,
  hip4ProvenCashLedgerEntries,
} from "./services/hip4-cash-ledger-evidence.js";

const buy = {
  coin: "#87750",
  px: "0.4",
  sz: "10",
  side: "B",
  time: 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "999",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  tid: 1,
  crossed: true,
  fee: "0.1",
  feeToken: "USDC",
  builderFee: "0.05",
};
const second = {
  ...buy,
  oid: 2,
  tid: 2,
  time: 2000,
  startPosition: "10",
  px: "0.6",
};
const sale = {
  ...buy,
  oid: 3,
  tid: 3,
  time: 3000,
  dir: "Sell",
  side: "A",
  startPosition: "20",
  sz: "5",
  px: "0.8",
  fee: "0.05",
};
const input = {
  positions: [{ coin: "+87750", quantity: "15" }],
  fills: [buy, second, sale],
  ledger: [],
  quoteLedgerToken: "USDC:exact-quote-id",
  observedTime: 4000,
  coveredFrom: 0,
  coveredThrough: 4000,
  gaps: [],
  incomplete: false,
};
test("zero-anchor weighted basis retains exact buy fees, releases partial basis and never adds builder fee twice", () => {
  const result = projectHip4PositionBasis(input)[0];
  assert.equal(result.reason, "verified");
  assert.equal(result.costBasis, "7.65");
  assert.equal(result.realizedSinceAnchor, "1.4");
  assert.equal(result.anchorTime, 1000);
  assert.deepEqual(
    projectHip4PositionBasis({ ...input, fills: [...input.fills, buy] }),
    [result],
  );
  assert.deepEqual(
    projectHip4PositionBasis({
      ...input,
      fills: [...input.fills, { ...buy, px: "0.400", sz: "10.00000" }],
    }),
    [result],
  );
});
test("tied timestamps use startPosition chain and ambiguous aliases never inflate financial totals", () => {
  const sameTime = { ...second, time: buy.time };
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [sameTime, buy, sale] })[0]
      .costBasis,
    "7.65",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [buy, { ...buy, tid: 99 }] })[0]
      .reason,
    "ambiguous_execution_sequence",
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      positions: [{ coin: "+87750", quantity: "10" }],
      fills: [buy, { ...buy, px: "0.9" }],
    })[0].reason,
    "execution_identity_conflict",
  );
});
test("settlement uses fractional actual proceeds, while missing valuation is not handled by the ledger", () => {
  const result = projectHip4PositionBasis({
    ...input,
    fills: [buy, second, { ...sale, dir: "Settlement", px: "0.25" }],
  })[0];
  assert.equal(result.costBasis, "7.65");
  assert.equal(result.realizedSinceAnchor, "-1.35");
});
test("merge, negate, expansion, transfers and unproven fees stay unknown, recoverable after a new zero anchor", () => {
  for (const dir of [
    "Merge Outcome",
    "Split Outcome",
    "Negate Outcome",
    "Expansion",
    "New Kind",
  ]) {
    const result = projectHip4PositionBasis({
      ...input,
      fills: [buy, second, { ...sale, dir }],
    })[0];
    assert.equal(result.costBasis, null);
    assert.equal(result.reason, "unsupported_economic_event");
  }
  for (const delta of [
    { type: "spotTransfer", token: "+87750" },
    { type: "futureKind" },
  ]) {
    assert.equal(
      projectHip4PositionBasis({ ...input, ledger: [{ time: 2000, delta }] })[0]
        .reason,
      "unsupported_economic_event",
    );
  }
  const quoteTransfer = {
    time: 2000,
    delta: { type: "send", token: input.quoteLedgerToken },
  };
  assert.equal(
    projectHip4PositionBasis({ ...input, ledger: [quoteTransfer] })[0]
      .costBasis,
    "7.65",
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      fills: [buy, second, { ...sale, feeToken: "" }],
    })[0].reason,
    "unknown_fee_asset",
  );
  const reset = { ...buy, time: 3500, oid: 9, tid: 9, sz: "15" };
  const recovered = projectHip4PositionBasis({
    ...input,
    fills: [buy, { ...second, dir: "Negate Outcome" }, reset],
  })[0];
  assert.equal(recovered.reason, "verified");
  assert.equal(recovered.costBasis, "6.1");
  assert.equal(recovered.anchorTime, 3500);
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      fills: [reset],
      conflicts: { "#87750": 2000 },
    })[0].reason,
    "verified",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, conflicts: { "#87750": 2000 } })[0]
      .reason,
    "execution_identity_conflict",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, conflicts: { "#87751": 2000 } })[0]
      .reason,
    "verified",
  );
});
test("history gaps, missing source, provider retention and balance mismatches cannot prove a zero-cost position", () => {
  for (const partial of [
    { incomplete: true },
    { coveredFrom: null },
    { coveredThrough: 3999 },
    { coveredFrom: 1500 },
    { gaps: [2500] },
    { fills: [null] },
  ])
    assert.equal(
      projectHip4PositionBasis({ ...input, ...partial })[0].reason,
      "history_incomplete",
    );
  assert.equal(
    projectHip4PositionBasis({ ...input, gaps: [500] })[0].reason,
    "verified",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [second, sale] })[0].costBasis,
    null,
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      positions: [{ coin: "+87750", quantity: "16" }],
    })[0].reason,
    "position_mismatch",
  );
});
test("opposite side legs sharing a hash are distinct holdings, not hash-level duplicates", () => {
  const no = { ...buy, coin: "#87751", tid: 2, oid: 2, px: "0.6" };
  const results = projectHip4PositionBasis({
    ...input,
    positions: [
      { coin: "+87750", quantity: "10" },
      { coin: "+87751", quantity: "10" },
    ],
    fills: [buy, no],
  });
  assert.deepEqual(
    results.map((row) => row.costBasis),
    ["4.1", "6.1"],
  );
});

function incomingCash(index = 1, fee = "0.0") {
  const owner = `0x${"9".repeat(40)}`;
  const sender = `0x${"7".repeat(40)}`;
  const entry = {
    time: 3100 + index,
    hash: `0x${String(index).repeat(64)}`,
    delta: {
      type: "send",
      user: sender,
      destination: owner,
      sourceDex: "",
      destinationDex: "spot",
      nonce: 3000 + index,
      token: "USDC",
      amount: "0.205539",
      usdcValue: "0.205539",
      fee,
      nativeTokenFee: fee,
      feeToken: "",
    },
  };
  const feeObservation = { fee, nativeTokenFee: fee, feeToken: "" };
  const receipt = {
    network_id: HYPERCORE_MAINNET_USDC.networkId,
    asset_id: HYPERCORE_MAINNET_USDC.assetId,
    asset_decimals: 8,
    tx_hash: entry.hash,
    event_index: "hypercore:send:destination_credit",
    kind: "destination_credit",
    from_address: sender,
    to_address: owner,
    raw_amount: "20553900",
    canonical: true,
    finality_status: "finalized",
    reorged_at: null as string | null,
    metadata: {
      observerId: "relay_owned_destination_observation_v1",
      nativeEvidenceKind: "hypercore_send_ledger_v1",
      relayTransactionReferenceMatched: true,
      nativeNonce: entry.delta.nonce,
      nativeLedgerTime: entry.time,
      nativeProviderBlock: 123,
      nativeSourceDex: "",
      nativeDestinationDex: "spot",
      nativeFeeObservation: feeObservation,
      nativeEvidenceFingerprint: canonicalJsonHash({
        networkId: HYPERCORE_MAINNET_USDC.networkId,
        asset: HYPERCORE_MAINNET_USDC,
        owner,
        direction: "credit",
        transactionHash: entry.hash,
        nonce: entry.delta.nonce,
        sourceAddress: sender,
        destinationAddress: owner,
        sourceDex: "",
        destinationDex: "spot",
        rawAmount: "20553900",
        feeObservation,
        ledgerTime: entry.time,
        providerBlock: 123,
      }),
    },
  };
  const scope = {
    environment: "mainnet" as const,
    address: owner,
    assetId: HYPERCORE_MAINNET_USDC.assetId,
    decimals: 8,
  };
  return { scope, entry, receipt };
}

test("existing exact canonical destination receipts qualify bare-USDC cash only, without subtracting sender fees from basis twice", () => {
  const first = incomingCash();
  const second = incomingCash(2, "1.0"); // denomination remains unknown; recipient credit is exact
  const ledger = [first.entry, second.entry];
  const provenQuoteTransfers = hip4ProvenCashLedgerEntries({
    ...first.scope,
    ledger,
    observations: [first.receipt, second.receipt],
  });
  assert.equal(provenQuoteTransfers.size, 2);
  const result = projectHip4PositionBasis({
    ...input,
    ledger,
    provenQuoteTransfers,
  })[0];
  assert.equal(result.reason, "verified");
  assert.equal(result.costBasis, "7.65");
  assert.equal(result.realizedSinceAnchor, "1.4");
  assert.equal(
    projectHip4PositionBasis({ ...input, ledger })[0].reason,
    "unsupported_economic_event",
  );
  const conflicting = {
    ...first.entry,
    delta: { ...first.entry.delta, token: "+87750" },
  };
  assert.ok(!provenQuoteTransfers.has(hip4BasisLedgerEvidenceKey(conflicting)));
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      ledger: [conflicting],
      provenQuoteTransfers,
    })[0].reason,
    "unsupported_economic_event",
  );
});

test("bare-USDC identity stays unknown without one exact finalized owned recipient receipt and matching immutable native proof", () => {
  const { scope, entry, receipt } = incomingCash();
  const changes: ((value: typeof receipt) => void)[] = [
    (value) => {
      value.canonical = false;
    },
    (value) => {
      value.finality_status = "provisional";
    },
    (value) => {
      value.reorged_at = new Date().toISOString();
    },
    (value) => {
      value.network_id = "hyperliquid:testnet";
    },
    (value) => {
      value.asset_id = `0x${"a".repeat(32)}`;
    },
    (value) => {
      value.asset_decimals = 6;
    },
    (value) => {
      value.tx_hash = `0x${"f".repeat(64)}`;
    },
    (value) => {
      value.to_address = value.from_address;
    },
    (value) => {
      value.from_address = value.to_address;
    },
    (value) => {
      value.raw_amount = "20553901";
    },
    (value) => {
      value.event_index = "hypercore:send:source_debit";
    },
    (value) => {
      value.metadata.nativeNonce++;
    },
    (value) => {
      value.metadata.nativeLedgerTime++;
    },
    (value) => {
      value.metadata.nativeProviderBlock++;
    },
    (value) => {
      value.metadata.nativeSourceDex = "spot";
    },
    (value) => {
      value.metadata.nativeDestinationDex = "";
    },
    (value) => {
      value.metadata.relayTransactionReferenceMatched = false;
    },
    (value) => {
      value.metadata.nativeEvidenceKind = "unknown";
    },
    (value) => {
      value.metadata.nativeFeeObservation.fee = "0.1";
    },
    (value) => {
      value.metadata.nativeFeeObservation.feeToken = "USDC";
    },
    (value) => {
      value.metadata.nativeEvidenceFingerprint = "0".repeat(64);
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.equal(
      hip4ProvenCashLedgerEntries({
        ...scope,
        ledger: [entry],
        observations: [changed],
      }).size,
      0,
      change.toString(),
    );
  }
  for (const observations of [
    [],
    [receipt, receipt],
    [receipt, { ...receipt, raw_amount: "1" }],
  ])
    assert.equal(
      hip4ProvenCashLedgerEntries({ ...scope, ledger: [entry], observations })
        .size,
      0,
    );
  for (const changedScope of [
    { ...scope, environment: "testnet" as const },
    { ...scope, address: entry.delta.user }, // credit cannot prove sender debit
    { ...scope, address: `0x${"a".repeat(40)}` },
    { ...scope, decimals: 6 },
    { ...scope, assetId: `0x${"a".repeat(32)}` },
  ])
    assert.equal(
      hip4ProvenCashLedgerEntries({
        ...changedScope,
        ledger: [entry],
        observations: [receipt],
      }).size,
      0,
    );
  for (const delta of [
    { ...entry.delta, fee: "0.1" },
    { ...entry.delta, amount: "0.20553901" },
    { ...entry.delta, nonce: entry.delta.nonce + 1 },
    { ...entry.delta, token: "USDC:unknown" },
    { ...entry.delta, type: "spotTransfer" },
  ])
    assert.equal(
      hip4ProvenCashLedgerEntries({
        ...scope,
        ledger: [{ ...entry, delta }],
        observations: [receipt],
      }).size,
      0,
    );
});
