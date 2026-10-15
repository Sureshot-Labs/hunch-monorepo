import assert from "node:assert/strict";
import {
  initialGammaV2Checkpoint,
  parseGammaV2Checkpoint,
  runGammaV2CatchUp,
  runGammaHotLanes,
  type GammaV2Checkpoint,
} from "./gamma-sync.js";
import type { GammaEventsQuery, GammaPageEvent } from "./gammaClient.js";
import type { TEvent } from "./types.js";

const event = (id: string): TEvent => ({ id, title: id, markets: [] });
let saved = initialGammaV2Checkpoint();
const processed: string[] = [];
const queries: GammaEventsQuery[] = [];
const options = {
  pageSize: 500,
  maxPages: 2,
  maxOffset: 100_000,
  pause: async () => {},
  fetchPage: async (query: GammaEventsQuery) => {
    queries.push(query);
    assert.equal(query.version, "v2");
    assert.equal(query.limit, 100);
    if (query.closed === false)
      return { events: query.offset === 0 ? [event("open")] : [] };
    return {
      events: query.offset === 0 ? [event("closed"), event("resolved")] : [],
    };
  },
  processPage: async (events: GammaPageEvent[]) => {
    processed.push(...events.map((e) => e.id));
    return {
      processedEvents: events.length,
      processedMarkets: events.length * 2,
    };
  },
  saveCheckpoint: async (checkpoint: GammaV2Checkpoint) => {
    saved = { ...checkpoint };
  },
};
const first = await runGammaV2CatchUp({ ...options, checkpoint: saved });
assert.deepEqual(saved, { phase: "catalog", offset: 0 });
assert.equal(first.unfinished, true);
assert.deepEqual(processed, ["open"]);
const second = await runGammaV2CatchUp({
  ...options,
  checkpoint: parseGammaV2Checkpoint(JSON.stringify(saved)),
});
assert.equal(second.unfinished, false);
assert.deepEqual(saved, { phase: "complete", offset: 2 });
assert.ok(queries[2]);
assert.equal(
  queries[2].active,
  undefined,
  "catalog includes inactive/resolved/archived",
);
assert.deepEqual(processed, ["open", "closed", "resolved"]);
await runGammaV2CatchUp({ ...options, checkpoint: saved });
assert.equal(
  queries.length,
  4,
  "complete catalog is not fetched on later ticks",
);

for (const stage of ["fetch", "before_upsert", "after_upsert", "checkpoint"]) {
  saved = initialGammaV2Checkpoint();
  const seen = new Set<string>();
  await assert.rejects(
    runGammaV2CatchUp({
      ...options,
      checkpoint: saved,
      fetchPage: async (query) => {
        if (stage === "fetch") throw Error(stage);
        return options.fetchPage(query);
      },
      processPage: async (events) => {
        if (stage === "before_upsert") throw Error(stage);
        events.forEach((e) => seen.add(e.id));
        if (stage === "after_upsert") throw Error(stage);
        return { processedEvents: events.length, processedMarkets: 1 };
      },
      saveCheckpoint: async (checkpoint) => {
        if (stage === "checkpoint") throw Error(stage);
        await options.saveCheckpoint(checkpoint);
      },
    }),
    new RegExp(stage),
  );
  assert.deepEqual(saved, initialGammaV2Checkpoint());
  await runGammaV2CatchUp({
    ...options,
    checkpoint: saved,
    processPage: async (events) => {
      events.forEach((e) => seen.add(e.id));
      return { processedEvents: events.length, processedMarkets: 1 };
    },
  });
  assert.deepEqual([...seen], ["open"], "replayed upsert is idempotent");
  assert.deepEqual(saved, { phase: "catalog", offset: 0 });
}

const lanes = await runGammaHotLanes(async (version, closed) => {
  if (version === "v1") throw Error("v1 offline");
  return closed ? 7 : 8;
});
assert.deepEqual(
  lanes.filter((lane) => lane.result != null).map((lane) => lane.result),
  [8, 7],
);
assert.equal(lanes.filter((lane) => lane.error).length, 2);
const v1Cursor = "28400";
const fakeRedis = new Map([
  ["indexer:polymarket:gamma:events_offset:v1", v1Cursor],
]);
await runGammaV2CatchUp({
  ...options,
  checkpoint: initialGammaV2Checkpoint(),
  saveCheckpoint: async (cp) => {
    fakeRedis.set("indexer:polymarket:gamma:catch_up:v2", JSON.stringify(cp));
  },
});
assert.equal(
  fakeRedis.get("indexer:polymarket:gamma:events_offset:v1"),
  v1Cursor,
);
assert.throws(() => parseGammaV2Checkpoint('{"phase":"catalog","offset":-1}'));
const cap = await runGammaV2CatchUp({
  ...options,
  checkpoint: { phase: "catalog", offset: 101 },
  maxOffset: 100,
});
assert.equal(cap.offsetCapReached, true);
assert.equal(cap.unfinished, true);
assert.equal(cap.pages, 0);
console.log(
  "ok - Gamma V2 checkpoints, replay, page caps, completion and lane isolation",
);
