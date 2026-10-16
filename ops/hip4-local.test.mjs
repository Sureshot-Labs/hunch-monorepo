import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapLocalEnvironment,
  buildLocalEnvironment,
  configurationStatus,
  inspectDatabase,
  isReadOnlyMode,
  launchArguments,
  parseArgs,
  policyStatus,
  readLocalReceiveOptionKey,
  schemaStatus,
  serviceArtifacts,
  validateCatalogPageBudget,
  validateDatabaseTarget,
  LOCAL_REDIS,
  LOCAL_RECEIVE_ENV,
} from "./hip4-local.mjs";

const target = "postgresql://local:example@127.0.0.1:55436/hip4_local";
const options = {
  mode: "api",
  databaseUrl: target,
  expectedDatabase: "hip4_local",
};
const testReceiveKey = "ab".repeat(32); // Synthetic fixture only, never runtime.

test("defaults to only API and requires an exact explicit loopback database", () => {
  assert.equal(
    parseArgs(["--database-url", target, "--expect-database", "hip4_local"])
      .mode,
    "api",
  );
  assert.throws(() => parseArgs([]), /expect-database/);
  for (const url of [
    target.replace("127.0.0.1", "prod.example"),
    target.replace("55436", "5432"),
    target.replace("hip4_local", "hunch"),
    `${target}?host=prod.example`,
    `${target}#other`,
  ])
    assert.throws(
      () => validateDatabaseTarget(url, "hip4_local"),
      /Database must/,
    );
  assert.throws(
    () => validateDatabaseTarget(target, "hunch"),
    /expect-database/,
  );
  assert.match(
    validateDatabaseTarget(
      target.replace("127.0.0.1", "localhost"),
      "hip4_local",
    ),
    /127\.0\.0\.1/,
  );
  assert.throws(() => parseArgs(["api", "finance-worker"]), /duplicate mode/);
  assert.throws(() => parseArgs(["--execute"]), /Unknown option/);
});

test("dotenv and inherited state cannot retarget local storage or enable financial lanes", () => {
  const values = {
    DATABASE_URL: "remote",
    REDIS_URL: "remote",
    JWT_SECRET: "remote",
    PRIVY_APP_ID: "login",
    PRIVY_WALLET_AUTHORIZATION_KEY: "forbidden",
    HUNCH_SIGNAL_BOT_TOKEN: "forbidden",
    HUNCH_FINANCE_EXECUTE: "true",
    CONTENT_ENABLED: "true",
    RELAY_API_KEY: "provider",
    ADMIN_SERVICE_TOKEN_PEPPER: "production-pepper-must-not-be-reused",
  };
  const local = buildLocalEnvironment(values, options, values);
  assert.equal(local.DATABASE_URL, target);
  assert.equal(local.REDIS_URL, LOCAL_REDIS);
  assert.notEqual(local.JWT_SECRET, "remote");
  assert.equal(local.ADMIN_AUTH_LEGACY_FALLBACK, "true");
  assert.throws(
    () =>
      buildLocalEnvironment(
        values,
        {
          ...options,
          databaseUrl: target.replace("127.0.0.1", "remote.example"),
        },
        {},
      ),
    /Database must/,
  );
  assert.equal(local.PRIVY_APP_ID, "login");
  assert.equal(local.RELAY_API_KEY, "provider");
  assert.equal(local.ADMIN_SERVICE_TOKEN_PEPPER, "");
  for (const key of [
    "PRIVY_WALLET_AUTHORIZATION_KEY",
    "HUNCH_SIGNAL_BOT_TOKEN",
  ])
    assert.equal(local[key], undefined);
  for (const key of [
    "HUNCH_FINANCE_EXECUTE",
    "HUNCH_FINANCE_WORKER_ENABLED",
    "HUNCH_FINANCE_TELEGRAM_TRADE_INTENTS_ENABLED",
    "HUNCH_FUNDING_PM_WRAP_EXECUTE",
    "CONTENT_ENABLED",
    "HUNCH_FINANCE_PRIVY_DELETION_RECONCILIATION_ENABLED",
  ])
    assert.equal(local[key], "false");
  const worker = buildLocalEnvironment(
    values,
    { ...options, mode: "finance-worker" },
    {},
  );
  assert.equal(worker.HUNCH_FINANCE_WORKER_ENABLED, "true");
  assert.equal(worker.HUNCH_FINANCE_EXECUTE, "false");
  assert.equal(worker.HUNCH_FINANCE_FUNDING_RECONCILIATION_ENABLED, "true");
  for (const mode of ["indexer", "finance-worker"])
    assert.equal(
      buildLocalEnvironment(values, { ...options, mode }, {}, testReceiveKey)
        .ADMIN_SERVICE_TOKEN_PEPPER,
      "",
    );
});

test("dedicated local Receive key is read-only, private and stable, without dotenv privilege inheritance", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hip4-local-key-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, LOCAL_RECEIVE_ENV);
  assert.deepEqual(readLocalReceiveOptionKey(root), {
    status: "missing",
    key: null,
  });
  assert.deepEqual(
    readdirSync(root),
    [],
    "check must not create the config directory or key",
  );
  mkdirSync(path.dirname(filename));
  writeFileSync(
    filename,
    `ADMIN_SERVICE_TOKEN_PEPPER=${testReceiveKey}\nDATABASE_URL=remote\nPRIVY_WALLET_AUTHORIZATION_KEY=forbidden\n`,
    { mode: 0o600 },
  );
  const before = {
    contents: readFileSync(filename, "utf8"),
    mtime: statSync(filename).mtimeMs,
  };
  const first = readLocalReceiveOptionKey(root),
    restarted = readLocalReceiveOptionKey(root);
  assert.deepEqual(first, { status: "valid", key: testReceiveKey });
  assert.equal(
    restarted.key,
    first.key,
    "restart must reuse the same option-token authority",
  );
  assert.deepEqual(
    {
      contents: readFileSync(filename, "utf8"),
      mtime: statSync(filename).mtimeMs,
    },
    before,
    "neither check nor startup reads may alter key contents or metadata",
  );
  const local = buildLocalEnvironment(
    {
      ADMIN_SERVICE_TOKEN_PEPPER: "production",
      PRIVY_APP_ID: "local-login",
      PRIVY_APP_SECRET: "local-login-secret",
    },
    options,
    {},
    first.key,
  );
  assert.equal(local.ADMIN_SERVICE_TOKEN_PEPPER, testReceiveKey);
  assert.equal(local.DATABASE_URL, target);
  assert.equal(local.PRIVY_WALLET_AUTHORIZATION_KEY, undefined);
  const status = configurationStatus(local, "api", false, [], [], first.status);
  assert.equal(status.receiveOptionTokenKey.ready, true);
  assert.deepEqual(status.missingRequired, []);
  assert.equal(JSON.stringify(status).includes(testReceiveKey), false);
  assert.equal(status.receiveOptionTokenKey.source, LOCAL_RECEIVE_ENV);
});

test("missing, malformed, publicly readable and symlinked Receive config fail with safe repair diagnostics", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hip4-local-key-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, LOCAL_RECEIVE_ENV);
  mkdirSync(path.dirname(filename));
  for (const value of ["", "short", "x".repeat(64)]) {
    writeFileSync(filename, `ADMIN_SERVICE_TOKEN_PEPPER=${value}\n`, {
      mode: 0o600,
    });
    const key = readLocalReceiveOptionKey(root);
    assert.equal(key.status, value ? "invalid" : "missing");
    assert.equal(key.key, null);
    const local = buildLocalEnvironment(
      { PRIVY_APP_ID: "id", PRIVY_APP_SECRET: "secret" },
      { ...options, check: true },
      {},
      key.key,
    );
    const diagnostic = configurationStatus(
      local,
      "api",
      false,
      [],
      [],
      key.status,
    );
    assert.equal(diagnostic.receiveOptionTokenKey.ready, false);
    assert.ok(
      diagnostic.missingRequired.includes("ADMIN_SERVICE_TOKEN_PEPPER"),
    );
    assert.equal(diagnostic.receiveOptionTokenKey.status, key.status);
    assert.match(
      diagnostic.receiveOptionTokenKey.advice,
      /untracked\/hip4-local\.env.*0600/u,
    );
    assert.match(
      diagnostic.receiveOptionTokenKey.advice,
      /Restore the original/u,
    );
  }
  writeFileSync(filename, `ADMIN_SERVICE_TOKEN_PEPPER=${testReceiveKey}\n`, {
    mode: 0o600,
  });
  chmodSync(filename, 0o644);
  assert.deepEqual(readLocalReceiveOptionKey(root), {
    status: "unsafe_file",
    key: null,
  });
  chmodSync(filename, 0o600);
  assert.equal(
    readLocalReceiveOptionKey(root).status,
    "valid",
    "explicit permission repair works immediately without cooldown",
  );
  const alternate = path.join(root, "other.env");
  writeFileSync(alternate, `ADMIN_SERVICE_TOKEN_PEPPER=${testReceiveKey}\n`, {
    mode: 0o600,
  });
  unlinkSync(filename);
  symlinkSync(alternate, filename);
  assert.deepEqual(readLocalReceiveOptionKey(root), {
    status: "unsafe_file",
    key: null,
  });
});

test("required key output contains presence only, varying with mode and funding policy", () => {
  const local = buildLocalEnvironment(
    { PRIVY_APP_ID: "never-print-this" },
    options,
    {},
  );
  assert.deepEqual(
    configurationStatus(local, "indexer", true).missingRequired,
    [],
  );
  assert.deepEqual(configurationStatus(local, "api").missingRequired, [
    "PRIVY_APP_SECRET",
    "ADMIN_SERVICE_TOKEN_PEPPER",
  ]);
  assert.equal(
    configurationStatus(local, "finance-worker", true).missingRequired.includes(
      "RELAY_API_KEY",
    ),
    true,
  );
  assert.equal(
    JSON.stringify(configurationStatus(local, "api")).includes(
      "never-print-this",
    ),
    false,
  );
  const funded = configurationStatus(
    local,
    "api",
    true,
    ["solana:usdc"],
    ["limitless"],
  );
  assert.equal(funded.missingRequired.includes("SOLANA_RPC_URL"), true);
  assert.equal(funded.missingRequired.includes("BASE_RPC_URL"), true);
  assert.equal(funded.missingRequired.includes("POLYGON_RPC_URL"), false);
});

test("uses the official bootstrap then reapplies local targets and discards unrelated dotenv keys", async () => {
  const local = buildLocalEnvironment(
    { PRIVY_APP_ID: "login" },
    options,
    {},
    testReceiveKey,
  );
  const environment = {
    HUNCH_FINANCE_EXECUTE: "true",
    AWS_SECRET_ACCESS_KEY: "unrelated",
  };
  await bootstrapLocalEnvironment(
    local,
    async ({ envPath }) => {
      assert.equal(envPath, "/repo/.env");
      assert.equal(environment.HUNCH_SECRETS_MODE, "off");
      assert.equal(environment.HUNCH_SECRET_BUNDLES, "");
      Object.assign(environment, {
        DATABASE_URL: "remote",
        REDIS_URL: "remote",
        HUNCH_FINANCE_EXECUTE: "true",
        HUNCH_SIGNAL_BOT_TOKEN: "unrelated",
        HUNCH_RUNTIME_SECRETS_LOADED: "1",
        ADMIN_SERVICE_TOKEN_PEPPER: "unrelated-production-pepper",
      });
    },
    "/repo/.env",
    environment,
  );
  assert.equal(environment.DATABASE_URL, target);
  assert.equal(environment.REDIS_URL, LOCAL_REDIS);
  assert.equal(environment.HUNCH_FINANCE_EXECUTE, "false");
  assert.equal(environment.HUNCH_SIGNAL_BOT_TOKEN, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.HUNCH_RUNTIME_SECRETS_LOADED, "1");
  assert.equal(environment.ADMIN_SERVICE_TOKEN_PEPPER, testReceiveKey);
  await assert.rejects(
    bootstrapLocalEnvironment(local, async () => {}, "/repo/.env", {}),
    /bootstrap failed/,
  );
});

test("schema diagnostics distinguish missing, changed and unknown migrations", () => {
  assert.deepEqual(
    schemaStatus(
      [
        { filename: "0001.sql", checksum: "one" },
        { filename: "0002.sql", checksum: "two" },
      ],
      [
        { filename: "0001.sql", checksum: "changed" },
        { filename: "extra.sql", checksum: "extra" },
      ],
    ),
    {
      expectedCount: 2,
      appliedCount: 2,
      missing: ["0002.sql"],
      changed: ["0001.sql"],
      unknown: ["extra.sql"],
    },
  );
});

test("policy diagnostics label raw overrides without inventing effective defaults or capabilities", () => {
  assert.deepEqual(policyStatus([]), {
    interpretation:
      "Unvalidated stored override hints only; omitted fields are null. Service policy resolvers own defaults, validation and effective capabilities. These hints are not activation evidence.",
    hipLifecycleOverride: null,
    hipIndexerModeOverride: null,
    fundingVersionOverride: null,
    fundingPausedOverride: null,
    fundingVenues: [],
    fundingAssets: [],
    socialEnabledOverride: null,
    publicationsEnabledOverride: null,
    copyEnabledOverride: null,
    hipPublicationVenueSelected: null,
    hipCopyVenueSelected: null,
    hipMatchingVenueSelected: null,
    matchingWorkerOverride: null,
  });
  const status = policyStatus([
    {
      policy_key: "funding_control_plane",
      payload: {
        version: 2,
        paused: false,
        venues: ["hyperliquid"],
        receive: { assets: ["base:usdc"] },
      },
    },
    {
      policy_key: "social",
      payload: { copyVenues: ["hyperliquid"], publicationVenues: [] },
    },
  ]);
  assert.equal(status.fundingVersionOverride, 2);
  assert.equal(status.hipCopyVenueSelected, true);
  assert.equal(status.hipPublicationVenueSelected, false);
  assert.equal(status.copyEnabledOverride, null);
  assert.equal(Object.hasOwn(status, "hipCopy"), false);
  assert.match(status.interpretation, /not activation evidence/);
});

test("database inspection is read-only, target checked before schema reads, and always releases", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("current_database()"))
        return {
          rows: [{ database_name: "hip4_local", version_number: 160002 }],
        };
      if (sql.includes("to_regclass"))
        return { rows: [{ migrations: true, policies: true }] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const result = await inspectDatabase({ connect: async () => client }, []);
  assert.equal(result.postgresMajor, 16);
  assert.equal(calls[0], "BEGIN READ ONLY");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(
    calls.every((sql) => /^(BEGIN READ ONLY|select |ROLLBACK)/.test(sql)),
    true,
  );
  assert.equal(released, true);
  calls.length = 0;
  client.query = async (sql) => {
    calls.push(sql);
    return { rows: [{ database_name: "hunch", version_number: 160002 }] };
  };
  await assert.rejects(
    inspectDatabase({ connect: async () => client }, []),
    /not hip4_local/,
  );
  assert.equal(
    calls.some((sql) => sql.includes("schema_migrations")),
    false,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("indexer retains its own explicit database guard and fixed Redis target", () => {
  assert.deepEqual(launchArguments({ ...options, mode: "indexer" }), [
    "--database-url",
    target,
    "--expect-database",
    "hip4_local",
    "--redis-url",
    LOCAL_REDIS,
  ]);
  assert.deepEqual(launchArguments(options), []);
});

test("all production indexer and one-shot modes retain local storage and need no login/funding credentials", () => {
  for (const mode of [
    "indexer",
    "indexer-polymarket",
    "indexer-limitless",
    "sync-polymarket",
    "sync-limitless",
    "sync-hyperliquid",
  ]) {
    const parsed = parseArgs([
      mode,
      "--database-url",
      target,
      "--expect-database",
      "hip4_local",
    ]);
    assert.equal(parsed.mode, mode);
    assert.equal(isReadOnlyMode(mode), true);
    const environment = buildLocalEnvironment(
      {
        LIMITLESS_WS_SESSION: "private-session",
        DATABASE_URL: "remote",
        REDIS_URL: "remote",
      },
      parsed,
      {
        HUNCH_RUNTIME_SECRETS_LOADED: "1",
        PRIVY_WALLET_AUTHORIZATION_KEY: "forbidden",
      },
      testReceiveKey,
    );
    assert.equal(environment.DATABASE_URL, target);
    assert.equal(environment.REDIS_URL, LOCAL_REDIS);
    assert.equal(environment.LIMITLESS_WS_SESSION, "private-session");
    assert.equal(environment.PRIVY_WALLET_AUTHORIZATION_KEY, undefined);
    assert.equal(environment.HUNCH_RUNTIME_SECRETS_LOADED, undefined);
    assert.equal(environment.ADMIN_SERVICE_TOKEN_PEPPER, "");
    assert.equal(environment.HUNCH_FINANCE_WORKER_ENABLED, "false");
    const status = configurationStatus(
      environment,
      mode,
      true,
      ["solana:usdc", "base:usdc"],
      ["polymarket", "limitless"],
    );
    assert.deepEqual(status.missingRequired, []);
    assert.equal(status.receiveOptionTokenKey.ready, true);
    assert.equal(JSON.stringify(status).includes("private-session"), false);
  }
  assert.equal(isReadOnlyMode("finance-worker"), false);
  assert.equal(isReadOnlyMode("api"), false);
  assert.equal(isReadOnlyMode("unknown"), false);
});

test("sync modes propagate explicit budgets and targets without changing normal indexer configuration", () => {
  for (const [venue, budgetKey, defaultBudget] of [
    ["polymarket", "POLYMARKET_HOT_MAX_PAGES", 10],
    ["limitless", "LIMITLESS_MAX_PAGES", 40],
  ]) {
    const parsed = parseArgs([
      `sync-${venue}`,
      "--max-pages",
      "3",
      "--database-url",
      target,
      "--expect-database",
      "hip4_local",
    ]);
    assert.equal(parsed.maxPages, 3);
    assert.equal(
      buildLocalEnvironment({ [budgetKey]: "99999" }, parsed, {})[budgetKey],
      "3",
    );
    assert.deepEqual(launchArguments(parsed), [
      "--venue",
      venue,
      "--database-url",
      target,
      "--expect-database",
      "hip4_local",
      "--redis-url",
      LOCAL_REDIS,
      "--max-pages",
      "3",
    ]);
    assert.equal(
      buildLocalEnvironment({}, { ...options, mode: `sync-${venue}` }, {})[
        budgetKey
      ],
      String(defaultBudget),
    );
    assert.equal(
      buildLocalEnvironment(
        { [budgetKey]: "99999" },
        { ...options, mode: `indexer-${venue}` },
        {},
      )[budgetKey],
      undefined,
    );
    assert.ok(
      serviceArtifacts(`sync-${venue}`).includes(
        `apps/indexer-${venue}/dist/bootstrap.js`,
      ),
    );
  }
  assert.deepEqual(launchArguments({ ...options, mode: "sync-hyperliquid" }), [
    ...launchArguments({ ...options, mode: "indexer" }),
    "--once",
  ]);
  assert.throws(() => serviceArtifacts("unknown"), /Unknown local mode/);
  for (const value of ["0", "-1", "1.5", "Infinity", "1e2", "10001", "", " 2"])
    assert.throws(() => validateCatalogPageBudget(value), /--max-pages/);
  assert.equal(validateCatalogPageBudget("10000"), 10000);
  assert.throws(() => parseArgs(["api", "--max-pages", "3"]), /only supported/);
  assert.throws(
    () => parseArgs(["sync-polymarket", "--max-pages"]),
    /Missing value/,
  );
  assert.throws(
    () =>
      parseArgs(["sync-polymarket", "--max-pages", "2", "--max-pages", "3"]),
    /Duplicate option/,
  );
});
