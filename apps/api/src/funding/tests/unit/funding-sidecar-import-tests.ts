import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deriveSafeProxyAddress } from "../../../services/polymarket-safe-address.js";

assert.equal(
  deriveSafeProxyAddress(
    "0x7f0f3913f02ddfd037bf590f9bdb069cbed20e88",
  )?.toLowerCase(),
  "0x285f26341a8e10d5d5272e630231b881de9c4415",
);
assert.equal(deriveSafeProxyAddress("invalid"), null);

// A sidecar intentionally lacks API-only configuration. Import the complete
// validation boundary in a fresh process, so module caching cannot hide a leak.
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CONTENT_REVALIDATE_URL: "https://example.invalid",
};
delete childEnv.CONTENT_REVALIDATE_SECRET;
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(new URL("../../validation/funding-commit-plan-validator.ts", import.meta.url).href)});`,
  ],
  { env: childEnv, encoding: "utf8", timeout: 30_000 },
);
assert.equal(result.status, 0, result.stderr);
console.log(
  "[funding-sidecar-import-tests] Safe derivation and sidecar isolation passed",
);
