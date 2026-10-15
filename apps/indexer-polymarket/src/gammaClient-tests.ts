import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publicMarket = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/polymarket/v2-public-20261015.json",
      import.meta.url,
    ),
    "utf8",
  ),
).markets[0];

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.POLYMARKET_GAMMA_BASE = "https://gamma.test";
process.env.POLYMARKET_GAMMA_RETRY_ATTEMPTS = "2";
process.env.POLYMARKET_GAMMA_RETRY_BASE_MS = "0";

const {
  fetchEventsByIdsDetailed,
  fetchMarketById,
  iterateEventPages,
  fetchEventsPage,
} = await import("./gammaClient.js");
const { fetchGammaEntityById, gammaPageSize } = await import("@hunch/shared");
const { runGammaV2CatchUp } = await import("./gamma-sync.js");
const { PolymarketEvent } = await import("./types.js");

type FetchHandler = (url: string) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

function event(id: string | number) {
  return {
    id: String(id),
    title: `Event ${id}`,
    markets: [],
  };
}

function idsFromUrl(url: string): string[] {
  return new URL(url).searchParams.getAll("id");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function installFetch(handler: FetchHandler): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return urls;
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await test("fetchEventsByIdsDetailed retries transient event batch failures", async () => {
  let calls = 0;
  const urls = installFetch((url) => {
    calls += 1;
    assert.deepEqual(idsFromUrl(url), ["1", "2"]);
    if (calls === 1) return textResponse("bad gateway", 502);
    return jsonResponse([event(1), event(2)]);
  });

  const result = await fetchEventsByIdsDetailed(["1", "2"]);

  assert.equal(urls.length, 2);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ["1", "2"],
  );
  assert.deepEqual(result.failedIds, []);
});

await test("fetchEventsByIdsDetailed splits failed event batches", async () => {
  const urls = installFetch((url) => {
    const ids = idsFromUrl(url);
    if (ids.join(",") === "1,2,3,4") {
      return textResponse("invalid batch", 422);
    }
    return jsonResponse(ids.map(event));
  });

  const result = await fetchEventsByIdsDetailed(["1", "2", "3", "4"]);

  assert.equal(urls.length, 3);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(result.failedIds, []);
});

await test("fetchEventsByIdsDetailed reports only singleton event failures", async () => {
  const urls = installFetch((url) => {
    const ids = idsFromUrl(url);
    if (new URL(url).pathname === "/events/2")
      return textResponse("bad gateway", 502);
    if (ids.length > 1 || ids[0] === "2") {
      return textResponse("invalid ID", 422);
    }
    return jsonResponse(ids.map(event));
  });

  const result = await fetchEventsByIdsDetailed(["1", "2"]);

  assert.ok(urls.length >= 5);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(result.failedIds, ["2"]);
});

for (const count of [100, 101, 200]) {
  await test(`mixed V1/V2 ID batches stay <=100 (${count})`, async () => {
    const urls = installFetch((url) => {
      const query = new URL(url).searchParams;
      const ids = query.getAll("id");
      assert.ok(ids.length <= 100);
      assert.ok(Number(query.get("limit")) <= 100);
      const v2 = query.get("version") === "v2";
      if (v2)
        assert.ok(
          ids.every((id) => Number(id) % 2 === 0),
          "only missing IDs go to V2",
        );
      return jsonResponse(
        ids.filter((id) => (Number(id) % 2 === 0) === v2).map(event),
      );
    });
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const result = await fetchEventsByIdsDetailed([...ids, ...ids]);
    assert.equal(result.events.length, count);
    assert.deepEqual(result.failedIds, []);
    assert.deepEqual(result.missingIds, []);
    assert.equal(urls.length, count === 101 ? 3 : (count / 100) * 2);
  });
}

await test("empty/partial lists use exact direct event fallback and distinguish absent/errors", async () => {
  installFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/events") return jsonResponse([]);
    if (parsed.pathname === "/events/1") return jsonResponse(event(1));
    if (parsed.pathname === "/events/2") return textResponse("not found", 404);
    if (parsed.pathname === "/events/3") return jsonResponse(event(99));
    return textResponse("unavailable", 502);
  });
  const result = await fetchEventsByIdsDetailed([1, 2, 3, 4]);
  assert.deepEqual(
    result.events.map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(result.missingIds, ["2"]);
  assert.deepEqual(result.failedIds, ["3", "4"]);
});

await test("systemic failure never fans out into singleton retries", async () => {
  const urls = installFetch(() => textResponse("provider down", 503));
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);
  const result = await fetchEventsByIdsDetailed(ids);
  assert.equal(
    urls.length,
    4,
    "two attempts per version, no singleton/direct fanout",
  );
  assert.equal(result.failedIds.length, 100);
});

await test("V1 outage does not delay V2 behind recursive retries", async () => {
  const urls = installFetch((url) =>
    new URL(url).searchParams.get("version") === "v1"
      ? textResponse("provider down", 503)
      : jsonResponse(idsFromUrl(url).map(event)),
  );
  const result = await fetchEventsByIdsDetailed(
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  assert.equal(urls.length, 3);
  assert.equal(result.events.length, 100);
});

await test("rejected list ID can still be recovered by exact direct endpoint", async () => {
  installFetch((url) =>
    new URL(url).pathname === "/events/42"
      ? jsonResponse(event(42))
      : textResponse("bad list", 422),
  );
  const result = await fetchEventsByIdsDetailed([42]);
  assert.deepEqual(
    result.events.map((e) => e.id),
    ["42"],
  );
  assert.deepEqual(result.failedIds, []);
});

await test("short pages continue using actual length until empty", async () => {
  const offsets: number[] = [];
  installFetch((url) => {
    const q = new URL(url).searchParams;
    assert.equal(q.get("version"), "v2");
    assert.equal(q.get("limit"), "100");
    const offset = Number(q.get("offset"));
    offsets.push(offset);
    return jsonResponse(
      offset === 0 ? [event(1), event(2)] : offset === 2 ? [event(3)] : [],
    );
  });
  const ids: string[] = [];
  for await (const page of iterateEventPages({ version: "v2", pageSize: 500 }))
    ids.push(...page.events.map((e) => e.id));
  assert.deepEqual(offsets, [0, 2, 3]);
  assert.deepEqual(ids, ["1", "2", "3"]);
});

await test("markets prefer direct ID then both versioned lists", async () => {
  const urls = installFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/markets/1") return textResponse("not found", 404);
    return jsonResponse(
      parsed.searchParams.get("version") === "v2"
        ? [{ ...publicMarket, id: "1" }]
        : [],
    );
  });
  assert.equal((await fetchMarketById("1"))?.version, "v2");
  assert.equal(urls.length, 3);
});

for (const status of [422, 429, 502]) {
  await test(`market HTTP ${status} is not absence`, async () => {
    installFetch(() => textResponse("unavailable", status));
    await assert.rejects(fetchMarketById("1"), new RegExp(String(status)));
  });
}

await test("market timeout retries boundedly; empty successful lists don't erase failure", async () => {
  let attempts = 0;
  installFetch((url) => {
    if (new URL(url).pathname === "/markets/1") {
      attempts += 1;
      throw new DOMException("timeout", "TimeoutError");
    }
    return jsonResponse([]);
  });
  await assert.rejects(fetchMarketById("1"), /timeout/);
  assert.equal(attempts, 2);
});

await test("404 + two successful empty lists is confirmed absence; mismatch is failure", async () => {
  installFetch((url) =>
    new URL(url).pathname === "/markets/1"
      ? textResponse("absent", 404)
      : jsonResponse([]),
  );
  assert.equal(await fetchMarketById("1"), null);
  installFetch(() => jsonResponse({ id: "2" }));
  await assert.rejects(fetchMarketById("1"), /mismatch/);
});

await test("real request deadline aborts a hung transport", async () => {
  globalThis.fetch = ((_input: unknown, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const fail = () => reject(init.signal?.reason);
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener("abort", fail, { once: true });
    })) as typeof fetch;
  // Keep the process alive while AbortSignal.timeout's unref'ed timer runs.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      fetchGammaEntityById(
        { baseUrl: "https://gamma.test", timeoutMs: 5 },
        "events",
        "1",
        false,
      ),
      /timeout/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

await test("partial market payload cannot erase an existing projection", async () => {
  installFetch(() => jsonResponse({ id: "1", closed: true }));
  await assert.rejects(fetchMarketById("1"), /Incomplete/);
});

await test("V2 identity uses positionIds without legacy clobTokenIds", async () => {
  const { clobTokenIds: _legacy, ...market } = publicMarket;
  const urls = installFetch(() => jsonResponse({ ...market, id: "1" }));
  assert.deepEqual(
    (await fetchMarketById("1"))?.positionIds,
    market.positionIds,
  );
  assert.equal(urls.length, 1);
});

await test("malformed row reaches durable repair without poisoning the page or offset", async () => {
  const offsets: number[] = [];
  installFetch((url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    return jsonResponse(
      offset === 100 ? [event("101"), { ...event("102"), title: null }] : [],
    );
  });
  const repairs = new Set<string>();
  const processed: string[] = [];
  const result = await runGammaV2CatchUp({
    checkpoint: { phase: "catalog", offset: 100 },
    pageSize: 100,
    maxPages: 2,
    maxOffset: 100_000,
    fetchPage: fetchEventsPage,
    processPage: async (events) => {
      let count = 0;
      for (const row of events) {
        if (PolymarketEvent.safeParse(row).success) {
          processed.push(row.id);
          count += 1;
        } else repairs.add(row.id);
      }
      return { processedEvents: count, processedMarkets: 0 };
    },
    saveCheckpoint: async () => {
      assert.equal(repairs.has("102"), true);
    },
    pause: async () => {},
  });
  assert.deepEqual(offsets, [100, 102]);
  assert.deepEqual(processed, ["101"]);
  assert.equal(result.checkpoint.phase, "complete");
  assert.equal(result.received, 2);
  assert.equal(result.skippedEvents, 1);
});

await test("mixed ID batch isolates invalid row and recovers its exact direct payload", async () => {
  installFetch((url) =>
    new URL(url).pathname === "/events/2"
      ? jsonResponse(event("2"))
      : jsonResponse([event("1"), { ...event("2"), title: null }]),
  );
  const result = await fetchEventsByIdsDetailed(["1", "2"]);
  assert.deepEqual(
    result.events.map((row) => row.id),
    ["1", "2"],
  );
  assert.deepEqual(result.failedIds, []);
});

await test("common Gamma cap preserves smaller configured pages", async () => {
  assert.equal(gammaPageSize(200), 100);
  assert.equal(gammaPageSize(32), 32);
  const urls = installFetch(() => jsonResponse([]));
  await fetchEventsPage({ version: "v2", offset: 0, limit: 32 });
  assert.equal(new URL(urls[0] ?? "").searchParams.get("limit"), "32");
});
