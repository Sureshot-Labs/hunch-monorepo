#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import type { FundingDestinationOption } from "../../domain/types.js";
import { FundingPlannerError } from "../../planner/money.js";
import { FundingPlanningRuntime } from "../../planner/runtime-service.js";
import {
  compileFundingIntentPolicy,
  type FundingIntentPolicy,
} from "../../policies/funding-policy-v2.js";
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
  venueId: "limitless" | "polymarket",
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
