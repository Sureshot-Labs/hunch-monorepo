#!/usr/bin/env tsx

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";

import {
  requireIntegrationDatabaseTarget,
  verifyIntegrationDatabaseTarget,
  type IntegrationDatabaseTarget,
} from "./test-database-target.js";
import { closeAcquiredRuntimeResources } from "./runtime-resource-cleanup.js";

type TestMode = "all" | "integration" | "unit";

type TestFile = {
  absolute: string;
  databaseGuarded: boolean;
  integration: boolean;
  relative: string;
  requiresDatabase: boolean;
};

async function collectTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith("-tests.ts")) continue;
    files.push(fullPath);
  }
  return files;
}

function parseFilters(argv: string[]): string[] {
  return argv.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function parseArgs(argv: string[]): {
  databaseTarget: IntegrationDatabaseTarget | null;
  filters: string[];
  mode: TestMode;
} {
  let mode: TestMode = "all";
  const filters: string[] = [];
  let databaseUrl: string | null = null;
  let expectedDatabase: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      mode = "all";
      continue;
    }
    if (arg === "--integration") {
      mode = "integration";
      continue;
    }
    if (arg === "--static" || arg === "--unit") {
      mode = "unit";
      continue;
    }
    if (arg === "--") continue;
    if (arg === "--database-url" || arg === "--expect-database") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--database-url") databaseUrl = value;
      else expectedDatabase = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--database-url=")) {
      databaseUrl = arg.slice("--database-url=".length).trim();
      continue;
    }
    if (arg?.startsWith("--expect-database=")) {
      expectedDatabase = arg.slice("--expect-database=".length).trim();
      continue;
    }
    if (!arg) continue;
    filters.push(arg);
  }
  if ((databaseUrl === null) !== (expectedDatabase === null)) {
    throw new Error(
      "--database-url and --expect-database must be provided together",
    );
  }
  if (!databaseUrl || !expectedDatabase) {
    return { databaseTarget: null, filters: parseFilters(filters), mode };
  }
  return {
    databaseTarget: requireIntegrationDatabaseTarget({
      databaseUrl,
      expectedDatabase,
    }),
    filters: parseFilters(filters),
    mode,
  };
}

async function inspectTestFile(
  srcDir: string,
  absolute: string,
): Promise<TestFile> {
  const relative = path.relative(srcDir, absolute);
  const source = await readFile(absolute, "utf8");
  const importsRuntimeDatabase =
    /(?:^|\n)\s*import\s+(?!type\b)[^;]*\sfrom\s+["'](?:\.\.?\/)+db\.js["']/mu.test(
      source,
    );
  const requiresDatabase =
    /@(?:api-)?integration\b|@requires-(?:db|infra)\b/.test(source) ||
    importsRuntimeDatabase;
  const integration =
    requiresDatabase ||
    /@requires-redis\b/.test(source) ||
    /from\s+["']\.\/redis\.js["']/.test(source) ||
    /from\s+["']\.\.\/redis\.js["']/.test(source) ||
    /\bREDIS_URL\b/.test(source);
  const databaseGuarded =
    /integration-test-database-guard\.js/.test(source) ||
    /\bcreateIntegrationTestPool\b/.test(source) ||
    /\bcreateContentTestPool\b/.test(source);
  return {
    absolute,
    databaseGuarded,
    integration,
    relative,
    requiresDatabase,
  };
}

const srcDir = path.resolve(import.meta.dirname);
const { databaseTarget, filters, mode } = parseArgs(process.argv.slice(2));
const discovered = await Promise.all(
  (await collectTestFiles(srcDir))
    .sort((a, b) => a.localeCompare(b))
    .map((absolute) => inspectTestFile(srcDir, absolute)),
);
const modeSelected = discovered
  .filter((file) => {
    if (mode === "all") return true;
    return mode === "integration" ? file.integration : !file.integration;
  })
  .sort((a, b) => a.relative.localeCompare(b.relative));

const selected = modeSelected.filter((file) => {
  if (filters.length === 0) return true;
  const haystack = file.relative.toLowerCase();
  return filters.some((filter) => haystack.includes(filter));
});

if (selected.length === 0) {
  const details = [
    "[test-runner] no matching test files",
    `[test-runner] mode=${mode} filters=${filters.length > 0 ? filters.join(",") : "(none)"}`,
  ];
  if (modeSelected.length > 0) {
    details.push("[test-runner] available files:");
    for (const file of modeSelected) {
      details.push(`  - ${file.relative}`);
    }
  }
  throw new Error(details.join("\n"));
}

const unguardedDatabaseTests = selected.filter(
  (file) => file.requiresDatabase && !file.databaseGuarded,
);
if (unguardedDatabaseTests.length > 0) {
  throw new Error(
    [
      "integration test entrypoints must verify an exact disposable database",
      ...unguardedDatabaseTests.map((file) => `  - ${file.relative}`),
    ].join("\n"),
  );
}

if (selected.some((file) => file.integration) && !databaseTarget) {
  throw new Error(
    "integration tests require --database-url and --expect-database",
  );
}
if (databaseTarget) {
  // Load the normal API secret bundle once, then pin only the disposable DB.
  // env.ts observes this marker and cannot replace the verified target.
  config({
    path: path.resolve(import.meta.dirname, "../../../.env"),
    override: true,
  });
  process.env.DATABASE_URL = databaseTarget.databaseUrl;
  process.env.HUNCH_TEST_EXPECT_DATABASE = databaseTarget.expectedDatabase;
  process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
  const { pool } = await import("./db.js");
  try {
    await verifyIntegrationDatabaseTarget(pool, databaseTarget);
  } catch (error) {
    await closeAcquiredRuntimeResources();
    throw error;
  }
}

try {
  let passed = 0;
  for (const file of selected) {
    const label = file.relative;
    const environment = { ...process.env };
    try {
      console.log(`[test-runner] running ${label}`);
      const url = `${pathToFileURL(file.absolute).href}?t=${Date.now()}`;
      await import(url);
      passed += 1;
      console.log(`[test-runner] ok ${label}`);
    } catch (error) {
      console.error(`[test-runner] failed ${label}`);
      throw error;
    } finally {
      restoreEnvironment(environment);
    }
  }

  console.log(`[test-runner] passed ${passed}/${selected.length}`);
} finally {
  // Transitive imports register only resources they actually acquired; test
  // cleanup must not instantiate API-wide env/DB/Redis modules on the way out.
  await closeAcquiredRuntimeResources();
}
