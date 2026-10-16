import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commandEnvironment,
  DATABASE_URL,
  ensurePrivateReceiveKey,
  parseArgs,
  runChildren,
  runCommand,
  servicePlan,
  SERVICES,
  SYNC_MODES,
  validateContainer,
} from "./hip4-local-stack.mjs";

test("fixed local target, no resets, overrides, broad dev or product workers", () => {
  assert.equal(parseArgs(["prepare"]), "prepare");
  assert.equal(parseArgs(["--help"]), "help");
  for (const args of [
    [],
    ["start", "--reset"],
    ["sync", "--database-url", "remote"],
    ["stop"],
    ["deploy"],
  ])
    assert.throws(() => parseArgs(args));
  assert.deepEqual(SERVICES, [
    "api",
    "finance-worker",
    "indexer",
    "indexer-polymarket",
    "indexer-limitless",
  ]);
  assert.equal(SYNC_MODES.length, 3);
  for (const mode of [...SERVICES, ...SYNC_MODES]) {
    const plan = servicePlan(mode, true);
    assert.deepEqual(plan.args.slice(-4), [
      "--database-url",
      DATABASE_URL,
      "--expect-database",
      "hip4_local",
    ]);
    assert.ok(plan.args.includes("--check"));
  }
  assert.throws(() => servicePlan("ai-worker"));
  assert.deepEqual(
    commandEnvironment({
      PATH: "installed",
      DATABASE_URL: "prod",
      REDIS_URL: "prod",
      HUNCH_FINANCE_EXECUTE: "true",
      PRIVY_WALLET_AUTHORIZATION_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    { PATH: "installed" },
  );
});

test("container inspection refuses unrelated images, remote exposure or additional ports before mutation", () => {
  const spec = {
    name: "hunch-hip4-local-pg16",
    port: "5432/tcp",
    hostPort: "55436",
    image: "timescale/timescaledb:2.14.2-pg16",
  };
  const container = {
    Name: `/${spec.name}`,
    Config: { Image: spec.image },
    State: { Running: false },
    HostConfig: {
      PortBindings: {
        [spec.port]: [{ HostIp: "127.0.0.1", HostPort: spec.hostPort }],
      },
    },
  };
  assert.deepEqual(validateContainer(container, spec), {
    name: spec.name,
    running: false,
  });
  for (const patch of [
    { Name: "/hunch-postgres" },
    { Config: { Image: "postgres:14" } },
    {
      HostConfig: {
        PortBindings: {
          [spec.port]: [{ HostIp: "0.0.0.0", HostPort: spec.hostPort }],
        },
      },
    },
    {
      HostConfig: {
        PortBindings: {
          [spec.port]: [{ HostIp: "127.0.0.1", HostPort: "5432" }],
        },
      },
    },
  ])
    assert.throws(() => validateContainer({ ...container, ...patch }, spec));
});

test("explicit preparation creates a private local Receive key once and preserves it byte-for-byte", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hip4-prepare-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(ensurePrivateReceiveKey(root), "created");
  const filename = path.join(root, "untracked/hip4-local.env"),
    original = readFileSync(filename);
  assert.match(
    original.toString(),
    /^ADMIN_SERVICE_TOKEN_PEPPER=[a-f0-9]{64}\n$/,
  );
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(ensurePrivateReceiveKey(root), "preserved");
  assert.deepEqual(readFileSync(filename), original);
  writeFileSync(filename, "ADMIN_SERVICE_TOKEN_PEPPER=broken\n");
  assert.throws(() => ensurePrivateReceiveKey(root), /invalid or unsafe/);
  assert.equal(
    readFileSync(filename, "utf8"),
    "ADMIN_SERVICE_TOKEN_PEPPER=broken\n",
  );
});

test("preparation never follows a symlink or replaces an empty existing key", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hip4-prepare-link-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "actual"));
  symlinkSync(path.join(root, "actual"), path.join(root, "untracked"));
  assert.throws(() => ensurePrivateReceiveKey(root), /Unsafe/);
  assert.equal(existsSync(path.join(root, "actual/hip4-local.env")), false);
  const second = mkdtempSync(path.join(tmpdir(), "hip4-prepare-empty-test-"));
  t.after(() => rmSync(second, { recursive: true, force: true }));
  mkdirSync(path.join(second, "untracked"));
  writeFileSync(path.join(second, "untracked/hip4-local.env"), "", {
    mode: 0o600,
  });
  assert.throws(() => ensurePrivateReceiveKey(second), /EEXIST/);
});

function childHarness() {
  const signals = new EventEmitter(),
    children = [],
    killed = [],
    spawned = [];
  return {
    signals,
    children,
    killed,
    spawned,
    spawnChild(binary, args, options) {
      const child = new EventEmitter();
      child.pid = 12340 + children.length;
      child.stdout = new EventEmitter();
      children.push(child);
      spawned.push({ binary, args, options });
      return child;
    },
    kill(child, signal) {
      killed.push([child.pid, signal]);
      if (signal === "SIGKILL")
        queueMicrotask(() => child.emit("close", null, signal));
    },
    graceMs: 5,
    log() {},
  };
}

test("Ctrl-C stops all and only owned children, including indexers that retain timers", async () => {
  const harness = childHarness();
  const running = runChildren(
    SERVICES.map((mode) => servicePlan(mode)),
    harness,
  );
  assert.equal(harness.children.length, 5);
  harness.signals.emit("SIGINT");
  assert.equal(await running, 130);
  assert.equal(harness.killed.length, 10);
  assert.deepEqual(
    new Set(harness.killed.map(([pid]) => pid)),
    new Set(harness.children.map((child) => child.pid)),
  );
  assert.equal(harness.signals.listenerCount("SIGINT"), 0);
  assert.ok(
    harness.spawned.every(
      (plan) => !plan.options.env.DATABASE_URL && plan.options.detached,
    ),
  );
});

test("one server failure stops siblings without hiding the error", async () => {
  const harness = childHarness();
  const running = runChildren(
    SERVICES.map((mode) => servicePlan(mode)),
    harness,
  );
  harness.children[0].emit("close", 2);
  assert.equal(await running, 2);
  assert.equal(harness.killed.length, 8);
  assert.ok(harness.killed.every(([pid]) => pid !== harness.children[0].pid));
});

test("spawn error cleans up other children and all signal handlers", async () => {
  const harness = childHarness();
  const running = runChildren(
    SERVICES.map((mode) => servicePlan(mode)),
    harness,
  );
  harness.children[2].emit("error", new Error("synthetic spawn error"));
  assert.equal(await running, 1);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    assert.equal(harness.signals.listenerCount(signal), 0);
});

test("one-shot success and failed check capture remain inspectable without raw errors", async () => {
  const harness = childHarness();
  const result = runCommand(servicePlan("api", true), {
    ...harness,
    capture: true,
  });
  harness.children[0].stdout.emit("data", '{"ready":false}');
  harness.children[0].emit("close", 1);
  await assert.rejects(
    result,
    (error) =>
      error.capturedOutput === '{"ready":false}' &&
      !error.message.includes("postgresql"),
  );
  const success = runCommand(servicePlan("api", true), harness);
  harness.children[1].emit("close", 0);
  assert.equal(await success, "");
});

test("interrupting a one-shot aborts later work even if its child exits zero", async () => {
  const harness = childHarness();
  const running = runCommand(servicePlan("sync-limitless"), harness);
  harness.signals.emit("SIGINT");
  harness.children[0].emit("close", 0);
  await assert.rejects(running, (error) => error.code === "LOCAL_INTERRUPTED");
  assert.equal(harness.signals.listenerCount("SIGINT"), 0);
});
