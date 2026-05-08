import assert from "node:assert/strict";
import { syncUnifiedMarketTokens } from "./unified-repo.js";

type QueryRecord = {
  sql: string;
  values?: readonly unknown[];
};

type QueryResult<Row = unknown> = {
  rows: Row[];
};

type PoolClientLike = {
  query: <Row = unknown>(
    sql: string,
    values?: readonly unknown[],
  ) => Promise<QueryResult<Row>>;
  connect: () => Promise<never>;
  release: () => void;
};

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("syncUnifiedMarketTokens reuses checked-out clients without reconnecting", async () => {
  const queries: QueryRecord[] = [];
  let connectCalled = false;

  const client: PoolClientLike = {
    async query<Row = unknown>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      queries.push({ sql, values });

      if (sql.includes("from unified_markets")) {
        return {
          rows: [
            {
              id: "hyperliquid:outcome:1",
              venue: "hyperliquid",
              token_yes: "hyperliquid:100000010",
              token_no: "hyperliquid:100000011",
              clob_token_ids: JSON.stringify([
                "hyperliquid:100000010",
                "hyperliquid:100000011",
              ]),
            },
          ],
        } as QueryResult<Row>;
      }

      return { rows: [] };
    },
    async connect(): Promise<never> {
      connectCalled = true;
      throw new Error("checked-out clients must not be reconnected");
    },
    release() {
      throw new Error(
        "syncUnifiedMarketTokens must not release caller clients",
      );
    },
  };

  await syncUnifiedMarketTokens(
    client as unknown as Parameters<typeof syncUnifiedMarketTokens>[0],
    ["hyperliquid:outcome:1"],
  );

  const normalizedSql = queries.map((query) =>
    query.sql.replace(/\s+/g, " ").trim().toLowerCase(),
  );

  assert.equal(connectCalled, false);
  assert.equal(
    normalizedSql.some((sql) => sql === "begin"),
    false,
    "caller-owned clients should not start a nested transaction",
  );
  assert.equal(
    normalizedSql.some((sql) => sql === "commit" || sql === "rollback"),
    false,
    "caller-owned clients should not commit or roll back the outer transaction",
  );
  assert.equal(
    normalizedSql.some((sql) =>
      sql.includes("insert into unified_market_tokens"),
    ),
    true,
  );
});
