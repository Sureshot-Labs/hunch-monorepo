#!/usr/bin/env tsx

import { pool } from "./db.js";
import { mergeUsersById, type MergeOptions } from "./admin-merge-user-core.js";

type ScriptOptions = MergeOptions & {
  sourceUserId?: string;
  targetUserId?: string;
};

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  return {
    sourceUserId: getValue("--source") ?? getValue("--source-user"),
    targetUserId: getValue("--target") ?? getValue("--target-user"),
    dryRun: hasFlag("--dry-run"),
    keepSource: hasFlag("--keep-source"),
  };
}

async function main() {
  const options = parseArgs();
  const sourceId = options.sourceUserId?.trim();
  const targetId = options.targetUserId?.trim();

  if (!sourceId || !targetId) {
    throw new Error("Provide --source and --target user IDs");
  }
  if (sourceId === targetId) {
    throw new Error("Source and target must be different users");
  }

  const result = await mergeUsersById(sourceId, targetId, options);

  console.log(
    JSON.stringify(
      {
        sourceId,
        targetId,
        dryRun: result.dryRun,
        keepSource: options.keepSource,
        summary: result.summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
