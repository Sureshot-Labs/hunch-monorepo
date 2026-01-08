#!/usr/bin/env tsx

import { pool } from "./db.js";
import { mergeUsersById, type MergeOptions } from "./admin-merge-user-core.js";

type ScriptOptions = MergeOptions & {
  sourceUserId?: string;
  targetUserId?: string;
  sourceWallet?: string;
  targetWallet?: string;
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
    sourceWallet: getValue("--source-wallet"),
    targetWallet: getValue("--target-wallet"),
    dryRun: hasFlag("--dry-run"),
    keepSource: hasFlag("--keep-source"),
  };
}

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

async function resolveUserIdByWallet(wallet: string): Promise<string | null> {
  const trimmed = wallet.trim();
  if (!trimmed) return null;

  const match = ETH_ADDRESS_RE.test(trimmed)
    ? "lower(wallet_address) = lower($1)"
    : "wallet_address = $1";

  const { rows } = await pool.query<{ user_id: string }>(
    `select user_id from user_wallets where ${match} limit 2`,
    [trimmed],
  );

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`Multiple users found for wallet ${trimmed}`);
  }
  return rows[0].user_id;
}

async function main() {
  const options = parseArgs();
  let sourceId = options.sourceUserId?.trim();
  let targetId = options.targetUserId?.trim();

  if (!sourceId && options.sourceWallet) {
    sourceId = (await resolveUserIdByWallet(options.sourceWallet)) ?? undefined;
  }
  if (!targetId && options.targetWallet) {
    targetId = (await resolveUserIdByWallet(options.targetWallet)) ?? undefined;
  }

  if (!sourceId || !targetId) {
    throw new Error(
      "Provide --source/--target user IDs or --source-wallet/--target-wallet",
    );
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
