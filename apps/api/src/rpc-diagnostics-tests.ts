#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
import {
  createEvmRpcProvider,
  rpcDiagnosticOutcomeFromJsonRpcResponse,
} from "./services/rpc-client-factory.js";

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

const rpcMethods: string[] = [];
const rpcServer = createServer((request, response) => {
  let requestBody = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    requestBody += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(requestBody) as
      | { id: number; method: string }
      | Array<{ id: number; method: string }>;
    const entries = Array.isArray(payload) ? payload : [payload];
    rpcMethods.push(...entries.map((entry) => entry.method));
    const errors = entries.map((entry) => ({
      jsonrpc: "2.0",
      id: entry.id,
      error: { code: 429, message: "rate limited" },
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.isArray(payload) ? errors : errors[0]));
  });
});

await new Promise<void>((resolve, reject) => {
  rpcServer.once("error", reject);
  rpcServer.listen(0, "127.0.0.1", resolve);
});

const rpcAddress = rpcServer.address() as AddressInfo;
const staticProvider = createEvmRpcProvider(
  `http://127.0.0.1:${rpcAddress.port}`,
  8453,
  "rpc-client-factory-tests",
);
try {
  const network = await staticProvider.getNetwork();
  assert.equal(network.chainId, 8453n);
  assert.equal(rpcMethods.length, 0);

  await assert.rejects(staticProvider.getBlockNumber());
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(
    rpcMethods.filter((method) => method === "eth_chainId").length,
    0,
  );
  assert.ok(rpcMethods.includes("eth_blockNumber"));
} finally {
  staticProvider.destroy();
  await new Promise<void>((resolve, reject) => {
    rpcServer.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log("rpc diagnostics tests passed");
