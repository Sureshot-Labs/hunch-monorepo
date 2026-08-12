#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import {
  canonicalAccountAddress,
  canonicalAssetId,
  isEvmAddress,
  sameAccountAddress,
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
assert.equal(
  canonicalAccountAddress(
    mixedCaseEvmAsset.networkId,
    mixedCaseEvmAsset.assetId,
  ),
  mixedCaseEvmAsset.assetId.toLowerCase(),
);
assert.equal(
  sameAccountAddress(
    mixedCaseEvmAsset.networkId,
    mixedCaseEvmAsset.assetId,
    mixedCaseEvmAsset.assetId.toLowerCase(),
  ),
  true,
);
assert.equal(
  sameAccountAddress(
    mixedCaseEvmAsset.networkId,
    ` ${mixedCaseEvmAsset.assetId}`,
    mixedCaseEvmAsset.assetId,
  ),
  false,
  "whitespace-padded identifiers are malformed evidence, not aliases",
);
assert.equal(
  stableWalletOpaqueId({
    walletType: "ethereum",
    networkId: mixedCaseEvmAsset.networkId,
    address: mixedCaseEvmAsset.assetId,
  }),
  stableWalletOpaqueId({
    walletType: "ethereum",
    networkId: mixedCaseEvmAsset.networkId,
    address: mixedCaseEvmAsset.assetId.toLowerCase(),
  }),
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
  sameAccountAddress(
    solanaAsset.networkId,
    ` ${solanaAsset.assetId}`,
    solanaAsset.assetId,
  ),
  false,
);
assert.notEqual(
  stableWalletOpaqueId({
    walletType: "solana",
    networkId: solanaAsset.networkId,
    address: solanaAsset.assetId,
  }),
  stableWalletOpaqueId({
    walletType: "solana",
    networkId: solanaAsset.networkId,
    address: solanaAsset.assetId.toLowerCase(),
  }),
);

assert.equal(
  canonicalAssetId({
    networkId: "evm:137",
    assetId: "0xNotAnAddress",
    decimals: 6,
  }),
  "0xNotAnAddress",
);
const invalidUppercasePrefix = "0XC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
assert.equal(isEvmAddress(invalidUppercasePrefix), false);
assert.equal(
  sameAccountAddress(
    mixedCaseEvmAsset.networkId,
    invalidUppercasePrefix,
    invalidUppercasePrefix.toLowerCase(),
  ),
  false,
);
assert.equal(
  canonicalAssetId({
    networkId: "evm:137",
    assetId: invalidUppercasePrefix,
    decimals: 6,
  }),
  invalidUppercasePrefix,
  "malformed EVM-looking identities must not gain aliases through case folding",
);

console.log(
  "[funding-asset-identity-tests] EVM addresses fold only with valid protocol identity, Solana IDs remain byte-sensitive, and decimals are identity",
);
