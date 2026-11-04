import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  LocalDataApiAdmissionBackend,
  PolymarketDataApiAdmission,
  DataApiAdmissionError,
  currentDataApiLane,
  withDataApiLane,
  type DataApiPermit,
} from "./services/polymarket-data-api-admission.js";
import {
  fetchPolymarketDataApiV2Page,
  PolymarketDataApiV2Error,
} from "./services/polymarket-data-api-v2.js";
import {
  discoverBackgroundPolymarketPositions as discover,
  type PositionDiscoveryStore,
} from "./services/polymarket-background-positions.js";
import { RuntimeDataApiAdmissionBackend } from "./services/polymarket-data-api-admission-runtime.js";
import { exerciseAdmissionRaces } from "./polymarket-data-api-admission-test-fixtures.js";
import { fetchWithWalletIntelRetry } from "./services/wallet-intel-retry.js";

const url = new URL("https://data.example.invalid/v2/positions");
// A sidecar import must not require unrelated API secrets or open Redis merely
// because the limiter module is loaded. Use a fresh, minimal-environment process.
const importProbe = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(new URL("./services/polymarket-data-api-admission-runtime.ts", import.meta.url).href)}); console.log("sidecar import ok");`,
  ],
  {
    env: { PATH: process.env.PATH, HUNCH_RUNTIME_SECRETS_LOADED: "1" },
    encoding: "utf8",
    timeout: 10000,
  },
);
assert.equal(importProbe.status, 0, importProbe.stderr);
assert.match(importProbe.stdout, /sidecar import ok/);
const permit = (id: string, epoch = 0): DataApiPermit => ({
  id,
  origin: url.origin,
  family: "positions",
  epoch,
  expiresAt: 100000,
});
const backend = new LocalDataApiAdmissionBackend();
const acquire = (
  id: string,
  now: number,
  lane: "background" | "interactive" = "interactive",
) => backend.acquire({ ...permit(id), now, lane });
assert.deepEqual(await acquire("a", 1000, "background"), {
  kind: "admitted",
  epoch: 0,
});
assert.deepEqual(await acquire("b", 1100, "background"), {
  kind: "admitted",
  epoch: 0,
});
assert.equal((await acquire("c", 1200, "background")).kind, "wait");
assert.equal(
  (await acquire("ui1", 1200)).kind,
  "admitted",
  "interactive capacity is reserved",
);
assert.equal((await acquire("ui2", 1300)).kind, "admitted");
assert.equal((await acquire("ui3", 1400)).kind, "wait");
assert.equal(
  await backend.finish(
    permit("a"),
    { kind: "limited", retryAfterMs: 5000, jitter: 0 },
    1400,
  ),
  5000,
);
assert.equal((await acquire("c", 1500)).kind, "cooldown");
await backend.finish(
  permit("ui1"),
  { kind: "success", retryAfterMs: 0, jitter: 0 },
  1500,
);
assert.equal(
  (await acquire("c", 1600)).kind,
  "cooldown",
  "a late healthy response cannot close a newer circuit",
);
await backend.finish(
  permit("b"),
  { kind: "limited", retryAfterMs: 10000, jitter: 0 },
  1600,
);
assert.equal(
  (await acquire("c", 6500)).kind,
  "cooldown",
  "concurrent Retry-After can lengthen but not multiply the failure count",
);
assert.equal((await acquire("probe", 11601)).kind, "admitted");
assert.equal(
  (await acquire("stampede", 11701)).kind,
  "cooldown",
  "only one cross-process recovery probe",
);
assert.equal(
  await backend.finish(
    permit("probe", 2),
    { kind: "limited", retryAfterMs: 0, jitter: 0 },
    11701,
  ),
  2000,
);
assert.equal((await acquire("probe2", 13702)).kind, "admitted");
await backend.finish(
  permit("probe2", 3),
  { kind: "success", retryAfterMs: 0, jitter: 0 },
  13703,
);
assert.equal((await acquire("normal", 13803)).kind, "admitted");
assert.equal(
  (
    await backend.acquire({
      ...permit("other"),
      family: "trades",
      lane: "interactive",
      now: 15000,
    })
  ).kind,
  "admitted",
  "a positions circuit does not block independent endpoint families",
);

// Empty Cloudflare 429: fifty simultaneous wallets must not each make two calls.
const storm = new PolymarketDataApiAdmission(
  new LocalDataApiAdmissionBackend(),
  Date.now,
  undefined,
  () => 0,
);
let calls = 0;
const options = {
  baseUrl: url.origin,
  endpoint: "positions" as const,
  params: { user: "synthetic" },
  parseRow: (value: unknown) => value,
  timeoutMs: 2000,
  admission: storm,
  lane: "background" as const,
  fetchImpl: (async () => {
    calls++;
    return new Response(null, {
      status: 429,
      headers: { server: "cloudflare", "cf-ray": "test-ARN" },
    });
  }) as typeof fetch,
};
const failures = await Promise.allSettled(
  Array.from({ length: 50 }, () => fetchPolymarketDataApiV2Page(options)),
);
assert.ok(calls <= 2, `fanout made ${calls} external calls`);
assert.ok(
  failures.every(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof PolymarketDataApiV2Error &&
      r.reason.status === 429,
  ),
);
const upstream = failures.flatMap((r) =>
  r.status === "rejected" && r.reason.diagnostics.source === "upstream"
    ? [r.reason]
    : [],
);
assert.equal(upstream[0].diagnostics.cfRay, "test-ARN");
assert.equal(upstream[0].diagnostics.responseFormat, "empty_or_non_json");
assert.ok(upstream[0].retryAfterMs >= 1000);
assert.ok(
  failures.some(
    (r) =>
      r.status === "rejected" &&
      r.reason.diagnostics.source === "shared_limiter",
  ),
);

// Cursor progress survives a headerless 429, process/controller restart and recovery.
let clock = 1000000;
const shared = new LocalDataApiAdmissionBackend();
const controller = () =>
  new PolymarketDataApiAdmission(
    shared,
    () => clock,
    async (ms) => {
      clock += ms;
    },
    () => 0,
  );
const owner = "0x1111111111111111111111111111111111111111";
const values = new Map<string, string>();
const store: PositionDiscoveryStore = {
  get: async (k) => values.get(k) ?? null,
  set: async (k, v) => {
    values.set(k, v);
  },
  del: async (k) => {
    values.delete(k);
  },
};
const row = (id: string) => ({
  token_id: id,
  proxy_wallet: owner,
  condition_id: `0x${"11".repeat(32)}`,
  current_size: 1,
  avg_price: 0.4,
  outcome_index: 0,
  redeemable: false,
});
const page = (rows: unknown[], cursor: string | null) =>
  Response.json({ data: rows, pagination: { next_cursor: cursor } });
const seen: (string | null)[] = [];
let attempts = 0;
const first = await discover({
  owner,
  baseUrl: url.origin,
  store,
  now: () => clock,
  sleep: async (ms) => {
    clock += ms;
  },
  admission: controller(),
  config: { maxAttempts: 1 },
  fetchImpl: (async (input) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    seen.push(cursor);
    return ++attempts === 1
      ? page([row("1")], "opaque-progress")
      : new Response(null, { status: 429 });
  }) as typeof fetch,
});
assert.equal(first.reason, "rate_limited");
assert.equal(first.discoveredTokens, 1);
assert.deepEqual(first.tokens, []);
assert.equal(first.retries, 0);
clock += 1001;
const recovered = await discover({
  owner,
  baseUrl: url.origin,
  store,
  now: () => clock,
  admission: controller(),
  fetchImpl: (async (input) => {
    seen.push(new URL(String(input)).searchParams.get("cursor"));
    return page([row("2")], null);
  }) as typeof fetch,
});
assert.equal(recovered.status, "complete");
assert.equal(recovered.resumed, true);
assert.deepEqual(
  recovered.tokens.map((t) => t.tokenId),
  ["1", "2"],
);
assert.deepEqual(seen, [null, "opaque-progress", "opaque-progress"]);
assert.equal(values.size, 0);

// A synthetic half-open lease wait cannot be frozen into an unrelated wallet checkpoint.
const trigger = await controller().acquire(
  url,
  AbortSignal.timeout(1000),
  "interactive",
  1000,
);
await controller().finish(trigger, { kind: "limited", retryAfterMs: 0 });
clock += 1001;
const probe = await controller().acquire(
  url,
  AbortSignal.timeout(1000),
  "interactive",
  1000,
);
const deferred = await discover({
  owner,
  baseUrl: url.origin,
  store,
  now: () => clock,
  admission: controller(),
  fetchImpl: (async () => {
    throw Error("must not fetch while shared probe runs");
  }) as typeof fetch,
});
assert.equal(deferred.rateLimitSource, "shared_limiter");
assert.ok([...values.values()].every((v) => !JSON.parse(v).retryDelay));
await controller().finish(probe, { kind: "success", retryAfterMs: 0 });
clock += 100;
const immediatelyRecovered = await discover({
  owner,
  baseUrl: url.origin,
  store,
  now: () => clock,
  admission: controller(),
  fetchImpl: (async () => page([], null)) as typeof fetch,
});
assert.equal(immediatelyRecovered.status, "complete");

// Cancellation while admission waits performs no HTTP request and leaks no permit.
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(() =>
  controller().acquire(url, cancelled.signal, "interactive", 1000),
);
const blocked = new PolymarketDataApiAdmission({
  acquire: async () => ({
    kind: "cooldown",
    retryAfterMs: 123,
    basis: "upstream",
  }),
  finish: async () => 0,
});
await assert.rejects(
  () => blocked.acquire(url, AbortSignal.timeout(1000), "background", 1000),
  (e: unknown) => e instanceof DataApiAdmissionError && e.retryAfterMs === 123,
);
assert.equal(currentDataApiLane(), "interactive");
await withDataApiLane("background", async () => {
  await Promise.resolve();
  assert.equal(currentDataApiLane(), "background");
});
assert.equal(currentDataApiLane(), "interactive");
await exerciseAdmissionRaces(() => new LocalDataApiAdmissionBackend());

// A lost coordinator acknowledgement cannot erase the observed Retry-After,
// either while falling back locally or while reconnecting the shared backend.
let runtimeClock = 10000,
  online = true,
  feedbackFails = true,
  extended = 0;
const fakeRedis = {
  acquire: async () => ({ kind: "admitted" as const, epoch: 0 }),
  finish: async () => {
    if (feedbackFails) throw Error("lost coordinator acknowledgement");
    return 0;
  },
  extendCooldown: async () => {
    extended++;
  },
};
const runtime = new RuntimeDataApiAdmissionBackend(
  async () => (online ? fakeRedis : null),
  () => true,
  () => runtimeClock,
);
const runtimeInput = {
  ...permit("runtime"),
  now: runtimeClock,
  lane: "interactive" as const,
};
assert.equal((await runtime.acquire(runtimeInput)).kind, "admitted");
assert.ok(
  (await runtime.finish(
    runtimeInput,
    { kind: "limited", retryAfterMs: 60000, jitter: 0 },
    runtimeClock,
  )) >= 60000,
);
online = false;
runtimeClock += 1000;
assert.equal(
  (
    await runtime.acquire({
      ...runtimeInput,
      id: "fallback",
      now: runtimeClock,
    })
  ).kind,
  "cooldown",
);
online = true;
feedbackFails = false;
assert.equal(
  (
    await runtime.acquire({
      ...runtimeInput,
      id: "reconnect",
      now: runtimeClock,
    })
  ).kind,
  "cooldown",
);
assert.ok(
  extended > 0,
  "local deadlines are republished to a recovered shared coordinator",
);
runtimeClock += 60001;
assert.equal(
  (await runtime.acquire({ ...runtimeInput, id: "after", now: runtimeClock }))
    .kind,
  "admitted",
);
const unavailable = new RuntimeDataApiAdmissionBackend(
  async () => null,
  () => true,
);

// Another process that merely observed the shared cooldown must preserve it
// during an outage too. Probe occupancy is not an upstream retry deadline.
let observerClock = 10000,
  observerOnline = true;
const sharedCoordinator = new LocalDataApiAdmissionBackend();
const peer = () =>
  new RuntimeDataApiAdmissionBackend(
    async () => (observerOnline ? sharedCoordinator : null),
    () => true,
    () => observerClock,
  );
const originPeer = peer(),
  observingPeer = peer();
const peerInput = (id: string) => ({
  ...permit(id),
  now: observerClock,
  lane: "interactive" as const,
});
const originReply = await originPeer.acquire(peerInput("peer-a"));
assert.equal(originReply.kind, "admitted");
await originPeer.finish(
  peerInput("peer-a"),
  { kind: "limited", retryAfterMs: 60000, jitter: 0 },
  observerClock,
);
const observed = await observingPeer.acquire(peerInput("peer-b"));
assert.equal(observed.kind, "cooldown");
observerOnline = false;
observerClock += 100;
assert.equal(
  (await observingPeer.acquire(peerInput("peer-b-offline"))).kind,
  "cooldown",
);
observerOnline = true;
observerClock += 60001;
const freshPeer = peer(),
  probeObserver = peer();
const peerProbe = await freshPeer.acquire(peerInput("peer-probe"));
assert.equal(peerProbe.kind, "admitted");
assert.deepEqual(await probeObserver.acquire(peerInput("probe-observer")), {
  kind: "cooldown",
  basis: "probe",
  retryAfterMs: 100000 - observerClock,
});
await freshPeer.finish(
  {
    ...peerInput("peer-probe"),
    epoch: peerProbe.kind === "admitted" ? peerProbe.epoch : 0,
  },
  { kind: "success", retryAfterMs: 0, jitter: 0 },
  observerClock,
);
observerClock += 100;
assert.equal(
  (await probeObserver.acquire(peerInput("probe-recovered"))).kind,
  "admitted",
  "a completed shared probe must not leave an independent local delay",
);
await assert.rejects(
  () => unavailable.acquire({ ...runtimeInput, lane: "background" }),
  (e: unknown) =>
    e instanceof DataApiAdmissionError &&
    e.reason === "coordination_unavailable",
);

// Deadline expiry returns promptly even if Redis is slow; a late permit is
// released asynchronously without sending an HTTP request or leaking a lease.
let lateReleases = 0;
const slow = new PolymarketDataApiAdmission({
  acquire: async () => {
    await new Promise((r) => setTimeout(r, 150));
    return { kind: "admitted", epoch: 0 };
  },
  finish: async () => {
    lateReleases++;
    return 0;
  },
});
const began = performance.now();
await assert.rejects(() =>
  slow.acquire(url, AbortSignal.timeout(10), "interactive", 1000),
);
assert.ok(
  performance.now() - began < 100,
  "admission cancellation must not wait for the backend",
);
await new Promise((r) => setTimeout(r, 170));
assert.equal(lateReleases, 1);
const slowFinish = {
  acquire: async () => permit("slow-finish"),
  finish: async () => {
    await new Promise((r) => setTimeout(r, 150));
    return 0;
  },
};
const finishBegan = performance.now();
assert.deepEqual(
  await fetchPolymarketDataApiV2Page({
    ...options,
    admission: slowFinish,
    timeoutMs: 10,
    fetchImpl: (async () => page([], null)) as typeof fetch,
  }),
  { data: [], nextCursor: null },
);
assert.ok(
  performance.now() - finishBegan < 100,
  "completion cleanup cannot overrun caller cancellation",
);

// Holder telemetry must preserve the reader's parent deadline, not replace it
// with the telemetry transport's independent timeout.
const originalFetch = globalThis.fetch;
let transportAborted = false;
globalThis.fetch = (async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    const stop = () => {
      transportAborted = true;
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  })) as typeof fetch;
try {
  const start = performance.now();
  await assert.rejects(() =>
    fetchWithWalletIntelRetry({
      url: url.toString(),
      init: { signal: AbortSignal.timeout(10) },
      timeoutMs: 1000,
      allowRetry: false,
    }),
  );
  assert.equal(transportAborted, true);
  assert.ok(
    performance.now() - start < 100,
    "parent cancellation survives the telemetry wrapper",
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "[data-api-admission] fanout, exact Retry-After, half-open epochs, no stale gate, restart/cursor recovery, cancellation and lanes passed",
);
