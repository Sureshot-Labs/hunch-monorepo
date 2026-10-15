import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relayRefundLocation,
  relayRefundLocationSnapshot,
} from "./operation-plan.js";
import { HYPERCORE_MAINNET_USDC } from "../../funding/domain/hypercore-identity.js";
import type { AssetLocation } from "../../funding/domain/types.js";
import { BASE_USDC } from "./rehearsal.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../funding/domain/refund-settlement.js";

function example() {
  const sourceLocation: AssetLocation = {
    kind: "venue_account",
    locationId: "owned-spot",
    accountId: "owner",
    asset: HYPERCORE_MAINNET_USDC,
    details: {
      venueId: "hyperliquid",
      environment: "mainnet",
      balanceClass: "spot",
      address: `0x${"a".repeat(40)}`,
      controllerWalletId: "controller",
    },
  };
  const nativeRefundLocation: AssetLocation = {
    ...sourceLocation,
    locationId: "owned-perps",
    details: { ...sourceLocation.details, balanceClass: "perp" },
  };
  return {
    sourceLocation,
    nativeRefundLocation,
    sourceAmount: { asset: HYPERCORE_MAINNET_USDC, raw: "1000000000" },
  };
}
test("native spot refund seals a distinct owned perps location", () => {
  const input = example();
  assert.equal(relayRefundLocation(input), input.nativeRefundLocation);
  assert.throws(
    () => relayRefundLocation({ ...input, nativeRefundLocation: undefined }),
    /exact owned perps/,
  );
});
test("native perps source can refund to its own physical location", () => {
  const input = example();
  assert.equal(
    relayRefundLocation({
      ...input,
      sourceLocation: input.nativeRefundLocation,
    }),
    input.nativeRefundLocation,
  );
});
test("refund identity rejects another owner, class, token, decimals, network or controller", () => {
  for (const refund of [
    { ...example().nativeRefundLocation, accountId: "other" },
    {
      ...example().nativeRefundLocation,
      asset: { ...HYPERCORE_MAINNET_USDC, networkId: "hyperliquid:testnet" },
    },
    {
      ...example().nativeRefundLocation,
      asset: { ...HYPERCORE_MAINNET_USDC, decimals: 6 },
    },
    {
      ...example().nativeRefundLocation,
      asset: { ...HYPERCORE_MAINNET_USDC, assetId: `0x${"0".repeat(32)}` },
    },
    { ...example().nativeRefundLocation, locationId: "owned-spot" },
    ...["spot", null].map((balanceClass) => ({
      ...example().nativeRefundLocation,
      details: { ...example().nativeRefundLocation.details, balanceClass },
    })),
    {
      ...example().nativeRefundLocation,
      details: {
        ...example().nativeRefundLocation.details,
        address: `0x${"b".repeat(40)}`,
      },
    },
    {
      ...example().nativeRefundLocation,
      details: {
        ...example().nativeRefundLocation.details,
        controllerWalletId: "other",
      },
    },
  ])
    assert.throws(
      () => relayRefundLocation({ ...example(), nativeRefundLocation: refund }),
      /exact owned perps/,
    );
  const input = example();
  assert.throws(
    () =>
      relayRefundLocation({
        ...input,
        sourceLocation: {
          ...input.sourceLocation,
          details: { ...input.sourceLocation.details, address: "bad" },
        },
        nativeRefundLocation: {
          ...input.nativeRefundLocation,
          details: { ...input.nativeRefundLocation.details, address: "bad" },
        },
      }),
    /exact owned perps/,
  );
});
test("EVM and Solana plans keep their original refund source unchanged", () => {
  for (const networkId of ["evm:8453", "solana:mainnet"]) {
    const base = example();
    const asset = { ...base.sourceAmount.asset, networkId };
    const sourceLocation = { ...base.sourceLocation, asset };
    const sourceAmount = { asset, raw: "1000000" };
    assert.equal(
      relayRefundLocation({ sourceLocation, sourceAmount }),
      sourceLocation,
    );
    assert.throws(
      () => relayRefundLocation({ ...base, sourceLocation, sourceAmount }),
      /non-native/,
    );
  }
});

function inboundExample() {
  const native = example();
  const sourceLocation: AssetLocation = {
    kind: "wallet",
    accountId: "owner",
    locationId: "evm-source",
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    details: {
      address: `0x${"b".repeat(40)}`,
      walletId: "different-evm-controller",
    },
  };
  return {
    sourceLocation,
    sourceAmount: { asset: sourceLocation.asset, raw: "10000000" },
    destination: {
      target: {
        kind: "owned_location" as const,
        location: native.sourceLocation,
      },
    },
    minimumOutput: { asset: native.sourceLocation.asset, raw: "860341800" },
    nativeRefundLocation: native.nativeRefundLocation,
    routeShape: "relay-depository-v2-hypercore",
  };
}

test("inbound immutable refund snapshot preserves EVM primary and distinct recipient perps alternative", () => {
  const input = inboundExample();
  const snapshot = relayRefundLocationSnapshot(input);
  assert.equal(snapshot.refundEvidenceContract, EXACT_REFUND_RECEIPTS_CONTRACT);
  assert.equal(snapshot.locationId, input.sourceLocation.locationId);
  assert.deepEqual(snapshot.asset, input.sourceAmount.asset);
  assert.deepEqual(snapshot.alternativeRefundLocations, {
    version: 1,
    locations: [input.nativeRefundLocation],
  });
  assert.notEqual(
    snapshot.alternativeRefundLocations?.locations[0],
    input.nativeRefundLocation,
  );
  assert.equal(
    snapshot.alternativeRefundLocations?.locations[0]?.details
      .controllerWalletId,
    "controller",
  );
  assert.equal(snapshot.details.walletId, "different-evm-controller");
  assert.equal(
    (input.sourceLocation as Record<string, unknown>)
      .alternativeRefundLocations,
    undefined,
  );
});

test("only new native plans opt in to exact refund completion", () => {
  const inbound = inboundExample();
  const native = example();
  const outbound = relayRefundLocationSnapshot({
    ...native,
    destination: {
      target: { kind: "owned_location", location: inbound.sourceLocation },
    },
    minimumOutput: { asset: inbound.sourceLocation.asset, raw: "9000000" },
    routeShape: "relay-hypercore-spot",
  });
  assert.equal(outbound.refundEvidenceContract, EXACT_REFUND_RECEIPTS_CONTRACT);
  assert.equal(outbound.locationId, native.nativeRefundLocation.locationId);
  const legacy = relayRefundLocationSnapshot({
    ...inbound,
    nativeRefundLocation: undefined,
    minimumOutput: { asset: inbound.sourceLocation.asset, raw: "9000000" },
  });
  assert.equal(legacy, inbound.sourceLocation);
  assert.equal(legacy.refundEvidenceContract, undefined);
});

test("inbound alternative refund cannot borrow another source/account/controller/asset or spot credit", () => {
  const input = inboundExample();
  for (const changed of [
    { ...input, nativeRefundLocation: undefined },
    { ...input, routeShape: "relay-depository-v2-erc20" },
    {
      ...input,
      sourceLocation: { ...input.sourceLocation, accountId: "other-user" },
    },
    {
      ...input,
      sourceLocation: { ...input.sourceLocation, kind: "venue_account" },
    },
    {
      ...input,
      minimumOutput: {
        ...input.minimumOutput,
        asset: { ...HYPERCORE_MAINNET_USDC, decimals: 6 },
      },
    },
    { ...input, nativeRefundLocation: input.destination.target.location },
    {
      ...input,
      nativeRefundLocation: {
        ...input.nativeRefundLocation,
        details: {
          ...input.nativeRefundLocation.details,
          controllerWalletId: "different-evm-controller",
        },
      },
    },
    {
      ...input,
      nativeRefundLocation: {
        ...input.nativeRefundLocation,
        details: {
          ...input.nativeRefundLocation.details,
          address: input.sourceLocation.details.address,
        },
      },
    },
  ])
    assert.throws(() => relayRefundLocationSnapshot(changed));
});
