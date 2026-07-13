const fs = require("node:fs");
const path = require("node:path");

function findUp(filename, startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const envPath = findUp(".env", process.cwd());
if (envPath) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("dotenv").config({ path: envPath, override: true });
}

// Node 18+ has global fetch; for older Node versions, fall back to undici.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const undici = require("undici");
const fetchImpl = globalThis.fetch || undici.fetch;

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(`
Usage:
  pnpm smoke:api

Options:
  --base <url>      Base URL (default: http://127.0.0.1:$PORT)
  --venue <name>    Venue filter for /feed (default: polymarket)
  --limit <n>       /feed limit (default: 3)
  --timeout <ms>    Per-request timeout (default: 10000)
  --verbose         Print small response snippets
`.trim());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function httpJson(baseUrl, pathname, opts) {
  const url = new URL(pathname, baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  const t0 = Date.now();

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    const xCache = res.headers.get("x-cache") || "-";
    const etag = res.headers.get("etag") || "-";

    console.log(
      `[${res.status}] GET ${pathname} ${ms}ms x-cache=${xCache} etag=${etag}`,
    );

    if (!res.ok) {
      const snippet = text.slice(0, 800);
      throw new Error(`HTTP ${res.status} ${pathname}\n${snippet}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${pathname}: ${text.slice(0, 200)}`);
    }

    if (opts.verbose) {
      const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      console.log(snippet);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function httpText(baseUrl, pathname, opts, requestOpts = {}) {
  const url = new URL(pathname, baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  const t0 = Date.now();

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "*/*", ...requestOpts.headers },
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.status === 404 && requestOpts.optionalNotFound) {
      console.log(
        `[404] GET ${pathname} ${ms}ms skipped=${requestOpts.optionalNotFound}`,
      );
      return null;
    }
    console.log(`[${res.status}] GET ${pathname} ${ms}ms bytes=${text.length}`);
    if (!res.ok) {
      const snippet = text.slice(0, 800);
      throw new Error(`HTTP ${res.status} ${pathname}\n${snippet}`);
    }
    if (opts.verbose) {
      const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      console.log(snippet);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage();
    return;
  }

  const port = Number(process.env.PORT ?? "3001");
  const baseUrl = getArg("--base") || `http://127.0.0.1:${port}`;
  const venue = (getArg("--venue") || "polymarket").toLowerCase();
  const limit = Math.max(1, Number(getArg("--limit") || "3"));
  const timeoutMs = Math.max(1000, Number(getArg("--timeout") || "10000"));
  const verbose = hasFlag("--verbose");

  const opts = { timeoutMs, verbose };
  const metricsAuthToken = process.env.METRICS_AUTH_TOKEN?.trim();

  console.log(`[smoke] base=${baseUrl} venue=${venue} limit=${limit}`);

  const health = await httpJson(baseUrl, "/health", opts);
  assert(health && health.ok === true, "Expected /health to return { ok: true }");

  await httpJson(baseUrl, "/price-history/status", opts);
  await httpText(baseUrl, "/metrics", opts, {
    optionalNotFound: "metrics_disabled",
    headers: metricsAuthToken
      ? { "x-metrics-token": metricsAuthToken }
      : undefined,
  });

  const feed = await httpJson(
    baseUrl,
    `/feed?venue=${encodeURIComponent(venue)}&limit=${limit}&offset=0`,
    opts,
  );

  assert(feed && Array.isArray(feed.data), "Expected /feed JSON with data[]");
  console.log(`[smoke] /feed returned ${feed.data.length} events`);

  const firstEvent = feed.data.find((e) => e && typeof e.eventId === "string");
  if (!firstEvent) {
    console.log("[smoke] No events returned; skipping /events and /markets.");
    return;
  }

  const eventId = firstEvent.eventId;
  const event = await httpJson(
    baseUrl,
    `/events/${encodeURIComponent(eventId)}`,
    opts,
  );
  assert(event && event.eventId, "Expected /events/:eventId to return eventId");
  console.log(
    `[smoke] /events returned markets=${Array.isArray(event.markets) ? event.markets.length : "?"}`,
  );

  const firstMarket =
    (firstEvent.markets || []).find((m) => m && typeof m.marketId === "string") ||
    (Array.isArray(event.markets)
      ? event.markets.find((m) => m && typeof m.marketId === "string")
      : undefined);
  if (!firstMarket) {
    console.log("[smoke] No marketId found; skipping /markets.");
    return;
  }

  const marketId = firstMarket.marketId;
  const market = await httpJson(
    baseUrl,
    `/markets/${encodeURIComponent(marketId)}`,
    opts,
  );
  assert(market && market.marketId, "Expected /markets/:marketId to return marketId");
  console.log(
    `[smoke] /markets ok venue=${market.venue} venueMarketId=${market.venueMarketId}`,
  );
}

main().catch((err) => {
  console.error("[smoke] FAILED");
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
