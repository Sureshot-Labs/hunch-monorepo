import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "@hunch/infra";
import {
  fundingEvidenceBudgetClient,
  FundingEvidenceBudgetExpiredError,
  setFundingEvidenceQueryBudget,
  fundingEvidencePageToken,
  fundingEvidenceReadDeadline,
  withFundingEvidenceReadBudget,
} from "../../reconciliation/funding-evidence-budget.js";

test("bounded page identities are stable and remain scoped to their existing lease/event/item", () => {
  const root = {
    progressToken: "00000000-0000-4000-8000-000000000001",
    eventFingerprint: "e".repeat(64),
    pageOrdinal: 0,
  };
  const token = fundingEvidencePageToken(root);
  assert.match(
    token,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(fundingEvidencePageToken(root), token);
  assert.notEqual(fundingEvidencePageToken({ ...root, pageOrdinal: 1 }), token);
  assert.notEqual(
    fundingEvidencePageToken({
      ...root,
      progressToken: "00000000-0000-4000-8000-000000000002",
    }),
    token,
  );
  assert.notEqual(
    fundingEvidencePageToken({ ...root, eventFingerprint: "d".repeat(64) }),
    token,
  );
  assert.throws(
    () => fundingEvidencePageToken({ ...root, pageOrdinal: -1 }),
    /page ordinal/,
  );
});

test("provider reads use the existing half-lease split, never a fresh fixed timeout", () => {
  assert.equal(fundingEvidenceReadDeadline(300, 100), 200);
  assert.equal(fundingEvidenceReadDeadline(300, 200), 250);
  assert.equal(fundingEvidenceReadDeadline(300, 300), 300);
  assert.equal(fundingEvidenceReadDeadline(300, 400), 400);
  assert.throws(
    () => fundingEvidenceReadDeadline(Infinity, 100),
    FundingEvidenceBudgetExpiredError,
  );
});

test("short evidence DB reads release their transaction before transport and expire safely after borrowing", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const statements: string[] = [];
  let releases = 0;
  let borrowDelay = 0;
  const pool = {
    connect: async () => {
      now += borrowDelay;
      return {
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [] };
        },
        release: () => {
          releases++;
        },
      };
    },
  } as unknown as import("@hunch/infra").Pool;
  await withFundingEvidenceReadBudget(pool, 200, async (db) => {
    await db.query("select 1");
  });
  assert.deepEqual(
    statements.filter((sql) => !sql.includes("set_config")),
    ["begin", "select 1", "commit"],
  );
  assert.equal(releases, 1);
  statements.length = 0;
  borrowDelay = 100;
  await assert.rejects(
    withFundingEvidenceReadBudget(pool, 200, async (db) => {
      await db.query("select 2");
    }),
    FundingEvidenceBudgetExpiredError,
  );
  assert.deepEqual(statements, ["begin", "rollback"]);
  assert.equal(releases, 2);
});

test("existing deadline shrinks query/lock timeouts and cannot prevent raw cleanup", async () => {
  const statements: { sql: string; values?: unknown[] }[] = [];
  let time = 100;
  const raw = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const bounded = fundingEvidenceBudgetClient(raw, 200, () => time);
  await bounded.query("select 1");
  assert.deepEqual(statements[0].values, ["100"]);
  assert.ok(statements[0].sql.includes("set_config('lock_timeout'"));
  time = 175;
  await bounded.query("select 2");
  assert.deepEqual(statements[2].values, ["25"]);
  time = 200;
  const before = statements.length;
  await assert.rejects(
    bounded.query("select 3"),
    FundingEvidenceBudgetExpiredError,
  );
  assert.equal(statements.length, before);
  await raw.query("rollback");
  assert.equal(statements.at(-1)?.sql, "rollback");
  // A normal later job's fresh deadline recovers without clearing state.
  await fundingEvidenceBudgetClient(raw, 300, () => time).query("select 4");
  assert.deepEqual(statements.at(-2)?.values, ["100"]);
});

test("invalid budgets fail before IO; final F/COMMIT has no intervening budget query", async () => {
  const statements: string[] = [];
  const raw = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  for (const invalid of [NaN, Infinity, -1, 100])
    await assert.rejects(
      setFundingEvidenceQueryBudget(raw, invalid, () => 100),
      FundingEvidenceBudgetExpiredError,
    );
  assert.equal(statements.length, 0);
  await setFundingEvidenceQueryBudget(raw, 200, () => 100);
  await raw.query("select funding_classification_fence('[]')");
  await raw.query("commit");
  assert.deepEqual(statements.slice(1), [
    "select funding_classification_fence('[]')",
    "commit",
  ]);
});
