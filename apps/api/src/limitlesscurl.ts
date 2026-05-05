import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { Client } from "pg";
import { limitlessRequest } from "./services/limitless-client.js";
import {
  decryptCredentialsString,
  getCredentialsEncryptionKey,
} from "./lib/credentials-encryption.js";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
console.log(`[limitlesscurl] Loading env from ${envPath}`);
config({ path: envPath, override: false });

const args = process.argv.slice(2);

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C hunch-monorepo/apps/api limitlesscurl <address?> <path>",
      "  --use-db will load Limitless auth from user_venue_credentials",
      "",
      "Examples:",
      "  LIMITLESS_API_KEY=lmts_... pnpm -C hunch-monorepo/apps/api limitlesscurl /portfolio/positions",
      "  LIMITLESS_SESSION=... pnpm -C hunch-monorepo/apps/api limitlesscurl /portfolio/positions",
      "  pnpm -C hunch-monorepo/apps/api limitlesscurl --use-db 0x... /portfolio/positions",
      "",
      "Optional flags:",
      "  --use-db (read Limitless auth from DB; requires DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY)",
      "  --user-id <uuid> (when multiple users share the wallet)",
      "  --method GET|POST|DELETE",
      "  --body '<json>' or --body @/path/to/file.json",
      "  --base-url <url>",
    ].join("\n"),
  );
  process.exit(1);
}

let address: string | undefined;
let requestPath: string | undefined;
let useDb = false;
let userId: string | undefined;
let baseUrl: string | undefined;

if (args.length === 0) {
  usage();
}

const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--use-db") {
    useDb = true;
    continue;
  }
  if (arg === "--user-id") {
    userId = args[i + 1];
    i += 1;
    continue;
  }
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

if (positional[0] && isHexAddress(positional[0])) {
  address = positional[0];
  requestPath = positional[1];
} else {
  requestPath = positional[0];
}

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

const sessionFromEnv = process.env.LIMITLESS_SESSION?.trim();
const apiKeyFromEnv = process.env.LIMITLESS_API_KEY?.trim();
const resolvedAddress = address ?? process.env.LIMITLESS_WALLET_ADDRESS?.trim();

type ResolvedAuth = {
  apiKey?: string;
  sessionCookie?: string;
  source: "env" | "db";
  userId?: string;
};

async function resolveDbAuth(): Promise<ResolvedAuth | null> {
  if (!resolvedAddress) return null;
  if (!process.env.DATABASE_URL) return null;
  const encryptionKey = getCredentialsEncryptionKey();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let resolvedUserId = userId;
    let row:
      | {
          user_id: string;
          api_secret: string | null;
          api_secret_enc: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!resolvedUserId) {
      const credsRows = await client.query<{
        user_id: string;
        api_secret: string | null;
        api_secret_enc: string | null;
        updated_at: string | null;
      }>(
        `
          select user_id, api_secret, api_secret_enc, updated_at
          from user_venue_credentials
          where venue = 'limitless'
            and is_active = true
            and lower(wallet_address) = lower($1)
          order by updated_at desc
          limit 2
        `,
        [resolvedAddress],
      );

      if (credsRows.rows.length === 1) {
        row = credsRows.rows[0];
        resolvedUserId = row.user_id;
        console.log(
          `[limitlesscurl] Resolved user ${resolvedUserId} from credentials (updated ${row.updated_at ?? "unknown"})`,
        );
      } else if (credsRows.rows.length > 1) {
        row = credsRows.rows[0];
        resolvedUserId = row.user_id;
        console.warn(
          `[limitlesscurl] Multiple credential rows found; using most recent (user ${resolvedUserId}, updated ${row.updated_at ?? "unknown"}). Pass --user-id to override.`,
        );
      }
    }

    if (!resolvedUserId) {
      const walletRows = await client.query<{ user_id: string }>(
        `
          select user_id
          from user_wallets
          where lower(wallet_address) = lower($1)
        `,
        [resolvedAddress],
      );
      const userIds = Array.from(
        new Set(walletRows.rows.map((r) => r.user_id)),
      );
      if (userIds.length === 0) return null;
      if (userIds.length > 1) {
        throw new Error(
          `Multiple users found for wallet ${resolvedAddress}; pass --user-id`,
        );
      }
      resolvedUserId = userIds[0];
      console.log(
        `[limitlesscurl] Resolved user ${resolvedUserId} from user_wallets`,
      );
    }

    const resolvedRow =
      row ??
      (
        await client.query<{
          user_id: string;
          api_secret: string | null;
          api_secret_enc: string | null;
          updated_at: string | null;
        }>(
          `
            select user_id, api_secret, api_secret_enc, updated_at
            from user_venue_credentials
            where user_id = $1
              and venue = 'limitless'
              and is_active = true
              and lower(wallet_address) = lower($2)
            limit 1
          `,
          [resolvedUserId, resolvedAddress],
        )
      ).rows[0];

    if (!resolvedRow) return null;
    const secretRaw =
      resolvedRow.api_secret_enc ?? resolvedRow.api_secret ?? null;
    if (!secretRaw) return null;
    const secret = resolvedRow.api_secret_enc
      ? decryptCredentialsString(secretRaw, encryptionKey)
      : secretRaw;
    const auth = secret.trim().toLowerCase().startsWith("lmts_")
      ? { apiKey: secret }
      : { sessionCookie: secret };

    return {
      ...auth,
      source: "db",
      userId: resolvedRow.user_id,
    };
  } finally {
    await client.end();
  }
}

const resolvedBody = await resolveBody();
const auth =
  (apiKeyFromEnv && { apiKey: apiKeyFromEnv, source: "env" as const }) ||
  (sessionFromEnv && {
    sessionCookie: sessionFromEnv,
    source: "env" as const,
  }) ||
  (useDb ? await resolveDbAuth() : null);

if (!auth?.sessionCookie && !auth?.apiKey) {
  console.error("[limitlesscurl] No Limitless auth resolved.");
  usage();
}

const requestPathNormalized = requestPath.startsWith("/")
  ? requestPath
  : `/${requestPath}`;

const result = await limitlessRequest({
  method: method as "GET" | "POST" | "DELETE",
  requestPath: requestPathNormalized,
  ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
  ...(auth.sessionCookie ? { sessionCookie: auth.sessionCookie } : {}),
  body: resolvedBody,
  baseUrl: baseUrl?.trim() || undefined,
});

const output = {
  ok: result.ok,
  ...(result.ok ? {} : { status: result.status }),
  payload: result.payload,
};

console.log(JSON.stringify(output, null, 2));
