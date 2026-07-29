import assert from "node:assert/strict";
import test from "node:test";

import type {
  FundingDiscoveryRequest,
  IntentLiquidityProjection,
} from "../../domain/types.js";
import { FundingLiquiditySingleflight } from "../../planner/runtime-service.js";

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
