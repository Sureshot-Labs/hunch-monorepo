#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";

import { env } from "./env.js";
import type { ExecutionRow } from "./repos/executions-repo.js";
import { finalizeKalshiExecutionEffects } from "./services/kalshi-executions.js";

type MockQuery = {
  sql: string;
  params: unknown[];
};

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createPoolMock() {
  const queries: MockQuery[] = [];
  const feeEventInserts: unknown[][] = [];
  const snapshotTimes: Date[] = [];

  async function query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    const text = sql.toLowerCase();

    if (text === "begin" || text === "commit" || text === "rollback") {
      return { rows: [] };
    }
    if (text.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (
      text.includes("from referrals") &&
      text.includes("where referred_user_id")
    ) {
      return { rows: [] };
    }
    if (text.includes("from rewards_policy")) {
      if (params[0] instanceof Date) snapshotTimes.push(params[0]);
      return { rows: [] };
    }
    if (
      text.includes("from volume_events") &&
      text.includes("coalesce(sum(points_awarded)")
    ) {
      if (params[1] instanceof Date) snapshotTimes.push(params[1]);
      return { rows: [{ total: "0" }] };
    }
    if (text.includes("insert into fee_events")) {
      feeEventInserts.push(params);
      return { rows: [{ id: "fee-event-1" }] };
    }
    if (text.includes("insert into notifications")) {
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in Kalshi fee event test: ${sql}`);
  }

  const client = {
    query,
    release() {},
  };

  return {
    queries,
    feeEventInserts,
    snapshotTimes,
    pool: {
      async query(sql: string, params?: unknown[]) {
        return query(sql, params);
      },
      async connect() {
        return client;
      },
    } as unknown as Pool,
  };
}

function buildExecution(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: "execution-1",
    user_id: "00000000-0000-4000-8000-000000000001",
    wallet_address: "wallet-1",
    venue: "kalshi",
    unified_market_id: "kalshi:MARKET",
    side: "BUY",
    outcome: "YES",
    input_mint: "not-usdc",
    output_mint: "outcome-mint",
    amount_in: null,
    amount_out: null,
    input_decimals: 6,
    output_decimals: 6,
    quote_id: null,
    tx_signature: "sig-1",
    venue_order_id: null,
    status: "fulfilled",
    raw: {
      settlement: {
        fills: [{ signature: "sig-1" }],
      },
    },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function installEnv() {
  const original = {
    dflowFeeAccount: env.dflowFeeAccount,
    feeBpsKalshi: env.feeBpsKalshi,
    feeScaleKalshi: env.feeScaleKalshi,
    solanaRpcUrls: env.solanaRpcUrls,
    solanaRpcTimeoutMs: env.solanaRpcTimeoutMs,
    solanaUsdcMint: env.solanaUsdcMint,
  };

  env.dflowFeeAccount = "fee-account";
  env.feeBpsKalshi = 100;
  env.feeScaleKalshi = 0;
  env.solanaRpcUrls = ["https://solana.test"];
  env.solanaRpcTimeoutMs = 1_000;
  env.solanaUsdcMint = "usdc-mint";

  return () => {
    env.dflowFeeAccount = original.dflowFeeAccount;
    env.feeBpsKalshi = original.feeBpsKalshi;
    env.feeScaleKalshi = original.feeScaleKalshi;
    env.solanaRpcUrls = original.solanaRpcUrls;
    env.solanaRpcTimeoutMs = original.solanaRpcTimeoutMs;
    env.solanaUsdcMint = original.solanaUsdcMint;
  };
}

function installFetch(status: "finalized" | "processed") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
    };
    if (body.method === "getSignatureStatuses") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id ?? 1,
          result: {
            value: [
              {
                confirmationStatus: status,
                err: null,
              },
            ],
          },
        }),
      } as Response;
    }
    if (body.method === "getTransaction") {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id ?? 1,
          result: {
            transaction: {
              message: {
                accountKeys: ["fee-account"],
              },
            },
            meta: {
              preTokenBalances: [
                {
                  accountIndex: 0,
                  mint: "usdc-mint",
                  uiTokenAmount: { amount: "100000", decimals: 6 },
                },
              ],
              postTokenBalances: [
                {
                  accountIndex: 0,
                  mint: "usdc-mint",
                  uiTokenAmount: { amount: "223456", decimals: 6 },
                },
              ],
            },
          },
        }),
      } as Response;
    }
    throw new Error(`Unexpected RPC method: ${body.method ?? "(missing)"}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

await test("Kalshi fee event is collected-only and snapshots rewards at collection time", async () => {
  const restoreEnv = installEnv();
  const restoreFetch = installFetch("finalized");
  try {
    const { pool, feeEventInserts, snapshotTimes } = createPoolMock();
    const execution = buildExecution();

    const result = await finalizeKalshiExecutionEffects(pool, {
      execution,
      purpose: "trade",
      publishNotifications: false,
      warnOnFeeVerificationDeferral: false,
    });

    assert.equal(result.feeEventStored, true);
    assert.equal(feeEventInserts.length, 1);

    const insert = feeEventInserts[0] ?? [];
    assert.equal(insert[2], execution.id);
    assert.equal(insert[3], "0.123456");
    assert.equal(insert[9], "sig-1");
    assert.equal(insert[11], "collected");
    assert.ok(insert[10] instanceof Date);

    const collectedAt = insert[10] as Date;
    assert.notEqual(
      collectedAt.toISOString(),
      execution.created_at.toISOString(),
    );
    assert.ok(snapshotTimes.length >= 2);
    assert.ok(snapshotTimes.every((time) => time === collectedAt));
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

await test("Kalshi does not write pending fee events before collection", async () => {
  const restoreEnv = installEnv();
  const restoreFetch = installFetch("processed");
  try {
    const { pool, feeEventInserts } = createPoolMock();

    const result = await finalizeKalshiExecutionEffects(pool, {
      execution: buildExecution(),
      purpose: "trade",
      publishNotifications: false,
      warnOnFeeVerificationDeferral: false,
    });

    assert.equal(result.feeEventStored, false);
    assert.equal(feeEventInserts.length, 0);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});
