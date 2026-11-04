import assert from "node:assert/strict";
import { discoverBackgroundPolymarketPositions as discover } from "./services/polymarket-background-positions.js";
import type { DataApiAdmission } from "./services/polymarket-data-api-admission.js";
import { PolymarketDataApiAdmission } from "./services/polymarket-data-api-admission.js";
const owner = `0x${"11".repeat(20)}`;
const defaults = { owner, baseUrl: "https://example.invalid" };
const pending = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
const requestSignal = (init: RequestInit | undefined) => {
  assert.ok(init?.signal);
  return init.signal;
};
// AbortSignal.timeout is unref'ed in Node. Keep this offline test alive only.
const alive = setInterval(() => {}, 1000);
try {
  const stored = new Map<string, string>();
  let calls = 0;
  const slice = await discover({
    ...defaults,
    config: { walletBudgetMs: 80, pageTimeoutMs: 500, maxAttempts: 2 },
    store: {
      get: async (k) => stored.get(k) ?? null,
      set: async (k, v) => {
        stored.set(k, v);
      },
      del: async (k) => stored.delete(k),
    },
    fetchImpl: (async (_url, init) => {
      calls++;
      if (calls === 1)
        return Response.json({ data: [], pagination: { next_cursor: "next" } });
      return pending(requestSignal(init));
    }) as typeof fetch,
  });
  assert.equal(slice.reason, "time_budget");
  assert.equal(slice.timeoutCause, "slice_budget");
  assert.equal(slice.pages, 1);
  assert.equal(slice.retries, 0);
  assert.equal(slice.checkpointAvailable, true);
  const page = await discover({
    ...defaults,
    config: { walletBudgetMs: 500, pageTimeoutMs: 20, maxAttempts: 1 },
    fetchImpl: (async (_url, init) =>
      pending(requestSignal(init))) as typeof fetch,
  });
  assert.equal(page.reason, "upstream_timeout");
  assert.equal(page.timeoutCause, "page_deadline");
  // Receiving headers is not a completed page: cancellation during JSON body
  // consumption must preserve the same deadline provenance.
  for (const ownSlice of [true, false]) {
    const body = await discover({
      ...defaults,
      config: {
        walletBudgetMs: ownSlice ? 25 : 300,
        pageTimeoutMs: ownSlice ? 500 : 20,
        maxAttempts: 1,
      },
      fetchImpl: (async (_url, init) => {
        const response = Response.json({});
        response.json = () => pending(requestSignal(init));
        return response;
      }) as typeof fetch,
    });
    assert.equal(body.reason, ownSlice ? "time_budget" : "upstream_timeout");
    assert.equal(
      body.timeoutCause,
      ownSlice ? "slice_budget" : "page_deadline",
    );
  }
  let fetched = 0;
  const admission: DataApiAdmission = {
    acquire: async (_url, signal) => pending(signal),
    finish: async () => 0,
  };
  const waiting = await discover({
    ...defaults,
    config: { walletBudgetMs: 25, pageTimeoutMs: 500 },
    admission,
    fetchImpl: (async () => {
      fetched++;
      throw Error("must not fetch");
    }) as typeof fetch,
  });
  assert.equal(waiting.reason, "time_budget");
  assert.equal(fetched, 0);
  const admissionPage = new PolymarketDataApiAdmission({
    acquire: async () => ({ kind: "wait", retryAfterMs: 10 }),
    finish: async () => 0,
  });
  const admissionTimed = await discover({
    ...defaults,
    config: { walletBudgetMs: 300, pageTimeoutMs: 25, maxAttempts: 1 },
    admission: admissionPage,
    fetchImpl: (async () => {
      fetched++;
      throw Error("must not fetch");
    }) as typeof fetch,
  });
  assert.equal(admissionTimed.reason, "upstream_error");
  assert.equal(admissionTimed.timeoutCause, "admission");
  assert.equal(admissionTimed.rateLimitSource, "shared_limiter");
  assert.equal(fetched, 0);
  // Finishing a real response must not turn its error into resumable progress.
  for (const status of [400, 429, 503]) {
    let pageCalls = 0;
    const slowFinish: DataApiAdmission = {
      acquire: async () => ({
        id: "test",
        origin: "https://example.invalid",
        family: "positions",
        epoch: 0,
        expiresAt: Date.now() + 1000,
      }),
      finish: async () => {
        if (pageCalls > 1)
          await new Promise((resolve) => setTimeout(resolve, 100));
        return 60000;
      },
    };
    const knownError = await discover({
      ...defaults,
      config: { walletBudgetMs: 40, pageTimeoutMs: 500, maxAttempts: 1 },
      admission: slowFinish,
      store: {
        get: async () => null,
        set: async () => {},
        del: async () => {},
      },
      fetchImpl: (async () =>
        ++pageCalls === 1
          ? Response.json({ data: [], pagination: { next_cursor: "next" } })
          : Response.json(
              { retryable: false },
              { status, headers: { "retry-after": "60" } },
            )) as typeof fetch,
    });
    assert.equal(knownError.httpStatus, status);
    assert.notEqual(knownError.reason, "time_budget");
    if (status === 429) assert.ok((knownError.retryAfterMs ?? 0) >= 60000);
  }
  // A real response near the boundary is not relabelled using wall time.
  let clock = 1000;
  const upstream = await discover({
    ...defaults,
    now: () => clock,
    config: { walletBudgetMs: 100 },
    fetchImpl: (async () => {
      clock += 101;
      return Response.json({ retryable: true }, { status: 503 });
    }) as typeof fetch,
  });
  assert.equal(upstream.reason, "upstream_error");
  let mixedAttempts = 0;
  const mixed = await discover({
    ...defaults,
    sleep: async () => {},
    fetchImpl: (async () => {
      if (++mixedAttempts === 1)
        throw new DOMException("fixture timeout", "TimeoutError");
      return Response.json({ retryable: false }, { status: 503 });
    }) as typeof fetch,
  });
  assert.equal(mixed.httpStatus, 503);
  assert.equal(mixed.timeoutCause, null);
  console.log(
    "[slice deadlines] slice/page/admission/real-error provenance passed",
  );
} finally {
  clearInterval(alive);
}
