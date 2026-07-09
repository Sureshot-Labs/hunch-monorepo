#!/usr/bin/env tsx

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type TestMode = "all" | "integration" | "unit";

type TestFile = {
  absolute: string;
  integration: boolean;
  relative: string;
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

function parseArgs(argv: string[]): { filters: string[]; mode: TestMode } {
  let mode: TestMode = "all";
  const filters: string[] = [];
  for (const arg of argv) {
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
    filters.push(arg);
  }
  return { filters: parseFilters(filters), mode };
}

async function inspectTestFile(
  srcDir: string,
  absolute: string,
): Promise<TestFile> {
  const relative = path.relative(srcDir, absolute);
  const source = await readFile(absolute, "utf8");
  const integration =
    /@(?:api-)?integration\b|@requires-(?:db|redis|infra)\b/.test(source) ||
    /from\s+["']\.\/db\.js["']/.test(source) ||
    /from\s+["']\.\.\/db\.js["']/.test(source) ||
    /from\s+["']\.\/redis\.js["']/.test(source) ||
    /from\s+["']\.\.\/redis\.js["']/.test(source) ||
    /\bDATABASE_URL\b|\bREDIS_URL\b/.test(source);
  return { absolute, integration, relative };
}

const srcDir = path.resolve(import.meta.dirname);
const { filters, mode } = parseArgs(process.argv.slice(2));
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
  console.error("[test-runner] no matching test files");
  console.error(
    `[test-runner] mode=${mode} filters=${filters.length > 0 ? filters.join(",") : "(none)"}`,
  );
  if (modeSelected.length > 0) {
    console.error("[test-runner] available files:");
    for (const file of modeSelected) {
      console.error(`  - ${file.relative}`);
    }
  }
  process.exit(1);
}

try {
  let passed = 0;
  for (const file of selected) {
    const label = file.relative;
    try {
      console.log(`[test-runner] running ${label}`);
      const url = `${pathToFileURL(file.absolute).href}?t=${Date.now()}`;
      await import(url);
      passed += 1;
      console.log(`[test-runner] ok ${label}`);
    } catch (error) {
      console.error(`[test-runner] failed ${label}`);
      throw error;
    }
  }

  console.log(`[test-runner] passed ${passed}/${selected.length}`);
} finally {
  if (mode !== "unit") {
    const [{ closeRedis }, { pool }] = await Promise.all([
      import("./redis.js"),
      import("./db.js"),
    ]);
    await closeRedis();
    await pool.end();
  }
}
