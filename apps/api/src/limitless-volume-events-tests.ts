#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  normalizeLimitlessVolumeSourceId,
  recordLimitlessVolumeEvent,
} from "./services/limitless-volume-events.js";

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createRewardsPoolMock() {
  const inserts: unknown[][] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      const text = sql.toLowerCase();
      if (
        text === "begin" ||
        text === "commit" ||
        text === "rollback" ||
        text.includes("pg_advisory_xact_lock")
      ) {
        return { rows: [] };
      }
      if (text.includes("from rewards_multiplier_user_overrides")) {
        return { rows: [] };
      }
      if (text.includes("from rewards_multiplier_policy")) {
        return {
          rows: [
            {
              global_multiplier: "1",
              referral_rules: [],
              tier_rules: [],
            },
          ],
        };
      }
      if (
        text.includes("from volume_events") &&
        text.includes("coalesce(sum(") &&
        text.includes("as total")
      ) {
        return { rows: [{ total: "0" }] };
      }
      if (text.includes("from referrals")) {
        return { rows: [{ total: "0" }] };
      }
      if (text.includes("insert into volume_events")) {
        inserts.push(params ?? []);
        return { rows: [{ id: "volume-event-1" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  return {
    inserts,
    pool: {
      async connect() {
        return client;
      },
    } as unknown as Pool,
  };
}

await test("normalizeLimitlessVolumeSourceId prefixes source ids once", () => {
  assert.equal(
    normalizeLimitlessVolumeSourceId("history:0xabc:0:buy"),
    "limitless:history:0xabc:0:buy",
  );
  assert.equal(
    normalizeLimitlessVolumeSourceId("limitless:amm:0xabc:limitless:123"),
    "limitless:amm:0xabc:limitless:123",
  );
  assert.equal(normalizeLimitlessVolumeSourceId("   "), null);
});

await test("recordLimitlessVolumeEvent writes a Limitless order volume event", async () => {
  const { pool, inserts } = createRewardsPoolMock();
  const inserted = await recordLimitlessVolumeEvent(pool, {
    userId: "00000000-0000-4000-8000-000000000001",
    walletAddress: "0x17cac6e4b08c8d95a2890a8df7cb0e7d83711387",
    sourceId: "history:0xabc:0:buy",
    notionalUsd: 1.23,
    createdAt: new Date("2026-05-17T20:00:00.000Z"),
  });

  assert.equal(inserted, 1);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][2], "limitless");
  assert.equal(inserts[0][3], "order");
  assert.equal(inserts[0][4], "limitless:history:0xabc:0:buy");
  assert.equal(inserts[0][5], 1.23);
});

await test("recordLimitlessVolumeEvent ignores empty or zero events", async () => {
  const { pool, inserts } = createRewardsPoolMock();
  assert.equal(
    await recordLimitlessVolumeEvent(pool, {
      userId: "00000000-0000-4000-8000-000000000001",
      walletAddress: null,
      sourceId: "history:0xabc:0:buy",
      notionalUsd: 0,
      createdAt: new Date(),
    }),
    0,
  );
  assert.equal(
    await recordLimitlessVolumeEvent(pool, {
      userId: "00000000-0000-4000-8000-000000000001",
      walletAddress: null,
      sourceId: "",
      notionalUsd: 1,
      createdAt: new Date(),
    }),
    0,
  );
  assert.equal(inserts.length, 0);
});
