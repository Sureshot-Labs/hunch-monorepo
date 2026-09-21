import assert from "node:assert/strict";
import { marketMapModelTestHooks as hooks } from "./ai-map-build-run.js";
import {
  applyRelocations,
  buildRelocationCandidates,
  buildSemanticGroups,
} from "./services/market-map-semantic-review.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
} from "./services/runtime-policies.js";
type Point = Parameters<typeof hooks.buildTreeGlobal>[0]["points"][number];
const make = (eventId: string, vector: number[]): Point =>
  ({
    eventId,
    title: eventId,
    vector,
    venue: "polymarket",
    score: 1,
    x: 0,
    y: 0,
    volume24h: 5,
    liquidity: 7,
    openInterest: 2,
  }) as Point;
const points = [
  make("earnings", [1, 0]),
  make("social", [0, 1]),
  make("social2", [0, 1]),
  make("micron", [1, 0]),
];
const groups = [
  { points: points.slice(0, 3), children: [] },
  { points: points.slice(3), children: [] },
];
const params = {
  points,
  depth: 3,
  k1: 2,
  k2: 2,
  k3: 2,
  nowIso: "2026-09-21T00:00:00Z",
  byNodeEvents: new Map(),
};
const generated = buildSemanticGroups(
  points,
  3,
  [2, 2, 2],
  hooks.partitionCluster,
);
assert.deepEqual(
  hooks.buildTreeGlobal(params),
  hooks.buildTreeGlobal({
    ...params,
    groups: generated,
    byNodeEvents: new Map(),
  }),
);
const old = hooks.buildTreeGlobal({ ...params, groups });
applyRelocations(
  groups,
  buildRelocationCandidates(
    groups.map((g) => g.points),
    1,
  ),
);
const events = new Map();
const nodes = hooks.buildTreeGlobal({
  ...params,
  groups,
  byNodeEvents: events,
});
assert.notEqual(old[0].id, nodes[0].id);
assert.equal(
  nodes.reduce((sum, node) => sum + node.eventCount, 0),
  4,
);
assert.equal(
  nodes.reduce((sum, node) => sum + node.sumVolume24h, 0),
  20,
);
assert.equal(
  nodes.reduce((sum, node) => sum + node.sumLiquidity, 0),
  28,
);
assert.equal(events.get(nodes[1].id).length, 2);
const hierarchy = [
  {
    points: [...groups[0].points],
    children: [{ points: [...groups[0].points], children: [] }],
  },
  {
    points: [...groups[1].points],
    children: [{ points: [...groups[1].points], children: [] }],
  },
];
const treeEvents = new Map();
const tree = hooks.buildTreeGlobal({
  ...params,
  groups: hierarchy,
  byNodeEvents: treeEvents,
});
const byId = new Map(tree.map((node) => [node.id, node]));
assert.equal(byId.size, tree.length);
for (const node of tree) {
  if (node.parentId)
    assert.ok(byId.get(node.parentId)?.childIds.includes(node.id));
  if (!node.childIds.length) continue;
  const descendants = node.childIds.flatMap((id) => treeEvents.get(id));
  assert.equal(descendants.length, node.eventCount);
  assert.deepEqual(
    descendants.map((p) => p.eventId).sort(),
    treeEvents
      .get(node.id)
      .map((p: Point) => p.eventId)
      .sort(),
  );
  assert.equal(
    node.childIds.reduce(
      (sum, id) => sum + (byId.get(id)?.sumVolume24h ?? 0),
      0,
    ),
    node.sumVolume24h,
  );
}
for (const node of nodes) {
  assert.ok(
    events.get(node.id).some((p: Point) => p.eventId === node.heroEventId),
  );
  assert.ok(
    node.sampleEventIds.every((id) =>
      events.get(node.id).some((p: Point) => p.eventId === id),
    ),
  );
}
const policy = getIntelPolicyDefaults("market_map");
assert.equal(policy.semanticReviewEnabled, true);
assert.equal(
  hooks.buildConfig(["--without-semantic-review"], policy)
    .semanticReviewEnabled,
  false,
);
assert.equal(
  hooks.buildConfig([], { ...policy, semanticReviewEnabled: false })
    .semanticReviewEnabled,
  false,
);
assert.ok(
  getIntelPolicySchema("market_map").safeParse({
    semanticReviewEnabled: true,
    semanticReviewMaxPairs: 200,
    semanticReviewBudgetUsd: 0.1,
  }).success,
);
assert.ok(
  !getIntelPolicySchema("market_map").safeParse({ semanticReviewBudgetUsd: -1 })
    .success,
);
console.log("market map semantic tree/policy tests passed");
