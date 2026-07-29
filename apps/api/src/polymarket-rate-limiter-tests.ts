import assert from "node:assert/strict";

import {
  PolymarketClient,
  PolymarketRateLimiter,
} from "./services/polymarket-client.js";

type RateLimiterTestHooks = {
  maxBackgroundRequests: number;
  makeRequest: (endpoint: string) => Promise<unknown>;
};

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function testIdenticalRequestsUseOneUpstreamCall(): Promise<void> {
  const limiter = new PolymarketRateLimiter();
  const hooks = limiter as unknown as RateLimiterTestHooks;
  let calls = 0;
  let release: (() => void) | undefined;
  hooks.makeRequest = async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true };
  };

  const first = limiter.queueRequest("same-book", { endpoint: "/book" });
  const second = limiter.queueRequest("same-book", { endpoint: "/book" });
  await flush();

  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
}

async function testInteractiveBookBypassesQueuedBackgroundWork(): Promise<void> {
  const limiter = new PolymarketRateLimiter();
  const hooks = limiter as unknown as RateLimiterTestHooks;
  const started: string[] = [];
  const releases: Array<() => void> = [];
  hooks.makeRequest = async (endpoint: string) => {
    started.push(endpoint);
    await new Promise<void>((resolve) => releases.push(resolve));
    return { endpoint };
  };

  const blockers = Array.from(
    { length: hooks.maxBackgroundRequests },
    (_, index) =>
      limiter.queueRequest(`background-${index}`, {
        endpoint: `/background-${index}`,
      }),
  );
  const queuedBackground = limiter.queueRequest("background-queued", {
    endpoint: "/background-queued",
  });
  const client = new PolymarketClient(limiter);
  const interactive = client.getOrderBook("interactive-token");

  await flush();
  assert.equal(started.length, hooks.maxBackgroundRequests + 1);
  assert.equal(started.at(-1), "/book");

  while (releases.length > 0) {
    releases.shift()?.();
    await flush();
  }
  await Promise.all([...blockers, queuedBackground, interactive]);
}

async function testHungInteractiveRequestIsAbortedAndReleasesCapacity(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new Error("upstream request aborted")),
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const limiter = new PolymarketRateLimiter({
      interactiveRequestTimeoutMs: 10,
      backgroundRequestTimeoutMs: 50,
    });
    const client = new PolymarketClient(limiter);

    await assert.rejects(
      client.getOrderBook("hung-interactive-token"),
      /Polymarket API request timed out after 10ms/,
    );
    assert.deepEqual(await client.getOrderBook("next-interactive-token"), {
      ok: true,
    });
    assert.equal(calls, 2);
    assert.equal(limiter.requestQueue.length, 0);
    assert.equal(limiter.isProcessing, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testIdenticalRequestsUseOneUpstreamCall();
await testInteractiveBookBypassesQueuedBackgroundWork();
await testHungInteractiveRequestIsAbortedAndReleasesCapacity();

console.log("ok - identical Polymarket requests share one upstream call");
console.log("ok - interactive orderbook bypasses queued background work");
console.log("ok - hung interactive request aborts and releases capacity");
