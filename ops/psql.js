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

// `pnpm <script> -- <args>` passes a literal `--` through to the script.
// Strip any standalone `--` so psql doesn't treat it as a positional arg.
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
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

function parseDbNameFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const pathname = url.pathname || "";
    const db = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    return db || null;
  } catch {
    return null;
  }
}

const container = process.env.PG_CONTAINER || "hunch-postgres";

const preferDocker = dockerFlag || (!localFlag && canUseDocker(container));
if (preferDocker) {
  const dockerTty = process.stdin.isTTY ? ["-t"] : [];
  const dbUser = process.env.PGUSER || "hunch";
  const dbName =
    process.env.PGDATABASE ||
    parseDbNameFromUrl(process.env.DATABASE_URL || "") ||
    "hunch";

  const child = spawn(
    "docker",
    ["exec", "-i", ...dockerTty, container, "psql", "-U", dbUser, "-d", dbName, ...args],
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
      console.error("[psql] `docker` not found on PATH.");
      process.exit(127);
    }
    console.error("[psql] Failed to start `docker exec`:", err);
    process.exit(1);
  });
  return;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "[psql] Missing DATABASE_URL (expected in .env). Example: postgresql://hunch:hunch@localhost:5432/hunch",
  );
  process.exit(1);
}

const child = spawn("psql", [...args, databaseUrl], {
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
      "[psql] `psql` not found on PATH. Install Postgres client tools (e.g. `brew install libpq` and add it to PATH).",
    );
    process.exit(127);
  }
  console.error("[psql] Failed to start `psql`:", err);
  process.exit(1);
});
