import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseDotenv } from "dotenv";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_DATABASE = "hip4_local";
export const LOCAL_REDIS = "redis://127.0.0.1:55437";
export const LOCAL_RECEIVE_ENV = "untracked/hip4-local.env";
const receiveKeyValid = (key) => /^[a-f0-9]{64}$/iu.test(key ?? "");

/** Explicit local-only configuration, never production .env/inherited pepper.
 * Both check and normal startup are strictly read-only: provision once, retain
 * the same private key across restarts so issued Receive options stay usable. */
export function readLocalReceiveOptionKey(root = ROOT) {
  const filename = path.join(root, LOCAL_RECEIVE_ENV);
  try {
    const directory = lstatSync(path.dirname(filename));
    const file = lstatSync(filename);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      (file.mode & 0o077) !== 0
    )
      return { status: "unsafe_file", key: null };
    const key = parseDotenv(
      readFileSync(filename),
    ).ADMIN_SERVICE_TOKEN_PEPPER?.trim();
    return receiveKeyValid(key)
      ? { status: "valid", key }
      : { status: key ? "invalid" : "missing", key: null };
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unreadable",
      key: null,
    };
  }
}
// Public, disposable local identity retained from untracked/hip4-local-api.mjs.
// Never use this key or this launcher for a non-loopback deployment.
const LOCAL_JWT = "hip4-disposable-local-live-only";
export const SELECTED_KEYS = [
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "RELAY_API_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
  "FUNDING_REFERENCE_LOOKUP_KEY_VERSION",
  "POLYMARKET_FUNDING_ROUTER_ADDRESS",
  "POLYGON_RPC_URL",
  "BASE_RPC_URL",
  "SOLANA_RPC_URL",
  "SOLANA_RPC_URLS",
  "ARBITRUM_RPC_URL",
  "ETHEREUM_RPC_URL",
  "OPTIMISM_RPC_URL",
  "BSC_RPC_URL",
  "AVALANCHE_RPC_URL",
  "LINEA_RPC_URL",
  "EVM_RPC_URLS_BY_CHAIN",
  "LIMITLESS_HMAC_TOKEN_ID",
  "LIMITLESS_HMAC_SECRET",
  "LIMITLESS_WS_SESSION",
];
// Ordinary interactive Polymarket setup needs the builder relayer credentials.
// These authenticate the service, not the user's wallet signature. Keep them
// API-only: passive indexers/sync and the reconciliation worker do not need them.
export const API_INTERACTIVE_KEYS = [
  "POLYMARKET_BUILDER_API_KEY",
  "POLYMARKET_BUILDER_API_SECRET",
  "POLYMARKET_BUILDER_API_PASSPHRASE",
];
const ENTRIES = {
  api: "apps/api/dist/server.js",
  indexer: "apps/api/dist/hip4-indexer.js",
  "finance-worker": "apps/finance-worker/dist/main.js",
  "indexer-polymarket": "apps/indexer-polymarket/dist/main.js",
  "indexer-limitless": "apps/indexer-limitless/dist/main.js",
  "sync-polymarket": "ops/hip4-local-sync.mjs",
  "sync-limitless": "ops/hip4-local-sync.mjs",
  "sync-hyperliquid": "apps/api/dist/hip4-indexer.js",
};

export const CATALOG_SYNC_PAGE_DEFAULTS = { polymarket: 10, limitless: 40 };

export function isReadOnlyMode(mode) {
  return (
    Object.hasOwn(ENTRIES, mode) && !["api", "finance-worker"].includes(mode)
  );
}

export function validateCatalogPageBudget(raw) {
  const value = Number(raw);
  if (
    !/^\d+$/u.test(String(raw)) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10_000
  )
    throw new Error("--max-pages must be an integer from 1 to 10000");
  return value;
}

export function serviceArtifacts(mode) {
  if (!Object.hasOwn(ENTRIES, mode)) throw new Error("Unknown local mode");
  const venue = mode.startsWith("sync-") ? mode.slice(5) : null;
  return [
    ENTRIES[mode],
    "packages/config/dist/secrets.js",
    ...(["polymarket", "limitless"].includes(venue)
      ? ["bootstrap", "db", "redis"].map(
          (name) => `apps/indexer-${venue}/dist/${name}.js`,
        )
      : []),
  ];
}

export function parseArgs(argv) {
  const result = { mode: "api", check: false, help: false };
  let modeSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--check") result.check = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--database-url" || value === "--expect-database") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${value}`);
      const key =
        value === "--database-url" ? "databaseUrl" : "expectedDatabase";
      if (result[key] !== undefined)
        throw new Error(`Duplicate option: ${value}`);
      result[key] = argv[++i];
    } else if (value === "--max-pages") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error("Missing value for --max-pages");
      if (result.maxPages !== undefined)
        throw new Error("Duplicate option: --max-pages");
      result.maxPages = validateCatalogPageBudget(argv[++i]);
    } else if (Object.hasOwn(ENTRIES, value) && !modeSeen) {
      result.mode = value;
      modeSeen = true;
    } else throw new Error("Unknown option or duplicate mode; use --help");
  }
  if (
    result.maxPages !== undefined &&
    !["sync-polymarket", "sync-limitless"].includes(result.mode)
  )
    throw new Error(
      "--max-pages is only supported by sync-polymarket and sync-limitless",
    );
  if (!result.help)
    result.databaseUrl = validateDatabaseTarget(
      result.databaseUrl,
      result.expectedDatabase,
    );
  return result;
}

export function validateDatabaseTarget(raw, expectedDatabase) {
  if (expectedDatabase !== LOCAL_DATABASE)
    throw new Error("Require --expect-database hip4_local");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Require an explicit loopback --database-url");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== "55436" ||
    url.pathname !== `/${LOCAL_DATABASE}` ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Database must be loopback port 55436 /hip4_local with no URL options",
    );
  // Do not allow local hostname resolution to change the target.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

export function buildLocalEnvironment(
  values,
  options,
  inherited = process.env,
  receiveOptionKey = null,
) {
  const local = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ])
    if (inherited[key] !== undefined) local[key] = inherited[key];
  for (const key of SELECTED_KEYS)
    if (values[key]?.trim()) local[key] = values[key];
  if (options.mode === "api")
    for (const key of API_INTERACTIVE_KEYS)
      if (values[key]?.trim()) local[key] = values[key];
  return Object.assign(local, {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "4014",
    DATABASE_URL: validateDatabaseTarget(
      options.databaseUrl,
      options.expectedDatabase,
    ),
    REDIS_URL: LOCAL_REDIS,
    JWT_SECRET: LOCAL_JWT,
    ADMIN_SERVICE_TOKEN_PEPPER:
      options.mode === "api" && receiveKeyValid(receiveOptionKey)
        ? receiveOptionKey
        : "",
    HUNCH_SECRETS_MODE: "off",
    HUNCH_SECRET_BUNDLES: "",
    HUNCH_SECRET_REQUIRED_KEYS: "",
    // Preserve the existing local users.is_admin login path, not a new grant.
    // auth.ts still requires the authenticated user's persisted isAdmin flag.
    ADMIN_AUTH_LEGACY_FALLBACK: "true",
    HUNCH_TELEGRAM_VENUE_RECONCILE_ENABLED: "false",
    HUNCH_FINANCE_WORKER_ENABLED: String(options.mode === "finance-worker"),
    HUNCH_FINANCE_EXECUTE: "false",
    HUNCH_FINANCE_FUNDING_RECONCILIATION_ENABLED: "true",
    HUNCH_FINANCE_STANDALONE_RECONCILIATION_ENABLED: "true",
    HUNCH_FINANCE_TELEGRAM_TRADE_INTENTS_ENABLED: "false",
    HUNCH_FUNDING_PM_WRAP_EXECUTE: "false",
    HUNCH_FINANCE_COLLECT_ENABLED: "false",
    HUNCH_FINANCE_RECONCILE_ENABLED: "false",
    HUNCH_FINANCE_KALSHI_EXECUTIONS_ENABLED: "false",
    HUNCH_FINANCE_PRIVY_DELETION_RECONCILIATION_ENABLED: "false",
    HUNCH_FINANCE_SWEEP_ENABLED: "false",
    HUNCH_FINANCE_PAYOUT_PREPARE_ENABLED: "false",
    HUNCH_FINANCE_PAYOUT_SEND_ENABLED: "false",
    HUNCH_FINANCE_API_CACHE_WARM_ENABLED: "false",
    CONTENT_ENABLED: "false",
    CONTENT_WORKER_ENABLED: "false",
    ...(options.mode === "sync-polymarket"
      ? {
          POLYMARKET_HOT_MAX_PAGES: String(
            options.maxPages ?? CATALOG_SYNC_PAGE_DEFAULTS.polymarket,
          ),
        }
      : {}),
    ...(options.mode === "sync-limitless"
      ? {
          LIMITLESS_MAX_PAGES: String(
            options.maxPages ?? CATALOG_SYNC_PAGE_DEFAULTS.limitless,
          ),
        }
      : {}),
  });
}

export function configurationStatus(
  local,
  mode,
  fundingEnabled = false,
  fundingAssets = [],
  fundingVenues = [],
  receiveKeyStatus = null,
) {
  const required = isReadOnlyMode(mode)
    ? []
    : ["PRIVY_APP_ID", "PRIVY_APP_SECRET"];
  if (mode === "api") required.push("ADMIN_SERVICE_TOKEN_PEPPER");
  if (fundingEnabled && !isReadOnlyMode(mode))
    required.push(
      "RELAY_API_KEY",
      "CREDENTIALS_ENCRYPTION_KEY",
      "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
    );
  if (fundingEnabled && !isReadOnlyMode(mode)) {
    if (
      fundingAssets.some((asset) => asset.startsWith("polygon:")) ||
      fundingVenues.includes("polymarket")
    )
      required.push("POLYGON_RPC_URL");
    if (
      fundingAssets.includes("base:usdc") ||
      fundingVenues.includes("limitless")
    )
      required.push("BASE_RPC_URL");
    if (fundingAssets.some((asset) => asset.startsWith("solana:")))
      required.push("SOLANA_RPC_URL");
  }
  return {
    keys: Object.fromEntries(
      [
        ...SELECTED_KEYS,
        ...API_INTERACTIVE_KEYS,
        "ADMIN_SERVICE_TOKEN_PEPPER",
      ].map((key) => [key, Boolean(local[key]?.trim())]),
    ),
    missingRequired: required.filter((key) => !local[key]?.trim()),
    interactiveTrading:
      mode === "api"
        ? {
            polymarketFundingRouter: {
              addressPresent: Boolean(
                local.POLYMARKET_FUNDING_ROUTER_ADDRESS?.trim(),
              ),
              scope:
                "Configuration only for Polymarket funding/shortfall tests. The ordinary API and funding runtime validate the canonical router address, policy and approvals.",
            },
            polymarketRelayer: {
              configured: API_INTERACTIVE_KEYS.every((key) =>
                Boolean(local[key]?.trim()),
              ),
              missingKeys: API_INTERACTIVE_KEYS.filter(
                (key) => !local[key]?.trim(),
              ),
              scope:
                "Service configuration only, not wallet readiness or transaction authority. The app still checks venue policy, owned funder, approvals and user authorization.",
              advice:
                "Restore missing builder relayer settings in the backend .env and restart pnpm dev:hip. No production credentials are fetched automatically. Missing relayer configuration does not block read-only markets or other venues.",
            },
          }
        : null,
    receiveOptionTokenKey: {
      source: LOCAL_RECEIVE_ENV,
      status:
        mode !== "api"
          ? "not_required"
          : (receiveKeyStatus ??
            (receiveKeyValid(local.ADMIN_SERVICE_TOKEN_PEPPER)
              ? "valid"
              : "missing")),
      ready:
        mode !== "api" ||
        (receiveKeyValid(local.ADMIN_SERVICE_TOKEN_PEPPER) &&
          (receiveKeyStatus === null || receiveKeyStatus === "valid")),
      advice:
        "API only: explicitly provision untracked/hip4-local.env (regular file, mode 0600) with only ADMIN_SERVICE_TOKEN_PEPPER=<32 cryptographically random bytes encoded as 64 hex characters>. Never reuse a production key or derive it from the public local JWT. Restore the original private file to preserve issued Receive options; replacing its key requires fresh options. The launcher never creates or overwrites this file.",
    },
  };
}

export function migrationManifest(root = ROOT) {
  const directory = path.join(root, "packages/db/migrations");
  return readdirSync(directory)
    .filter((name) => /^\d{4}.*\.sql$/.test(name))
    .sort()
    .map((filename) => ({
      filename,
      checksum: createHash("sha256")
        .update(readFileSync(path.join(directory, filename)))
        .digest("hex"),
    }));
}

export function schemaStatus(expected, applied) {
  const stored = new Map(applied.map((row) => [row.filename, row.checksum]));
  return {
    expectedCount: expected.length,
    appliedCount: stored.size,
    missing: expected
      .filter((row) => !stored.has(row.filename))
      .map((row) => row.filename),
    changed: expected
      .filter(
        (row) =>
          stored.has(row.filename) && stored.get(row.filename) !== row.checksum,
      )
      .map((row) => row.filename),
    unknown: [...stored.keys()].filter(
      (name) => !expected.some((row) => row.filename === name),
    ),
  };
}

export function policyStatus(rows) {
  const policies = new Map(rows.map((row) => [row.policy_key, row.payload]));
  const lifecycle = policies.get("venue_lifecycle")?.venues?.hyperliquid;
  const funding = policies.get("funding_control_plane");
  const social = policies.get("social");
  const matching = policies.get("market_matching");
  return {
    interpretation:
      "Unvalidated stored override hints only; omitted fields are null. Service policy resolvers own defaults, validation and effective capabilities. These hints are not activation evidence.",
    hipLifecycleOverride: lifecycle?.lifecycle ?? null,
    hipIndexerModeOverride: lifecycle?.indexerMode ?? null,
    fundingVersionOverride: funding?.version ?? null,
    fundingPausedOverride: funding?.paused ?? null,
    fundingVenues: Array.isArray(funding?.venues)
      ? funding.venues.filter((venue) =>
          ["polymarket", "limitless", "hyperliquid"].includes(venue),
        )
      : [],
    fundingAssets: Array.isArray(funding?.receive?.assets)
      ? funding.receive.assets.filter((asset) =>
          [
            "hypercore:usdc",
            "polygon:pusd",
            "polygon:usdc",
            "polygon:usdce",
            "base:usdc",
            "solana:usdc",
            "solana:sol",
          ].includes(asset),
        )
      : [],
    socialEnabledOverride: social?.enabled ?? null,
    publicationsEnabledOverride: social?.publicationsEnabled ?? null,
    copyEnabledOverride: social?.copyEnabled ?? null,
    hipPublicationVenueSelected:
      social?.publicationVenues?.includes("hyperliquid") ?? null,
    hipCopyVenueSelected: social?.copyVenues?.includes("hyperliquid") ?? null,
    hipMatchingVenueSelected: matching?.venues?.includes("hyperliquid") ?? null,
    matchingWorkerOverride: matching?.workerEnabled ?? null,
  };
}

export async function inspectDatabase(pool, expected) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const target = (
      await client.query(
        "select current_database() as database_name, current_setting('server_version_num')::int as version_number",
      )
    ).rows[0];
    if (target?.database_name !== LOCAL_DATABASE)
      throw new Error("Connected database is not hip4_local");
    if (Math.floor(target.version_number / 10_000) !== 16)
      throw new Error("Local stand requires PostgreSQL 16");
    const tables = (
      await client.query(
        "select to_regclass('public.schema_migrations') is not null as migrations, to_regclass('public.runtime_policies') is not null as policies",
      )
    ).rows[0];
    const applied = tables.migrations
      ? (
          await client.query(
            "select filename, checksum from public.schema_migrations",
          )
        ).rows
      : [];
    const policies = tables.policies
      ? (
          await client.query(
            "select distinct on (policy_key) policy_key, payload from public.runtime_policies where policy_key=any($1::text[]) and effective_at<=transaction_timestamp() order by policy_key, effective_at desc, created_at desc",
            [
              [
                "venue_lifecycle",
                "funding_control_plane",
                "social",
                "market_matching",
              ],
            ],
          )
        ).rows
      : [];
    return {
      database: LOCAL_DATABASE,
      postgresMajor: 16,
      schema: schemaStatus(expected, applied),
      observedOverrides: policyStatus(policies),
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

function replaceEnvironment(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export async function bootstrapLocalEnvironment(
  local,
  loadSecrets,
  envPath,
  environment = process.env,
) {
  replaceEnvironment(environment, local);
  try {
    // The ordinary bootstrap, in its documented off mode, owns its loaded marker.
    // It may load .env, but local targets and the whitelist are reapplied before
    // importing any service. No AWS bundles or provider requests are possible.
    await loadSecrets({
      envPath,
      logger: { info() {}, warn() {}, error() {} },
    });
    if (environment.HUNCH_RUNTIME_SECRETS_LOADED !== "1")
      throw new Error("Runtime secrets bootstrap did not complete");
    replaceEnvironment(environment, {
      ...local,
      HUNCH_RUNTIME_SECRETS_LOADED: environment.HUNCH_RUNTIME_SECRETS_LOADED,
    });
  } catch {
    replaceEnvironment(environment, local);
    throw new Error(
      "Local runtime secrets bootstrap failed; no service was started",
    );
  }
}

export function launchArguments(options) {
  if (["indexer", "sync-hyperliquid"].includes(options.mode))
    return [
      "--database-url",
      options.databaseUrl,
      "--expect-database",
      LOCAL_DATABASE,
      "--redis-url",
      LOCAL_REDIS,
      ...(options.mode === "sync-hyperliquid" ? ["--once"] : []),
    ];
  if (["sync-polymarket", "sync-limitless"].includes(options.mode)) {
    const venue = options.mode.slice(5);
    return [
      "--venue",
      venue,
      "--database-url",
      options.databaseUrl,
      "--expect-database",
      LOCAL_DATABASE,
      "--redis-url",
      LOCAL_REDIS,
      "--max-pages",
      String(options.maxPages ?? CATALOG_SYNC_PAGE_DEFAULTS[venue]),
    ];
  }
  return [];
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      "Usage: node ops/hip4-local.mjs [api|indexer|finance-worker|indexer-polymarket|indexer-limitless|sync-polymarket|sync-limitless|sync-hyperliquid] [--check] [--max-pages <1..10000>] --database-url <loopback:55436/hip4_local> --expect-database hip4_local\nDefault: API 127.0.0.1:4014 only. API Receive options require a separately provisioned private untracked/hip4-local.env; --check reports safe configuration advice without creating or changing it. Indexers perform public reads and local writes. sync-* runs one production read/bootstrap pass; PM catalog checkpoints are resumable, and summaries distinguish partial from complete coverage. --max-pages is supported only for PM/Limitless sync (per PM lane; defaults 10/40). finance-worker observes/reconciles and can advance existing user-authorized funding operations; it never enables autonomous HIP signing. No migrations, policy changes or financial tests are performed. Run --check for each desired mode first. Frontend starts separately with HUNCH_API_BASE_URL=http://127.0.0.1:4014 bun run dev:http.",
    );
    return;
  }
  const envPath = path.join(ROOT, ".env");
  const receiveKey =
    options.mode === "api"
      ? readLocalReceiveOptionKey()
      : { status: "not_required", key: null };
  const local = buildLocalEnvironment(
    existsSync(envPath) ? parseDotenv(readFileSync(envPath)) : {},
    options,
    process.env,
    receiveKey.key,
  );
  const pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  });
  let database;
  try {
    database = await inspectDatabase(pool, migrationManifest());
  } catch (error) {
    const known = [
      "Connected database is not hip4_local",
      "Local stand requires PostgreSQL 16",
    ];
    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          checkOnly: options.check,
          ready: false,
          configuration: configurationStatus(
            local,
            options.mode,
            false,
            [],
            [],
            receiveKey.status,
          ),
          database: {
            ready: false,
            reason: known.includes(error?.message)
              ? error.message
              : "Local database unavailable or schema inspection failed",
            ...(typeof error?.code === "string" &&
            /^[0-9A-Z]{5}$/.test(error.code)
              ? { sqlState: error.code }
              : {}),
          },
          advice:
            "Verify local PG16 is available on loopback port 55436 and hip4_local exists. No migrations or service startup were attempted.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  } finally {
    await pool.end();
  }
  const configuration = configurationStatus(
    local,
    options.mode,
    database.observedOverrides.fundingVersionOverride === 2 &&
      database.observedOverrides.fundingVenues.length > 0,
    database.observedOverrides.fundingAssets,
    database.observedOverrides.fundingVenues,
    receiveKey.status,
  );
  const built = serviceArtifacts(options.mode).every((file) =>
    existsSync(path.join(ROOT, file)),
  );
  const ready =
    built &&
    !configuration.missingRequired.length &&
    configuration.receiveOptionTokenKey.ready &&
    !database.schema.missing.length &&
    !database.schema.changed.length &&
    !database.schema.unknown.length;
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        checkOnly: options.check,
        ready,
        readinessScope:
          "Local process startup only; financial activation remains owned by service-resolved runtime policies, not the observed override hints",
        built,
        configuration,
        ...database,
        advice:
          "Missing schema: run the explicit guarded migrator after backup. Policies are diagnostic only: local venue_lifecycle owns trade activation; funding owns selected routes/assets; social owns HIP Copy/publication. No policy is changed. Missing RPC keys may use public fallbacks; verify intended source-chain config before manual funding.",
      },
      null,
      2,
    ),
  );
  if (!ready) {
    process.exitCode = 1;
    return;
  }
  if (options.check) return;
  const { loadRuntimeSecrets } = await import(
    pathToFileURL(path.join(ROOT, "packages/config/dist/secrets.js")).href
  );
  await bootstrapLocalEnvironment(local, loadRuntimeSecrets, envPath);
  const entry = path.join(ROOT, ENTRIES[options.mode]);
  process.argv = [process.execPath, entry, ...launchArguments(options)];
  await import(pathToFileURL(entry).href);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    // Raw connection/provider errors can contain credentials or URLs.
    console.error(
      "Local launcher failed; verify the explicit local DB target, PG16, build artifacts and .env key presence with --check. No error details or credentials are printed.",
    );
    process.exitCode = 1;
  });
}
