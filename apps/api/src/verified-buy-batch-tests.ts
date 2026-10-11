import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  EvidenceBudgetExhausted,
  repairVerifiedBuys,
  type ClaimedPurchase,
  type PurchaseObservation,
} from "./services/verified-buy.js";

type Kind = "order" | "execution";
type FixtureRow = { id: string; kind: Kind; leased: boolean };
function batchFixture(orderCount: number, executionCount: number) {
  const rows: FixtureRow[] = [
    ...Array.from({ length: orderCount }, (_, index) => ({
      id: `order-${index}`,
      kind: "order" as const,
      leased: false,
    })),
    ...Array.from({ length: executionCount }, (_, index) => ({
      id: `execution-${index}`,
      kind: "execution" as const,
      leased: false,
    })),
  ];
  const claimQueries: Array<{ kind: Kind; limit: number; seenIds: string[] }> =
    [];
  const storedIds: string[] = [];
  const retryDelays: number[] = [];
  const db = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes("with due_purchase")) {
        const kind = sql.includes("from orders") ? "order" : "execution";
        const limit = values[0] as number;
        const seenIds = values[2] as string[];
        assert.match(sql, /not \(id = any\(\$3::uuid\[\]\)\)/);
        assert.ok(Array.isArray(seenIds));
        claimQueries.push({ kind, limit, seenIds: [...seenIds] });
        const claimed = rows
          .filter(
            (row) =>
              row.kind === kind && !row.leased && !seenIds.includes(row.id),
          )
          .slice(0, limit);
        for (const row of claimed) row.leased = true;
        return {
          rows: claimed.map((row) => ({
            id: row.id,
            user_id: "fixture-user",
            verified_buy_lease_token: `lease-${row.id}`,
            verified_buy_attempts: 1,
          })),
        };
      }
      assert.ok(sql.startsWith("with stored_purchase"));
      const row = rows.find((entry) => entry.id === values[0]);
      assert.ok(row?.leased);
      // Pretend the retry already became due during a slow run. The bounded
      // exclusions, not an application clock or arbitrary delay, prevent churn.
      row.leased = false;
      storedIds.push(row.id);
      retryDelays.push(values[4] as number);
      return { rows: [{ id: row.id }] };
    },
  } as unknown as Pick<Pool, "query">;
  return { db, claimQueries, storedIds, retryDelays };
}

const policy = {
  batchSize: 50,
  concurrency: 2,
  leaseSeconds: 120,
  retrySeconds: 30,
  verifiedRecheckSeconds: 3600,
};
const pending = async (): Promise<PurchaseObservation> => ({
  state: "pending",
  reason: "fixture_pending",
});
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) =>
  tests.push([name, run]);

test("repair fills the total batch in round-robin chunks without exceeding concurrency", async () => {
  const fixture = batchFixture(30, 30);
  const seen: ClaimedPurchase[] = [];
  let active = 0,
    maxActive = 0;
  const result = await repairVerifiedBuys(fixture.db, {
    ...policy,
    observe: async (claim) => {
      seen.push(claim);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return pending();
    },
  });
  assert.equal(result.claimed, 50);
  assert.equal(result.pending, 50);
  assert.equal(maxActive, 2);
  assert.equal(new Set(fixture.storedIds).size, 50);
  assert.equal(fixture.claimQueries.length, 25);
  assert.deepEqual(
    fixture.claimQueries.map((query) => query.kind),
    Array.from({ length: 25 }, (_, index) =>
      index % 2 === 0 ? "order" : "execution",
    ),
  );
  assert.ok(
    fixture.claimQueries.every((query) => query.limit <= policy.concurrency),
  );
  assert.equal(
    seen.filter((claim) => claim.purchaseRef.kind === "order").length,
    26,
  );
  assert.equal(
    seen.filter((claim) => claim.purchaseRef.kind === "execution").length,
    24,
  );
});

test("repair uses a partial final chunk without exceeding the total batch", async () => {
  const fixture = batchFixture(10, 10);
  const result = await repairVerifiedBuys(fixture.db, {
    ...policy,
    batchSize: 7,
    observe: pending,
  });
  assert.equal(result.claimed, 7);
  assert.deepEqual(
    fixture.claimQueries.map((query) => query.limit),
    [2, 2, 2, 1],
  );
  assert.deepEqual(fixture.storedIds, [
    "order-0",
    "order-1",
    "execution-0",
    "execution-1",
    "order-2",
    "order-3",
    "execution-2",
  ]);
});

test("repair drains available work once even when retries become due during the run", async () => {
  const fixture = batchFixture(5, 3);
  const result = await repairVerifiedBuys(fixture.db, {
    ...policy,
    observe: pending,
  });
  assert.equal(result.claimed, 8);
  assert.equal(new Set(fixture.storedIds).size, 8);
  assert.deepEqual(
    fixture.claimQueries.map((query) => query.kind),
    ["order", "execution", "order", "execution", "order", "execution", "order"],
  );
  assert.equal(fixture.claimQueries.at(-1)?.seenIds.length, 5);
});

test("repair continues the nonempty kind after the other queue is drained", async () => {
  for (const [orders, executions] of [
    [5, 0],
    [0, 5],
  ] as const) {
    const fixture = batchFixture(orders, executions);
    const result = await repairVerifiedBuys(fixture.db, {
      ...policy,
      observe: pending,
    });
    assert.equal(result.claimed, 5);
    assert.equal(
      fixture.claimQueries.filter(
        (query) => query.kind === (orders ? "execution" : "order"),
      ).length,
      1,
    );
    assert.equal(new Set(fixture.storedIds).size, 5);
  }
});

test("repair stops claiming after the current chunk exhausts the shared provider budget", async () => {
  const fixture = batchFixture(30, 30);
  let remainingBudget = 7,
    spent = 0;
  const result = await repairVerifiedBuys(fixture.db, {
    ...policy,
    observe: async () => {
      if (remainingBudget < 3)
        throw new EvidenceBudgetExhausted(3, remainingBudget);
      remainingBudget -= 3;
      spent += 3;
      return pending();
    },
  });
  assert.equal(spent, 6);
  assert.equal(result.claimed, 4);
  assert.equal(result.budgetExhausted, 2);
  assert.equal(fixture.claimQueries.length, 2);
  assert.deepEqual(
    fixture.claimQueries.map((query) => query.kind),
    ["order", "execution"],
  );
  assert.equal(fixture.storedIds.length, 4);
  assert.deepEqual(fixture.retryDelays, [30, 30, 30, 30]);
});

test("repair validates concurrency before claiming any work", async () => {
  for (const concurrency of [0, -1, 1.5]) {
    const fixture = batchFixture(1, 1);
    await assert.rejects(
      repairVerifiedBuys(fixture.db, {
        ...policy,
        concurrency,
        observe: pending,
      }),
      /Invalid verification policy/,
    );
    assert.equal(fixture.claimQueries.length, 0);
  }
});

for (const [name, run] of tests) {
  await run();
  console.log(`✓ ${name}`);
}
console.log(`Verified buy batching: ${tests.length} checks passed`);
