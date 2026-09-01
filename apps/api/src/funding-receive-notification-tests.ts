#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import { SOLANA_NATIVE_ASSET } from "./funding/domain/network-fees.js";
import type { DirectIngressObservationVariant } from "./funding/reconciliation/direct-ingress-observer.js";
import type { FundingReceiveCanonicalEvent } from "./funding/receive/canonical-receive-event-scanner.js";
import {
  nativeSolDepositNotificationDedupeKey,
  recordCanonicalReceiveDepositNotification,
} from "./funding/receive/receive-deposit-notification.js";

const NOW = new Date("2026-09-01T01:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const RECEIVE_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const CANONICAL_EVENT_ID = "00000000-0000-4000-8000-000000000003";
const WALLET = "9WAHHmDT2AK8HyYSHY52QbsWGbGNskVv4cbshT5NSgMR";
const TRANSACTION_HASH =
  "eh9tPN7f8ddy9N1B4ysuh77JGKGT3eKDhwxA9G9sY7PT2deQ1WL1vE4tBaTCMLDZgKZYpdEpUupWoV9mrfBdkbB";

const retainedSolVariant: DirectIngressObservationVariant = {
  variantId: "ingress_variant_por10_native_sol",
  networkId: "solana:mainnet",
  asset: SOLANA_NATIVE_ASSET,
  destinationAddress: WALLET,
  destinationLocationId: "location_por10_solana_wallet",
  baselineRaw: "0",
  baselineRevision: "baseline_por10_native_sol",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: {
      eventCursorSlot: "443167474",
      eventConfirmations: 1,
      eventIdentity: "solana_transfer_v1",
    },
  },
  completion: { kind: "retained_owned_source_credit" },
};

const canonicalEvent: FundingReceiveCanonicalEvent = {
  variant: retainedSolVariant,
  transactionHash: TRANSACTION_HASH,
  eventIndex: "outer:2",
  blockNumber: "443167475",
  blockHash: "por10-block-hash",
  sourceAddress: "7HKfQDSWEktGc6VGcGYi1B7HerHUpLD35aTpF8Q87UQm",
  destinationAddress: WALLET,
  rawAmount: "30000000",
  observedAt: "2026-08-31T13:53:10.000Z",
};

type RecordedQuery = Readonly<{ sql: string; params: readonly unknown[] }>;

function mockDb(input: { suppressed: boolean; duplicate?: boolean }): {
  db: DbQuery;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    queries.push({ sql, params });
    if (/select exists \(/iu.test(sql)) {
      return {
        rows: [{ suppressed: input.suppressed } as unknown as T],
      };
    }
    if (/insert into notifications/iu.test(sql)) {
      if (input.duplicate) return { rows: [] };
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000004",
            user_id: params[0],
            type: params[1],
            title: params[2],
            body: params[3],
            severity: params[4],
            data: params[5],
            read_at: null,
            created_at: NOW,
            updated_at: NOW,
          } as unknown as T,
        ],
      };
    }
    throw new Error(`Unexpected POR10 notification query: ${sql}`);
  };
  return { db: { query: query as DbQuery["query"] }, queries };
}

{
  const { db, queries } = mockDb({ suppressed: false });
  const result = await recordCanonicalReceiveDepositNotification(db, {
    receiveSessionId: RECEIVE_SESSION_ID,
    userId: USER_ID,
    ownerChannel: "telegram",
    variant: retainedSolVariant,
    event: canonicalEvent,
    canonicalEventId: CANONICAL_EVENT_ID,
    now: NOW,
  });
  assert.equal(result, "created");
  const suppressionQuery = queries.find(({ sql }) =>
    /from telegram_funding_sessions funding_context/iu.test(sql),
  );
  assert.ok(suppressionQuery);
  assert.match(suppressionQuery.sql, /origin = 'buy_return_context'/u);
  assert.match(suppressionQuery.sql, /continuation_mode = 'app_handoff'/u);
  assert.match(
    suppressionQuery.sql,
    /\$6::text = any\(funding_consent\.consented_variant_ids\)/u,
  );
  const insert = queries.find(({ sql }) =>
    /insert into notifications/iu.test(sql),
  );
  assert.ok(insert);
  assert.equal(insert.params[1], "deposit_received");
  assert.equal(insert.params[3], "0.03 SOL deposit received on Solana");
  assert.equal(
    insert.params[6],
    nativeSolDepositNotificationDedupeKey({
      networkId: "solana:mainnet",
      walletAddress: WALLET,
      amountRaw: "30000000",
      txHash: TRANSACTION_HASH,
    }),
  );
  assert.deepEqual(insert.params[5], {
    category: "funds",
    source: "funding_receive",
    walletAddress: WALLET,
    walletType: "solana",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    network: "solana",
    asset: { type: "native-token" },
    amountRaw: "30000000",
    amountLabel: "0.03 SOL",
    amountUsd: null,
    txHash: TRANSACTION_HASH,
    canonicalEventId: CANONICAL_EVENT_ID,
    eventIndex: "outer:2",
    receiveSessionId: RECEIVE_SESSION_ID,
  });
}

{
  const { db, queries } = mockDb({ suppressed: true });
  const result = await recordCanonicalReceiveDepositNotification(db, {
    receiveSessionId: RECEIVE_SESSION_ID,
    userId: USER_ID,
    ownerChannel: "telegram",
    variant: retainedSolVariant,
    event: canonicalEvent,
    canonicalEventId: CANONICAL_EVENT_ID,
    now: NOW,
  });
  assert.equal(result, "suppressed");
  assert.equal(
    queries.some(({ sql }) => /insert into notifications/iu.test(sql)),
    false,
  );
}

{
  const { db, queries } = mockDb({ suppressed: true, duplicate: true });
  const result = await recordCanonicalReceiveDepositNotification(db, {
    receiveSessionId: RECEIVE_SESSION_ID,
    userId: USER_ID,
    ownerChannel: "web",
    variant: retainedSolVariant,
    event: canonicalEvent,
    canonicalEventId: CANONICAL_EVENT_ID,
    now: NOW,
  });
  assert.equal(result, "deduplicated");
  assert.equal(
    queries.some(({ sql }) =>
      /from telegram_funding_sessions funding_context/iu.test(sql),
    ),
    false,
  );
}

{
  const { db, queries } = mockDb({ suppressed: false });
  const result = await recordCanonicalReceiveDepositNotification(db, {
    receiveSessionId: RECEIVE_SESSION_ID,
    userId: USER_ID,
    ownerChannel: "telegram",
    variant: {
      ...retainedSolVariant,
      completion: { kind: "child_funding_operation" },
    },
    event: canonicalEvent,
    canonicalEventId: CANONICAL_EVENT_ID,
    now: NOW,
  });
  assert.equal(result, "ineligible");
  assert.deepEqual(queries, []);
}

console.log("[funding-receive-notification-tests] complete");
