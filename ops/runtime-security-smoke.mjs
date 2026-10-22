import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  createBrotliDecompress,
} from "node:zlib";

// Run manually with EACH bundled binary; not an application startup guard.
// A Node pass does not certify Bun, nor does a Bun pass certify Node.
const runtime = process.versions.bun ? "bun" : "node";
const version = process.versions.bun ?? process.versions.node;
const [major, minor, patch] = version.split(".").map(Number);
assert.ok(
  runtime === "bun"
    ? major === 1 && (minor > 4 || (minor === 4 && patch >= 4))
    : major === 24 && (minor > 22 || (minor === 22 && patch >= 1)),
  `Expected patched Bun 1 >= 1.4.4 or Node 24 >= 24.22.1; got ${runtime} ${version}`,
);
const input = Buffer.from("Hunch runtime compression smoke test");
assert.deepEqual(brotliDecompressSync(brotliCompressSync(input)), input);

// CVE-2026-111497 regression vector from Node's MIT-licensed upstream test:
// https://github.com/nodejs/node/blob/v24.22.1/test/parallel/test-zlib-invalid-input.js
assert.equal(constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, -17);
const invalid = Buffer.from(
  "200010414141fcffff07002228f00b60f7f41f000000",
  "hex",
);
const expectedError = { code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17 };
assert.throws(() => brotliDecompressSync(invalid), expectedError);
await assert.rejects(
  pipeline(
    Readable.from(Array.from(invalid, (byte) => Buffer.from([byte]))),
    createBrotliDecompress(),
    async (chunks) => {
      for await (const chunk of chunks) void chunk;
    },
  ),
  expectedError,
);
console.log(
  JSON.stringify({
    runtime,
    version,
    brotliSync: "passed",
    brotliStream: "passed",
  }),
);
