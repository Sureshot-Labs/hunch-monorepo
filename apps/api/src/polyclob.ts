import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { Client } from "pg";
import { polymarketL2Request } from "./services/polymarket-clob-l2.js";
import {
  decryptCredentialsString,
  getCredentialsEncryptionKey,
} from "./lib/credentials-encryption.js";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
console.log(`[polyclob] Loading env from ${envPath}`);
config({ path: envPath, override: false });

const args = process.argv.slice(2);

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C hunch-monorepo/apps/api polycurl <address?> <path>",
      "  (loads POLYMARKET_L2_* creds from repo root .env if present)",
      "  --use-db will load L2 creds from user_venue_credentials",
      "",
      "Examples:",
      "  POLYMARKET_L2_API_KEY=... POLYMARKET_L2_API_SECRET=... POLYMARKET_L2_API_PASSPHRASE=... \\",
      "  pnpm -C hunch-monorepo/apps/api polycurl 0x... /data/trades?maker=0x...&after=1710000000",
      "",
      "  POLYMARKET_L2_ADDRESS=0x... pnpm -C hunch-monorepo/apps/api polycurl /data/orders",
      "",
      "Optional flags:",
      "  --use-db (read creds from DB; requires DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY)",
      "  --user-id <uuid> (when multiple users share the wallet)",
      "  --method POST|DELETE",
      "  --body '<json>' or --body @/path/to/file.json",
    ].join("\n"),
  );
  process.exit(1);
}

let address: string | undefined;
let requestPath: string | undefined;
let useDb = false;
let userId: string | undefined;

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

const baseUrl =
  process.env.POLYMARKET_CLOB_BASE?.trim() || "https://clob.polymarket.com";
const apiKey = process.env.POLYMARKET_L2_API_KEY?.trim();
const apiSecret = process.env.POLYMARKET_L2_API_SECRET?.trim();
const apiPassphrase = process.env.POLYMARKET_L2_API_PASSPHRASE?.trim();
const resolvedAddress =
  address ?? process.env.POLYMARKET_L2_ADDRESS?.trim();

type ResolvedCreds = {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  source: "env" | "db";
};

async function resolveDbCreds(): Promise<ResolvedCreds | null> {
  if (!resolvedAddress) return null;
  if (!process.env.DATABASE_URL) return null;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let resolvedUserId = userId;
    let resolvedRow:
      | {
          user_id: string;
          api_key: string;
          api_secret: string | null;
          api_secret_enc: string | null;
          api_passphrase_enc: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!resolvedUserId) {
      const credsRows = await client.query<{
        user_id: string;
        api_key: string;
        api_secret: string | null;
        api_secret_enc: string | null;
        api_passphrase_enc: string | null;
        updated_at: string | null;
      }>(
        `
          select user_id, api_key, api_secret, api_secret_enc, api_passphrase_enc, updated_at
          from user_venue_credentials
          where venue = 'polymarket'
            and is_active = true
            and lower(wallet_address) = lower($1)
          order by updated_at desc
          limit 2
        `,
        [resolvedAddress],
      );

      if (credsRows.rows.length === 1) {
        resolvedRow = credsRows.rows[0];
        resolvedUserId = resolvedRow.user_id;
        console.log(
          `[polyclob] Resolved user ${resolvedUserId} from credentials (updated ${resolvedRow.updated_at ?? "unknown"})`,
        );
      } else if (credsRows.rows.length > 1) {
        resolvedRow = credsRows.rows[0];
        resolvedUserId = resolvedRow.user_id;
        console.warn(
          `[polyclob] Multiple Polymarket credential rows found for wallet; using most recent (user ${resolvedUserId}, updated ${resolvedRow.updated_at ?? "unknown"}). Pass --user-id to override.`,
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
        new Set(walletRows.rows.map((row) => row.user_id)),
      );
      if (userIds.length === 0) return null;
      if (userIds.length > 1) {
        throw new Error(
          `Multiple users found for wallet ${resolvedAddress}; pass --user-id`,
        );
      }
      resolvedUserId = userIds[0];
      console.log(
        `[polyclob] Resolved user ${resolvedUserId} from user_wallets`,
      );
    }

    const row = resolvedRow
      ? resolvedRow
      : (
          await client.query<{
            user_id: string;
            api_key: string;
            api_secret: string | null;
            api_secret_enc: string | null;
            api_passphrase_enc: string | null;
            updated_at: string | null;
          }>(
            `
              select user_id, api_key, api_secret, api_secret_enc, api_passphrase_enc, updated_at
              from user_venue_credentials
              where user_id = $1
                and venue = 'polymarket'
                and is_active = true
                and lower(wallet_address) = lower($2)
              limit 1
            `,
            [resolvedUserId, resolvedAddress],
          )
        ).rows[0];
    if (!row) return null;

    const key = getCredentialsEncryptionKey();
    const apiSecretResolved = row.api_secret_enc
      ? decryptCredentialsString(row.api_secret_enc, key)
      : row.api_secret ?? "";
    const apiPassphraseResolved = row.api_passphrase_enc
      ? decryptCredentialsString(row.api_passphrase_enc, key)
      : "";

    if (!row.api_key || !apiSecretResolved || !apiPassphraseResolved) {
      return null;
    }

    return {
      apiKey: row.api_key,
      apiSecret: apiSecretResolved,
      apiPassphrase: apiPassphraseResolved,
      source: "db",
    };
  } finally {
    await client.end();
  }
}

let resolvedCreds: ResolvedCreds | null =
  apiKey && apiSecret && apiPassphrase
    ? {
        apiKey,
        apiSecret,
        apiPassphrase,
        source: "env",
      }
    : null;

if (useDb || !resolvedCreds) {
  resolvedCreds = await resolveDbCreds();
}

if (!resolvedCreds || !resolvedAddress) {
  console.error(
    "Missing L2 creds: set POLYMARKET_L2_API_KEY, POLYMARKET_L2_API_SECRET, POLYMARKET_L2_API_PASSPHRASE, and POLYMARKET_L2_ADDRESS (or pass address).",
  );
  console.error(
    "To load creds from DB, pass --use-db and ensure DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY are set.",
  );
  process.exit(1);
}

console.log(`[polyclob] Using ${resolvedCreds.source} credentials`);

let normalizedPath = requestPath;
if (normalizedPath.startsWith("http")) {
  try {
    const url = new URL(normalizedPath);
    normalizedPath = `${url.pathname}${url.search}`;
  } catch {
    // leave as-is; polymarketL2Request will error if invalid
  }
}

const body = await resolveBody();

const response = await polymarketL2Request({
  baseUrl,
  timeoutMs: 15_000,
  address: resolvedAddress,
  creds: {
    apiKey: resolvedCreds.apiKey,
    apiSecret: resolvedCreds.apiSecret,
    apiPassphrase: resolvedCreds.apiPassphrase,
  },
  method: method as "GET" | "POST" | "DELETE",
  requestPath: normalizedPath,
  body,
});

if (!response.ok) {
  console.error(JSON.stringify(response.payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(response.payload, null, 2));
