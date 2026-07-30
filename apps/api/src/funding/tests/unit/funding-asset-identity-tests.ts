#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  canonicalAccountAddress,
  canonicalAssetId,
  sameAsset,
} from "../../domain/asset-identity.js";

const mixedCaseEvmAsset = {
  networkId: "evm:137",
  assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  decimals: 6,
};
assert.equal(
  canonicalAssetId(mixedCaseEvmAsset),
  mixedCaseEvmAsset.assetId.toLowerCase(),
);
assert.equal(
  sameAsset(mixedCaseEvmAsset, {
    ...mixedCaseEvmAsset,
    assetId: mixedCaseEvmAsset.assetId.toLowerCase(),
  }),
  true,
);
assert.equal(
  sameAsset(mixedCaseEvmAsset, {
    ...mixedCaseEvmAsset,
    assetId: mixedCaseEvmAsset.assetId.toLowerCase(),
    decimals: 18,
  }),
  false,
);

const solanaAsset = {
  networkId: "solana:mainnet",
  assetId: "So11111111111111111111111111111111111111112",
  decimals: 9,
};
assert.equal(
  sameAsset(solanaAsset, {
    ...solanaAsset,
    assetId: solanaAsset.assetId.toLowerCase(),
  }),
  false,
);
assert.notEqual(
  canonicalAccountAddress(solanaAsset.networkId, solanaAsset.assetId),
  solanaAsset.assetId.toLowerCase(),
);

assert.equal(
  canonicalAssetId({
    networkId: "evm:137",
    assetId: "0xNotAnAddress",
    decimals: 6,
  }),
  "0xNotAnAddress",
);

console.log(
  "[funding-asset-identity-tests] EVM addresses fold only with valid protocol identity, Solana IDs remain byte-sensitive, and decimals are identity",
);
