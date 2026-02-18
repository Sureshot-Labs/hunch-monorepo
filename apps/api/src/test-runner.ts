#!/usr/bin/env tsx

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  return argv
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

const srcDir = path.resolve(import.meta.dirname);
const filters = parseFilters(process.argv.slice(2));
const discovered = (await collectTestFiles(srcDir))
  .sort((a, b) => a.localeCompare(b))
  .map((absolute) => ({
    absolute,
    relative: path.relative(srcDir, absolute),
  }));

const selected = discovered.filter((file) => {
  if (filters.length === 0) return true;
  const haystack = file.relative.toLowerCase();
  return filters.some((filter) => haystack.includes(filter));
});

if (selected.length === 0) {
  console.error("[test-runner] no matching test files");
  console.error(
    `[test-runner] filters=${filters.length > 0 ? filters.join(",") : "(none)"}`,
  );
  if (discovered.length > 0) {
    console.error("[test-runner] available files:");
    for (const file of discovered) {
      console.error(`  - ${file.relative}`);
    }
  }
  process.exit(1);
}

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

