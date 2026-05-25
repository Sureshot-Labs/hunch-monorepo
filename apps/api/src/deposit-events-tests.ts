#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import { env } from "./env.js";
import { handlePrivyDepositWebhook } from "./services/deposit-events.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

type MockWallet = {
  userId: string;
  walletAddress: string;
  walletType: string;
};

type MockBridgeOrder = {
  id: string;
  userId: string;
  provider?: string;
  status?: string;
  swapType?: string;
  srcChainId?: string;
  dstChainId?: string;
  dstToken?: string;
  orderId?: string | null;
  txHashSrc?: string | null;
  txHashDst?: string | null;
  expectedOutputAmount?: string | null;
  matchByTxHash?: boolean;
  matchByIntent?: boolean;
};

type MockDbOptions = {
  wallet?: MockWallet | null;
  wallets?: MockWallet[];
  venueCredential?: {
    userId: string;
    walletAddress: string;
    funderAddress: string;
  } | null;
  bridgeOrder?: MockBridgeOrder | null;
  bridgeOrders?: MockBridgeOrder[];
  execution?: {
    id: string;
    userId: string;
    venue: string;
    match?: "any" | "exact" | "settlement";
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
  bridgeUpdates: Array<{
    id: string | null;
    txHashDst: string | null;
    status: string | null;
  }>;
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

function normalizeMockWalletAddress(walletType: string, address: string) {
  return walletType === "solana" ? address : address.toLowerCase();
}

function normalizeMockTxHash(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function mockTxHashMatches(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  return normalizeMockTxHash(left) === normalizeMockTxHash(right);
}

function mockBridgeRow(bridgeOrder: MockBridgeOrder) {
  return {
    id: bridgeOrder.id,
    user_id: bridgeOrder.userId,
    provider: bridgeOrder.provider ?? "debridge",
    status: bridgeOrder.status ?? "fulfilled",
    swap_type: bridgeOrder.swapType ?? "same_chain",
    src_chain_id: bridgeOrder.srcChainId ?? "137",
    dst_chain_id: bridgeOrder.dstChainId ?? "8453",
    order_id: bridgeOrder.orderId ?? "bridge-order-1",
    tx_hash_src: bridgeOrder.txHashSrc ?? "0xsource",
    tx_hash_dst: bridgeOrder.txHashDst ?? null,
  };
}

function createMockDb(options: MockDbOptions): MockDb {
  const calls: MockDb["calls"] = [];
  const notificationInserts: MockDb["notificationInserts"] = [];
  const depositUpdates: MockDb["depositUpdates"] = [];
  const bridgeUpdates: MockDb["bridgeUpdates"] = [];

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });

    if (/from user_wallets/i.test(sql)) {
      const walletType = typeof params?.[0] === "string" ? params[0] : "";
      const walletAddressNorm =
        typeof params?.[1] === "string" ? params[1] : "";
      const wallets = [
        ...(options.wallet ? [options.wallet] : []),
        ...(options.wallets ?? []),
      ];
      const wallet = wallets.find(
        (candidate) =>
          candidate.walletType === walletType &&
          normalizeMockWalletAddress(
            candidate.walletType,
            candidate.walletAddress,
          ) === walletAddressNorm,
      );
      if (!wallet) return { rows: [] };
      return {
        rows: [
          {
            user_id: wallet.userId,
            wallet_address: wallet.walletAddress,
            wallet_type: wallet.walletType,
          } as unknown as T,
        ],
      };
    }

    if (/from user_venue_credentials/i.test(sql)) {
      const credential = options.venueCredential;
      if (!credential) return { rows: [] };
      const sender = typeof params?.[0] === "string" ? params[0] : "";
      const recipient = typeof params?.[1] === "string" ? params[1] : "";
      const signer = credential.walletAddress.toLowerCase();
      const funder = credential.funderAddress.toLowerCase();
      const direction =
        funder === sender && signer === recipient
          ? "funder_to_signer"
          : signer === sender && funder === recipient
            ? "signer_to_funder"
            : null;
      if (!direction) return { rows: [] };
      return {
        rows: [
          {
            user_id: credential.userId,
            signer_address: credential.walletAddress,
            funder_address: credential.funderAddress,
            direction,
          } as unknown as T,
        ],
      };
    }

    if (/from bridge_orders/i.test(sql)) {
      const bridgeOrders = [
        ...(options.bridgeOrder ? [options.bridgeOrder] : []),
        ...(options.bridgeOrders ?? []),
      ];
      if (bridgeOrders.length === 0) return { rows: [] };

      const isIntentLookup = /created_at > now\(\) - interval '24 hours'/i.test(
        sql,
      );
      if (isIntentLookup) {
        const userId = typeof params?.[0] === "string" ? params[0] : "";
        const dstChainId = typeof params?.[1] === "string" ? params[1] : "";
        const dstToken = typeof params?.[2] === "string" ? params[2] : "";
        const amount = typeof params?.[3] === "string" ? params[3] : "";
        return {
          rows: bridgeOrders
            .filter((bridgeOrder) => {
              if (bridgeOrder.matchByIntent === false) return false;
              if (bridgeOrder.userId !== userId) return false;
              if ((bridgeOrder.dstChainId ?? "8453") !== dstChainId) {
                return false;
              }
              if (
                (bridgeOrder.dstToken ?? basePayload.asset.address).toLowerCase() !==
                dstToken.toLowerCase()
              ) {
                return false;
              }
              return (
                (bridgeOrder.expectedOutputAmount ?? basePayload.amount) ===
                amount
              );
            })
            .slice(0, 2)
            .map((bridgeOrder) => mockBridgeRow(bridgeOrder) as unknown as T),
        };
      }

      return {
        rows: bridgeOrders
          .filter((bridgeOrder) => {
            if (bridgeOrder.matchByTxHash === false) return false;
            const txHash = typeof params?.[0] === "string" ? params[0] : "";
            return (
              mockTxHashMatches(bridgeOrder.txHashSrc ?? "0xsource", txHash) ||
              mockTxHashMatches(bridgeOrder.txHashDst, txHash)
            );
          })
          .slice(0, 1)
          .map((bridgeOrder) => mockBridgeRow(bridgeOrder) as unknown as T),
      };
    }

    if (/from executions/i.test(sql)) {
      if (!options.execution) return { rows: [] };
      const settlementQuery = /jsonb_array_elements/i.test(sql);
      const match = options.execution.match ?? "any";
      if (
        (settlementQuery && match === "exact") ||
        (!settlementQuery && match === "settlement")
      ) {
        return { rows: [] };
      }
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
      if (options.existingNotificationId) return { rows: [] };
      notificationInserts.push({ type, body, data, dedupeKey });
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

    if (/update bridge_orders/i.test(sql)) {
      bridgeUpdates.push({
        id: typeof params?.[0] === "string" ? params[0] : null,
        txHashDst: typeof params?.[1] === "string" ? params[1] : null,
        status: typeof params?.[2] === "string" ? params[2] : null,
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
    bridgeUpdates,
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
    name: "bridge-matched Privy deposit records bridge completion instead of deposit",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            status: "submitted",
            txHashDst: basePayload.transaction_hash,
          },
        });

        const result = await handlePrivyDepositWebhook(db, basePayload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.notificationInserts, [
          {
            type: "bridge_completed",
            body: "deBridge Polygon → Base",
            data: {
              provider: "debridge",
              status: "completed",
              srcChainId: "137",
              dstChainId: "8453",
              bridgeOrderId: "bridge-order-1",
              txHash: "0xsource",
            },
            dedupeKey: "bridge:bridge-order-1:completed",
          },
        ]);
      });
    },
  },
  {
    name: "source-side bridge tx match does not create completed notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            status: "submitted",
            txHashSrc: basePayload.transaction_hash,
            txHashDst: null,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "eip155:137",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.bridgeUpdates, [
          { id: "bridge-1", txHashDst: "0xabc", status: "submitted" },
        ]);
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "failed bridge destination tx match does not create completed notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: basePayload.recipient,
            walletType: "ethereum",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            status: "failed",
            txHashDst: basePayload.transaction_hash,
          },
        });

        const result = await handlePrivyDepositWebhook(db, basePayload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.bridgeUpdates, [
          { id: "bridge-1", txHashDst: "0xabc", status: "failed" },
        ]);
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "Across destination deposit before status sync records bridge completion",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "F7RnPp1GebLJkGspGCct38QqyRVxgoYWpkzUSXUDaYay";
        const fillTx =
          "2dV7ZJXJTyrg8PptcWyZL86yvndz9Cp3uCRsCDaTMamVboQkQzA85Xs7oHtohfpBPPPA8FeQJgdNRcxAQxRjuoVw";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            provider: "across",
            status: "submitted",
            swapType: "cross_chain",
            srcChainId: "137",
            dstChainId: "7565164",
            dstToken: env.solanaUsdcMint,
            orderId: null,
            txHashSrc: "0xpolygonsource",
            expectedOutputAmount: "998266",
            matchByTxHash: false,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          amount: "998266",
          sender: "E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC",
          recipient: solanaWallet,
          transaction_hash: fillTx,
          idempotency_key: "deposit-key-across-fill",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.bridgeUpdates, [
          { id: "bridge-1", txHashDst: fillTx, status: "fulfilled" },
        ]);
        assert.deepEqual(db.notificationInserts, [
          {
            type: "bridge_completed",
            body: "Across Polygon → Solana",
            data: {
              provider: "across",
              status: "completed",
              srcChainId: "137",
              dstChainId: "7565164",
              bridgeOrderId: "bridge-1",
              txHash: "0xpolygonsource",
            },
            dedupeKey: "bridge:bridge-1:completed",
          },
        ]);
      });
    },
  },
  {
    name: "Across intent candidate from different sender creates normal deposit notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "F7RnPp1GebLJkGspGCct38QqyRVxgoYWpkzUSXUDaYay";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            provider: "across",
            status: "submitted",
            swapType: "cross_chain",
            srcChainId: "137",
            dstChainId: "7565164",
            dstToken: env.solanaUsdcMint,
            orderId: null,
            txHashSrc: "0xpolygonsource",
            expectedOutputAmount: "998266",
            matchByTxHash: false,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          amount: "998266",
          sender: "unrelated-sender",
          recipient: solanaWallet,
          transaction_hash: "solana-unrelated-same-amount",
          idempotency_key: "deposit-key-solana-same-amount",
        });

        assert.equal(result.ok, true);
        assert.equal(result.notified, true);
        assert.equal(result.status, "notified");
        assert.deepEqual(db.bridgeUpdates, []);
        assert.equal(db.notificationInserts[0]?.type, "deposit_received");
      });
    },
  },
  {
    name: "ambiguous Across intent candidates from bridge sender are ignored",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "F7RnPp1GebLJkGspGCct38QqyRVxgoYWpkzUSXUDaYay";
        const warnings: unknown[][] = [];
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          bridgeOrders: [
            {
              id: "bridge-newer",
              userId: "user-1",
              provider: "across",
              status: "submitted",
              swapType: "cross_chain",
              srcChainId: "137",
              dstChainId: "7565164",
              dstToken: env.solanaUsdcMint,
              txHashSrc: "0xsource-newer",
              expectedOutputAmount: "998266",
              matchByTxHash: false,
            },
            {
              id: "bridge-older",
              userId: "user-1",
              provider: "across",
              status: "submitted",
              swapType: "cross_chain",
              srcChainId: "137",
              dstChainId: "7565164",
              dstToken: env.solanaUsdcMint,
              txHashSrc: "0xsource-older",
              expectedOutputAmount: "998266",
              matchByTxHash: false,
            },
          ],
        });

        const result = await handlePrivyDepositWebhook(
          db,
          {
            ...basePayload,
            caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            asset: {
              type: "spl",
              mint: env.solanaUsdcMint,
            },
            amount: "998266",
            sender: "E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC",
            recipient: solanaWallet,
            transaction_hash: "ambiguous-solana-fill",
            idempotency_key: "deposit-key-solana-ambiguous",
          },
          { warn: (...args: unknown[]) => warnings.push(args) },
        );

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.bridgeUpdates, []);
        assert.deepEqual(db.notificationInserts, []);
        assert.equal(warnings.length, 1);
      });
    },
  },
  {
    name: "known Across Base sender records ignored event without notification",
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
          ...basePayload,
          caip2: "eip155:8453",
          sender: "0x0f7ae28de1c8532170ad4ee566b5801485c13a0e",
          transaction_hash: "base-across-fill-tx",
          idempotency_key: "deposit-key-base-across-fill",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "known Across Polygon sender records ignored event without notification",
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
          ...basePayload,
          caip2: "eip155:137",
          sender: "0x0000000000000000000000000000000000000000",
          transaction_hash: "polygon-across-fill-tx",
          idempotency_key: "deposit-key-polygon-across-fill",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_bridge");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "Across intent amount mismatch still creates normal deposit notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "F7RnPp1GebLJkGspGCct38QqyRVxgoYWpkzUSXUDaYay";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            provider: "across",
            dstChainId: "7565164",
            dstToken: env.solanaUsdcMint,
            expectedOutputAmount: "998266",
            matchByTxHash: false,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          amount: "123456",
          sender: "not-across",
          recipient: solanaWallet,
          transaction_hash: "solana-unrelated-deposit",
          idempotency_key: "deposit-key-solana-unrelated",
        });

        assert.equal(result.ok, true);
        assert.equal(result.notified, true);
        assert.equal(result.status, "notified");
        assert.equal(db.notificationInserts[0]?.type, "deposit_received");
      });
    },
  },
  {
    name: "duplicate Across fill webhook does not create duplicate bridge notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "F7RnPp1GebLJkGspGCct38QqyRVxgoYWpkzUSXUDaYay";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: solanaWallet,
            walletType: "solana",
          },
          bridgeOrder: {
            id: "bridge-1",
            userId: "user-1",
            provider: "across",
            status: "fulfilled",
            swapType: "cross_chain",
            srcChainId: "137",
            dstChainId: "7565164",
            dstToken: env.solanaUsdcMint,
            orderId: null,
            txHashSrc: "0xpolygonsource",
            expectedOutputAmount: "998266",
            matchByTxHash: false,
          },
          depositInsertConflict: true,
          existingDepositStatus: "ignored_bridge",
          existingDepositUserId: "user-1",
          existingNotificationId: "notification-existing",
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          amount: "998266",
          sender: "E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC",
          recipient: solanaWallet,
          transaction_hash: "solana-fill-duplicate",
          idempotency_key: "deposit-key-across-fill-duplicate",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.duplicate, true);
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
    name: "same-user linked wallet movement records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const sender = "0x1111111111111111111111111111111111111111";
        const recipient = "0x2222222222222222222222222222222222222222";
        const db = createMockDb({
          wallets: [
            {
              userId: "user-1",
              walletAddress: sender,
              walletType: "ethereum",
            },
            {
              userId: "user-1",
              walletAddress: recipient,
              walletType: "ethereum",
            },
          ],
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          sender,
          recipient,
          idempotency_key: "deposit-key-internal-wallet",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_internal");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "Polymarket funder to signer movement records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const signer = "0x2222222222222222222222222222222222222222";
        const funder = "0x3333333333333333333333333333333333333333";
        const db = createMockDb({
          wallet: {
            userId: "user-1",
            walletAddress: signer,
            walletType: "ethereum",
          },
          venueCredential: {
            userId: "user-1",
            walletAddress: signer,
            funderAddress: funder,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "eip155:137",
          asset: {
            type: "erc20",
            address: env.polymarketUsdceAddress,
          },
          sender: funder,
          recipient: signer,
          idempotency_key: "deposit-key-funder-to-signer",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_internal");
        assert.deepEqual(db.notificationInserts, []);
      });
    },
  },
  {
    name: "Polymarket signer to funder movement records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const signer = "0x2222222222222222222222222222222222222222";
        const funder = "0x3333333333333333333333333333333333333333";
        const db = createMockDb({
          venueCredential: {
            userId: "user-1",
            walletAddress: signer,
            funderAddress: funder,
          },
        });

        const result = await handlePrivyDepositWebhook(db, {
          ...basePayload,
          caip2: "eip155:137",
          asset: {
            type: "erc20",
            address: env.polymarketPusdAddress,
          },
          sender: signer,
          recipient: funder,
          idempotency_key: "deposit-key-signer-to-funder",
        });

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_internal");
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
    name: "DFlow settlement-matched Solana deposit records ignored event without notification",
    run: async () => {
      await withRedisDisabled(async () => {
        const solanaWallet = "8JtStScw3jBKQoobn6JMP6QBryCF48U6Qj2TqQVoFw35";
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
            match: "settlement",
          },
        });
        const payload = {
          ...basePayload,
          caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: {
            type: "spl",
            mint: env.solanaUsdcMint,
          },
          sender: "dflow-market-ledger-order-vault",
          recipient: solanaWallet,
          transaction_hash:
            "3kMZy9qbV84ZQeGYnNQHYqbQEyZAU3sbQHLgGdyducwmL1qAFG5Ut94hCrbBHJGk7N56wrgf7V5CoEivfFWB7p6M",
          idempotency_key: "deposit-key-dflow-refund",
        };

        const result = await handlePrivyDepositWebhook(db, payload);

        assert.equal(result.ok, true);
        assert.equal(result.ignored, true);
        assert.equal(result.status, "ignored_venue");
        assert.deepEqual(db.notificationInserts, []);
        assert.ok(
          db.calls.some(
            (call) =>
              /from executions/i.test(call.sql) &&
              /jsonb_array_elements/i.test(call.sql) &&
              /settlement,reverts/i.test(call.sql),
          ),
          "expected DFlow settlement signature lookup",
        );
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
