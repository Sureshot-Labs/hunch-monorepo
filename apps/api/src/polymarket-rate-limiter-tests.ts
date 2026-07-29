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

await testIdenticalRequestsUseOneUpstreamCall();
await testInteractiveBookBypassesQueuedBackgroundWork();

console.log("ok - identical Polymarket requests share one upstream call");
console.log("ok - interactive orderbook bypasses queued background work");
