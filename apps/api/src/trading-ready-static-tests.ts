#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function routeWindow(source: string, start: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  const nextRoute = /\n {2}(?:app|z)\.(?:get|post|put|patch|delete)\(/g;
  nextRoute.lastIndex = startIndex;
  const endIndex = nextRoute.exec(source)?.index ?? source.length;
  return source.slice(startIndex, endIndex);
}

const source = read("routes/dflow-private.ts");
const submit = routeWindow(source, '"/submit"');
assert.match(submit, /ensureDflowReady\(reply\)/);
assert.match(submit, /deriveKalshiDflowTransactionContext/);
assert.match(submit, /strictKalshiSubmit && !userPublicKey/);
assert.match(submit, /strictKalshiSubmit && !context/);
assert.match(submit, /strictKalshiSubmit \|\| context/);
assert.match(submit, /enforceKalshiProof/);
assert.match(submit, /isKalshiMarketMintContextValid/);
assert.match(submit, /loadMarketForVenue/);
assert.match(submit, /marketId/);
assert.match(submit, /validateKalshiDflowTransaction/);
assert.match(submit, /submitKalshiDflowSignedTransactionRoute/);
assert.match(submit, /expectedInputMint: env\.solanaUsdcMint/);
assert.ok(
  submit.indexOf("validateKalshiDflowTransaction") <
    submit.indexOf("submitKalshiDflowSignedTransactionRoute"),
);
assert.ok(
  submit.indexOf("retainClientCopyBeforeSubmission") >= 0 &&
    submit.indexOf("retainClientCopyBeforeSubmission") <
      submit.indexOf("submitKalshiDflowSignedTransactionRoute"),
  "Copy attribution must be retained before broadcasting",
);

const routes = read("routes/index.ts");
assert.match(
  routes,
  /prefix: "\/trade\/kalshi"[\s\S]*strictKalshiSubmit: true/,
);
assert.match(
  routes,
  /prefix: "\/trade\/dflow"[\s\S]*strictKalshiSubmit: false/,
);

console.log("[trading-ready-static-tests] passed route surface checks");
