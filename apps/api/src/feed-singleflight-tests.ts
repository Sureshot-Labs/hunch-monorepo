import assert from "node:assert/strict";
import { createFeedSingleflight } from "./lib/feed-singleflight.js";

const run = createFeedSingleflight<string>();
let calls = 0;
let resolve!: (value: string) => void;
const body = new Promise<string>((done) => {
  resolve = done;
});
const requests = Array.from({ length: 30 }, () =>
  run("revision:1:100:0", () => {
    calls++;
    return body;
  }),
);
await Promise.resolve();
assert.equal(calls, 1);
resolve("exact serialized response bytes");
assert.deepEqual(
  await Promise.all(requests),
  Array(30).fill("exact serialized response bytes"),
);
assert.equal(
  await run("revision:1:100:0", async () => "fresh"),
  "fresh",
  "No extra cache/freshness lifetime",
);
await assert.rejects(
  run("error", async () => {
    throw Error("SQL timeout");
  }),
  /timeout/,
);
assert.equal(await run("error", async () => "recovered"), "recovered");
const keys = [
  "revision:1:100:0",
  "revision:1:100:100",
  "revision:2:100:0",
  "revision:1:25:0",
];
assert.deepEqual(
  await Promise.all(keys.map((key) => run(key, async () => key))),
  keys,
);
const small = createFeedSingleflight<string>(1);
let release!: (value: string) => void;
const active = small(
  "active",
  () =>
    new Promise<string>((done) => {
      release = done;
    }),
);
await Promise.resolve();
assert.equal(await small("other", async () => "bypassed"), "bypassed");
release("done");
await active;
console.log(
  "ok - shared concurrent misses, exact keys, failure recovery, no extra caching, overload bypass",
);
