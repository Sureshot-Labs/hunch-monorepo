// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_HIP4_READ_POLICY, hip4Identity } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";
import {
  readHip4Markets,
  readHip4LiveOutcomes,
} from "./services/hip4-repository.js";
import { hip4KnownStreamTokensAllowed } from "./services/hip4-stream-access.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
const base = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const policyId = randomUUID();
const ids = Array.from({ length: 120 }, (_, i) => 600000 + i);
const policy = {
  ...DEFAULT_HIP4_READ_POLICY,
  enabled: true,
  catalogMode: "all" as const,
  outcomeAllowlist: [],
  maxOutcomesPerCycle: 2,
  maxLiveOutcomes: 2,
};
const metadata = {
  ...base.metadata,
  questions: [],
  outcomes: ids.map((outcome) => ({
    ...base.metadata.outcomes[0],
    outcome,
    description: `participant:Catalog ${outcome}|resolutionDeadline:20990101-0000`,
  })),
};
let requests = 0;
try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',now(),$2)",
    [policyId, JSON.stringify(policy)],
  );
  const result = await runHip4ReadCycle(pool, async (request) => {
    requests++;
    if (request.type === "outcomeMeta") return metadata;
    if (request.type === "spotMetaAndAssetCtxs")
      return [
        base.spotMetadata,
        ids.flatMap((outcome) => [
          { coin: `#${outcome}0`, dayNtlVlm: "10", midPx: "0.4" },
          { coin: `#${outcome}1`, dayNtlVlm: "15", midPx: "0.6" },
        ]),
      ];
    if (request.type === "l2Book")
      return { coin: request.coin, time: Date.now(), levels: [[], []] };
    if (request.type === "recentTrades") return [];
    throw new Error("unexpected_provider_request");
  });
  assert.deepEqual(result.failures, []);
  assert.equal(requests, 8); // Metadata pair + only two depth/history repairs, NOT 120.
  const all = [];
  let after = -1;
  for (;;) {
    const page = await readHip4Markets(pool, "mainnet", null, after, 20);
    if (!page.length) break;
    all.push(...page);
    after = page.at(-1)?.outcome ?? after;
  }
  assert.deepEqual(
    all.map((row) => row.outcome),
    ids,
  );
  assert.equal(all[90].volume24h?.usd, "10");
  assert.equal(all[90].indicativePrices?.prices[0].price, "0.4");
  const scoped = await readHip4Markets(
    pool,
    "mainnet",
    null,
    -1,
    20,
    all[90].eventId,
  );
  assert.deepEqual(
    scoped.map((row) => row.outcome),
    [ids[90]],
  );
  assert.equal(
    (await readHip4Markets(pool, "mainnet", null, ids[90], 20, all[90].eventId))
      .length,
    0,
  );
  assert.equal(
    (await readHip4Markets(pool, "mainnet", [ids[0]], -1, 20, all[90].eventId))
      .length,
    0,
  );
  assert.equal(
    (await readHip4Markets(pool, "testnet", null, -1, 20, all[90].eventId))
      .length,
    0,
  );
  assert.equal(
    (await readHip4Markets(pool, "testnet", null, -1, 20)).length,
    0,
  );
  assert.equal(
    (await readHip4Markets(pool, "mainnet", [ids[0], ids[9]], -1, 20)).length,
    2,
  );
  const token = hip4Identity("mainnet", ids[99]).sides[0].tokenId;
  assert.deepEqual(await readHip4LiveOutcomes(pool, policy, [token]), [
    ids[99],
    ids[0],
  ]);
  assert.equal(await hip4KnownStreamTokensAllowed(pool, [token], policy), true);
  assert.equal(
    await hip4KnownStreamTokensAllowed(
      pool,
      [token.replace("mainnet", "testnet")],
      policy,
    ),
    false,
  );
  assert.equal(
    await hip4KnownStreamTokensAllowed(
      pool,
      ["hyperliquid:mainnet:8999990"],
      policy,
    ),
    false,
  );
  assert.equal(
    await hip4KnownStreamTokensAllowed(pool, [token], {
      ...policy,
      catalogMode: "allowlist",
    }),
    false,
  );
  // A smaller batch is a continuation, not a total catalog cap.
  await pool.query("delete from unified_markets where id=any($1::text[])", [
    ids.map((id) => hip4Identity("mainnet", id).marketId),
  ]);
  await pool.query("delete from hip4_read_runtime where environment='mainnet'");
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyId,
    JSON.stringify({ ...policy, catalogBatchSize: 3 }),
  ]);
  for (let pass = 0; pass < 4; pass++)
    await runHip4ReadCycle(pool, async (request) => {
      if (request.type === "outcomeMeta")
        return { ...metadata, outcomes: metadata.outcomes.slice(0, 8) };
      if (request.type === "spotMetaAndAssetCtxs")
        return [base.spotMetadata, []];
      if (request.type === "l2Book")
        return { coin: request.coin, time: Date.now(), levels: [[], []] };
      if (request.type === "recentTrades") return [];
      return null;
    });
  assert.deepEqual(
    (await readHip4Markets(pool, "mainnet", null, -1, 100)).map(
      (row) => row.outcome,
    ),
    ids.slice(0, 8),
  );
  console.log(
    "HIP4 catalog PG16: full discovery, bounded provider work, paging, batch continuation, hot demand, environment and SSE access passed",
  );
} finally {
  await pool.query("delete from runtime_policies where id=$1", [policyId]);
  await pool.query("delete from unified_markets where id=any($1::text[])", [
    ids.map((id) => hip4Identity("mainnet", id).marketId),
  ]);
  await pool.query("delete from unified_events where id=any($1::text[])", [
    ids.map((id) => hip4Identity("mainnet", id).marketId),
  ]);
  await pool.query("delete from hip4_read_runtime where environment='mainnet'");
  await pool.end();
}
