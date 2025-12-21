const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

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

const envPath = findUp(".env", process.cwd());
if (envPath) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("dotenv").config({ path: envPath, override: true });
}

const rawArgs = process.argv.slice(2);
// `pnpm <script> -- <args>` passes a literal `--` through to the script.
// Strip it so we can forward flags like `ping`/`--scan` to redis-cli.
if (rawArgs[0] === "--") rawArgs.shift();
const dockerFlag = rawArgs.includes("--docker");
const localFlag = rawArgs.includes("--local");
const args = rawArgs.filter((a) => a !== "--docker" && a !== "--local");

function canUseDocker(containerName) {
  const p = spawnSync(
    "docker",
    ["ps", "-q", "-f", `name=^${containerName}$`],
    { encoding: "utf8" },
  );
  if (p.status !== 0) return false;
  return Boolean((p.stdout || "").trim());
}

function canUseLocalRedisCli() {
  const p = spawnSync("redis-cli", ["--version"], { encoding: "utf8" });
  if (p.error && p.error.code === "ENOENT") return false;
  return p.status === 0;
}

const container = process.env.REDIS_CONTAINER || "hunch-redis";
const localRedisCli = canUseLocalRedisCli();
const dockerAvailable = canUseDocker(container);
const preferDocker =
  dockerFlag || (!localFlag && (dockerAvailable || !localRedisCli));
if (preferDocker) {
  if (!dockerAvailable) {
    console.error(
      `[redis] Docker container \"${container}\" not running. Start it with \`pnpm infra:up\` or pass --local to use redis-cli.`,
    );
    process.exit(1);
  }
  const dockerTty = process.stdin.isTTY ? ["-t"] : [];

  const child = spawn(
    "docker",
    ["exec", "-i", ...dockerTty, container, "redis-cli", ...args],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      console.error("[redis] `docker` not found on PATH.");
      process.exit(127);
    }
    console.error("[redis] Failed to start `docker exec`:", err);
    process.exit(1);
  });
  return;
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error(
    "[redis] Missing REDIS_URL (expected in .env). Example: redis://localhost:6379",
  );
  process.exit(1);
}

const child = spawn("redis-cli", ["-u", redisUrl, ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  if (err && err.code === "ENOENT") {
    console.error(
      "[redis] `redis-cli` not found on PATH. Install Redis CLI (e.g. `brew install redis`).",
    );
    process.exit(127);
  }
  console.error("[redis] Failed to start `redis-cli`:", err);
  process.exit(1);
});
