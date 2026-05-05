#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import { env } from "./env.js";
import { handlePrivyDepositWebhook } from "./services/deposit-events.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

type MockDbOptions = {
  wallet?: {
    userId: string;
    walletAddress: string;
    walletType: string;
  } | null;
  bridgeOrder?: {
    id: string;
    userId: string;
  } | null;
  execution?: {
    id: string;
    userId: string;
    venue: string;
  } | null;
  depositInsertConflict?: boolean;
  existingDepositStatus?: string;
  existingDepositUserId?: string | null;
  existingNotificationId?: string | null;
};

type MockDb = DbQuery & {
  calls: Array<{ sql: string; params?: unknown[] }>;
  notificationInserts: Array<{
    type: string;
    body: string | null;
    data: unknown;
    dedupeKey: string | null;
  }>;
  depositUpdates: Array<{ status: string; eventId: string }>;
};

const basePayload = {
  type: "wallet.funds_deposited",
  wallet_id: "wallet-1",
  idempotency_key: "deposit-key-1",
  caip2: "eip155:8453",
  asset: {
    type: "erc20",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  amount: "1000000",
  transaction_hash: "0xabc",
  sender: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  block: { number: 123 },
};

function createMockDb(options: MockDbOptions): MockDb {
  const calls: MockDb["calls"] = [];
  const notificationInserts: MockDb["notificationInserts"] = [];
  const depositUpdates: MockDb["depositUpdates"] = [];

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });

    if (/from user_wallets/i.test(sql)) {
      if (!options.wallet) return { rows: [] };
      return {
        rows: [
          {
            user_id: options.wallet.userId,
            wallet_address: options.wallet.walletAddress,
            wallet_type: options.wallet.walletType,
          } as unknown as T,
        ],
      };
    }

    if (/from bridge_orders/i.test(sql)) {
      if (!options.bridgeOrder) return { rows: [] };
      return {
        rows: [
          {
            id: options.bridgeOrder.id,
            user_id: options.bridgeOrder.userId,
            provider: "debridge",
            status: "fulfilled",
            swap_type: "same_chain",
          } as unknown as T,
        ],
      };
    }

    if (/from executions/i.test(sql)) {
      if (!options.execution) return { rows: [] };
      return {
        rows: [
          {
            id: options.execution.id,
            user_id: options.execution.userId,
            venue: options.execution.venue,
            status: "fulfilled",
          } as unknown as T,
        ],
      };
    }

    if (/insert into deposit_events/i.test(sql)) {
      if (options.depositInsertConflict) return { rows: [] };
      return {
        rows: [
          {
            id: "deposit-event-1",
            source: "privy",
            source_event_type: params?.[0],
            source_idempotency_key: params?.[1],
            user_id: params?.[3] ?? null,
            status: params?.[13],
          } as unknown as T,
        ],
      };
    }

    if (/from deposit_events/i.test(sql)) {
      return {
        rows: [
          {
            id: "deposit-event-existing",
            source: "privy",
            source_event_type: "wallet.funds_deposited",
            source_idempotency_key: params?.[0],
            user_id: options.existingDepositUserId ?? null,
            status: options.existingDepositStatus ?? "recorded",
          } as unknown as T,
        ],
      };
    }

    if (/insert into notifications/i.test(sql)) {
      const type = typeof params?.[1] === "string" ? params[1] : "";
      const body = typeof params?.[3] === "string" ? params[3] : null;
      const data = params?.[5];
      const dedupeKey = typeof params?.[6] === "string" ? params[6] : null;
      notificationInserts.push({ type, body, data, dedupeKey });
      if (options.existingNotificationId) return { rows: [] };
      return {
        rows: [
          {
            id: "notification-1",
            user_id: params?.[0],
            type,
            title: params?.[2],
            body: params?.[3],
            severity: params?.[4],
            data: params?.[5],
            read_at: null,
            created_at: new Date("2026-04-26T00:00:00Z"),
            updated_at: new Date("2026-04-26T00:00:00Z"),
          } as unknown as T,
        ],
      };
    }

    if (/from notifications/i.test(sql)) {
      if (!options.existingNotificationId) return { rows: [] };
      return { rows: [{ id: options.existingNotificationId } as unknown as T] };
    }

    if (/update deposit_events/i.test(sql)) {
      const status = sql.includes("status = 'notified'")
        ? "notified"
        : typeof params?.[1] === "string"
          ? params[1]
          : "unknown";
      depositUpdates.push({
        eventId: typeof params?.[0] === "string" ? params[0] : "",
        status,
      });
      return { rows: [] };
    }

    throw new Error(`Unexpected query in deposit-events test: ${sql}`);
  };

  return {
    query: query as DbQuery["query"],
    calls,
    notificationInserts,
    depositUpdates,
  };
}

async function withRedisDisabled(fn: () => Promise<void>): Promise<void> {
  const originalRedisUrl = env.redisUrl;
  env.redisUrl = "";
  try {
    await fn();
  } finally {
    env.redisUrl = originalRedisUrl;
  }
}

const tests: TestCase[] = [
  {
    name: "resolved Privy deposit records event and creates notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
        });

        const result = await handlePrivyDepositWebhook(db, basePayload);

        assert.deepEqual(result, {
          ok: true,
          duplicate: false,
          notified: true,
          status: "notified",
        });
        assert.deepEqual(db.notificationInserts, [
          {
            type: "deposit_received",
            body: "1 USDC deposit received on Base",
            data: {
              category: "system",
              source: "privy",
              walletAddress: basePayload.recipient,
              walletType: "ethereum",
              caip2: "eip155:8453",
              network: "base",
              asset: basePayload.asset,
              amountRaw: "1000000",
              amountLabel: "1 USDC",
              amountUsd: 1,
              txHash: "0xabc",
            },
            dedupeKey: "deposit:privy:deposit-key-1",
          },
        ]);
        assert.deepEqual(
          db.depositUpdates.map((update) => update.status),
          ["notified"],
        );
      });
    },
  },
  {
    name: "bridge-matched Privy deposit records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
          bridgeOrder: { id: "bridge-1", userId: "user-1" },
        });

        const result = await handlePrivyDepositWebhook(db, basePayload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "venue cash movement records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
        });
        const payload = {
          ...basePayload,
          caip2: "eip155:137",
          asset: {
            type: "erc20",
            address: env.polymarketPusdAddress,
          },
          sender: env.polymarketExchangeAddress,
          idempotency_key: "deposit-key-polymarket-sell",
        };

        const result = await handlePrivyDepositWebhook(db, payload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_venue");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "DFlow execution-matched Solana deposit records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "5CnexXV3q3B4kDRev36fdMUoCpP4qFmS7PKXNpZrgL3H";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          execution: {
            id: "execution-1",
            userId: "user-1",
            venue: "kalshi",
          },
        });
        const payload = {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          sender: "dflow-token-account",
          recipient: solanaWallet,
          transaction_hash: "solana-signature-1",
          idempotency_key: "deposit-key-dflow-sell",
        };

        const result = await handlePrivyDepositWebhook(db, payload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_venue");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "pUSD Privy deposit uses precise asset and Polygon label",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
        });
        const pusdPayload = {
          ...basePayload,
          caip2: "eip155:137",
          asset: {
            type: "erc20",
            address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
          },
          amount: "5000000",
          idempotency_key: "deposit-key-pusd",
        };

        const result = await handlePrivyDepositWebhook(db, pusdPayload);

        assert.equal(result.ok, true);
        assert.equal(result.notified, true);
        assert.equal(
          db.notificationInserts[0]?.body,
          "5 pUSD deposit received on Polygon",
        );
        assert.deepEqual(db.notificationInserts[0]?.data, {
          category: "system",
          source: "privy",
          walletAddress: basePayload.recipient,
          walletType: "ethereum",
          caip2: "eip155:137",
          network: "polygon",
          asset: pusdPayload.asset,
          amountRaw: "5000000",
          amountLabel: "5 pUSD",
          amountUsd: 5,
          txHash: "0xabc",
        });
      });
    },
  },
  {
    name: "duplicate recorded event retries notification and marks notified",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
          depositInsertConflict: true,
          existingDepositStatus: "recorded",
        });

        const result = await handlePrivyDepositWebhook(db, basePayload);

        assert.equal(result.duplicate, true);
        assert.equal(result.notified, true);
        assert.equal(result.status, "notified");
        assert.deepEqual(
          db.depositUpdates.map((update) => update.status),
          ["recorded", "notified"],
        );
      });
    },
  },
  {
    name: "wrapped Privy event/data payload is accepted",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          event: "wallet.funds_deposited",
          data: { ...basePayload, type: undefined },
        });

        assert.equal(result.ok, true);
        assert.equal(result.notified, true);
      });
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
    console.log(`ok - ${test.name}`);
  } catch (error) {
    console.error(`not ok - ${test.name}`);
    throw error;
  }
}

console.log(`[deposit-events-tests] passed ${passed}/${tests.length}`);
