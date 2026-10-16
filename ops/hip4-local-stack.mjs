import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  inspectDatabase,
  migrationManifest,
  readLocalReceiveOptionKey,
  validateDatabaseTarget,
  LOCAL_DATABASE,
  LOCAL_RECEIVE_ENV,
} from "./hip4-local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Public disposable credentials for this existing, loopback-only local stand.
// Neither the root .env nor inherited DATABASE_URL can select the target.
export const DATABASE_URL =
  "postgresql://postgres:hip4-local-test@127.0.0.1:55436/hip4_local";
export const SERVICES = [
  "api",
  "finance-worker",
  "indexer",
  "indexer-polymarket",
  "indexer-limitless",
];
export const SYNC_MODES = [
  "sync-hyperliquid",
  "sync-polymarket",
  "sync-limitless",
];
const INFRA = [
  {
    name: "hunch-hip4-local-pg16",
    port: "5432/tcp",
    hostPort: "55436",
    image: "timescale/timescaledb:2.14.2-pg16",
  },
  {
    name: "hunch-hip4-local-redis",
    port: "6379/tcp",
    hostPort: "55437",
    image: "redis:7-alpine",
  },
];

export function parseArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return "help";
  if (
    args.length !== 1 ||
    !["start", "prepare", "sync", "status"].includes(args[0])
  )
    throw new Error(
      "Use pnpm dev:hip, hip:prepare, hip:sync or hip:status. No target overrides are accepted.",
    );
  return args[0];
}

export function servicePlan(mode, check = false, root = ROOT) {
  if (![...SERVICES, ...SYNC_MODES].includes(mode))
    throw new Error("Unknown local service");
  return {
    name: mode,
    binary: process.execPath,
    args: [
      path.join(root, "ops/hip4-local.mjs"),
      mode,
      ...(check ? ["--check"] : []),
      "--database-url",
      validateDatabaseTarget(DATABASE_URL, LOCAL_DATABASE),
      "--expect-database",
      LOCAL_DATABASE,
    ],
    cwd: root,
  };
}

// A child never inherits the ambient API/database/automation configuration.
// hip4-local.mjs subsequently selects allowed provider keys from the repository .env.
export function commandEnvironment(env = process.env) {
  const clean = {};
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
    if (env[key] !== undefined) clean[key] = env[key];
  return clean;
}

export function validateContainer(container, spec) {
  const bindings = container?.HostConfig?.PortBindings;
  const expected = bindings?.[spec.port];
  if (
    container?.Name !== `/${spec.name}` ||
    container?.Config?.Image !== spec.image ||
    Object.keys(bindings ?? {}).length !== 1 ||
    expected?.length !== 1 ||
    expected[0].HostIp !== "127.0.0.1" ||
    expected[0].HostPort !== spec.hostPort
  )
    throw new Error(
      `Unexpected local container configuration: ${spec.name}. No container was changed.`,
    );
  return { name: spec.name, running: container.State?.Running === true };
}

function dockerInspect(spec) {
  const result = spawnSync("docker", ["inspect", spec.name], {
    encoding: "utf8",
    timeout: 10_000,
    env: commandEnvironment(),
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `Cannot inspect ${spec.name}. Start Docker and restore the existing HIP local containers; no replacement or reset is attempted.`,
    );
  try {
    return validateContainer(JSON.parse(result.stdout)[0], spec);
  } catch (error) {
    if (error.message.startsWith("Unexpected local")) throw error;
    throw new Error(`Invalid Docker inspection for ${spec.name}`);
  }
}

export function ensurePrivateReceiveKey(root = ROOT) {
  const status = readLocalReceiveOptionKey(root);
  if (status.status === "valid") return "preserved";
  if (status.status !== "missing")
    throw new Error(
      "Local Receive key is invalid or unsafe. Restore the original private untracked/hip4-local.env; it will not be replaced.",
    );
  const filename = path.join(root, LOCAL_RECEIVE_ENV),
    directory = path.dirname(filename);
  if (
    existsSync(directory) &&
    (!lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink())
  )
    throw new Error("Unsafe local configuration directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // O_EXCL is intentional: even a malformed/empty existing file must be restored,
  // never silently rotate the authority of already-issued Receive options.
  writeFileSync(
    filename,
    `ADMIN_SERVICE_TOKEN_PEPPER=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return "created";
}

function killOwned(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** Foreground ownership: never look up or kill unrelated processes by name/port.
 * Production indexers retain timers on SIGTERM, so their own process groups have
 * a bounded grace period before SIGKILL. The DB/Redis containers are not children. */
export async function runChildren(
  plans,
  {
    spawnChild = spawn,
    signals = process,
    kill = killOwned,
    graceMs = 4_000,
    log = console.log,
  } = {},
) {
  const children = [],
    handlers = new Map();
  let stopRequested = false,
    exitCode = 0;
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const stop = (code) => {
    if (stopRequested) return;
    stopRequested = true;
    exitCode = code;
    resolveStop();
  };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => stop(name === "SIGINT" ? 130 : 143);
    handlers.set(name, handler);
    signals.on(name, handler);
  }
  try {
    for (const plan of plans) {
      if (stopRequested) break;
      const child = spawnChild(plan.binary, plan.args, {
        cwd: plan.cwd,
        env: commandEnvironment(),
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      const record = { child, closed: false, done: null };
      record.done = new Promise((resolve) => {
        const finish = (code) => {
          if (record.closed) return;
          record.closed = true;
          resolve();
          if (!stopRequested) {
            log(
              `${plan.name} exited; stopping this local command's remaining processes.`,
            );
            stop(code || 1);
          }
        };
        child.once("error", () => finish(1));
        child.once("close", (code) => finish(code));
      });
      children.push(record);
    }
    if (!children.length) stop(1);
    await stopped;
  } finally {
    for (const record of children)
      if (!record.closed) kill(record.child, "SIGTERM");
    let timer;
    await Promise.race([
      Promise.all(children.map((record) => record.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
    for (const record of children)
      if (!record.closed) kill(record.child, "SIGKILL");
    await Promise.all(children.map((record) => record.done));
    for (const [name, handler] of handlers)
      signals.removeListener(name, handler);
  }
  return exitCode;
}

export async function runCommand(
  plan,
  {
    capture = false,
    outputFd,
    spawnChild = spawn,
    signals = process,
    kill = killOwned,
    graceMs = 4_000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(plan.binary, plan.args, {
      cwd: plan.cwd ?? ROOT,
      env: commandEnvironment(),
      stdio:
        outputFd !== undefined
          ? ["ignore", outputFd, "ignore"]
          : capture
            ? ["ignore", "pipe", "ignore"]
            : "inherit",
      detached: process.platform !== "win32",
    });
    let output = "",
      failed = false,
      interrupted = false,
      timer;
    const stop = () => {
      kill(child, "SIGTERM");
      timer ??= setTimeout(() => kill(child, "SIGKILL"), graceMs);
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) {
        failed = true;
        stop();
      }
    });
    const handlers = new Map(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
        signal,
        () => {
          interrupted = true;
          stop();
        },
      ]),
    );
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    const clean = () => {
      clearTimeout(timer);
      for (const [signal, handler] of handlers)
        signals.removeListener(signal, handler);
    };
    child.once("error", () => {
      clean();
      reject(new Error(`${plan.name} could not start`));
    });
    child.once("close", (code) => {
      clean();
      if (interrupted) {
        const error = new Error(
          "Local command interrupted; no subsequent step was run.",
        );
        error.code = "LOCAL_INTERRUPTED";
        reject(error);
      } else if (code === 0 && !failed) resolve(output);
      else {
        const error = new Error(
          `${plan.name} failed; no later preparation step was run.`,
        );
        if (capture && !failed) error.capturedOutput = output;
        reject(error);
      }
    });
  });
}

async function inspectLocalDatabase() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
  });
  try {
    return await inspectDatabase(pool, migrationManifest());
  } catch {
    throw new Error(
      "Cannot inspect local PG16 hip4_local on 55436. No schema or policy was changed.",
    );
  } finally {
    await pool.end();
  }
}

export async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function checkModes(modes) {
  let ready = true;
  for (const mode of modes) {
    const result = await runCommand(servicePlan(mode, true), { capture: true })
      .catch((error) => {
        if (error.code === "LOCAL_INTERRUPTED") throw error;
        return error.capturedOutput ?? "null";
      })
      .then((output) => {
        try {
          return JSON.parse(output);
        } catch {
          return null;
        }
      });
    if (!result?.ready) {
      ready = false;
      console.log(
        JSON.stringify(
          result ?? {
            mode,
            ready: false,
            advice:
              "Run the low-level launcher with --check; see docs/hip4-local-testing.md.",
          },
          null,
          2,
        ),
      );
    } else console.log(`${mode}: configuration and schema ready`);
  }
  if (!ready)
    throw new Error(
      "Local prerequisites missing. Run pnpm hip:prepare, then hip:status; restore missing local/provider configuration as reported.",
    );
}

async function prepare() {
  if (await portIsOpen(4014))
    throw new Error(
      "Stop the API with Ctrl+C before schema preparation. No process was killed.",
    );
  // Inspect the entire exact scope before starting either container.
  const containers = INFRA.map(dockerInspect);
  for (const container of containers)
    if (!container.running)
      await runCommand({
        name: `start ${container.name}`,
        binary: "docker",
        args: ["start", container.name],
      });
  await runCommand({
    name: "full backend build",
    binary: process.execPath,
    args: ["ops/hip4-local-build.mjs"],
  });
  const database = await inspectLocalDatabase();
  if (database.schema.changed.length || database.schema.unknown.length)
    throw new Error(
      "Existing migration history differs from this checkout. Restore the matching branch/history; no migration was attempted.",
    );
  if (database.schema.missing.length) {
    const directory = path.join(ROOT, "untracked");
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error("Unsafe backup directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(
      directory,
      `hip4-local-before-migrate-${Date.now()}.dump`,
    );
    const fd = openSync(filename, "wx", 0o600);
    try {
      await runCommand(
        {
          name: "local PG16 backup",
          binary: "docker",
          args: [
            "exec",
            "hunch-hip4-local-pg16",
            "pg_dump",
            "-U",
            "postgres",
            "-d",
            LOCAL_DATABASE,
            "-Fc",
          ],
        },
        { outputFd: fd },
      );
    } finally {
      closeSync(fd);
    }
    console.log(`Local backup saved: ${filename}`);
    await runCommand({
      name: "guarded local migrations",
      binary: process.execPath,
      args: [
        "packages/db/dist/migrate.js",
        "--database-url",
        DATABASE_URL,
        "--expect-database",
        LOCAL_DATABASE,
      ],
    });
  } else
    console.log("Local schema already current; no migration or backup needed.");
  console.log(`Local Receive key: ${ensurePrivateReceiveKey()}.`);
  await checkModes(SERVICES);
  console.log(
    "Prepared. Run pnpm hip:sync for a catalog refresh, then pnpm dev:hip. Users, admin, policies, trades and Redis cursors were not reset.",
  );
}

export async function main(args = process.argv.slice(2)) {
  const action = parseArgs(args);
  if (action === "help") {
    console.log(
      "HIP local stand (no production):\n  pnpm hip:prepare  build + start existing local Docker infra + guarded schema update\n  pnpm hip:sync     bounded/resumable catalog refresh for all three venues\n  pnpm dev:hip      API + finance-worker + HIP/Polymarket/Limitless indexers, foreground\n  pnpm hip:status   read-only configuration/schema checks\nFrontend: cd ../Hunch_App && bun run dev:hip. Ctrl+C in each terminal stops its own apps; DB/Redis and saved data remain. No database reset, policy rewrite, Telegram or AI workers. Finance-worker may reconcile already user-authorized funding; signing/submission remains user-interactive. See docs/hip4-local-testing.md.",
    );
    return 0;
  }
  if (action === "prepare") {
    await prepare();
    return 0;
  }
  if (action === "status") {
    console.log(
      JSON.stringify(
        {
          apiPort4014: await portIsOpen(4014),
          frontendPort3000: await portIsOpen(3000),
          database: await inspectLocalDatabase(),
        },
        null,
        2,
      ),
    );
    await checkModes(SERVICES);
    return 0;
  }
  await checkModes(action === "sync" ? SYNC_MODES : SERVICES);
  if (action === "sync") {
    // Run every venue even if one provider fails; never claim complete coverage
    // from the presence of old rows. Per-venue drivers print their own coverage.
    let failed = false;
    for (const mode of SYNC_MODES) {
      try {
        await runCommand(servicePlan(mode));
      } catch (error) {
        if (error.code === "LOCAL_INTERRUPTED") throw error;
        failed = true;
        console.error(
          `${mode}: incomplete/failed; other venues are still checked. Re-run hip:sync to resume.`,
        );
      }
    }
    return failed ? 1 : 0;
  }
  if (await portIsOpen(4014))
    throw new Error(
      "Port 4014 is already occupied. Stop the existing API yourself; no unrelated process will be killed.",
    );
  console.log(
    "Starting API :4014, finance-worker and three ordinary venue indexers. Ctrl+C stops only these processes; Docker data stays. Frontend starts separately with bun run dev:hip.",
  );
  return runChildren(SERVICES.map((mode) => servicePlan(mode)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`HIP local: ${error.message}`);
      process.exitCode = 1;
    });
