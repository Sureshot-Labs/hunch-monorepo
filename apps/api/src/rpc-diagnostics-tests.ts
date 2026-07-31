#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  decodeRpcDiagnosticField,
  encodeRpcDiagnosticField,
  inferRpcDiagnosticService,
  rpcDiagnosticsHourKey,
  type RpcDiagnosticDimensions,
} from "@hunch/infra";
import {
  rpcDiagnosticRetryCount,
  rpcDiagnosticsReportWindow,
} from "./rpc-diagnostics-report.js";
import { rpcDiagnosticOutcomeFromJsonRpcResponse } from "./services/rpc-client-factory.js";

const dimensions: RpcDiagnosticDimensions = {
  service: "finance-worker",
  network: "evm:137",
  method: "eth_getBalance",
  source: "apps/api/src/example.ts:42",
  metric: "attempt",
  outcome: "http_429",
};

assert.deepEqual(
  decodeRpcDiagnosticField(encodeRpcDiagnosticField(dimensions)),
  dimensions,
);
assert.equal(decodeRpcDiagnosticField("not-json"), null);
assert.equal(
  decodeRpcDiagnosticField(
    JSON.stringify([
      "api",
      "evm:137",
      "eth_call",
      "source.ts:1",
      "unknown_metric",
      "ok",
    ]),
  ),
  null,
);
assert.equal(
  rpcDiagnosticsHourKey(new Date("2026-07-31T17:59:59.999Z")),
  "rpc:diag:v1:2026073117",
);

assert.equal(
  inferRpcDiagnosticService({
    configured: null,
    argv: ["node", "apps/api/dist/server.js"],
    cwd: "/app",
  }),
  "api",
);
assert.equal(
  inferRpcDiagnosticService({
    configured: null,
    argv: ["node", "dist/unrelated.js"],
    cwd: "/app",
  }),
  null,
);
assert.equal(
  inferRpcDiagnosticService({
    configured: "explicit-service",
    argv: ["node", "apps/api/dist/server.js"],
    cwd: "/app",
  }),
  "explicit-service",
);
assert.equal(
  inferRpcDiagnosticService({
    configured: null,
    argv: ["tsx", "src/server.ts"],
    cwd: "/workspace/apps/api",
  }),
  "api",
);

assert.equal(
  rpcDiagnosticOutcomeFromJsonRpcResponse(200, {
    jsonrpc: "2.0",
    id: 1,
    result: "0x1",
  }),
  "ok",
);
assert.equal(
  rpcDiagnosticOutcomeFromJsonRpcResponse(200, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32_000, message: "execution failed" },
  }),
  "rpc_error",
);
assert.equal(
  rpcDiagnosticOutcomeFromJsonRpcResponse(200, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: 429, message: "Too Many Requests" },
  }),
  "rpc_429",
);
assert.equal(
  rpcDiagnosticOutcomeFromJsonRpcResponse(200, [
    { jsonrpc: "2.0", id: 1, result: "0x1" },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32_005, message: "rate limit exceeded" },
    },
  ]),
  "rpc_429",
);
assert.equal(rpcDiagnosticOutcomeFromJsonRpcResponse(200, {}), "rpc_error");
assert.equal(rpcDiagnosticOutcomeFromJsonRpcResponse(429, null), "http_429");
assert.equal(rpcDiagnosticOutcomeFromJsonRpcResponse(302, null), "http_error");
assert.equal(rpcDiagnosticOutcomeFromJsonRpcResponse(503, null), "http_error");

const reportWindow = rpcDiagnosticsReportWindow(
  2,
  new Date("2026-07-31T17:59:59.999Z"),
);
assert.deepEqual(reportWindow, {
  hours: 2,
  windowKind: "utc_hour_buckets",
  fromHour: "2026-07-31T16:00:00.000Z",
  throughHour: "2026-07-31T17:00:00.000Z",
  currentBucketPartial: true,
  keys: ["rpc:diag:v1:2026073117", "rpc:diag:v1:2026073116"],
});
assert.equal(
  rpcDiagnosticRetryCount({ logical: 0, attempts: 5, dedup: 0 }),
  null,
);
assert.equal(rpcDiagnosticRetryCount({ logical: 4, attempts: 6, dedup: 1 }), 3);

console.log("rpc diagnostics tests passed");
