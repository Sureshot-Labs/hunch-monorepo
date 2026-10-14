import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalLocationKey,
  stableWalletOpaqueId,
} from "../../account-value/canonical.js";
import {
  canonicalAccountAddress,
  canonicalAssetId,
  isEvmNetworkId,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreFundingNetwork,
} from "../../funding/domain/hypercore-identity.js";
import {
  assertRelayPinnedAsset,
  assertRelayRouteAssets,
  isRelayPinnedStableAsset,
  networkForRelayChainId,
  normalizeRelayAccountAddress,
  normalizeRelayAssetId,
  RELAY_ROUTE_SPECS,
  relayChainIdForNetwork,
  relayRuntimeRoute,
  relayStableAssetSymbol,
  relayWalletLocationPatternId,
} from "./mappings.js";
import { normalizeRelayFees } from "./fees.js";
import { relayQuoteResponseSchema } from "./schemas.js";

const asset = HYPERCORE_MAINNET_USDC;
const owner = `0x${"Ab".repeat(20)}`;
const upperToken = `0x${asset.assetId.slice(2).toUpperCase()}`;

test("native cash preserves P2 network and cannot alias EVM or testnet", () => {
  assert.equal(asset.networkId, "hyperliquid:mainnet");
  assert.equal(networkForRelayChainId(1337), asset.networkId);
  assert.equal(relayChainIdForNetwork(asset.networkId), 1337);
  assert.equal(isEvmNetworkId(asset.networkId), false);
  for (const networkId of [
    "evm:1337",
    "evm:999",
    "hypercore:mainnet",
    "hyperliquid:testnet",
  ]) {
    assert.equal(sameAsset(asset, { ...asset, networkId }), false);
    assert.throws(() => relayChainIdForNetwork(networkId));
  }
  assert.equal(isHypercoreFundingNetwork("hyperliquid:testnet"), true);
  assert.equal(isHypercoreFundingNetwork("hyperliquid:mainnet:spot"), false);
});

test("account and currency normalization accept different native identities", () => {
  assert.equal(
    normalizeRelayAccountAddress(asset.networkId, owner),
    owner.toLowerCase(),
  );
  assert.equal(
    normalizeRelayAssetId(asset.networkId, upperToken),
    asset.assetId,
  );
  assert.equal(
    canonicalAccountAddress(asset.networkId, owner),
    owner.toLowerCase(),
  );
  assert.equal(
    canonicalAssetId({ ...asset, assetId: upperToken }),
    asset.assetId,
  );
  assert.equal(sameAsset(asset, { ...asset, assetId: upperToken }), true);
  assert.throws(() => normalizeRelayAssetId(asset.networkId, owner));
  assert.throws(() =>
    normalizeRelayAccountAddress(asset.networkId, asset.assetId),
  );
  for (const value of [` ${owner}`, owner.replace("0x", "0X"), "USDC"]) {
    assert.throws(() => normalizeRelayAccountAddress(asset.networkId, value));
    assert.equal(canonicalAccountAddress(asset.networkId, value), value);
  }
  for (const value of [
    ` ${upperToken}`,
    upperToken.replace("0x", "0X"),
    "USDC",
  ]) {
    assert.throws(() => normalizeRelayAssetId(asset.networkId, value));
    assert.equal(canonicalAssetId({ ...asset, assetId: value }), value);
  }
});

test("wallet and reservation identity fold native owners without merging DEX balances", () => {
  assert.equal(
    stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: asset.networkId,
      address: owner,
    }),
    stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: asset.networkId,
      address: owner.toLowerCase(),
    }),
  );
  const location = {
    accountId: "owner-user",
    kind: "venue_account",
    locationId: "native-location",
    asset,
    details: { address: owner },
  };
  assert.equal(
    canonicalLocationKey(location),
    canonicalLocationKey({
      ...location,
      details: { address: owner.toLowerCase() },
    }),
  );
  assert.notEqual(
    canonicalLocationKey(location),
    canonicalLocationKey({
      ...location,
      details: { address: owner, balanceClass: "perp" },
    }),
  );
  assert.notEqual(
    canonicalLocationKey(location),
    canonicalLocationKey({
      ...location,
      asset: { ...asset, networkId: "hyperliquid:testnet" },
    }),
  );
});

test("native stable classification pins token, environment and eight-decimal raw units", () => {
  assert.doesNotThrow(() => assertRelayPinnedAsset(asset));
  assert.equal(isRelayPinnedStableAsset(asset), true);
  assert.equal(relayStableAssetSymbol(asset), "USDC");
  for (const candidate of [
    { ...asset, decimals: 6 },
    { ...asset, decimals: 18 },
    { ...asset, assetId: "USDC" },
    { ...asset, assetId: `0x${"1".repeat(32)}` },
    { ...asset, networkId: "hyperliquid:testnet" },
  ]) {
    assert.equal(isRelayPinnedStableAsset(candidate), false);
    assert.throws(() => assertRelayPinnedAsset(candidate));
  }
  assert.equal(relayWalletLocationPatternId(asset), null);
});

test("native mapping cannot silently enter an existing EVM or Solana executor", () => {
  const baseRoute = RELAY_ROUTE_SPECS["base-usdc-to-polygon-pusd"];
  assert.ok(baseRoute);
  const nativeDestination = { ...baseRoute, destination: asset };
  assert.throws(
    () => assertRelayRouteAssets(nativeDestination, baseRoute.source, asset),
    /matching registered VM/,
  );
  assert.throws(
    () =>
      relayRuntimeRoute(nativeDestination, {
        sourceLocationPatternId: "source",
        destinationLocationPatternId: "destination",
      }),
    /matching registered VM/,
  );
  assert.ok(
    Object.values(RELAY_ROUTE_SPECS).every(
      (route) =>
        (!isHypercoreFundingNetwork(route.source.networkId) ||
          route.sourceVm === "hypercore") &&
        (!isHypercoreFundingNetwork(route.destination.networkId) ||
          route.destinationVm === "hypercore"),
    ),
  );
  for (const route of Object.values(RELAY_ROUTE_SPECS)) {
    assert.doesNotThrow(() =>
      assertRelayRouteAssets(route, route.source, route.destination),
    );
    if (route.destinationVm === "hypercore") {
      const runtime = relayRuntimeRoute(route, {
        sourceLocationPatternId: "source",
        destinationLocationPatternId: "destination",
      });
      assert.equal(runtime.networkExecutorId, "wallet_profile_evm_v1");
      assert.equal(runtime.actionValidatorId, "relay_evm_action_v1");
      assert.throws(() =>
        assertRelayRouteAssets(
          { ...route, destinationVm: "evm" },
          route.source,
          route.destination,
        ),
      );
    }
    if (route.sourceVm === "hypercore") {
      const runtime = relayRuntimeRoute(route, {
        sourceLocationPatternId: "source",
        destinationLocationPatternId: "destination",
      });
      assert.equal(runtime.networkExecutorId, "relay_hypercore_native_v1");
      assert.equal(runtime.actionValidatorId, "relay_hypercore_native_v1");
      assert.throws(() =>
        assertRelayRouteAssets(
          { ...route, sourceVm: "evm" },
          route.source,
          route.destination,
        ),
      );
      assert.throws(() =>
        assertRelayRouteAssets(
          { ...route, sourceVm: "svm" },
          route.source,
          route.destination,
        ),
      );
    }
  }
});

test("existing EVM checksum and Solana case handling stay unchanged", () => {
  const evm = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
  assert.equal(
    normalizeRelayAccountAddress("evm:137", evm),
    normalizeRelayAssetId("evm:137", evm),
  );
  const solana = "So11111111111111111111111111111111111111112";
  assert.equal(normalizeRelayAccountAddress("solana:mainnet", solana), solana);
  assert.equal(canonicalAccountAddress("solana:mainnet", solana), solana);
  assert.notEqual(
    canonicalAccountAddress("solana:mainnet", solana.toLowerCase()),
    solana,
  );
});

test("native relayer fees retain exact eight-decimal total, charge breakdown only once", () => {
  // Synthetic full response: the captured P0 summary omits fee currency IDs.
  const currency = { chainId: 1337, address: asset.assetId, decimals: 8 };
  const fee = (amount: string) => ({ currency, amount });
  const quote = relayQuoteResponseSchema.parse({
    steps: [
      {
        id: "test",
        kind: "transaction",
        requestId: "synthetic-request",
        items: [{ status: "incomplete", data: {} }],
      },
    ],
    details: {
      currencyIn: {
        currency,
        amount: "1000000000",
        minimumAmount: "1000000000",
      },
      currencyOut: {
        currency,
        amount: "997695500",
        minimumAmount: "990000000",
      },
    },
    fees: {
      gas: fee("0"),
      app: fee("0"),
      relayer: fee("2304500"),
      relayerGas: fee("104200"),
      relayerService: fee("2200300"),
    },
  });
  assert.deepEqual(normalizeRelayFees(quote), [
    { kind: "relayer", amount: { asset, raw: "2304500" } },
  ]);
  assert.ok(quote.fees?.relayerService && quote.fees.relayer);
  quote.fees.relayerService.amount = "2200200";
  assert.throws(
    () => normalizeRelayFees(quote),
    /breakdown does not match/,
    "rounding allowance is not silently enabled without the native route's policy",
  );
  quote.fees.relayer.currency.decimals = 6;
  assert.throws(() => normalizeRelayFees(quote), /precision is not supported/);
});
