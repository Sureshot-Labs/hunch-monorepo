import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { createVerifiedRepairLaneRunner } from "./services/verified-repair-lanes.js";
import { repairUnrecordedCopies } from "./services/verified-copy-repair.js";
import { EvidenceBudgetExhausted } from "./services/verified-buy.js";
import type { VerifiedBuyObserverDependencies } from "./services/verified-buy-observer.js";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) =>
  tests.push([name, run]);
test("full-backlog lanes alternate full unsplit budget turns without claiming the exhausted lane", async () => {
  const runLanes = createVerifiedRepairLaneRunner();
  const turns: string[] = [];
  for (let run = 0; run < 4; run++) {
    let remaining = 100;
    const calls: string[] = [];
    const fullProof = async (lane: string) => {
      calls.push(lane);
      assert.equal(
        remaining,
        100,
        "One proof can use the entire configured allowance",
      );
      remaining -= 100;
      return 1;
    };
    const result = await runLanes({
      purchases: () => fullProof("purchases"),
      copies: () => fullProof("copies"),
      hasBudget: () => remaining > 0,
    });
    turns.push(result.firstLane);
    assert.deepEqual(calls, [result.firstLane]);
    assert.equal(result[result.firstLane], 1);
    assert.equal(
      result[result.firstLane === "copies" ? "purchases" : "copies"],
      null,
    );
    assert.equal(remaining, 0);
  }
  assert.deepEqual(turns, ["copies", "purchases", "copies", "purchases"]);
});
test("unused and partially used first-lane budget remains available to the other lane", async () => {
  for (const spentByCopies of [0, 40]) {
    const runLanes = createVerifiedRepairLaneRunner();
    let remaining = 100;
    const result = await runLanes({
      copies: async () => {
        remaining -= spentByCopies;
        return spentByCopies;
      },
      purchases: async () => {
        assert.equal(remaining, 100 - spentByCopies);
        const spent = remaining;
        remaining = 0;
        return spent;
      },
      hasBudget: () => remaining > 0,
    });
    assert.equal((result.copies ?? 0) + (result.purchases ?? 0), 100);
    assert.equal(remaining, 0);
  }
});
test("a failed lane does not monopolize first turn on the next run", async () => {
  const runLanes = createVerifiedRepairLaneRunner();
  await assert.rejects(
    runLanes({
      copies: async () => {
        throw new Error("fixture failure");
      },
      purchases: async () => "purchase",
      hasBudget: () => true,
    }),
    /fixture failure/,
  );
  const calls: string[] = [];
  const result = await runLanes({
    purchases: async () => {
      calls.push("purchases");
      return 1;
    },
    copies: async () => {
      calls.push("copies");
      return 1;
    },
    hasBudget: () => true,
  });
  assert.equal(result.firstLane, "purchases");
  assert.deepEqual(calls, ["purchases", "copies"]);
});

const owner = `0x${"1".repeat(40)}`,
  position = `0x${"2".repeat(40)}`;
const policy = {
  batchSize: 50,
  concurrency: 2,
  leaseSeconds: 120,
  retrySeconds: 30,
  recheckSeconds: 3600,
};
function copiesFixture(count: number, requestBudget = 100) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `copy-${index}`,
    copier_user_id: "fixture-user",
    provider_reference: `limitless:clob:8453:client-${index}`,
    repair_lease_token: `lease-${index}`,
    instrument: {
      venue: "limitless",
      marketId: "limitless:market",
      tokenId: "limitless:123",
      outcome: "YES",
      generation: `8453:${position}:limitless:123`,
      expiry: null,
    },
    source_snapshot: { submission: { walletAddress: owner } },
  }));
  const queries: Array<{ limit: number; seen: string[] }> = [];
  const saved: Array<{ id: string; delay: number }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes("with due_copy")) {
        const seen = values[2] as string[];
        assert.match(sql, /not \(id = any\(\$3::uuid\[\]\)\)/);
        queries.push({ limit: values[0] as number, seen: [...seen] });
        return {
          rows: rows
            .filter((row) => !seen.includes(row.id))
            .slice(0, values[0] as number),
        };
      }
      if (sql.includes("from unified_markets market_row")) {
        assert.deepEqual(values, ["limitless:market", "limitless:123", "YES"]);
        return { rows: [{ metadata: {}, expiration_time: null }] };
      }
      assert.match(sql, /^update copy_attributions/);
      saved.push({ id: values[0] as string, delay: values[6] as number });
      return { rows: [{ state: "pending" }] };
    },
  } as unknown as Pool;
  let remaining = requestBudget,
    active = 0,
    maxActive = 0,
    requests = 0;
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 100,
    limitlessPositionContract: position,
    limitlessExchangeAddress: owner,
    solanaCollateralMint: "usd",
    readLimitlessOrder: async () => {
      if (remaining <= 0) throw new EvidenceBudgetExhausted(1, remaining);
      remaining--;
      requests++;
      active++;
      maxActive = Math.max(active, maxActive);
      await Promise.resolve();
      active--;
      return { status: "not_found" };
    },
    readEvmReceipt: async () => {
      throw new Error("Unexpected receipt read");
    },
    readPolymarketFills: async () => [],
    readDflowOrder: async () => null,
    readFinalizedSolanaTransaction: async () => null,
  };
  return {
    pool,
    deps,
    queries,
    saved,
    stats: () => ({ requests, remaining, maxActive }),
  };
}
test("unrecorded-copy repair honors the total batch with bounded concurrency and no same-run repeats", async () => {
  const fixture = copiesFixture(60);
  const result = await repairUnrecordedCopies(
    fixture.pool,
    fixture.deps,
    policy,
  );
  assert.equal(result.checked, 50);
  assert.equal(result.pending, 50);
  assert.equal(fixture.queries.length, 25);
  assert.equal(new Set(fixture.saved.map((row) => row.id)).size, 50);
  assert.equal(fixture.stats().maxActive, 2);
  assert.ok(fixture.queries.every((query) => query.limit === 2));
});
test("unrecorded-copy repair stops at an empty tail and bounds a partial final chunk", async () => {
  for (const batchSize of [7, 50]) {
    const fixture = copiesFixture(9);
    const result = await repairUnrecordedCopies(fixture.pool, fixture.deps, {
      ...policy,
      batchSize,
    });
    assert.equal(result.checked, Math.min(batchSize, 9));
    assert.equal(
      new Set(fixture.saved.map((row) => row.id)).size,
      result.checked,
    );
    assert.ok(fixture.queries.every((query) => query.seen.length <= batchSize));
    if (batchSize === 7) assert.equal(fixture.queries.at(-1)?.limit, 1);
  }
});
test("unrecorded-copy budget exhaustion stops new chunks and uses normal retry instead of hourly recheck", async () => {
  const fixture = copiesFixture(60, 3);
  const result = await repairUnrecordedCopies(
    fixture.pool,
    fixture.deps,
    policy,
  );
  assert.equal(result.checked, 4);
  assert.equal(result.budgetExhausted, 1);
  assert.equal(fixture.queries.length, 2);
  assert.equal(fixture.stats().requests, 3);
  assert.equal(fixture.stats().remaining, 0);
  assert.ok(fixture.saved.every((row) => row.delay === policy.retrySeconds));
});
test("unrecorded-copy repair validates batch policy before querying", async () => {
  const fixture = copiesFixture(1);
  await assert.rejects(
    repairUnrecordedCopies(fixture.pool, fixture.deps, {
      ...policy,
      concurrency: 0,
    }),
    /Invalid verification policy/,
  );
  assert.equal(fixture.queries.length, 0);
});
for (const [name, run] of tests) {
  await run();
  console.log(`✓ ${name}`);
}
console.log(`Verified repair lanes: ${tests.length} checks passed`);
