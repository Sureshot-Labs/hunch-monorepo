#!/usr/bin/env tsx

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildApp } from "./app.js";

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return typeof value === "string" && value.length ? value : undefined;
}

const outPath = getArgValue("--out") ?? getArgValue("-o") ?? "openapi.json";
const useStdout = process.argv.includes("--stdout");

const app = await buildApp();
try {
  await app.ready();
  const spec = app.swagger();
  const json = JSON.stringify(spec, null, 2);

  if (useStdout) {
    process.stdout.write(json);
    process.stdout.write("\n");
  } else {
    await writeFile(resolve(process.cwd(), outPath), json);
    console.log(`Wrote OpenAPI spec to ${outPath}`);
  }
} finally {
  await app.close();
}
