#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  extractDflowErrorCode,
  formatDflowUserMessage,
} from "./services/dflow-client.js";

const routeUnavailable =
  "No route available for this market right now. It may be closed or have no liquidity.";

assert.equal(
  extractDflowErrorCode({ code: "route_not_found" }),
  "route_not_found",
);
assert.equal(
  extractDflowErrorCode({ errorCode: "route_not_found" }),
  "route_not_found",
);
assert.equal(
  extractDflowErrorCode({ error_code: "route_not_found" }),
  "route_not_found",
);
assert.equal(
  formatDflowUserMessage({ errorCode: "route_not_found" }),
  routeUnavailable,
);
assert.equal(
  formatDflowUserMessage({ message: "route not found for selected mints" }),
  routeUnavailable,
);

console.log("[dflow-client-tests] passed");
