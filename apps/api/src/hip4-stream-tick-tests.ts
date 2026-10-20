import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { hip4StreamTickAllowed } from "./services/hip4-stream-tick.js";

const token = "hyperliquid:mainnet:1230";
const requested = new Set([token, "123456"]);
const now = 1_792_000_000_000;
const context = {
  revision: "current",
  policy: {
    ...DEFAULT_HIP4_READ_POLICY,
    enabled: true,
    liveEnabled: true,
    bookMaxAgeMs: 1_000,
  },
};
const tick = {
  token_id: token,
  best_bid: 0.4,
  best_ask: 0.6,
  ts: now - 100,
  valid_until: new Date(now + 900).toISOString(),
  policy_revision: "current",
};

test("HIP ticks require the effective revision and current bounded observation lifetime", () => {
  assert.equal(hip4StreamTickAllowed(tick, context, requested, now), true);
  for (const change of [
    { policy_revision: "previous" },
    { policy_revision: undefined },
    { ts: now + 1 },
    { ts: "1792000000000" },
    { ts: Number.NaN },
    { ts: now - 1_000 },
    { ts: now - 30_000, valid_until: new Date(now + 30_000).toISOString() },
    { valid_until: new Date(now).toISOString() },
    { valid_until: new Date(now + 901).toISOString() },
    { valid_until: "invalid" },
    { valid_until: undefined },
    { token_id: "hyperliquid:mainnet:1231" },
    { best_bid: Number.POSITIVE_INFINITY },
    { best_ask: 1.1 },
    { best_bid: 0.8, best_ask: 0.7 },
    { best_bid: undefined },
  ])
    assert.equal(
      hip4StreamTickAllowed({ ...tick, ...change }, context, requested, now),
      false,
      JSON.stringify(change),
    );
  assert.equal(hip4StreamTickAllowed(tick, undefined, requested, now), false);
  assert.equal(
    hip4StreamTickAllowed(
      tick,
      { ...context, policy: { ...context.policy, liveEnabled: false } },
      requested,
      now,
    ),
    false,
  );
});

test("cached HIP payloads cannot change token identity; legacy ticks keep their contract", () => {
  assert.equal(
    hip4StreamTickAllowed(tick, context, requested, now, token),
    true,
  );
  assert.equal(
    hip4StreamTickAllowed(
      { token_id: "123456" },
      context,
      requested,
      now,
      token,
    ),
    false,
  );
  assert.equal(
    hip4StreamTickAllowed(null, context, requested, now, token),
    false,
  );
  assert.equal(
    hip4StreamTickAllowed(
      { token_id: "123456", ts: now - 100_000 },
      undefined,
      requested,
      now,
    ),
    true,
  );
});
