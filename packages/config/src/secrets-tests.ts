import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSecretBundles,
  loadRuntimeSecrets,
  parseSecretBundleRefs,
} from "./secrets.js";

type Test = {
  name: string;
  run: () => Promise<void> | void;
};

const tests: Test[] = [];

function test(name: string, run: Test["run"]): void {
  tests.push({ name, run });
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hunch-secrets-test-"));
}

test("parseSecretBundleRefs accepts aws-sm and bare secret ids", () => {
  assert.deepEqual(parseSecretBundleRefs("aws-sm:/a/b,/c/d"), [
    { provider: "aws-sm", secretId: "/a/b" },
    { provider: "aws-sm", secretId: "/c/d" },
  ]);
});

test("mode off keeps dotenv-only behavior", async () => {
  const envBefore = snapshotEnv();
  try {
    const dir = tempDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      "HUNCH_SECRETS_MODE=off\nHUNCH_SECRET_BUNDLES=aws-sm:/x\nJWT_SECRET=local\n",
    );
    delete process.env.JWT_SECRET;
    const result = await loadRuntimeSecrets({
      envPath,
      logger: silentLogger,
      fetchImpl: failFetch,
    });
    assert.equal(result.mode, "off");
    assert.equal(result.skipped, true);
    assert.equal(process.env.JWT_SECRET, "local");
  } finally {
    restoreEnv(envBefore);
  }
});

test("optional mode falls back to dotenv if fetch fails", async () => {
  const envBefore = snapshotEnv();
  try {
    const dir = tempDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      "HUNCH_SECRETS_MODE=optional\nHUNCH_SECRET_BUNDLES=aws-sm:/x\nAWS_REGION=eu-north-1\nJWT_SECRET=local\n",
    );
    delete process.env.JWT_SECRET;
    const result = await loadRuntimeSecrets({
      envPath,
      logger: silentLogger,
      fetchImpl: failFetch,
    });
    assert.equal(result.mode, "optional");
    assert.equal(result.skipped, true);
    assert.equal(process.env.JWT_SECRET, "local");
  } finally {
    restoreEnv(envBefore);
  }
});

test("optional mode does not keep partial remote values after a later bundle fails", async () => {
  const envBefore = snapshotEnv();
  try {
    const dir = tempDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "HUNCH_SECRETS_MODE=optional",
        "HUNCH_SECRET_BUNDLES=aws-sm:/ok,aws-sm:/fail",
        "AWS_REGION=eu-north-1",
        "AWS_ACCESS_KEY_ID=test",
        "AWS_SECRET_ACCESS_KEY=secret",
        "JWT_SECRET=local",
        "",
      ].join("\n"),
    );
    const result = await loadRuntimeSecrets({
      envPath,
      logger: silentLogger,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          SecretId?: string;
        };
        if (body.SecretId === "/fail") {
          return new Response(JSON.stringify({ message: "boom" }), {
            status: 500,
          });
        }
        return new Response(
          JSON.stringify({
            SecretString: JSON.stringify({ JWT_SECRET: "remote" }),
          }),
          { status: 200 },
        );
      },
      now: new Date("2026-05-24T00:00:00.000Z"),
    });
    assert.equal(result.skipped, true);
    assert.equal(process.env.JWT_SECRET, "local");
  } finally {
    restoreEnv(envBefore);
  }
});

test("runtime secret controls override values from dotenv", async () => {
  const envBefore = snapshotEnv();
  try {
    const dir = tempDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "HUNCH_SECRETS_MODE=off",
        "HUNCH_SECRET_BUNDLES=aws-sm:/from-file",
        "AWS_REGION=us-east-1",
        "JWT_SECRET=local",
        "",
      ].join("\n"),
    );
    process.env.HUNCH_SECRETS_MODE = "strict";
    process.env.HUNCH_SECRET_BUNDLES = "aws-sm:/from-runtime";
    process.env.AWS_REGION = "eu-north-1";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const result = await loadRuntimeSecrets({
      envPath,
      logger: silentLogger,
      fetchImpl: async (input) => {
        assert.equal(
          String(input),
          "https://secretsmanager.eu-north-1.amazonaws.com/",
        );
        return new Response(
          JSON.stringify({
            SecretString: JSON.stringify({ JWT_SECRET: "remote" }),
          }),
          { status: 200 },
        );
      },
      now: new Date("2026-05-24T00:00:00.000Z"),
    });
    assert.equal(result.mode, "strict");
    assert.deepEqual(result.bundles, ["/from-runtime"]);
    assert.equal(process.env.JWT_SECRET, "remote");
  } finally {
    restoreEnv(envBefore);
  }
});

test("strict mode loads bundle values over dotenv", async () => {
  const envBefore = snapshotEnv();
  try {
    const dir = tempDir();
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "HUNCH_SECRETS_MODE=strict",
        "HUNCH_SECRET_BUNDLES=aws-sm:/hunch/prod/shared",
        "AWS_REGION=eu-north-1",
        "AWS_ACCESS_KEY_ID=test",
        "AWS_SECRET_ACCESS_KEY=secret",
        "JWT_SECRET=local",
        "",
      ].join("\n"),
    );
    delete process.env.JWT_SECRET;
    const result = await loadRuntimeSecrets({
      envPath,
      logger: silentLogger,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            SecretString: JSON.stringify({ JWT_SECRET: "remote" }),
          }),
          { status: 200 },
        ),
      now: new Date("2026-05-24T00:00:00.000Z"),
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.keysLoaded, ["JWT_SECRET"]);
    assert.equal(process.env.JWT_SECRET, "remote");
  } finally {
    restoreEnv(envBefore);
  }
});

test("bundle builder writes only allowlisted secret keys", () => {
  const dir = tempDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "DATABASE_URL=postgres://secret",
      "DFLOW_API_KEY=dflow-secret",
      "JWT_SECRET=secret",
      "LIMITLESS_WS_SESSION=limitless-ws-secret",
      "POLYMARKET_BUILDER_CODE=public-code",
      "POLYMARKET_RELAYER_PRIVATE_KEY=0xsecret",
      "NEXT_PUBLIC_POLYMARKET_RELAYER_SIGN_TOKEN=public-token",
      "NEXT_PUBLIC_ALCHEMY_BASE_URL=https://alchemy.example/v2?apiKey=public",
      "FEATURE_FLAG=true",
      "",
    ].join("\n"),
  );
  const outDir = path.join(dir, "out");
  const result = buildSecretBundles({
    envPath,
    outDir,
    profile: "prod",
    logger: silentLogger,
  });
  assert.deepEqual(result.bundles.shared.sort(), [
    "DATABASE_URL",
    "JWT_SECRET",
  ]);
  assert.equal(result.bundles.api.includes("DFLOW_API_KEY"), true);
  assert.equal(result.bundles["indexer-dflow"].includes("DFLOW_API_KEY"), true);
  assert.deepEqual(result.bundles["indexer-limitless"], [
    "LIMITLESS_WS_SESSION",
  ]);
  assert.deepEqual(result.bundles["polymarket-builder"], [
    "POLYMARKET_RELAYER_PRIVATE_KEY",
  ]);
  const sanitized = fs.readFileSync(result.sanitizedEnvPath, "utf8");
  assert.equal(sanitized.includes("JWT_SECRET="), false);
  assert.equal(sanitized.includes("DFLOW_API_KEY="), false);
  assert.equal(sanitized.includes("LIMITLESS_WS_SESSION="), false);
  assert.equal(sanitized.includes("POLYMARKET_RELAYER_PRIVATE_KEY="), false);
  assert.equal(sanitized.includes("POLYMARKET_BUILDER_CODE=public-code"), true);
  assert.equal(
    sanitized.includes(
      "NEXT_PUBLIC_POLYMARKET_RELAYER_SIGN_TOKEN=public-token",
    ),
    true,
  );
  assert.equal(
    sanitized.includes(
      "NEXT_PUBLIC_ALCHEMY_BASE_URL=https://alchemy.example/v2?apiKey=public",
    ),
    true,
  );
});

test("bundle builder sanitized env switches secrets mode to optional", () => {
  const dir = tempDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "HUNCH_SECRETS_MODE=off",
      "DATABASE_URL=postgres://secret",
      "FEATURE_FLAG=true",
      "",
    ].join("\n"),
  );
  const outDir = path.join(dir, "out");
  const result = buildSecretBundles({
    envPath,
    outDir,
    profile: "prod",
    logger: silentLogger,
  });
  const sanitized = fs.readFileSync(result.sanitizedEnvPath, "utf8");
  assert.equal(sanitized.includes("HUNCH_SECRETS_MODE=off"), false);
  assert.equal(sanitized.includes("HUNCH_SECRETS_MODE=optional"), true);
});

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

async function failFetch(): Promise<Response> {
  throw new Error("network disabled");
}

let failed = 0;
for (const entry of tests) {
  try {
    await entry.run();
    console.info(`ok - ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${entry.name}`);
    console.error(error);
  }
}

if (failed > 0) process.exit(1);
