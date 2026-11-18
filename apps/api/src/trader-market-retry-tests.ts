import assert from "node:assert/strict";
import { TraderRepository, type Asset } from "./repos/trader-collections.js";

const assets: Asset[] = Array.from({ length: 250 }, (_, i) => ({
  token: String(i),
  condition: "fixture",
  index: 0,
  label: "Yes",
}));

const fixture = (failures: unknown[], controller?: AbortController) => {
  const batchSizes: number[] = [];
  const timeouts: string[] = [];
  const transactions: string[] = [];
  let releases = 0;
  const repository = new TraderRepository({
    connect: async () => ({
      async query(sql: string, args?: unknown[]) {
        if (sql.startsWith("BEGIN")) transactions.push(sql);
        if (sql.includes("set_config('statement_timeout'")) {
          timeouts.push(String(args?.[0]));
        }
        if (sql.includes("WITH requested_assets")) {
          const batch = JSON.parse(String(args?.[0]));
          batchSizes.push(batch.length);
          const error = failures[batchSizes.length - 1];
          if (error) {
            controller?.abort(new Error("fixture abort"));
            throw error;
          }
        }
        return { rows: [] };
      },
      release: () => {
        releases += 1;
      },
    }),
  } as never);
  return {
    repository,
    batchSizes,
    timeouts,
    transactions,
    releases: () => releases,
  };
};

const timeout = Object.assign(
  new Error("canceling statement due to statement timeout"),
  { code: "57014" },
);
const stop = new AbortController();
const retry = fixture([timeout]);
assert.equal(
  (await retry.repository.markets(assets, 0, stop.signal, true)).size,
  0,
);
assert.deepEqual(retry.batchSizes, [250, 125, 125]);
assert.deepEqual(retry.timeouts, ["5000", "2500"]);
assert.deepEqual(retry.transactions, [
  "BEGIN READ ONLY",
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
]);
assert.equal(retry.releases(), 2);

const noPartial = fixture([timeout, undefined, timeout]);
await assert.rejects(
  noPartial.repository.markets(assets, 0, stop.signal),
  /statement timeout/,
);
assert.equal(noPartial.releases(), 2);
const nonTimeout = fixture([new Error("fixture non-timeout")]);
await assert.rejects(
  nonTimeout.repository.markets(assets, 0, stop.signal),
  /fixture non-timeout/,
);
assert.deepEqual(nonTimeout.batchSizes, [250]);
const cancelled = fixture([
  Object.assign(new Error("canceling statement due to user request"), {
    code: "57014",
  }),
]);
await assert.rejects(
  cancelled.repository.markets(assets, 0, stop.signal),
  /user request/,
);
assert.deepEqual(cancelled.batchSizes, [250]);
const controller = new AbortController();
const aborted = fixture([timeout], controller);
await assert.rejects(
  aborted.repository.markets(assets, 0, controller.signal),
  /statement timeout/,
);
assert.deepEqual(aborted.batchSizes, [250]);
console.log(
  "ok - isolated smaller retry, unchanged timeout for ordinary reads, no partial map",
);
