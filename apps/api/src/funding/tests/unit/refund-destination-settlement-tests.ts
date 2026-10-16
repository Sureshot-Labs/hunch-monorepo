import assert from "node:assert/strict";
import { test } from "node:test";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import {
  readRefundNativeDestination,
  refundDestinationObservationMatches,
  type RefundDestinationObservation,
} from "../../reconciliation/relay-refund-destination-settlement.js";

const owner = `0x${"ab".repeat(20)}`;
const location = {
  kind: "venue_account",
  accountId: "owner-fixture",
  locationId: "native-spot",
  asset: HYPERCORE_MAINNET_USDC,
  details: {
    venueId: "hyperliquid",
    environment: "mainnet",
    address: owner,
    nativeSourceDex: "spot",
  },
};
const input = {
  userId: "owner-fixture",
  destination: { kind: "owned_location", location },
  minimum: { asset: HYPERCORE_MAINNET_USDC, raw: "980000000" },
};
const receipt: RefundDestinationObservation = {
  id: "receipt",
  network_id: HYPERCORE_MAINNET_USDC.networkId,
  asset_id: HYPERCORE_MAINNET_USDC.assetId,
  asset_decimals: 8,
  tx_hash: `0x${"11".repeat(32)}`,
  event_index: "hypercore:send:destination_credit",
  from_address: `0x${"cd".repeat(20)}`,
  to_address: owner,
  raw_amount: "980000000",
  ledger_height: null,
  block_hash: null,
  native_destination_dex: "spot",
  observer_id: "relay_owned_destination_observation_v1",
};

test("native successful-settlement target is exact owned asset, DEX and frozen minimum", () => {
  assert.ok(readRefundNativeDestination(input));
  for (const changed of [
    { ...input, userId: "other" },
    { ...input, minimum: { ...input.minimum, raw: "0" } },
    { ...input, minimum: { ...input.minimum, raw: "1".repeat(79) } },
    {
      ...input,
      minimum: {
        asset: { ...HYPERCORE_MAINNET_USDC, decimals: 6 },
        raw: "9800000",
      },
    },
    { ...input, destination: { kind: "external", location } },
    {
      ...input,
      destination: {
        kind: "owned_location",
        location: {
          ...location,
          details: {
            ...location.details,
            nativeSourceDex: "spot",
            balanceClass: "perp",
          },
        },
      },
    },
    {
      ...input,
      destination: {
        kind: "owned_location",
        location: {
          ...location,
          details: { ...location.details, environment: "testnet" },
        },
      },
    },
  ])
    assert.equal(readRefundNativeDestination(changed), null);
});

test("physical native credit excludes balance deltas and mismatched receipt identity", () => {
  const target = readRefundNativeDestination(input);
  assert.ok(target);
  assert.equal(refundDestinationObservationMatches(target, receipt), true);
  for (const patch of [
    { tx_hash: "owned-route:balance-delta" },
    { event_index: "owned-route:delta" },
    { network_id: "hyperliquid:testnet" },
    { asset_decimals: 6 },
    { asset_id: `0x${"00".repeat(16)}` },
    { to_address: `0x${"cd".repeat(20)}` },
    { native_destination_dex: "" },
    { from_address: null },
    { ledger_height: "10" },
    { block_hash: "0xblock" },
    { observer_id: "unknown" },
    { raw_amount: "0" },
    { raw_amount: "1.5" },
  ])
    assert.equal(
      refundDestinationObservationMatches(target, { ...receipt, ...patch }),
      false,
    );
});
