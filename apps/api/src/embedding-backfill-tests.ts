import assert from "node:assert/strict";
import type { RuntimePolicyQuery } from "@hunch/db";
import {
  parseEmbeddingBackfillOptions,
  runEmbeddingBackfill,
} from "./ai-embed-backfill.js";

assert.equal(parseEmbeddingBackfillOptions([]).mode, "preview");
assert.equal(parseEmbeddingBackfillOptions(["--dry-run"]).mode, "preview");
assert.deepEqual(
  parseEmbeddingBackfillOptions(["--venue=dflow,kalshi"]).venues,
  ["kalshi"],
);
assert.deepEqual(
  parseEmbeddingBackfillOptions([
    "--",
    "--venue",
    "polymarket",
    "--limit=25",
    "--events",
  ]),
  {
    mode: "preview",
    venues: ["polymarket"],
    limit: 25,
    includeMarkets: false,
    includeEvents: true,
  },
);
for (const args of [
  ["--unknown"],
  ["--limit"],
  ["--limit=-1"],
  ["--limit=1.2"],
  ["--limit=0"],
  ["--limit=9007199254740993"],
  ["--venue="],
  ["--venue=foo"],
  ["--venue=polymarket,"],
  ["--markets", "--events"],
  ["--execute", "--dry-run"],
  ["--execute=true"],
  ["--execute", "--venue=polymarket"],
  ["--execute", "--limit=1"],
  ["--execute", "--markets"],
  ["--status", "--events"],
  ["--status", "--execute"],
  ["--batch-size=500"],
  ["--execute", "--execute"],
  ["positional"],
])
  assert.throws(() => parseEmbeddingBackfillOptions(args), args.join(" "));

function fixture(policyPayload: unknown = {}) {
  const writes: string[] = [];
  const reads: string[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const logs: unknown[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      assert.match(sql.trim(), /^select\s/i, "preview may only read the DB");
      queries.push({ sql, params });
      if (sql.includes("runtime_policies")) {
        return {
          rows:
            params?.[0] === "ai_embeddings" ? [{ payload: policyPayload }] : [],
        };
      }
      return {
        rows: [{ n: sql.includes("unified_events entity") ? 200 : 1000 }],
      };
    },
  } as unknown as RuntimePolicyQuery;
  const redis = {
    get: async (key: string) => {
      reads.push(key);
      return null;
    },
    incr: async (key: string) => {
      writes.push(key);
      return 7;
    },
  };
  return {
    writes,
    reads,
    queries,
    logs,
    dependencies: {
      db,
      redis,
      log: (value: unknown) => {
        logs.push(value);
      },
    },
  };
}

const preview = fixture();
await runEmbeddingBackfill(
  parseEmbeddingBackfillOptions([
    "--events",
    "--limit=25",
    "--venue=polymarket",
  ]),
  preview.dependencies,
);
assert.deepEqual(preview.writes, []);
const report = preview.logs[0] as {
  previewCandidates: unknown;
  venues: string[];
  activeGeneration: { id: string };
};
assert.deepEqual(report.previewCandidates, { event: 25, market: 0 });
assert.deepEqual(report.venues, ["polymarket"]);
assert.equal(report.activeGeneration.id, "legacy-e5");
assert.equal(preview.queries.length, 4);

const execute = fixture();
await runEmbeddingBackfill(
  parseEmbeddingBackfillOptions(["--execute"]),
  execute.dependencies,
);
assert.deepEqual(execute.writes, ["ai:embed:control:reconcile"]);
assert.equal((execute.logs[1] as { completed: boolean }).completed, false);
assert.deepEqual(
  execute.queries.slice(2).map((query) => query.params?.[0]),
  [
    ["polymarket", "limitless"],
    ["polymarket", "limitless"],
  ],
);

for (const payload of [{ enabled: false }, { model: "bad/model" }]) {
  const invalid = fixture(payload);
  await assert.rejects(
    runEmbeddingBackfill(
      parseEmbeddingBackfillOptions(["--execute"]),
      invalid.dependencies,
    ),
  );
  assert.deepEqual(invalid.writes, []);
}

const status = fixture();
await runEmbeddingBackfill(
  parseEmbeddingBackfillOptions(["--status"]),
  status.dependencies,
);
assert.deepEqual(status.queries, []);
assert.deepEqual(status.writes, []);
assert.deepEqual(status.reads, ["ai:embed:control:status"]);
assert.deepEqual(status.logs, [{ readOnly: true, status: null, error: null }]);
console.log("embedding backfill tests passed");
