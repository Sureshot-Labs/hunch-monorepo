import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
console.log(`[dflowcurl] Loading env from ${envPath}`);
config({ path: envPath, override: false });

const args = process.argv.slice(2);

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C hunch-monorepo/apps/api dflowcurl <path>",
      "",
      "Examples:",
      "  pnpm -C hunch-monorepo/apps/api dflowcurl /api/v1/trades/by-mint/<mint>?limit=5",
      "  DFLOW_API_KEY=... pnpm -C hunch-monorepo/apps/api dflowcurl /api/v1/trades?limit=10",
      "",
      "Optional flags:",
      "  --method GET|POST|DELETE",
      "  --body '<json>' or --body @/path/to/file.json",
      "  --base-url <url> (defaults to DFLOW_PREDICTION_MARKETS_API_BASE)",
    ].join("\n"),
  );
  process.exit(1);
}

if (args.length === 0) {
  usage();
}

let baseUrl: string | undefined;

const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--base-url") {
    baseUrl = args[i + 1];
    i += 1;
    continue;
  }
  if (arg === "--method" || arg === "--body") {
    i += 1;
    continue;
  }
  positional.push(arg);
}

const requestPath = positional[0];

if (!requestPath) {
  usage();
}

const methodFlagIndex = args.findIndex((value) => value === "--method");
const method =
  methodFlagIndex >= 0 && args[methodFlagIndex + 1]
    ? args[methodFlagIndex + 1].toUpperCase()
    : "GET";

const bodyFlagIndex = args.findIndex((value) => value === "--body");
const bodyRaw =
  bodyFlagIndex >= 0 && args[bodyFlagIndex + 1]
    ? args[bodyFlagIndex + 1]
    : null;

async function resolveBody(): Promise<unknown> {
  if (!bodyRaw) return undefined;
  if (bodyRaw.startsWith("@")) {
    const path = bodyRaw.slice(1);
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  }
  return JSON.parse(bodyRaw);
}

const apiKey = process.env.DFLOW_API_KEY?.trim();
if (!apiKey) {
  console.error("[dflowcurl] Missing DFLOW_API_KEY.");
  usage();
}

const base =
  baseUrl?.trim() ||
  process.env.DFLOW_PREDICTION_MARKETS_API_BASE?.trim() ||
  "https://prediction-markets-api.dflow.net";

const requestPathNormalized = requestPath.startsWith("/")
  ? requestPath
  : `/${requestPath}`;

const resolvedBody = await resolveBody();

const url = new URL(requestPathNormalized, base);
const res = await fetch(url.toString(), {
  method,
  headers: {
    "x-api-key": apiKey,
    ...(resolvedBody ? { "Content-Type": "application/json" } : {}),
  },
  body: resolvedBody ? JSON.stringify(resolvedBody) : undefined,
});

const text = await res.text();
let payload: unknown = text;
try {
  payload = JSON.parse(text);
} catch {
  // leave as text
}

const output = {
  ok: res.ok,
  status: res.status,
  payload,
};

console.log(JSON.stringify(output, null, 2));
