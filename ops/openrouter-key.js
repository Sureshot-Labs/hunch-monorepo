const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

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

function getArg(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function usage() {
  console.log(`
Usage:
  pnpm openrouter:key

Options:
  --env <path>     Use a specific .env file (default: find up from cwd)
  --json           Print selected fields as JSON
  --raw            Print raw response data
  --timeout <ms>   Request timeout (default: 15000)
`.trim());
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const envArg = getArg("--env");
const envPath = envArg ? path.resolve(envArg) : findUp(".env", process.cwd());
if (envPath && fs.existsSync(envPath)) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("dotenv").config({ path: envPath, override: true });
}

const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
if (!apiKey) {
  console.error(
    "[openrouter] Missing OPENROUTER_API_KEY (expected in .env or process env).",
  );
  process.exit(1);
}

// Node 18+ has global fetch; for older Node versions, fall back to undici.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const undici = require("undici");
const fetchImpl = globalThis.fetch || undici.fetch;

function fmt(value) {
  return value === undefined || value === null ? "null" : String(value);
}

async function main() {
  const timeoutMs = Math.max(1000, Number(getArg("--timeout") || "15000"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const text = await res.text();

    if (!res.ok) {
      const snippet = text.slice(0, 800);
      console.error(`[openrouter] HTTP ${res.status} ${res.statusText}`);
      if (snippet) console.error(snippet);
      process.exit(1);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error(
        `[openrouter] Non-JSON response: ${text.slice(0, 200) || "(empty)"}`,
      );
      process.exit(1);
    }

    const data = json && json.data ? json.data : {};
    if (hasFlag("--raw")) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const output = {
      label: data.label ?? null,
      limit: data.limit ?? null,
      limit_remaining: data.limit_remaining ?? null,
      limit_reset: data.limit_reset ?? null,
      include_byok_in_limit: data.include_byok_in_limit ?? null,
      usage: data.usage ?? null,
      usage_daily: data.usage_daily ?? null,
      usage_weekly: data.usage_weekly ?? null,
      usage_monthly: data.usage_monthly ?? null,
      byok_usage: data.byok_usage ?? null,
      byok_usage_daily: data.byok_usage_daily ?? null,
      byok_usage_weekly: data.byok_usage_weekly ?? null,
      byok_usage_monthly: data.byok_usage_monthly ?? null,
      is_free_tier: data.is_free_tier ?? null,
    };

    if (hasFlag("--json")) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(
      `[openrouter] label=${fmt(output.label)} freeTier=${fmt(output.is_free_tier)}`,
    );
    console.log(
      `[openrouter] limit=${fmt(output.limit)} remaining=${fmt(output.limit_remaining)} reset=${fmt(output.limit_reset)}`,
    );
    console.log(
      `[openrouter] includeByokInLimit=${fmt(output.include_byok_in_limit)}`,
    );

    if (
      typeof output.limit === "number" &&
      typeof output.limit_remaining === "number"
    ) {
      const used = output.limit - output.limit_remaining;
      const pct =
        output.limit > 0 ? `${((used / output.limit) * 100).toFixed(2)}%` : "n/a";
      console.log(`[openrouter] used=${used} (${pct})`);
    }

    console.log(
      `[openrouter] usage total=${fmt(output.usage)} daily=${fmt(output.usage_daily)} weekly=${fmt(output.usage_weekly)} monthly=${fmt(output.usage_monthly)}`,
    );
    console.log(
      `[openrouter] byok total=${fmt(output.byok_usage)} daily=${fmt(output.byok_usage_daily)} weekly=${fmt(output.byok_usage_weekly)} monthly=${fmt(output.byok_usage_monthly)}`,
    );

    if (data.rate_limit) {
      const interval = data.rate_limit.interval ?? "n/a";
      const requests = data.rate_limit.requests ?? "n/a";
      console.log(
        `[openrouter] rateLimit interval=${interval} requests=${requests} (deprecated)`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((err) => {
  console.error("[openrouter] FAILED");
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
