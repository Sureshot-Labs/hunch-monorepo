import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryRepository,
  DISCOVERY_SMART_INPUTS_SQL,
} from "./repos/discovery.js";
import { DiscoveryBuilder } from "./services/discovery-builder.js";
import {
  discoveryTestNow,
  discoveryTestScope,
  discoveryTestWallet,
} from "./discovery-test-fixtures.js";

test("failed Smart Money batch is split and checkpointed without repeating completed inputs", async () => {
  const requests: string[][] = [];
  const seen = new Set<string>();
  let limit = 40;
  const repo = new DiscoveryRepository({} as never);
  repo.query = async (sql, params) => {
    assert.equal(sql, DISCOVERY_SMART_INPUTS_SQL);
    assert.equal(params[1], new Date(discoveryTestNow).toISOString());
    const ids = params[0] as string[];
    requests.push(ids);
    if (ids.length > limit)
      throw Object.assign(Error("fixture timeout"), { code: "57014" });
    for (const id of ids) {
      assert.ok(!seen.has(id), "completed wallet was re-read");
      seen.add(id);
    }
    return [
      {
        positions: ids.map((wallet_id) => ({
          wallet_id,
          venue: "limitless",
          market_id: "limitless:m",
          side: "YES",
          shares: "10",
          value_usd: "5",
          snapshot_at: new Date(discoveryTestNow).toISOString(),
        })),
        changes: [],
      },
    ];
  };
  const builder = new DiscoveryBuilder(repo, "0xctf", () => discoveryTestNow);
  let progress = await builder.start("smart-money", discoveryTestScope, null);
  progress.phase = "positions";
  progress.wallets = Array.from({ length: 520 }, (_, i) =>
    discoveryTestWallet(String(i)),
  );
  let checkpoints = 0;
  while (progress.phase === "positions") {
    const before = progress.position;
    const step = await builder.step(progress, discoveryTestScope);
    assert.equal(
      step.snapshot,
      undefined,
      "partial inputs must not publish a pool",
    );
    progress = JSON.parse(JSON.stringify(step.progress));
    checkpoints++;
    if (progress.position === before && progress.phase === "positions")
      assert.ok(
        (progress.positionBatchSize ?? 500) < (requests.at(-1)?.length ?? 0),
      );
    if (seen.size > 200) limit = 500;
    assert.ok(checkpoints < 100);
  }
  assert.equal(seen.size, 520);
  assert.equal(requests[0].length, 500);
  assert.equal(progress.phase, "cards");
});
test("non-timeout and single-wallet failures retain position and have a retry path", async () => {
  const repo = new DiscoveryRepository({} as never),
    builder = new DiscoveryBuilder(repo, "0xctf", () => discoveryTestNow);
  const progress = await builder.start("smart-money", discoveryTestScope, null);
  progress.phase = "positions";
  progress.wallets = [discoveryTestWallet("one")];
  for (const code of ["08006", "57014"]) {
    repo.query = async () => {
      throw Object.assign(Error("fixture"), { code });
    };
    await assert.rejects(builder.step(progress, discoveryTestScope));
    assert.equal(progress.position, 0);
    assert.equal(progress.positions.length, 0);
  }
  repo.query = async () => [{ positions: [], changes: [] }];
  assert.equal(
    (await builder.step(progress, discoveryTestScope)).progress.phase,
    "cards",
  );
});
