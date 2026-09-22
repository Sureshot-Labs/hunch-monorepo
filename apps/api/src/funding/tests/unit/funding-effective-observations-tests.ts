import assert from "node:assert/strict";
import {
  effectiveFundingObservations,
  type FundingObservationRow,
} from "../../persistence/funding-operation-repository.js";
const synthetic: FundingObservationRow = {
  id: "synthetic",
  operationId: "operation",
  segmentId: "lane",
  kind: "destination_credit",
  networkId: "evm:8453",
  assetId: "usdc",
  assetDecimals: 6,
  txHash: "owned-route:operation:revision",
  eventIndex: "0",
  fromAddress: null,
  toAddress: "wallet",
  rawAmount: "500000",
  observedAt: new Date(),
  ledgerHeight: null,
  blockHash: null,
  finalityStatus: "finalized",
  canonical: true,
  reorgedAt: null,
  finalizedAt: new Date(),
  metadata: { observerId: "relay_owned_destination_observation_v1" },
};
const exact: FundingObservationRow = {
  ...synthetic,
  id: "exact",
  txHash: `0x${"1".repeat(64)}`,
  rawAmount: "505051",
  metadata: { ...synthetic.metadata, relayTransactionReferenceMatched: true },
};
assert.deepEqual(effectiveFundingObservations([synthetic, exact]), [exact]);
assert.deepEqual(effectiveFundingObservations([exact, synthetic]), [exact]);
assert.deepEqual(effectiveFundingObservations([synthetic]), [synthetic]);
for (const unrelated of [
  { ...exact, segmentId: "other" },
  { ...exact, operationId: "other" },
  { ...exact, toAddress: "other" },
  { ...exact, assetId: "other" },
  { ...exact, networkId: "evm:137" },
  {
    ...exact,
    metadata: { observerId: "other", relayTransactionReferenceMatched: true },
  },
  { ...exact, canonical: false, finalityStatus: "reorged" as const },
])
  assert.equal(effectiveFundingObservations([synthetic, unrelated]).length, 2);
const second = { ...exact, id: "second", txHash: `0x${"2".repeat(64)}` };
const solanaSynthetic = { ...synthetic, networkId: "solana:mainnet" };
const solanaExact = {
  ...exact,
  networkId: "solana:mainnet",
  txHash: "3".repeat(88),
};
assert.deepEqual(effectiveFundingObservations([solanaSynthetic, solanaExact]), [
  solanaExact,
]);
assert.deepEqual(effectiveFundingObservations([synthetic, exact, second]), [
  exact,
  second,
]);
assert.deepEqual(
  effectiveFundingObservations([synthetic, { ...exact, rawAmount: "1" }]),
  [{ ...exact, rawAmount: "1" }],
  "partial exact evidence must not add to the aggregate estimate",
);
