import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./routes/wallets.ts", import.meta.url),
  "utf8",
);
const cacheStart = source.indexOf("const cacheKey = getVenueStatusCacheKey({");
const cacheEnd = source.indexOf(
  'app.log.warn(\n                { error, walletAddress },\n                "EVM venue status lookup failed"',
  cacheStart,
);

assert.notEqual(cacheStart, -1, "venue status cache key is missing");
assert.notEqual(cacheEnd, -1, "venue status cache window is missing");

const cacheWindow = source.slice(cacheStart, cacheEnd);
assert.match(
  cacheWindow,
  /const inflight = venueStatusInflight\.get\(cacheKey\);[\s\S]*if \(inflight\)[\s\S]*if \(!refresh\) \{[\s\S]*readVenueStatusCache\(cacheKey\)/,
  "all callers must prefer an active fresh computation over a completed cache entry",
);
assert.match(
  cacheWindow,
  /venueStatusInflight\.set\(cacheKey, computePromise\)/,
  "all venue status computations must participate in singleflight",
);
assert.match(
  cacheWindow,
  /const computed = await computePromise;\s+writeVenueStatusCache\(cacheKey, computed\)/,
  "successful forced refreshes must replace the shared completed cache",
);
assert.doesNotMatch(
  cacheWindow,
  /if \(!refresh\) \{\s+writeVenueStatusCache\(cacheKey, computed\)/,
  "forced refreshes must not leave the completed cache stale",
);

console.log("[venue-status-cache-tests] passed refresh cache contract checks");
