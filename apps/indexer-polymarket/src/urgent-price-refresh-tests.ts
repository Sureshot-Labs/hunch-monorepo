import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
const { fetchTradableTokenIdsForSnapshot, createBookSnapshotQueue } =
  await import("./bootstrap.js");
const { postBooksOnce } = await import("./clobClient.js");
let queryCount = 0;
const db = {
  query: async (sql: string, params: unknown[]) => {
    queryCount++;
    assert.match(sql, /and not \$2::boolean/);
    assert.equal(params[1], true);
    return { rows: [{ token_id: "2" }, { token_id: "1" }] };
  },
};
assert.deepEqual(
  await fetchTradableTokenIdsForSnapshot([], true, db as never),
  [],
);
assert.equal(queryCount, 0);
assert.deepEqual(
  await fetchTradableTokenIdsForSnapshot(["1", "2"], true, db as never),
  ["1", "2"],
);
const sourceRoot = new URL(
  import.meta.url.endsWith(".js") ? "../src/" : "./",
  import.meta.url,
);
const main = readFileSync(new URL("main.ts", sourceRoot), "utf8");
const urgent = main.slice(
  main.indexOf("async function periodicUrgentPriceRefresh"),
  main.indexOf("async function main()"),
);
assert.doesNotMatch(urgent, /\bpriceRefreshRunning\b/);
assert.match(urgent, /topOnly: true/);
assert.match(urgent, /limit: Math.min\(20, env.topBookSnapshot\)/);
const bootstrap = readFileSync(new URL("bootstrap.ts", sourceRoot), "utf8");
assert.match(
  bootstrap,
  /if \(!options.topOnly\) \{[\s\S]*?await refreshMarketRefs/,
);
assert.match(bootstrap, /fetchTimeoutMs: options.topOnly \? 10_000/);
assert.match(bootstrap, /Unknown\/closed\/obsolete mappings[\s\S]*?delayMs: 0/);
assert.match(bootstrap, /const q = bookSnapshotQueue/);
const queue = createBookSnapshotQueue({ intervalMs: 10, intervalCap: 1 });
const order: string[] = [];
await Promise.all([
  queue.add(async () => {
    order.push("inflight");
  }),
  queue.add(async () => {
    order.push("normal");
  }),
  queue.add(
    async () => {
      order.push("urgent");
    },
    { priority: 1 },
  ),
]);
assert.deepEqual(order, ["inflight", "urgent", "normal"]);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (async (_url, options) => {
    assert.ok(options?.signal);
    return await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
      // Keep this mocked request alive; AbortSignal.timeout is otherwise unref'd.
      const timer = setTimeout(() => reject(new Error("test timeout")), 100);
      options.signal?.addEventListener("abort", () => clearTimeout(timer), {
        once: true,
      });
    });
  }) as typeof fetch;
  await assert.rejects(postBooksOnce(["1"], { timeoutMs: 5 }), /aborted/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "[urgent-price-refresh-tests] canonical lookup, independent bounded lane, normal repair and HTTP abort passed",
);
