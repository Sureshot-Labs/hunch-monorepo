import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHip4PerpsCash } from "./services/hip4-perps-cash.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { projectHip4AccountValue } from "./account-value/hip4-account-value.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { hypercorePerpsRefundLocation } from "./account-value/canonical.js";
import {
  fundingRefundSnapshotLagOperations,
  fundingInvalidatedRefundComponentIds,
} from "./account-value/funding-movement-feed.js";

const now = Date.parse("2026-10-16T10:00:00Z");
const summary = {
  accountValue: "9.962411",
  totalRawUsd: "9.962411",
  totalMarginUsed: "0",
  totalNtlPos: "0",
};
function perpsCashTestState(time = now) {
  return {
    marginSummary: { ...summary },
    crossMarginSummary: { ...summary },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "9.96241099",
    assetPositions: [],
    time,
  };
}
const project = (
  state: unknown = perpsCashTestState(),
  mode = "disabled",
  role = "user",
) =>
  projectHip4PerpsCash({
    state,
    mode,
    role,
    observedAt: new Date(now).toISOString(),
    now,
  });

test("native perps cash uses exact USDC8 total and transferable ceiling, not a receipt or spot", () => {
  assert.deepEqual(project(), {
    observedAt: new Date(now).toISOString(),
    state: "verified",
    totalRaw: "996241100",
    availableRaw: "996241099",
    reason: "cash_only",
  });
  const big = perpsCashTestState();
  big.marginSummary.accountValue =
    big.marginSummary.totalRawUsd =
    big.crossMarginSummary.accountValue =
    big.crossMarginSummary.totalRawUsd =
    big.withdrawable =
      "9007199254740993.12345678";
  assert.equal(project(big).availableRaw, "900719925474099312345678");
  const older = project(perpsCashTestState(now - 1234));
  assert.equal(
    older.observedAt,
    new Date(now - 1234).toISOString(),
    "provider time cannot be made fresher by reading it",
  );
});

test("margin/unified/borrowable or malformed equity is never classified as free perps cash", () => {
  for (const mode of [
    "unifiedAccount",
    "portfolioMargin",
    "dexAbstraction",
    "default",
  ])
    assert.equal(project(undefined, mode).state, "unsupported");
  for (const role of ["missing", "vault", "agent", "subAccount"])
    assert.equal(project(undefined, "disabled", role).state, "unsupported");
  for (const patch of [
    { withdrawable: "10" },
    { withdrawable: "-1" },
    { withdrawable: "0.000000001" },
    { time: now + 1 },
    { marginSummary: { ...summary, accountValue: "10" } },
    { crossMarginSummary: { ...summary, totalRawUsd: "1" } },
  ])
    assert.equal(
      project({ ...perpsCashTestState(), ...patch }).state,
      "unavailable",
    );
  for (const patch of [
    { assetPositions: [{}] },
    { crossMaintenanceMarginUsed: "1" },
    { marginSummary: { ...summary, totalMarginUsed: "1" } },
  ])
    assert.equal(
      project({ ...perpsCashTestState(), ...patch }).reason,
      "margin_inventory",
    );
});

test("spot and verified perps are distinct canonical inventory, with separate freshness and recoverable failures", () => {
  const userId = "owner",
    address = `0x${"ab".repeat(20)}`;
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date(now).toISOString(),
    role: "user",
    mode: "disabled",
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: { balances: [] },
  });
  observation.perpsCash = project();
  const input = {
    userId,
    now,
    read: {
      environment: "mainnet" as const,
      snapshotMaxAgeMs: 60000,
      accounts: [{ address, observation }],
      positions: [],
      coverage: {
        state: "ready" as const,
        policyRevision: "test",
        accounts: 1,
        missingAccounts: 0,
        staleAccounts: 0,
        unresolvedBalances: 0,
        missingCostBasis: 0,
        unpricedPositions: 0,
      },
    },
  };
  const value = projectHip4AccountValue(input);
  assert.equal(value.assets.length, 2);
  const perps = value.assets.find(
    (row) => row.location.details.nativeSourceDex === "",
  );
  const spot = value.assets.find(
    (row) => row.location.details.nativeSourceDex === "spot",
  );
  assert.ok(perps && spot);
  assert.equal(
    perps.location.locationId,
    hypercorePerpsRefundLocation({
      accountId: userId,
      address,
      controllerWalletId: null,
    }).locationId,
  );
  assert.notEqual(perps.componentId, spot.componentId);
  const refund = {
    operationId: "refunded-old-buy",
    locationId: perps.location.locationId,
    asset: HYPERCORE_MAINNET_USDC,
    observedAt: new Date(now + 1).toISOString(),
    invalidated: false,
    nativeDestinationDex: "" as const,
  };
  assert.equal(
    fundingRefundSnapshotLagOperations([refund], value.assets).size,
    1,
    "a successful receipt alone cannot restore a pre-refund balance",
  );
  const afterRefund = { ...perps, observedAt: new Date(now + 2).toISOString() };
  assert.equal(
    fundingRefundSnapshotLagOperations([refund], [spot, afterRefund]).size,
    0,
  );
  assert.equal(
    fundingRefundSnapshotLagOperations(
      [refund],
      [{ ...spot, observedAt: afterRefund.observedAt }],
    ).size,
    1,
    "even newer spot is not a perps refund observation",
  );
  assert.deepEqual(
    [
      ...fundingInvalidatedRefundComponentIds(
        [{ ...refund, invalidated: true }],
        value.assets,
      ),
    ],
    [perps.componentId],
    "refund invalidation fences only the exact old perps snapshot",
  );
  assert.equal(perps.amount.raw, "996241100");
  assert.equal(spot.amount.raw, "0");
  observation.cash.total = "-1";
  assert.equal(
    projectHip4AccountValue(input).assets.find(
      (row) => row.location.details.nativeSourceDex === "",
    )?.amount.raw,
    "996241100",
    "invalid spot cash cannot erase independent verified perps cash",
  );
  observation.cash.total = "0";
  assert.equal(
    value.availability.find((row) => row.componentId === perps.componentId)
      ?.lockedRaw,
    "1",
  );
  assert.equal(
    projectHip4AccountValue({ ...input, now: now + 60000 }).assets.find(
      (row) => row.componentId === perps.componentId,
    )?.estimatedUsd,
    null,
  );
  observation.perpsCash = {
    ...project(),
    state: "unavailable",
    totalRaw: null,
    availableRaw: null,
    reason: "read_failed",
  };
  const failed = projectHip4AccountValue(input);
  assert.equal(failed.assets.length, 1);
  assert.ok(failed.errors.some((row) => row.retryable));
  assert.equal(failed.unsupportedPerpsLocationIds, undefined);
  observation.perpsCash = {
    ...project(),
    state: "unsupported",
    totalRaw: null,
    availableRaw: null,
    reason: "unsupported_cash_mode",
  };
  assert.deepEqual(projectHip4AccountValue(input).unsupportedPerpsLocationIds, [
    perps.location.locationId,
  ]);
});
