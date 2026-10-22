import assert from "node:assert/strict";
import { marketRepairValidationTestHooks as hooks } from "./market-active-status-repair.js";
import { SharedRateLimitBackoff } from "./services/shared-rate-limit-backoff.js";

const candidate = {
  market_id: "kalshi:EVENT-A",
  venue: "kalshi" as const,
  venue_market_id: "EVENT-A",
  slug: null,
  event_id: "kalshi:EVENT",
  title: "Test",
  terminal_at: new Date("2026-01-01"),
  cursor_terminal_at: "2026-01-01 00:00:00+00",
};
const originalFetch = globalThis.fetch;
let marketPayload: unknown = {};
let marketStatus = 200;
try {
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("/events/") ? { markets: [] } : marketPayload,
      ),
      {
        status: String(url).includes("/events/") ? 200 : marketStatus,
        headers: { "content-type": "application/json" },
      },
    );
  for (const scenario of [
    {
      payload: { market: { ticker: "EVENT-A", status: "active" } },
      expected: "verified",
      target: null,
    },
    {
      payload: {
        market: { ticker: "EVENT-A", status: "finalized", result: "yes" },
      },
      expected: "verified",
      target: "SETTLED",
    },
    { payload: {}, expected: "error", target: null },
    {
      payload: { market: { ticker: "EVENT-A" } },
      expected: "error",
      target: null,
    },
    {
      payload: { market: { ticker: "EVENT-A", status: "made_up" } },
      expected: "error",
      target: null,
    },
    {
      payload: { market: { ticker: "OTHER", status: "closed" } },
      expected: "error",
      target: null,
    },
  ]) {
    marketPayload = scenario.payload;
    const [row] = await hooks.applyKalshiPublicFallbacks(
      [candidate],
      [hooks.buildValidation(candidate, null, "dflow_active")],
      1000,
      1,
    );
    assert.equal(row.validation_state, scenario.expected);
    assert.equal(row.target_status, scenario.target);
  }
  for (const status of [404, 503]) {
    marketStatus = status;
    const [row] = await hooks.applyKalshiPublicFallbacks(
      [candidate],
      [hooks.buildValidation(candidate, null, "dflow_active")],
      1000,
      1,
    );
    assert.equal(row.validation_state, status === 404 ? "deferred" : "error");
    assert.equal(row.target_status, null);
  }

  const limitless = {
    ...candidate,
    market_id: "limitless:123",
    venue: "limitless" as const,
    venue_market_id: "123",
    slug: "old-slug",
  };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return String(url).endsWith("old-slug")
      ? new Response("{}", { status: 404 })
      : Response.json({ id: 123, status: "RESOLVED" });
  };
  const backoff = new SharedRateLimitBackoff({
    label: "test",
    logPrefix: "test",
    baseBackoffMs: 0,
    jitterMs: 0,
  });
  const recovered = await hooks.validateLimitless(limitless, 1000, backoff);
  assert.equal(recovered.target_status, "SETTLED");
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 429 });
  };
  const limited = await hooks.validateLimitless(limitless, 1000, backoff);
  assert.equal(limited.validation_state, "error");
  assert.equal(calls, 5); // existing shared retry bound; no ID retry on 429
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "market repair provider tests passed (mock HTTP; no database or network)",
);
