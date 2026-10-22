import assert from "node:assert/strict";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

// Run manually inside the Node image; not an application startup guard.
// Bun is deliberately not certified by a successful test of the Node binary.
assert.equal(
  process.versions.bun,
  undefined,
  "Run this probe with Node, not Bun",
);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
assert.ok(
  major === 24 && (minor > 22 || (minor === 22 && patch >= 1)),
  `Expected patched Node 24 >= 24.22.1; got ${process.versions.node}`,
);
const input = Buffer.from("Hunch runtime compression smoke test");
assert.deepEqual(brotliDecompressSync(brotliCompressSync(input)), input);

// CVE-2026-111497 regression vector from Node's MIT-licensed upstream test:
// https://github.com/nodejs/node/blob/v24.22.1/test/parallel/test-zlib-invalid-input.js
assert.equal(constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, -17);
assert.throws(
  () =>
    brotliDecompressSync(
      Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex"),
    ),
  { code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17 },
);
console.log(
  JSON.stringify({ node: process.version, brotliRegression: "passed" }),
);
