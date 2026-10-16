import assert from "node:assert/strict";
import { test } from "node:test";
import { committedFundingReadLocationAlias } from "../../../account-value/funding-read-location-identity.js";
import {
  canonicalLocationKey,
  hypercorePerpsRefundLocation,
  hypercoreSpotAccountLocation,
  stableOpaqueId,
  stableWalletAssetLocationIdentity,
  stableVenueAssetLocationId,
} from "../../../account-value/canonical.js";
import {
  fundingInvalidSourceComponentIds,
  fundingInvalidatedRefundComponentIds,
  fundingRefundSnapshotLagOperations,
  loadFundingAccountValueFacts,
  applyFundingSourceDebitSuppression,
} from "../../../account-value/funding-movement-feed.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../domain/refund-settlement.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type {
  AssetLocation,
  ValuedAssetComponent,
} from "../../domain/types.js";

const original = "original-owner",
  current = "current-owner";
const identity = {
  originalEconomicAccountId: original,
  currentOwnerUserId: current,
};
const address = `0x${"ab".repeat(20)}`;
const asset = {
  networkId: "evm:8453",
  assetId: `0x${"cd".repeat(20)}`,
  decimals: 6,
};
const wallet = (accountId: string): AssetLocation => ({
  kind: "wallet",
  accountId,
  asset,
  locationId: stableWalletAssetLocationIdentity({
    accountId,
    address,
    asset,
    balanceClass: "",
  }).locationId,
  details: { address },
});
const component = (
  location: AssetLocation,
  observedAt = "2026-10-16T10:00:00Z",
) =>
  ({
    componentId: stableOpaqueId("asset", canonicalLocationKey(location)),
    location,
    amount: { asset: location.asset, raw: "100000000" },
    observedAt,
    observationFreshness: "fresh",
    observationError: null,
  }) as ValuedAssetComponent;

test("bad refund ownership plus missing reservation does not erase the independently owned source fence", async () => {
  for (const originalAccountId of [current, original]) {
    const sourceAsset = {
      ...asset,
      assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    };
    const source = {
      ...wallet(originalAccountId),
      asset: sourceAsset,
      locationId: stableWalletAssetLocationIdentity({
        accountId: originalAccountId,
        address,
        asset: sourceAsset,
        balanceClass: "",
      }).locationId,
    };
    const row = {
      operation_id: "operation",
      segment_id: "segment",
      source_component_id: null,
      source_location_id: null,
      network_id: sourceAsset.networkId,
      asset_id: sourceAsset.assetId,
      asset_decimals: 6,
      raw_amount: "10000000",
      observed_at: new Date("2026-10-16T10:00:01Z"),
      operation_source_snapshot: { kind: "owned_location", location: source },
      committed_source: { kind: "owned_location", location: source },
      committed_input: { asset: sourceAsset, raw: "10000000" },
      source_network_count: "1",
      source_asset_count: "1",
      source_decimal_count: "1",
      source_actual_decimals: 6,
      source_owner_count: "1",
      source_owner_complete: true,
      source_owner_address: address,
      reservation_component_id: null,
      reservation_location_id: null,
      refund_location_snapshot: {
        ...source,
        accountId: "foreign-refund-owner",
        refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
        relayProtocolOrderId: `0x${"a".repeat(64)}`,
      },
      provider_quote_ref_lookup_hmac: "b".repeat(64),
      lookup_key_version: 1,
      refund_receipts: [],
    };
    const db = {
      query: async (sql: string) => ({
        rows: sql.includes("to_regclass")
          ? [{ ready: true }]
          : sql.includes("with owned_operations as materialized")
            ? [row]
            : [],
      }),
    };
    const facts = await loadFundingAccountValueFacts(db as never, current);
    assert.equal(facts.inTransit.length, 1);
    assert.equal(
      facts.inTransit[0].observationError,
      "funding_source_evidence_invalid",
    );
    assert.deepEqual(facts.inTransit[0].committedSourceLocation, source);
    const currentSource = {
      ...source,
      accountId: current,
      locationId: stableWalletAssetLocationIdentity({
        accountId: current,
        address,
        asset: sourceAsset,
        balanceClass: "",
      }).locationId,
    };
    const stale = component(currentSource);
    assert.deepEqual(
      [...fundingInvalidSourceComponentIds(current, facts.inTransit, [stale])],
      [stale.componentId],
    );
    assert.equal(
      fundingInvalidSourceComponentIds(current, facts.inTransit, [
        component(currentSource, "2026-10-16T10:00:02Z"),
      ]).size,
      0,
    );
  }
});

test("read aliases regenerate only canonical identities and never rewrite original snapshots", () => {
  for (const location of [
    wallet(original),
    hypercoreSpotAccountLocation({
      accountId: original,
      address,
      controllerWalletId: "controller",
    }).location,
    hypercorePerpsRefundLocation({
      accountId: original,
      address,
      controllerWalletId: "controller",
    }),
  ]) {
    const snapshot = JSON.stringify(location);
    const alias = committedFundingReadLocationAlias(location, identity);
    assert.ok(alias);
    assert.equal(alias.originalLocation, location);
    assert.equal(alias.currentLocation.accountId, current);
    assert.notEqual(alias.currentLocation.locationId, location.locationId);
    assert.notEqual(alias.currentComponentId, alias.originalComponentId);
    const onward = committedFundingReadLocationAlias(location, {
      ...identity,
      currentOwnerUserId: "third-owner",
    });
    assert.ok(onward);
    assert.equal(onward.originalLocation.accountId, original);
    assert.equal(onward.currentLocation.accountId, "third-owner");
    assert.equal(JSON.stringify(location), snapshot);
  }
});

test("arbitrary ID, synthetic handoff alias, wrong original subject and native spot/perps mismatch are not merge authority", () => {
  const source = wallet(original);
  const native = hypercoreSpotAccountLocation({
    accountId: original,
    address,
    controllerWalletId: "controller",
  }).location;
  for (const location of [
    { ...source, locationId: "legacy-arbitrary" },
    {
      ...source,
      details: { ...source.details, balanceLocationId: "original-venue" },
    },
    { ...source, accountId: "foreign" },
    { ...source, kind: "venue_account" },
    { ...native, details: { ...native.details, nativeSourceDex: "" } },
    { ...native, asset: { ...native.asset, decimals: 6 } },
    { ...native, asset: { ...native.asset, networkId: "hyperliquid:testnet" } },
    { ...native, details: { ...native.details, balanceClass: "perp" } },
  ])
    assert.equal(committedFundingReadLocationAlias(location, identity), null);
});

test("canonical Polymarket funder rebasing is read-only and does not alias its controller", () => {
  for (const assetId of [
    RELAY_PINNED_ASSETS.polygonPusd,
    RELAY_PINNED_ASSETS.polygonUsdce,
    RELAY_PINNED_ASSETS.polygonUsdc,
  ]) {
    const asset = { networkId: "evm:137", assetId, decimals: 6 };
    const source: AssetLocation = {
      kind: "venue_account",
      accountId: original,
      asset,
      locationId: stableVenueAssetLocationId({
        accountId: original,
        address,
        asset,
      }),
      details: { address, venueId: "polymarket", balanceClass: "polymarket" },
    };
    const alias = committedFundingReadLocationAlias(source, identity);
    assert.ok(alias);
    assert.equal(
      alias.currentLocation.locationId,
      stableVenueAssetLocationId({ accountId: current, address, asset }),
    );
    assert.equal(alias.originalLocation, source);
    for (const invalid of [
      { ...source, locationId: "arbitrary-venue-id" },
      {
        ...source,
        details: { ...source.details, balanceLocationId: "controller" },
      },
      { ...source, details: { ...source.details, venueId: "limitless" } },
      { ...source, details: { ...source.details, balanceClass: "wallet" } },
      { ...source, asset: { ...asset, decimals: 8 } },
      { ...source, asset: { ...asset, assetId: `0x${"ff".repeat(20)}` } },
    ])
      assert.equal(committedFundingReadLocationAlias(invalid, identity), null);
  }
});

test("validated current read alias fences only the current owned physical source and normal refresh recovers", () => {
  const source = wallet(original);
  const alias = committedFundingReadLocationAlias(source, identity);
  assert.ok(alias);
  const currentComponent = component(alias.currentLocation);
  const fact = {
    operationId: "operation",
    segmentId: "segment",
    sourceComponentId: alias.currentComponentId,
    sourceLocationId: alias.currentLocation.locationId,
    committedSourceLocation: source,
    currentReadSourceLocation: alias.currentLocation,
    amount: { asset, raw: "10000000" },
    observedAt: "2026-10-16T10:00:01Z",
    observationError: "funding_source_evidence_invalid",
  };
  assert.deepEqual(
    [
      ...fundingInvalidSourceComponentIds(
        current,
        [fact],
        [
          currentComponent,
          component(wallet("unrelated-owner")),
          component({
            ...alias.currentLocation,
            locationId: "unrelated-location",
          }),
        ],
      ),
    ],
    [currentComponent.componentId],
  );
  assert.equal(
    fundingInvalidSourceComponentIds(
      current,
      [fact],
      [component(alias.currentLocation, "2026-10-16T10:00:02Z")],
    ).size,
    0,
  );
  assert.equal(source.accountId, original);
});

test("SQL-bound physical snapshot ordering survives sub-millisecond PG evidence and never leaks to a newer snapshot", () => {
  const source = component(wallet(current));
  const observedAt = source.observedAt;
  const fact = {
    operationId: "operation",
    segmentId: "segment",
    sourceComponentId: source.componentId,
    sourceLocationId: source.location.locationId,
    amount: { asset, raw: "10000000" },
    observedAt,
    sourceSnapshotObservedAt: observedAt,
  };
  assert.equal(
    applyFundingSourceDebitSuppression([source], [fact])[0].amount.raw,
    "90000000",
  );
  const pending = {
    ...fact,
    amount: { asset, raw: "0" },
    observationError: "funding_handoff_snapshot_pending",
  };
  assert.deepEqual(
    [...fundingInvalidSourceComponentIds(current, [pending], [source])],
    [source.componentId],
  );
  const refreshed = component(source.location, "2026-10-16T10:00:00.001Z");
  assert.equal(
    applyFundingSourceDebitSuppression([refreshed], [fact])[0].amount.raw,
    "100000000",
  );
  assert.equal(
    fundingInvalidSourceComponentIds(current, [pending], [refreshed]).size,
    0,
  );
});

test("canonical native aliases keep refund lag and reorg recovery distinct from perps and foreign cash", () => {
  const spot = hypercoreSpotAccountLocation({
    accountId: original,
    address,
    controllerWalletId: "controller",
  }).location;
  const alias = committedFundingReadLocationAlias(spot, identity);
  assert.ok(alias);
  const stale = component(alias.currentLocation);
  const change = {
    operationId: "operation",
    locationId: alias.currentLocation.locationId,
    asset: spot.asset,
    observedAt: "2026-10-16T10:00:01Z",
    invalidated: true,
    nativeDestinationDex: "spot" as const,
  };
  const perps = component(
    hypercorePerpsRefundLocation({
      accountId: current,
      address,
      controllerWalletId: "controller",
    }),
  );
  assert.deepEqual(
    [...fundingInvalidatedRefundComponentIds([change], [stale, perps])],
    [stale.componentId],
  );
  assert.deepEqual(
    [...fundingRefundSnapshotLagOperations([change], [stale, perps])],
    ["operation"],
  );
  const fresh = component(alias.currentLocation, "2026-10-16T10:00:02Z");
  assert.equal(fundingInvalidatedRefundComponentIds([change], [fresh]).size, 0);
  assert.equal(fundingRefundSnapshotLagOperations([change], [fresh]).size, 0);
});
