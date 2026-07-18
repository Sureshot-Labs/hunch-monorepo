#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import { repairLimitlessFokOrdersFromStoredExecution } from "./services/limitless-trading-execution-service.js";

let updateCount = 0;
let capturedSelectParams: unknown[] = [];
let capturedSelectSql = "";
let capturedUpdateParams: unknown[] = [];
let capturedUpdateSql = "";
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    if (/as upstream_payload/i.test(sql) && /from orders/i.test(sql)) {
      capturedSelectSql = sql;
      capturedSelectParams = params ?? [];
      return {
        rowCount: 1,
        rows: [
          {
            id: "order-1",
            order_hash: null,
            price: "0.40",
            size: "2.28",
            upstream_payload: {
              execution: {
                matched: true,
                settlementStatus: "MINED",
                totalsRaw: {
                  contractsGross: "2280000",
                  usdGross: "841320",
                },
                txHash: "0xterminal",
              },
            },
          },
        ],
      };
    }
    if (/set status = 'filled'/i.test(sql)) {
      capturedUpdateSql = sql;
      capturedUpdateParams = params ?? [];
      updateCount += 1;
      return {
        rowCount: updateCount === 1 ? 1 : 0,
        rows: updateCount === 1 ? [{ id: "order-1" }] : [],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  },
} as unknown as Pool;

const input = {
  pool,
  userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
  walletAddress: "0x0000000000000000000000000000000000000001",
  marketSlug: "sol-up-or-down-daily-1784304000",
};

assert.equal(await repairLimitlessFokOrdersFromStoredExecution(input), 1);
assert.equal(await repairLimitlessFokOrdersFromStoredExecution(input), 0);
assert.equal(capturedSelectParams[3], 100);
assert.match(capturedSelectSql, /'submitted'->'payload'->>'marketSlug'/i);
assert.match(capturedUpdateSql, /lower\(coalesce\(status, ''\)\) in/i);
assert.match(capturedUpdateSql, /settlementStatus/i);
assert.equal(capturedUpdateParams[1], 0.369);
assert.equal(capturedUpdateParams[2], 2.28);
assert.equal(capturedUpdateParams[4], "0xterminal");
console.log(
  "ok - terminal stored FOK execution repair is bounded and idempotent",
);
