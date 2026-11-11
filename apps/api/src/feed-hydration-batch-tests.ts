import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  fetchFeedMarketsBatched,
  type FeedInputs,
} from "./repos/unified-read.js";

const input: FeedInputs = {
  limit: 100,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  view: "events",
  sort: "trending_v2",
  nowParam: "2026-11-11T12:00:00Z",
  sevenDaysAgo: "2026-11-04T12:00:00Z",
  sevenDaysFromNow: "2026-11-18T12:00:00Z",
};
const ids = Array.from({ length: 100 }, (_, index) => `event-${index}`);
async function fixture(eventIds: string[], failBatch = 0) {
  const controls: string[] = [],
    bindings: unknown[][] = [];
  let released = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (!sql.trim().startsWith("with ")) {
        controls.push(sql);
        return { rows: [] };
      }
      bindings.push(params);
      if (bindings.length === failBatch)
        throw Object.assign(Error("Fixture hydration failure"), {
          code: "57014",
        });
      assert.equal(params[1], input.nowParam);
      assert.equal(params[2], input.nowParam);
      return {
        rows: (params[0] as string[]).map((event_id) => ({ event_id })),
      };
    },
    release() {
      released++;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const operation = fetchFeedMarketsBatched(pool, input, eventIds);
  if (failBatch) await assert.rejects(operation, /hydration failure/);
  else
    assert.deepEqual(
      (await operation).map((row) => row.event_id),
      eventIds,
    );
  assert.equal(released, 1);
  return { controls, bindings };
}
const complete = await fixture(ids);
assert.equal(complete.bindings.length, 5);
assert.ok(
  complete.bindings.every((params) => (params[0] as string[]).length === 20),
);
assert.equal(
  complete.controls.filter((sql) => sql.startsWith("BEGIN")).length,
  1,
);
assert.equal(
  complete.controls[0],
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
);
assert.equal(complete.controls.at(-1), "COMMIT");
const failed = await fixture(ids, 2);
assert.equal(failed.bindings.length, 2);
assert.equal(failed.controls.at(-1), "ROLLBACK");
assert.equal(failed.controls.includes("COMMIT"), false);
const duplicate = await fixture([...ids.slice(0, 21), ids[0] as string]);
assert.equal(
  duplicate.bindings.length,
  1,
  "Duplicate input IDs preserve original window semantics",
);
console.log(
  "ok - bounded complete hydration, one read-only snapshot/as-of, rollback without partial results, duplicate-ID compatibility",
);
