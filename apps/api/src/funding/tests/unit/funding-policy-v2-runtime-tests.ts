#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import type { FundingDestinationOption } from "../../domain/types.js";
import { FundingPlannerError } from "../../planner/money.js";
import { FundingPlanningRuntime } from "../../planner/runtime-service.js";
import {
  compileFundingIntentPolicy,
  DEFAULT_FUNDING_INTENT_POLICY,
  fundingReceiveAssetEnabled,
  fundingVenueReceiveEnabled,
  type FundingIntentPolicy,
} from "../../policies/funding-policy-v2.js";
import {
  HYPERCORE_MAINNET_USDC,
  HYPERCORE_SPOT_LOCATION_PATTERN,
} from "../../domain/hypercore-identity.js";
import { FundingReceiveSessionService } from "../../receive/receive-session-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";

function policyDb(policy: FundingIntentPolicy): Pool {
  return {
    async query() {
      return {
        rows: [
          {
            id: "policy_v2_runtime_test",
            policy_key: "funding_control_plane",
            effective_at: new Date("2026-08-09T00:00:00.000Z"),
            payload: policy,
            created_by: null,
            created_by_admin_id: "admin_v2_runtime_test",
            created_at: new Date("2026-08-09T00:00:00.000Z"),
          },
        ],
      };
    },
  } as unknown as Pool;
}

function destination(
  venueId: "limitless" | "polymarket" | "hyperliquid",
  requiredAsset: FundingDestinationOption["requiredAsset"],
): FundingDestinationOption {
  return {
    destinationOptionId: `destination_${venueId}_12345678`,
    venueId,
    venueBindingId: `binding_${venueId}_12345678`,
    venueBindingOptionId: `binding_option_${venueId}_12345678`,
    controllerWalletId: `wallet_${venueId}_12345678`,
    safeLabel: venueId,
    requiredAsset,
    networkLabel: requiredAsset.networkId,
    readinessClass: "internal_managed",
    preparationStatus: "ready",
    preparationPurpose: "fund",
    executionMode: "privy_authorization",
    marketClass: null,
    topology: "deposit_wallet",
    inspectionRevision: `inspection_${venueId}_12345678`,
    recommended: false,
    selectable: true,
    reasonCodes: [],
  };
}

function settlementAsset(
  policy: FundingIntentPolicy,
  locationPatternId: string,
) {
  const runtime = compileFundingIntentPolicy(policy);
  const location = runtime.locations.find(
    (candidate) => candidate.locationPatternId === locationPatternId,
  );
  assert.ok(location);
  return location.asset;
}

function setPreparationOptions(
  runtime: FundingPlanningRuntime,
  options: readonly FundingDestinationOption[],
): void {
  Object.defineProperty(runtime, "preparationRuntime", {
    value: { listDestinationOptions: async () => options },
  });
}

async function test(name: string, run: () => Promise<void> | void) {
  await run();
  console.log(`[funding-policy-v2-runtime-tests] ok ${name}`);
}

await test("filters destinations through V2 and preserves venue recommendation order", async () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: ["limitless", "polymarket"],
    receive: { assets: ["base:usdc", "polygon:pusd"], privy: false },
    paused: false,
  };
  const limitless = destination(
    "limitless",
    settlementAsset(policy, "limitless-venue-cash-v1"),
  );
  const polymarket = destination(
    "polymarket",
    settlementAsset(policy, "polymarket-venue-cash-v1"),
  );
  const runtime = new FundingPlanningRuntime(policyDb(policy));
  setPreparationOptions(runtime, [polymarket, limitless]);

  const access = await runtime.destinationAccess(USER_ID, { purpose: "fund" });
  assert.deepEqual(
    access.options.map((option) => [option.venueId, option.recommended]),
    [
      ["polymarket", false],
      ["limitless", true],
    ],
  );
  assert.deepEqual(access.policyDisabledOptions, []);
});

await test("native funding uses the common policy catalogue, destination access and pause recovery", async () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: ["hyperliquid"],
    receive: { assets: ["base:usdc"], privy: false },
    paused: false,
  };
  const compiled = compileFundingIntentPolicy(policy);
  assert.equal(fundingVenueReceiveEnabled(compiled, "hyperliquid"), true);
  assert.equal(
    fundingReceiveAssetEnabled(compiled, HYPERCORE_MAINNET_USDC),
    false,
    "native settlement does not invent a manual wallet receive scanner",
  );
  const ingress = compiled.routes.find(
    (route) => route.routeId === "base-usdc-to-hypercore-spot-usdc",
  );
  assert.ok(ingress);
  assert.deepEqual(ingress.destinationAsset, HYPERCORE_MAINNET_USDC);
  assert.equal(
    ingress.destinationLocationPatternId,
    HYPERCORE_SPOT_LOCATION_PATTERN,
  );
  const native = {
    ...destination("hyperliquid", HYPERCORE_MAINNET_USDC),
    topology: "native",
  } as FundingDestinationOption;
  const scenarios: Array<[FundingIntentPolicy, boolean]> = [
    [policy, true],
    [{ ...policy, paused: true }, false],
    [{ ...policy, venues: [] }, false],
    [{ ...policy, receive: { assets: [], privy: false } }, false],
    [policy, true],
  ];
  for (const [effective, enabled] of scenarios) {
    const runtime = new FundingPlanningRuntime(policyDb(effective));
    setPreparationOptions(runtime, [native]);
    const access = await runtime.destinationAccess(USER_ID, {
      purpose: "fund",
    });
    assert.equal(access.options.length, enabled ? 1 : 0);
    assert.equal(access.policyDisabledOptions.length, enabled ? 0 : 1);
  }
  assert.deepEqual(DEFAULT_FUNDING_INTENT_POLICY.venues, []);
  assert.deepEqual(DEFAULT_FUNDING_INTENT_POLICY.receive.assets, []);
  assert.equal(compiled.venues[0].tradingEnabled, false);
  assert.equal(compiled.venues[0].delegatedExecutionEnabled, false);
});

await test("native source policy keeps eight-decimal venue cash and one physical location for cross-venue routes", () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: ["limitless", "polymarket", "hyperliquid"],
    receive: {
      assets: ["base:usdc", "polygon:usdc", "polygon:pusd", "hypercore:usdc"],
      privy: false,
    },
    paused: false,
  };
  const compiled = compileFundingIntentPolicy(policy);
  const native = compiled.locations.filter(
    (location) =>
      location.locationPatternId === HYPERCORE_SPOT_LOCATION_PATTERN,
  );
  assert.equal(native.length, 1);
  const pUsdInbound = compiled.routes.find(
    (route) => route.routeId === "polygon-pusd-to-hypercore-spot-usdc",
  );
  assert.ok(pUsdInbound);
  assert.equal(pUsdInbound.sourceLocationPatternId, "wallet-polygon-pusd-v1");
  assert.equal(pUsdInbound.networkExecutorId, "wallet_profile_evm_v1");
  assert.deepEqual(pUsdInbound.destinationAsset, HYPERCORE_MAINNET_USDC);
  assert.equal(native[0].locationKind, "venue_account");
  assert.deepEqual(native[0].asset, HYPERCORE_MAINNET_USDC);
  for (const capability of [
    "observe",
    "value",
    "execution_source",
    "venue_settlement",
    "withdrawal_source",
  ] as const)
    assert.ok(native[0].capabilities.includes(capability));
  for (const id of [
    "hypercore-spot-usdc-to-base-usdc",
    "hypercore-spot-usdc-to-polygon-pusd",
  ]) {
    const route = compiled.routes.find((candidate) => candidate.routeId === id);
    assert.ok(route);
    assert.equal(
      route.sourceLocationPatternId,
      HYPERCORE_SPOT_LOCATION_PATTERN,
    );
    assert.equal(route.networkExecutorId, "relay_hypercore_native_v1");
    assert.deepEqual(route.sourceAsset, HYPERCORE_MAINNET_USDC);
  }
  const removed = compileFundingIntentPolicy({
    ...policy,
    receive: { ...policy.receive, assets: ["base:usdc"] },
  });
  assert.ok(
    !removed.routes.some(
      (route) =>
        route.sourceAsset.networkId === HYPERCORE_MAINNET_USDC.networkId ||
        route.routeId === "polygon-pusd-to-hypercore-spot-usdc",
    ),
  );
});

await test("keeps a disabled venue out of capabilities and destinations", async () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: ["limitless"],
    receive: { assets: ["base:usdc", "polygon:pusd"], privy: false },
    paused: false,
  };
  const limitless = destination(
    "limitless",
    settlementAsset(policy, "limitless-venue-cash-v1"),
  );
  const polymarket = destination(
    "polymarket",
    settlementAsset(
      { ...policy, venues: ["polymarket", "limitless"] },
      "polymarket-venue-cash-v1",
    ),
  );
  const runtime = new FundingPlanningRuntime(policyDb(policy));
  setPreparationOptions(runtime, [polymarket, limitless]);

  assert.deepEqual((await runtime.capabilities()).destinationVenues, [
    "limitless",
  ]);
  const access = await runtime.destinationAccess(USER_ID, { purpose: "fund" });
  assert.deepEqual(
    access.options.map((option) => option.venueId),
    ["limitless"],
  );
  assert.deepEqual(
    access.policyDisabledOptions.map((option) => option.venueId),
    ["polymarket"],
  );
});

await test("reports a direct disabled receive destination as policy conflict", async () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: [],
    receive: { assets: ["polygon:pusd"], privy: false },
    paused: false,
  };
  const blocked = destination(
    "polymarket",
    settlementAsset(
      { ...policy, venues: ["polymarket"] },
      "polymarket-venue-cash-v1",
    ),
  );
  const service = new FundingReceiveSessionService({} as Pool);
  Object.defineProperty(service, "runtime", {
    value: {
      destinationAccess: async () => ({
        options: [],
        policyDisabledOptions: [blocked],
      }),
    },
  });

  await assert.rejects(
    () =>
      service.open(USER_ID, {
        destinationOptionId: blocked.destinationOptionId,
        venueBindingOptionId: blocked.venueBindingOptionId,
      }),
    (error: unknown) =>
      error instanceof FundingPlannerError &&
      error.code === "funding_policy_disabled",
  );
});

await test("does not turn funding policy into trade or withdrawal authorization", async () => {
  const policy: FundingIntentPolicy = {
    version: 2,
    venues: [],
    receive: { assets: [], privy: false },
    paused: true,
  };
  const option = {
    ...destination(
      "polymarket",
      settlementAsset(
        {
          version: 2,
          venues: ["polymarket"],
          receive: { assets: ["polygon:pusd"], privy: false },
          paused: false,
        },
        "polymarket-venue-cash-v1",
      ),
    ),
    recommended: true,
  };
  const runtime = new FundingPlanningRuntime(policyDb(policy));
  setPreparationOptions(runtime, [option]);

  for (const purpose of ["buy", "sell", "redeem", "withdraw"] as const) {
    const access = await runtime.destinationAccess(USER_ID, { purpose });
    assert.deepEqual(
      access.options.map((candidate) => [
        candidate.destinationOptionId,
        candidate.recommended,
      ]),
      [[option.destinationOptionId, true]],
    );
    assert.deepEqual(access.policyDisabledOptions, []);
  }
});

console.log("[funding-policy-v2-runtime-tests] complete");
