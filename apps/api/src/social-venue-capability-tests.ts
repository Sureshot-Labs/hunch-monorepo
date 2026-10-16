import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { DEFAULT_SOCIAL_POLICY, SocialPolicyUnavailableError } from "./services/social-policy.js";
import { readSocialCopyVenues } from "./services/social-venue-capabilities.js";

function db(payload?: unknown) {
  let calls = 0;
  return { get calls() { return calls; }, query: async () => { calls++; return { rows: payload === undefined ? [] : [{ payload }] }; } } as unknown as Pick<Pool, "query"> & { calls: number };
}
test("social Copy cannot independently enable an unreleased or exit-only venue", async () => {
  const policy = { ...DEFAULT_SOCIAL_POLICY, copyVenues: ["polymarket", "limitless", "kalshi", "hyperliquid"] as const };
  const input = { ...policy, copyVenues: [...policy.copyVenues] };
  assert.deepEqual(await readSocialCopyVenues(db(), input), ["polymarket", "limitless"]);
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid.lifecycle = "active";
  assert.deepEqual(await readSocialCopyVenues(db(lifecycle), input), ["polymarket", "limitless", "hyperliquid"]);
  lifecycle.venues.hyperliquid.lifecycle = "exit-only";
  assert.deepEqual(await readSocialCopyVenues(db(lifecycle), input), ["polymarket", "limitless"]);
});
test("social capability errors are recoverable configuration errors, not permissions or default fallback", async () => {
  await assert.rejects(() => readSocialCopyVenues(db({ malformed: true }), DEFAULT_SOCIAL_POLICY), SocialPolicyUnavailableError);
  assert.deepEqual(await readSocialCopyVenues(db(), DEFAULT_SOCIAL_POLICY), ["polymarket", "limitless"]);
  const unused = db();
  assert.deepEqual(await readSocialCopyVenues(unused, { ...DEFAULT_SOCIAL_POLICY, copyEnabled: false }), []);
  assert.equal(unused.calls, 0);
});
