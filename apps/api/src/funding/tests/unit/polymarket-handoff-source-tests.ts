import assert from "node:assert/strict";
import { test } from "node:test";
import { polymarketHandoffSourceIntent } from "../../domain/polymarket-handoff-source.js";
import { stableWalletAssetLocationIdentity } from "../../../account-value/canonical.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type {
  AssetLocation,
  WalletExecutionProfile,
} from "../../domain/types.js";

const accountId = "offline-account",
  funder = `0x${"ab".repeat(20)}`,
  controller = `0x${"cd".repeat(20)}`;
const location: AssetLocation = {
  kind: "venue_account",
  accountId,
  locationId: "frozen-venue-source",
  asset: {
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonPusd,
    decimals: 6,
  },
  details: {
    address: funder,
    venueId: "polymarket",
    balanceClass: "polymarket",
  },
};
const profile: WalletExecutionProfile = {
  walletId: "controller-wallet",
  networkId: "evm:137",
  address: controller,
  source: "embedded",
  controllerWalletRef: "controller-ref",
  serverWalletRef: "offline-privy",
  signingModes: ["privy_authorization"],
  sponsorshipPolicyIds: [],
};

test("pre-route economic venue and canonical physical controller are separate even with no controller balance observation", () => {
  const saved = structuredClone(location);
  for (const token of [
    RELAY_PINNED_ASSETS.polygonPusd,
    RELAY_PINNED_ASSETS.polygonUsdce,
    RELAY_PINNED_ASSETS.polygonUsdc,
  ]) {
    const economic = {
      ...location,
      asset: { ...location.asset, assetId: token },
    };
    const result = polymarketHandoffSourceIntent({
      economicLocation: economic,
      controllerProfile: profile,
    });
    assert.ok(result);
    assert.deepEqual(result.economicSource, {
      kind: "owned_location",
      location: economic,
    });
    const canonical = stableWalletAssetLocationIdentity({
      accountId,
      address: controller,
      asset: economic.asset,
      balanceClass: "polymarket",
    });
    assert.equal(result.controllerComponentId, canonical.componentId);
    assert.equal(
      result.executionSource.location.locationId,
      canonical.locationId,
    );
    assert.notEqual(
      result.executionSource.location.locationId,
      economic.locationId,
    );
    assert.equal(
      result.executionSource.location.details.balanceLocationId,
      undefined,
    );
    assert.equal(
      result.executionSource.location.details.balanceClass,
      "polymarket",
    );
    assert.equal(result.executionSource.location.details.address, controller);
  }
  assert.deepEqual(location, saved);
});

test("handoff identity construction cannot turn an arbitrary asset/source or funder into a controller capability", () => {
  for (const economicLocation of [
    { ...location, kind: "wallet" },
    { ...location, asset: { ...location.asset, networkId: "evm:8453" } },
    { ...location, asset: { ...location.asset, decimals: 8 } },
    {
      ...location,
      asset: { ...location.asset, assetId: `0x${"ef".repeat(20)}` },
    },
    { ...location, details: { ...location.details, address: "invalid" } },
    { ...location, details: { address: funder, venueId: "other" } },
  ])
    assert.equal(
      polymarketHandoffSourceIntent({
        economicLocation,
        controllerProfile: profile,
      }),
      null,
    );
  for (const controllerProfile of [
    { ...profile, networkId: "evm:8453" },
    { ...profile, address: funder },
    { ...profile, address: "invalid" },
    { ...profile, source: "smart" as const },
    { ...profile, walletId: "" },
  ])
    assert.equal(
      polymarketHandoffSourceIntent({
        economicLocation: location,
        controllerProfile,
      }),
      null,
    );
});
