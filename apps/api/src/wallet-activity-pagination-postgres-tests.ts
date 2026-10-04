// @integration
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  compareWalletActivitySummaryStats,
  fetchWalletActivitySummaries,
  fetchWalletActivitySummaryStats,
  fetchWalletActivityTopChanges,
} from "./services/wallet-activity-summary.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  activityFixtureWalletIds,
  withWalletActivityFixture,
} from "./wallet-activity-sql-fixtures.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
let checks = 0;
const fixtureClient = (boundaryTies = false) =>
  ({
    query: (sql: string, params: unknown[]) =>
      client.query(withWalletActivityFixture(sql, boundaryTies), params),
  }) as unknown as PoolClient;

try {
  await client.query("BEGIN READ ONLY");
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await client.query("SET LOCAL statement_timeout = '8s'");
  await client.query("SET LOCAL jit = off");
  for (const windowHours of [24, 168]) {
    for (const walletIds of [
      activityFixtureWalletIds,
      activityFixtureWalletIds.slice(0, 1),
      activityFixtureWalletIds.slice(-1),
      [],
    ]) {
      const options = { windowHours, topChanges: 3 };
      const all = await fetchWalletActivitySummaryStats(
        fixtureClient(),
        walletIds,
        options,
      );
      const sorted = [...all.values()]
        .filter((row) => row.lastActivityAt)
        .sort((a, b) =>
          compareWalletActivitySummaryStats(a, b, "last_activity"),
        );
      for (const page of [
        { limit: 2, offset: 0 },
        { limit: 2, offset: 2 },
        { limit: 2, offset: 5 },
        { limit: 2, offset: 100 },
      ]) {
        const actual = [
          ...(
            await fetchWalletActivitySummaryStats(
              fixtureClient(),
              walletIds,
              options,
              page,
            )
          ).values(),
        ].sort((a, b) =>
          compareWalletActivitySummaryStats(a, b, "last_activity"),
        );
        assert.deepEqual(
          actual,
          sorted.slice(page.offset, page.offset + page.limit),
        );
        checks++;
      }
      for (const topChanges of [1, 2, 3, 10]) {
        const topOptions = { ...options, topChanges };
        const legacy = await fetchWalletActivitySummaries(
          fixtureClient(),
          walletIds,
          topOptions,
        );
        const actual = await fetchWalletActivityTopChanges(
          fixtureClient(),
          walletIds,
          topOptions,
        );
        assert.deepEqual(
          actual,
          new Map([...legacy].map(([id, row]) => [id, row.topChanges])),
        );
        checks++;
      }
    }
  }
  for (const retentionDaysActivity of [0, 30]) {
    const options = {
      windowHours: 24,
      topChanges: 3,
      signalConfig: { retentionDaysActivity },
    };
    const legacy = await fetchWalletActivitySummaries(
      fixtureClient(),
      activityFixtureWalletIds,
      options,
    );
    const actual = await fetchWalletActivityTopChanges(
      fixtureClient(),
      activityFixtureWalletIds,
      options,
    );
    assert.deepEqual(
      actual,
      new Map([...legacy].map(([id, row]) => [id, row.topChanges])),
    );
    assert.equal(
      actual.get(activityFixtureWalletIds[0])?.[0].priorDistinctMarkets,
      retentionDaysActivity === 0 ? 2 : 1,
    );
    checks++;
  }
  // The legacy ORDER BY has no market-id tiebreaker. Preserve every row at
  // the boundary as eligible, rather than inventing a new tie selection rule.
  for (const topChanges of [2, 3]) {
    const options = { windowHours: 24, topChanges };
    const allLegacy = await fetchWalletActivitySummaries(
      fixtureClient(true),
      activityFixtureWalletIds,
      { ...options, topChanges: 100 },
    );
    const actual = await fetchWalletActivityTopChanges(
      fixtureClient(true),
      activityFixtureWalletIds,
      options,
    );
    for (const [walletId, changes] of actual) {
      const referenceSummary = allLegacy.get(walletId);
      assert.ok(referenceSummary);
      const reference = referenceSummary.topChanges;
      assert.equal(changes.length, Math.min(topChanges, reference.length));
      changes.forEach((change) =>
        assert.deepEqual(
          change,
          reference.find((row) => row.marketId === change.marketId),
        ),
      );
      assert.deepEqual(
        changes.map((row) => [row.stakeUsd, row.occurredAt]),
        reference
          .slice(0, topChanges)
          .map((row) => [row.stakeUsd, row.occurredAt]),
      );
    }
    checks++;
  }
  console.log(
    `wallet activity PostgreSQL equivalence: ${checks} cases passed (query-only fixtures)`,
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
