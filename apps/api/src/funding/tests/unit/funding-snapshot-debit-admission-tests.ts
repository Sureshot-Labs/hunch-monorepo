import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitFundingSnapshotDebits,
  partitionFundingSnapshotDebits,
  requireAdmittedFundingSnapshotDebits,
  FundingSnapshotDebitEvidenceError,
  type FundingSnapshotDebitRow,
} from "../../../account-value/funding-snapshot-debits.js";
import { committedFundingReadLocationAlias } from "../../../account-value/funding-read-location-identity.js";
import {
  hypercoreSpotAccountLocation,
  hypercorePerpsRefundLocation,
  stableWalletAssetLocationIdentity,
} from "../../../account-value/canonical.js";
import type { AssetLocation } from "../../domain/types.js";

const original = "original",
  current = "current",
  address = `0x${"ab".repeat(20)}`;
const evmAsset = {
  networkId: "evm:8453",
  assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  decimals: 6,
};
function candidate(native = false, physical = false): FundingSnapshotDebitRow {
  const location: AssetLocation = native
    ? hypercoreSpotAccountLocation({
        accountId: original,
        address,
        controllerWalletId: "controller",
      }).location
    : {
        kind: "wallet",
        accountId: original,
        asset: evmAsset,
        locationId: stableWalletAssetLocationIdentity({
          accountId: original,
          address,
          asset: evmAsset,
          balanceClass: "",
        }).locationId,
        details: { address },
      };
  const alias = committedFundingReadLocationAlias(location, {
    originalEconomicAccountId: original,
    currentOwnerUserId: current,
  });
  assert.ok(alias);
  return {
    debit_id: "debit",
    operation_id: "operation",
    segment_id: "segment",
    source_component_id: physical ? null : alias.currentComponentId,
    source_location_id: alias.currentLocation.locationId,
    network_id: location.asset.networkId,
    asset_id: location.asset.assetId,
    asset_decimals: location.asset.decimals,
    source_address: address,
    raw_amount: "1234",
    observed_at: new Date("2026-10-16T10:00:00Z"),
    strict_match: false,
    operation_source_snapshot: { source: { kind: "owned_location", location } },
    segment_source_snapshot: { kind: "owned_location", location },
    reservation_proofs: [
      {
        locationId: alias.originalLocation.locationId,
        componentId: alias.originalComponentId,
      },
    ],
  };
}

test("merged canonical native/EVM debits are admitted once; physical native alias needs the exact old location", () => {
  for (const row of [candidate(), candidate(true), candidate(true, true)]) {
    assert.deepEqual(
      admitFundingSnapshotDebits(current, [row, structuredClone(row)]),
      [row],
    );
    const legacy = {
      ...row,
      strict_match: true,
      operation_source_snapshot: null,
      reservation_proofs: null,
    };
    assert.deepEqual(
      admitFundingSnapshotDebits(current, [legacy]),
      [legacy],
      "unchanged strict legacy guard",
    );
  }
  const native = candidate(true, true);
  native.reservation_proofs = [
    {
      ...(native.reservation_proofs as Record<string, unknown>[])[0],
      componentId: "old-physical-alias",
    },
  ];
  assert.equal(admitFundingSnapshotDebits(current, [native]).length, 1);
});

test("candidate admission cannot invent address-only ownership or cross asset/DEX/component identities", () => {
  for (const base of [candidate(), candidate(true), candidate(true, true)]) {
    const changes: Partial<FundingSnapshotDebitRow>[] = [
      { source_location_id: "wrong" },
      { source_address: `0x${"cd".repeat(20)}` },
      { asset_id: "wrong" },
      { asset_decimals: 18 },
      { network_id: "evm:1" },
      { reservation_proofs: [] },
      { reservation_proofs: [{ locationId: "wrong", componentId: "wrong" }] },
      { operation_source_snapshot: null },
      { segment_source_snapshot: null },
      {
        operation_source_snapshot: {
          kind: "owned_location",
          location: {
            ...(base.segment_source_snapshot as { location: AssetLocation })
              .location,
            accountId: "foreign",
          },
        },
      },
    ];
    if (base.source_component_id !== null)
      changes.push({ source_component_id: "wrong" });
    for (const patch of changes)
      assert.equal(
        admitFundingSnapshotDebits(current, [{ ...base, ...patch }]).length,
        0,
        JSON.stringify(patch),
      );
    for (const patch of [
      { locationId: "arbitrary" },
      { details: { address, balanceLocationId: "same-physical" } },
      { accountId: current },
    ]) {
      const cloned = structuredClone(base);
      (cloned.segment_source_snapshot as { location: AssetLocation }).location =
        {
          ...(cloned.segment_source_snapshot as { location: AssetLocation })
            .location,
          ...patch,
        };
      assert.equal(admitFundingSnapshotDebits(current, [cloned]).length, 0);
    }
  }
  assert.equal(
    admitFundingSnapshotDebits(current, [
      { ...candidate(), source_component_id: null },
    ]).length,
    0,
    "EVM must preserve component guard",
  );
  const perps = candidate(true, true);
  const perpsSource = perps.segment_source_snapshot as {
    location: AssetLocation;
  };
  perpsSource.location = {
    ...perpsSource.location,
    details: { ...perpsSource.location.details, nativeSourceDex: "perps" },
  };
  assert.equal(admitFundingSnapshotDebits(current, [perps]).length, 0);
});

test("unverified alias is a separate diagnostic and blocks monetary admission until a fresh snapshot removes it", () => {
  const good = candidate(true, true),
    bad = {
      ...candidate(true, true),
      debit_id: "bad",
      source_location_id: "legacy-arbitrary",
    };
  assert.deepEqual(
    partitionFundingSnapshotDebits(current, [good, bad, structuredClone(bad)]),
    { accepted: [good], rejected: [bad] },
  );
  assert.throws(
    () => requireAdmittedFundingSnapshotDebits(current, [good, bad]),
    FundingSnapshotDebitEvidenceError,
  );
  assert.deepEqual(
    requireAdmittedFundingSnapshotDebits(current, [
      good,
      structuredClone(good),
    ]),
    [good],
  );
  assert.deepEqual(
    requireAdmittedFundingSnapshotDebits(current, []),
    [],
    "fresh post-debit snapshot has no unknown tail",
  );
});

test("operation-scoped source supports legacy null segment, but never an unanchored merged owner", () => {
  const row = candidate(true, true);
  const source = row.segment_source_snapshot as {
    kind: string;
    location: AssetLocation;
  };
  const legacy = {
    ...row,
    segment_id: null,
    segment_source_snapshot: null,
    operation_source_snapshot: source,
  };
  assert.equal(admitFundingSnapshotDebits(current, [legacy]).length, 1);
  assert.equal(admitFundingSnapshotDebits("unrelated", [legacy]).length, 0);
  assert.equal(
    admitFundingSnapshotDebits(current, [
      { ...legacy, operation_source_snapshot: { kind: "external_ingress" } },
    ]).length,
    0,
  );
});

test("proved other-class debits are neither cash reductions nor invalid-proof fences, in either direction", () => {
  for (const sourceDex of ["spot", ""] as const) {
    const row = candidate(true, true);
    const source =
      sourceDex === "spot"
        ? hypercoreSpotAccountLocation({
            accountId: original,
            address,
            controllerWalletId: "controller",
          }).location
        : hypercorePerpsRefundLocation({
            accountId: original,
            address,
            controllerWalletId: "controller",
          });
    const alias = committedFundingReadLocationAlias(source, {
      originalEconomicAccountId: original,
      currentOwnerUserId: current,
    });
    assert.ok(alias);
    row.segment_source_snapshot = { kind: "owned_location", location: source };
    row.operation_source_snapshot = { source: row.segment_source_snapshot };
    row.reservation_proofs = [
      {
        locationId: alias.originalLocation.locationId,
        componentId: alias.originalComponentId,
      },
    ];
    row.source_location_id = alias.currentLocation.locationId;
    row.source_native_dex = sourceDex;
    assert.equal(
      requireAdmittedFundingSnapshotDebits(current, [row]).length,
      1,
    );
    const other = {
      ...row,
      source_native_dex:
        sourceDex === "spot" ? ("" as const) : ("spot" as const),
      source_location_id: "other-physical-class",
    };
    assert.deepEqual(partitionFundingSnapshotDebits(current, [other]), {
      accepted: [],
      rejected: [],
    });
    assert.deepEqual(
      requireAdmittedFundingSnapshotDebits(current, [other]),
      [],
    );
    assert.throws(
      () =>
        requireAdmittedFundingSnapshotDebits(current, [
          { ...other, reservation_proofs: [] },
        ]),
      FundingSnapshotDebitEvidenceError,
      "invalid proof is not permission to discard a debit",
    );
  }
});
