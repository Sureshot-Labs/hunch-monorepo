#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  decodeRpcDiagnosticField,
  encodeRpcDiagnosticField,
  rpcDiagnosticsHourKey,
  type RpcDiagnosticDimensions,
} from "@hunch/infra";

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

console.log("rpc diagnostics tests passed");
