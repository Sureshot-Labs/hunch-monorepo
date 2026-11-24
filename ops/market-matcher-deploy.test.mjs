import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
// Execute the real deploy scripts against recording Docker/Compose executables.
// No daemon, network, credentials or production files are used by these tests.
function probe(script, args = [], overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "matcher-deploy-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const executable = require('node:path').basename(process.argv[1]);
const overlay = args.some((arg) => arg.endsWith('/docker-compose.house-trader-image.yml')) ? [process.env.HUNCH_BACKEND_IMAGE] : [];
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([executable, ...args, ...overlay]) + '\\n');
const s = args.join(' ');
if (executable === 'ssh') {
  const r = require('node:child_process').spawnSync('bash', ['-c', args.at(-1)], {input:fs.readFileSync(0), stdio:['pipe', 'inherit', 'inherit']});
  process.exit(r.status ?? 1);
}
if (args[0] === 'compose' && args[1] === 'version' && process.env.COMPOSE_V1 === '1') process.exit(1);
if (s.includes('accessSync') && process.env.LEGACY_IMAGE === '1') process.exit(1);
if (s.includes('migrate.js') && process.env.MIGRATION_FAIL === '1') process.exit(1);
if (args[0] === 'inspect') {
  if (process.env.MISSING === '1' || args.at(-1) === 'hunch-native-onboarding-worker') process.exit(1);
  if (args.includes('--type') && args.at(-1) === 'hunch-api') console.log('sha256:' + 'a'.repeat(64));
  else if (s.includes('com.docker.compose.service')) console.log(process.env.SERVICE || '<no value>');
  else if (s.includes('com.docker.compose.project')) console.log(process.env.PROJECT || '<no value>');
  else if (s.includes('.Config.Image')) console.log(process.env.IMAGE || 'hunch-backend:old');
  else if (s.includes('.Config.Cmd')) console.log(process.env.COMMAND || ' ["node","packages/config/dist/run-with-secrets.js","apps/market-matcher/dist/main.js","run"]'.trim());
  else if (s.includes('.State.Status')) console.log(process.env.STATE || 'running healthy 0');
  else if (s.includes('.State.Running')) console.log('true');
  else if (s.includes('.RestartCount')) console.log('0');
  else if (s.includes('.Image')) console.log(args.at(-1) === 'hunch-api' ? 'sha256:release' : (process.env.MATCHER_IMAGE || 'sha256:release'));
} else if (s.includes('redis-cli --raw ping')) console.log('PONG');
else if (s.includes('redis-cli --raw config set')) console.log('OK');
else if (s.includes('ps -q redis')) console.log('redis-id');
else if (s.includes('ps -q social-media-worker')) console.log('social-id');
else if (args[0] === 'ps' && s.includes('--filter')) console.log('container-id');
`;
  for (const name of ["docker", "docker-compose", "sleep", "ssh", "curl"])
    writeFileSync(join(dir, name), mock, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [join(repo, "ops", script), ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CALL_LOG: log,
        APP_DIR: repo,
        ENV_FILE: "/dev/null",
        DOCKER_PRUNE: "0",
        HUNCH_BACKEND_IMAGE: "hunch-backend:release",
        HUNCH_SOCIAL_MEDIA_WORKER_IMAGE: "hunch-social:release",
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      calls: readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const mutations = (calls) =>
  calls.filter((call) => ["stop", "rm"].includes(call[1]));

test("no-build recovery rejects legacy images before replacing application containers", () => {
  const result = probe("recreate-services-no-build.sh", [], {
    LEGACY_IMAGE: "1",
    SERVICES: "api market-matcher",
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(mutations(result.calls), []);
});
test("no-build recovery refreshes nginx before matcher failure can abort verification", () => {
  const result = probe("recreate-services-no-build.sh", [], {
    STATE: "running unhealthy 0",
    SERVICES: "api market-matcher",
  });
  assert.notEqual(result.status, 0);
  const restart = result.calls.findIndex(
    (call) => call[1] === "restart" && call[2] === "hunch-nginx",
  );
  const health = result.calls.findIndex(
    (call) =>
      call[1] === "inspect" &&
      call.some((arg) => arg.includes(".State.Status")),
  );
  assert.ok(restart >= 0 && health > restart);
});

test("adoption is a no-op for absent or already managed matcher", () => {
  for (const env of [
    { MISSING: "1" },
    { SERVICE: "market-matcher", PROJECT: "hunch-monorepo" },
  ]) {
    const result = probe("market-matcher-deploy.sh", ["adopt"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(mutations(result.calls), []);
  }
});
test("only the known standalone matcher is gracefully adopted", () => {
  const result = probe("market-matcher-deploy.sh", ["adopt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(mutations(result.calls), [
    ["docker", "stop", "--time", "120", "hunch-market-matcher"],
    ["docker", "rm", "hunch-market-matcher"],
  ]);
});
test("unexpected owner, image or command cannot be removed", () => {
  for (const env of [
    { SERVICE: "api" },
    { PROJECT: "other" },
    { IMAGE: "foreign:latest" },
    { COMMAND: '["other"]' },
  ]) {
    const result = probe("market-matcher-deploy.sh", ["adopt"], env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(mutations(result.calls), []);
  }
});
test("readiness requires heartbeat, zero restarts and API image identity", () => {
  assert.equal(probe("market-matcher-deploy.sh", ["verify"]).status, 0);
  for (const env of [
    { MATCHER_IMAGE: "sha256:old" },
    { STATE: "running unhealthy 0" },
    { STATE: "running healthy 1" },
  ])
    assert.notEqual(
      probe("market-matcher-deploy.sh", ["verify"], env).status,
      0,
    );
});
for (const script of ["deploy-ec2.sh", "deploy-ec2-prebuilt.sh"]) {
  test(`${script}: rejected migration preserves live API and standalone matcher`, () => {
    const result = probe(script, [], { MIGRATION_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(
      result.calls.some(
        (call) =>
          call.includes("stop") ||
          call.includes("rm") ||
          call.includes("hunch-market-matcher"),
      ),
      false,
    );
  });
  test(`${script}: success migrates before adoption and deploys matcher with applications`, () => {
    const result = probe(script);
    assert.equal(result.status, 0, result.stderr);
    const migrate = result.calls.findIndex((call) =>
      call.some((arg) => arg.endsWith("migrate.js")),
    );
    const adopt = result.calls.findIndex((call) => call[1] === "stop");
    assert.ok(migrate >= 0 && adopt > migrate);
    const composeStop = result.calls.find(
      (call) => call[0] === "docker-compose" && call.includes("stop"),
    );
    const composeStart = result.calls.find(
      (call) =>
        call[0] === "docker-compose" &&
        call.includes("--no-deps") &&
        call.includes("up"),
    );
    assert.ok(composeStop.includes("market-matcher"));
    assert.ok(composeStop.includes("house-trader-worker"));
    assert.ok(
      composeStart.includes("api") &&
        composeStart.includes("market-matcher") &&
        composeStart.includes("house-trader-worker"),
    );
  });
}

test("House Trader config check pins the healthy API image without starting the service", () => {
  for (const v1 of [false, true]) {
    const result = probe("house-trader-worker.sh", ["check"], {
      COMPOSE_V1: v1 ? "1" : "0",
    });
    assert.equal(result.status, 0, result.stderr);
    const checks = result.calls.filter((call) =>
      call.includes("--check-config"),
    );
    assert.equal(checks.length, 1);
    const [check] = checks;
    assert.equal(check[0], v1 ? "docker-compose" : "docker");
    assert.equal(check.includes("--pull"), !v1);
    assert.ok(check.includes("--no-deps") && check.includes("--rm"));
    assert.ok(check.includes("/app/ops/run-js-runtime.sh"));
    assert.equal(check.includes("--profile"), false);
    assert.ok(
      check.some((arg) =>
        arg.endsWith("/docker-compose.house-trader-image.yml"),
      ),
    );
    assert.equal(check.at(-1), `sha256:${"a".repeat(64)}`);
    assert.ok(!result.calls.some((call) => call.includes("up")));
  }
});

test("House Trader no-build repair only replaces the selected service gracefully", () => {
  const result = probe("recreate-services-no-build.sh", [], {
    SERVICES: "house-trader-worker",
    RESTART_NGINX: "0",
    VERIFY: "0",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(mutations(result.calls), [
    ["docker", "stop", "--time", "120", "container-id"],
    ["docker", "rm", "container-id"],
  ]);
  const started = result.calls.find((call) => call.includes("up"));
  assert.deepEqual(started.slice(started.indexOf("up")), [
    "up",
    "-d",
    "--no-build",
    "--no-deps",
    "house-trader-worker",
  ]);
  assert.ok(
    result.calls.some((call) =>
      call.includes("hunch-monorepo_house-trader-worker:latest"),
    ),
  );
});
