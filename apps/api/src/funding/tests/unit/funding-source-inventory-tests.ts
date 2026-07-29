import assert from "node:assert/strict";

import { fundingSourceInventoryBlockingReasonCodes } from "../../planner/production-source-planner.js";

assert.deepEqual(
  fundingSourceInventoryBlockingReasonCodes([
    {
      collectorId: "wallet-inventory",
      retryable: true,
    },
  ]),
  ["rpc_unavailable"],
);
assert.deepEqual(
  fundingSourceInventoryBlockingReasonCodes([
    {
      collectorId: "wallet-inventory",
      retryable: false,
    },
    {
      collectorId: "polymarket-position-value",
      retryable: true,
    },
  ]),
  [],
);

console.log(
  "[funding-source-inventory-tests] retryable wallet inventory gaps remain distinct from confirmed insufficient liquidity",
);
