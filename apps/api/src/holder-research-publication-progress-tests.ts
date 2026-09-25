import assert from "node:assert/strict";
import {
  createHolderResearchPublicationProgress,
  holderResearchCacheOutputAfterPersistence,
} from "./services/holder-research-publication-progress.js";
import type {
  HolderResearchPersistDecision,
  HolderResearchPersistStats,
} from "./services/holder-research.js";

function decision(
  key: string,
  status = "PUBLISH",
): HolderResearchPersistDecision {
  return {
    candidate: { key },
    output: { status },
    modelMeta: {},
  } as HolderResearchPersistDecision;
}
function result(
  key: string,
  status: "persisted" | "rejected" | "skipped_existing" | "error",
  reason?: string,
): HolderResearchPersistStats {
  return {
    considered: 1,
    persisted: Number(status === "persisted"),
    rejected: Number(status === "rejected"),
    rejectedByReason: status === "rejected" ? { no_meaningful_delta: 1 } : {},
    skippedExisting: Number(status === "skipped_existing"),
    superseded: 0,
    errors: Number(status === "error"),
    outcomesByKey: { [key]: { status, reason } },
  };
}

// Real run shape: four Luna investigations, first CONTEXT, second unsavable
// PUBLISH. Neither consumes the single publication slot; the third can save.
const persistedKeys: string[] = [];
const progress = createHolderResearchPublicationProgress({
  maxPublishPerRun: 1,
  persist: async (item) => {
    persistedKeys.push(item.candidate.key);
    return result(
      item.candidate.key,
      item.candidate.key === "blockade" ? "rejected" : "persisted",
    );
  },
});
let calls = 0;
for (const item of [
  decision("iran", "CONTEXT"),
  decision("blockade"),
  decision("hormuz"),
  decision("btc"),
]) {
  if (calls >= 4 || progress.stopped) break;
  calls += 1;
  await progress.record(item);
}
assert.equal(calls, 3);
assert.deepEqual(persistedKeys, ["blockade", "hormuz"]);
assert.equal(progress.stats?.persisted, 1);
assert.equal(progress.stats?.rejected, 1);
assert.equal(progress.stats?.considered, 3);
assert.deepEqual(
  progress.publishedDecisions.map((item) => item.candidate.key),
  ["hormuz"],
);

for (const outcome of ["rejected", "skipped_existing", "error"] as const) {
  const state = createHolderResearchPublicationProgress({
    maxPublishPerRun: 1,
    persist: async (item) => result(item.candidate.key, outcome),
  });
  let attempts = 0;
  for (let index = 0; index < 6; index += 1) {
    if (attempts >= 4 || state.stopped) break;
    attempts += 1;
    await state.record(decision(String(index)));
  }
  assert.equal(attempts, 4);
  assert.equal(state.stats?.persisted, 0);
  assert.equal(state.publishedDecisions.length, 0);
}

const uncertain = createHolderResearchPublicationProgress({
  maxPublishPerRun: 1,
  persist: async (item) =>
    result(item.candidate.key, "error", "commit_outcome_unknown"),
});
await uncertain.record(decision("uncertain"));
assert.equal(uncertain.stopped, true);
assert.equal(uncertain.publishedDecisions.length, 0);

const preview = createHolderResearchPublicationProgress({
  maxPublishPerRun: 1,
  persist: null,
});
await preview.record(decision("preview"));
assert.equal(preview.stopped, false);
assert.equal(preview.stats, null);
assert.equal(preview.publishedDecisions.length, 0);

let zeroCalls = 0;
const disabled = createHolderResearchPublicationProgress({
  maxPublishPerRun: 0,
  persist: async (item) => {
    zeroCalls += 1;
    return result(item.candidate.key, "persisted");
  },
});
await disabled.record(decision("disabled"));
assert.equal(disabled.stopped, true);
assert.equal(zeroCalls, 0);
console.log(
  "[holder-research-publication-progress-tests] passed reject/duplicate/error continuation, committed cap, uncertain COMMIT and preview regressions",
);
for (const reason of [
  "no_meaningful_delta",
  "duplicate_delta",
  "unsupported_update_reason",
]) {
  const output = holderResearchCacheOutputAfterPersistence(decision("repeat"), {
    status: "rejected",
    reason,
  });
  assert.equal(output.status, "CONTEXT");
  assert.match(output.rationale, /Publication update check/);
}
for (const reason of [
  "missing_price_snapshot",
  "stale_price_snapshot",
  "commit_outcome_unknown",
]) {
  assert.equal(
    holderResearchCacheOutputAfterPersistence(decision("technical"), {
      status: "rejected",
      reason,
    }).status,
    "PUBLISH",
  );
}
assert.equal(
  holderResearchCacheOutputAfterPersistence(decision("saved"), {
    status: "persisted",
  }).status,
  "PUBLISH",
);
