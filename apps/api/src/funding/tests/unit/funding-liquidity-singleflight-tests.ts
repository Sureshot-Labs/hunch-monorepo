import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "@hunch/infra";
import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";

import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
} from "../../domain/types.js";
import {
  FundingLiquiditySingleflight,
  FundingPlanningRuntime,
} from "../../planner/runtime-service.js";
import {
  FundingPlanner,
  type FundingPlannerDependencies,
} from "../../planner/planner.js";
import { DirectIngressFundingSourceAdapter } from "../../planner/direct-ingress-source-adapter.js";
import { ProductionFundingSourcePlanner } from "../../planner/production-source-planner.js";
import type { FundingSourcePlanningInput } from "../../planner/source-adapter.js";
import type {
  FundingPlanningStore,
  PlannedSourceOption,
} from "../../planner/planning-types.js";

const request: FundingDiscoveryRequest = {
  purpose: "trade_shortfall",
  requestedDestinationAmount: {
    asset: {
      networkId: "evm:137",
      assetId: "0x0000000000000000000000000000000000000001",
      decimals: 6,
    },
    raw: "1000000",
  },
  confirmedSourceAmount: null,
  marketContextId: "token-yes",
  destinationOptionId: "destination_12345678",
  withdrawalRecipientId: null,
  venueBindingOptionId: "binding_12345678",
  maxFeeUsd: null,
  maxSlippageBps: null,
  deadline: null,
};

const projection = {
  liquidityProjectionId: "projection_12345678",
} as IntentLiquidityProjection;

await test("identical liquidity parameters share one concurrent discovery and Relay quote", async () => {
  const singleflight = new FundingLiquiditySingleflight();
  let executions = 0;
  let release!: (value: IntentLiquidityProjection) => void;
  const blocked = new Promise<IntentLiquidityProjection>((resolve) => {
    release = resolve;
  });
  const discover = async () => {
    executions += 1;
    return blocked;
  };

  const first = singleflight.run("user-1", request, discover);
  const second = singleflight.run(
    "user-1",
    { ...request, controllerWalletRef: null },
    discover,
  );
  await Promise.resolve();

  assert.equal(executions, 1);
  assert.equal(first, second);
  release(projection);
  assert.deepEqual(await Promise.all([first, second]), [
    projection,
    projection,
  ]);

  const afterCompletion = singleflight.run("user-1", request, async () => {
    executions += 1;
    return projection;
  });
  assert.equal(await afterCompletion, projection);
  assert.equal(executions, 2);
});

await test("receive catalog never joins full-source discovery or persists its placeholder projection", async () => {
  const runtime = new FundingPlanningRuntime({} as Pool);
  const observed: Array<
    { sourceScope?: string; store: FundingPlanningStore } | undefined
  > = [];
  const original = Reflect.get(runtime, "discoverLiquidity");
  Reflect.set(
    runtime,
    "discoverLiquidity",
    async (
      _userId: string,
      _request: FundingDiscoveryRequest,
      options?: { sourceScope?: string; store: FundingPlanningStore },
    ) => {
      observed.push(options);
      return {
        ...projection,
        liquidityProjectionId: `projection_${observed.length}`,
      };
    },
  );
  try {
    const full = runtime.liquidity("user-1", request);
    const catalog = runtime.liquidity("user-1", request, {
      sourceScope: "receive_catalog",
    });
    assert.equal(
      catalog,
      runtime.liquidity("user-1", request, { sourceScope: "receive_catalog" }),
      "concurrent catalog discovery still shares its own bounded work",
    );
    assert.notEqual(full, catalog);
    assert.notDeepEqual(await full, await catalog);
    assert.equal(observed.length, 2);
    const scoped = observed.find(
      (options) => options?.sourceScope === "receive_catalog",
    );
    assert.ok(scoped);
    assert.ok(
      observed.includes(undefined),
      "ordinary liquidity retains its full-source path",
    );
    assert.notEqual(scoped.store, Reflect.get(runtime, "planningStore"));
    const stored = await scoped.store.create({
      userId: "user-1",
      request,
      projection,
      plannerSnapshot: {} as never,
      policyVersion: 1,
      policyRevision: "policy_test_12345678",
      ownershipRevision: "ownership_test_12345678",
      expiresAt: new Date("2026-10-04T12:00:00Z"),
    });
    assert.equal(stored.projection, projection);
    assert.equal(await scoped.store.fetchOwnedCurrent({} as never), null);
  } finally {
    Reflect.set(runtime, "discoverLiquidity", original);
  }
});

await test("catalog uses only the existing receive/card adapter; ordinary discovery still uses production sources", async () => {
  const runtime = new FundingPlanningRuntime({} as Pool);
  const account = {
    runtimePolicy: {},
    policy: { revision: "policy_test_12345678" },
    ownershipEvidenceRevision: "ownership_test_12345678",
  } as AccountValueReadModel;
  const sourceInput = { request } as FundingSourcePlanningInput;
  const sources = [
    { option: { kind: "manual_receive" } },
    { option: { kind: "privy_funding_method" } },
  ] as unknown as readonly PlannedSourceOption[];
  let ingressCalls = 0;
  let productionCalls = 0;
  let blockerCalls = 0;
  const originalPlan = FundingPlanner.prototype.discover;
  const originalIngress = DirectIngressFundingSourceAdapter.prototype.list;
  const originalProduction = ProductionFundingSourcePlanner.prototype.discover;
  const originalBlockers =
    ProductionFundingSourcePlanner.prototype.listBlockingReasonCodes;
  FundingPlanner.prototype.discover = async function () {
    const dependencies = Reflect.get(
      this,
      "dependencies",
    ) as FundingPlannerDependencies;
    assert.deepEqual(await dependencies.listSources(sourceInput), sources);
    assert.deepEqual(await dependencies.discoverSources?.(sourceInput), {
      sources,
      reasonCodes: [],
    });
    assert.deepEqual(await dependencies.listSourceBlockers?.(sourceInput), []);
    return projection;
  };
  DirectIngressFundingSourceAdapter.prototype.list = async () => {
    ingressCalls += 1;
    return sources;
  };
  ProductionFundingSourcePlanner.prototype.discover = async () => {
    productionCalls += 1;
    return { sources, reasonCodes: [] };
  };
  ProductionFundingSourcePlanner.prototype.listBlockingReasonCodes =
    async () => {
      blockerCalls += 1;
      return [];
    };
  try {
    const discover = Reflect.get(runtime, "discoverLiquidity").bind(
      runtime,
    ) as (
      userId: string,
      request: FundingDiscoveryRequest,
      preview: {
        account: AccountValueReadModel;
        store: FundingPlanningStore;
        sourceScope?: "receive_catalog";
      },
    ) => Promise<IntentLiquidityProjection>;
    const store = {} as FundingPlanningStore;
    await discover("user-1", request, {
      account,
      store,
      sourceScope: "receive_catalog",
    });
    assert.deepEqual([ingressCalls, productionCalls, blockerCalls], [2, 0, 0]);
    await discover("user-1", request, { account, store });
    assert.deepEqual([ingressCalls, productionCalls, blockerCalls], [2, 2, 1]);
  } finally {
    FundingPlanner.prototype.discover = originalPlan;
    DirectIngressFundingSourceAdapter.prototype.list = originalIngress;
    ProductionFundingSourcePlanner.prototype.discover = originalProduction;
    ProductionFundingSourcePlanner.prototype.listBlockingReasonCodes =
      originalBlockers;
  }
});
