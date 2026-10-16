import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  hip4CanonicalChange,
  hip4CanonicalFingerprint,
} from "./services/hip4-canonical-change.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const mapped = mapHip4Market({
  ...fixture.observations[0],
  outcome: 8775,
  settlement: null,
  fetchedAt: "2026-10-16T13:00:00.000Z",
  generation: "material-a",
});

test("first canonical publication invalidates one market and its event", () => {
  const change = hip4CanonicalChange(null, mapped);
  assert.equal(change?.marketId, mapped.market.marketId);
  assert.deepEqual(change?.eventIds, [mapped.market.eventId]);
});

test("refresh generations, clocks, books and current metrics do not churn paid work", () => {
  const next = structuredClone(mapped);
  next.market.generation = "new-refresh-uuid";
  next.market.fetchedAt = "2026-10-16T13:01:00.000Z";
  next.market.metadataAttempt = { at: next.market.fetchedAt, result: "ok" };
  next.market.sides[0].bid = "0.12";
  next.market.sides[0].bookAt = next.market.fetchedAt;
  next.market.volume24h = null;
  assert.equal(hip4CanonicalChange(mapped, next), null);
});

test("real source condition, expiry, side-label and membership changes invalidate relevant canonical IDs", () => {
  for (const field of ["expiry", "title", "description"] as const) {
    const next = structuredClone(mapped);
    next.market[field] =
      field === "expiry"
        ? "2099-01-01T00:00:00.000Z"
        : `${next.market[field]} updated`;
    assert.ok(hip4CanonicalChange(mapped, next), field);
  }
  const rawChange = structuredClone(mapped);
  rawChange.raw.outcome.description += "|newOfficialField:review";
  assert.notEqual(
    hip4CanonicalFingerprint(rawChange),
    hip4CanonicalFingerprint(mapped),
  );
  const moved = structuredClone(mapped);
  moved.market.eventId = "hyperliquid:mainnet:question:99999";
  assert.deepEqual(hip4CanonicalChange(mapped, moved)?.eventIds, [
    mapped.market.eventId,
    moved.market.eventId,
  ]);
  const labelChange = structuredClone(mapped);
  labelChange.market.sides[0].label += " updated";
  assert.ok(hip4CanonicalChange(mapped, labelChange));
});

test("official fractional settlement invalidates without claiming binary outcomes", () => {
  const next = structuredClone(mapped);
  next.market.status = "settled";
  next.market.sides[0].payout = "0.123456789";
  next.market.sides[1].payout = "0.876543211";
  assert.ok(hip4CanonicalChange(mapped, next));
  next.market.fetchedAt = "2026-10-16T14:00:00.000Z";
  const before = hip4CanonicalFingerprint(next);
  next.market.fetchedAt = "2026-10-16T15:00:00.000Z";
  assert.equal(hip4CanonicalFingerprint(next), before);
});
