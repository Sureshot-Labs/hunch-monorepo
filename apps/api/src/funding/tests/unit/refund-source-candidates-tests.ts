import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadRefundSourceCandidatePage,
  matchRefundSourceEnvelope,
  REFUND_SOURCE_FIRST_PAGE_SQL,
  REFUND_SOURCE_NEXT_PAGE_SQL,
  type RefundSourceCandidateRow,
} from "../../reconciliation/relay-refund-source-candidates.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../domain/refund-settlement.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../reconciliation/owned-route-destination-observer.js";

const userId = "11111111-1111-4111-8111-111111111111";
const owner = `0x${"ab".repeat(20)}`;
const asset = {
  networkId: "evm:8453",
  assetId: `0x${"cd".repeat(20)}`,
  decimals: 6,
};
const location = {
  kind: "wallet",
  accountId: userId,
  locationId: "source-location",
  asset,
  details: { address: owner },
};
const event: OwnedRouteCanonicalDestinationEvent = {
  networkId: asset.networkId,
  asset,
  destinationAddress: owner,
  sourceAddress: `0x${"ef".repeat(20)}`,
  rawAmount: "9800000",
  transactionHash: `0x${"a".repeat(64)}`,
  eventIndex: "1",
  ledgerHeight: "123",
  blockHash: `0x${"b".repeat(64)}`,
  observedAt: new Date(),
};
const row: RefundSourceCandidateRow = {
  reservation_id: "22222222-2222-4222-8222-222222222222",
  reservation_created_at: "2026-10-14T00:00:00.123456Z",
  user_id: userId,
  operation_user_id: userId,
  operation_id: "operation",
  segment_id: "segment",
  location_id: location.locationId,
  network_id: asset.networkId,
  asset_id: asset.assetId,
  asset_decimals: 6,
  raw_amount: "10000000",
  mode: "subtract_available",
  provider_id: "relay",
  source_snapshot: { kind: "owned_location", location },
  quoted_input: { asset, raw: "10000000" },
  refund_location_snapshot: {
    ...location,
    refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
    relayProtocolOrderId: `0x${"c".repeat(64)}`,
  },
  provider_quote_ref_lookup_hmac: "d".repeat(64),
  lookup_key_version: 1,
};

test("source enumeration preserves possible envelopes without asserting money movement", () => {
  assert.deepEqual(matchRefundSourceEnvelope(userId, event, row), {
    kind: "candidate",
    operationId: row.operation_id,
    segmentId: row.segment_id,
    reservationId: row.reservation_id,
  });
  // No status/finality/attempt input exists here: future final validation must
  // retain this identity even if the leg was settled during enumeration.
  assert.equal(
    matchRefundSourceEnvelope(userId, { ...event, rawAmount: "10000001" }, row)
      .kind,
    "unrelated",
  );
  assert.equal(
    matchRefundSourceEnvelope(
      userId,
      { ...event, destinationAddress: `0x${"ff".repeat(20)}` },
      row,
    ).kind,
    "unrelated",
  );
  assert.equal(
    matchRefundSourceEnvelope(userId, event, {
      ...row,
      refund_location_snapshot: location,
    }).kind,
    "unrelated",
  );
  assert.equal(
    matchRefundSourceEnvelope(userId, event, { ...row, user_id: "foreign" })
      .kind,
    "unrelated",
  );
});

test("matching frozen envelope cannot disappear through a misbound reservation or owner", () => {
  for (const patch of [
    { operation_user_id: "foreign" },
    { mode: "fence_only" },
    { segment_id: null },
    { location_id: "different" },
    { network_id: "evm:137" },
    { asset_id: `0x${"ee".repeat(20)}` },
    { asset_decimals: 8 },
    { raw_amount: "1" },
    { provider_id: "different" },
    { provider_quote_ref_lookup_hmac: null },
    {
      source_snapshot: {
        kind: "owned_location",
        location: { ...location, accountId: "foreign" },
      },
    },
    { quoted_input: { asset: { ...asset, decimals: 8 }, raw: "10000000" } },
    {
      refund_location_snapshot: {
        ...(row.refund_location_snapshot as object),
        refundEvidenceContract: "future",
      },
    },
  ]) {
    assert.equal(
      matchRefundSourceEnvelope(userId, event, { ...row, ...patch }).kind,
      "invalid",
      JSON.stringify(patch),
    );
  }
});

test("page continuation is the last source row, never the filtered candidate subset", async () => {
  const cut = "2026-10-14T01:00:00.999999Z";
  const second = {
    ...row,
    reservation_id: "11111111-2222-4222-8222-222222222222",
    refund_location_snapshot: location,
  };
  const sentinel = {
    ...second,
    reservation_id: "00000000-2222-4222-8222-222222222222",
  };
  let calls = 0;
  const db = {
    query: async (sql: string, args: unknown[]) => {
      calls++;
      if (calls === 1) {
        assert.equal(sql, REFUND_SOURCE_FIRST_PAGE_SQL);
        assert.deepEqual(args, [userId, cut, 3]);
        return { rows: [row, second, sentinel] };
      }
      assert.equal(sql, REFUND_SOURCE_NEXT_PAGE_SQL);
      assert.deepEqual(args, [
        userId,
        cut,
        3,
        second.reservation_created_at,
        second.reservation_id,
      ]);
      return { rows: [sentinel] };
    },
  };
  const first = await loadRefundSourceCandidatePage(db as never, {
    userId,
    scanBefore: cut,
    cursor: null,
    limit: 2,
  });
  assert.equal(first.rows.length, 2);
  assert.deepEqual(first.nextCursor, {
    createdAt: second.reservation_created_at,
    id: second.reservation_id,
  });
  const next = await loadRefundSourceCandidatePage(db as never, {
    userId,
    scanBefore: cut,
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.deepEqual(next.rows, [sentinel]);
  assert.equal(next.nextCursor, null);
  assert.equal(
    matchRefundSourceEnvelope(userId, event, second).kind,
    "unrelated",
  );
  assert.equal(calls, 2);
});

test("page input rejects invalid resource limits without a database query", async () => {
  const db = { query: async () => assert.fail("invalid page cannot query") };
  for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      loadRefundSourceCandidatePage(db as never, {
        userId,
        scanBefore: row.reservation_created_at,
        cursor: null,
        limit,
      }),
    );
  }
});
