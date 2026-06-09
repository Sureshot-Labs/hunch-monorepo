import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.POLYMARKET_GAMMA_BASE = "https://gamma.test";
process.env.POLYMARKET_GAMMA_RETRY_ATTEMPTS = "2";
process.env.POLYMARKET_GAMMA_RETRY_BASE_MS = "0";

const { fetchEventsByIdsDetailed } = await import("./gammaClient.js");

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
      return textResponse("bad gateway", 502);
    }
    return jsonResponse(ids.map(event));
  });

  const result = await fetchEventsByIdsDetailed(["1", "2", "3", "4"]);

  assert.equal(urls.length, 4);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(result.failedIds, []);
});

await test("fetchEventsByIdsDetailed reports only singleton event failures", async () => {
  const urls = installFetch((url) => {
    const ids = idsFromUrl(url);
    if (ids.length > 1 || ids[0] === "2") {
      return textResponse("bad gateway", 502);
    }
    return jsonResponse(ids.map(event));
  });

  const result = await fetchEventsByIdsDetailed(["1", "2"]);

  assert.equal(urls.length, 5);
  assert.deepEqual(
    result.events.map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(result.failedIds, ["2"]);
});
