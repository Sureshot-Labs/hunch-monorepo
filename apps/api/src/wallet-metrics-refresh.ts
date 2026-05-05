import { chunkArray } from "@hunch/shared";

import { pool } from "./db.js";
import { refreshWalletMetrics } from "./services/wallet-metrics-refresh.js";

type Args = {
  all: boolean;
  tag: string | null;
  walletIds: string[];
  walletAddresses: string[];
  chain: string | null;
  limit: number | null;
  batch: number;
  statementTimeoutSec: number;
  asOf: Date;
  dryRun: boolean;
  skipSelectorSnapshot: boolean;
};

function readValues(argv: string[], name: string): string[] {
  const key = `--${name}`;
  const values: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith(`${key}=`)) {
      const value = arg.slice(key.length + 1).trim();
      if (value.length) values.push(value);
      continue;
    }
    if (arg === key) {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        values.push(value.trim());
        i += 1;
      }
    }
  }

  return values.filter(Boolean);
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function readNumber(
  argv: string[],
  name: string,
  fallback: number | null,
): number | null {
  const raw = readValues(argv, name)[0];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  const walletIds = readValues(argv, "wallet-id");
  const walletAddresses = [
    ...readValues(argv, "wallet"),
    ...readValues(argv, "address"),
  ];
  const all = hasFlag(argv, "all");
  const explicitTag = readValues(argv, "tag")[0] ?? null;
  const tag =
    all || walletIds.length > 0 || walletAddresses.length > 0
      ? explicitTag
      : (explicitTag ?? "whale");
  const asOfRaw = readValues(argv, "as-of")[0];
  const asOf = asOfRaw ? new Date(asOfRaw) : new Date();

  if (!Number.isFinite(asOf.getTime())) {
    throw new Error(`Invalid --as-of value: ${asOfRaw}`);
  }

  return {
    all,
    tag,
    walletIds,
    walletAddresses,
    chain: readValues(argv, "chain")[0]?.trim().toLowerCase() ?? null,
    limit: readNumber(argv, "limit", null),
    batch: Math.max(1, readNumber(argv, "batch", 250) ?? 250),
    statementTimeoutSec: Math.max(
      1,
      readNumber(argv, "statement-timeout-sec", 120) ?? 120,
    ),
    asOf,
    dryRun: hasFlag(argv, "dry-run"),
    skipSelectorSnapshot: hasFlag(argv, "skip-selector-snapshot"),
  };
}

async function selectWalletIds(args: Args): Promise<string[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (args.all) {
    // No-op: intentionally include every wallet.
  } else if (args.walletIds.length > 0) {
    values.push(args.walletIds);
    conditions.push(`w.id = any($${values.length}::uuid[])`);
  } else if (args.walletAddresses.length > 0) {
    const normalizedAddresses = args.walletAddresses.map((address) =>
      address.toLowerCase(),
    );
    values.push(args.walletAddresses);
    const exactIndex = values.length;
    values.push(normalizedAddresses);
    const normalizedIndex = values.length;
    conditions.push(
      args.chain === "solana"
        ? `w.address = any($${exactIndex}::text[])`
        : args.chain
          ? `lower(w.address) = any($${normalizedIndex}::text[])`
          : `(
            (w.chain = 'solana' and w.address = any($${exactIndex}::text[]))
            or (w.chain <> 'solana' and lower(w.address) = any($${normalizedIndex}::text[]))
          )`,
    );
  }

  if (args.chain) {
    values.push(args.chain);
    conditions.push(`w.chain = $${values.length}`);
  }

  if (args.tag) {
    values.push(args.tag);
    conditions.push(`
      exists (
        select 1
        from wallet_tag_map tm
        join wallet_tags t on t.id = tm.tag_id
        where tm.wallet_id = w.id
          and t.slug = $${values.length}
      )
    `);
  }

  if (!args.all && conditions.length === 0) {
    throw new Error("No wallet selector provided");
  }

  const limitSql = args.limit ? `limit ${args.limit}` : "";
  const { rows } = await pool.query<{ id: string }>(
    `
      select w.id
      from wallets w
      ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      order by w.last_seen_at desc nulls last, w.id
      ${limitSql}
    `,
    values,
  );

  return rows.map((row) => row.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const walletIds = await selectWalletIds(args);
  const batches = chunkArray(walletIds, args.batch);

  console.log("[wallets:metrics:refresh] start", {
    wallets: walletIds.length,
    batches: batches.length,
    batch: args.batch,
    all: args.all,
    tag: args.tag,
    chain: args.chain,
    limit: args.limit,
    statementTimeoutSec: args.statementTimeoutSec,
    asOf: args.asOf.toISOString(),
    dryRun: args.dryRun,
    skipSelectorSnapshot: args.skipSelectorSnapshot,
  });

  if (args.dryRun) {
    console.log("[wallets:metrics:refresh] dry-run complete");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("select set_config('statement_timeout', $1, false)", [
      `${args.statementTimeoutSec}s`,
    ]);

    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      console.log("[wallets:metrics:refresh] batch start", {
        batch: i + 1,
        batches: batches.length,
        wallets: batch.length,
      });
      await refreshWalletMetrics(client, {
        walletIds: batch,
        asOf: args.asOf,
        logPrefix: "[wallets:metrics:refresh]",
      });
      console.log("[wallets:metrics:refresh] batch complete", {
        batch: i + 1,
        batches: batches.length,
        wallets: batch.length,
      });
    }

    if (!args.skipSelectorSnapshot) {
      await client.query("select refresh_wallet_intel_selector_snapshot()");
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log("[wallets:metrics:refresh] done", {
    wallets: walletIds.length,
    durationMs: Date.now() - startedAt,
  });
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("[wallets:metrics:refresh] failed", error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
