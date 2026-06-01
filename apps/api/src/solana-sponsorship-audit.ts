import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { pool } from "./db.js";
import { analyzeEmbeddedSolanaTransaction } from "./services/embedded-solana-sponsorship.js";

type SampleRow = {
  source: "execution" | "bridge_order";
  id: string;
  user_id: string;
  wallet_address: string | null;
  raw: unknown;
};

function parseArgs(): { out: string; limit: number } {
  const args = process.argv.slice(2);
  let out = resolve(
    process.cwd(),
    "../../untracked/solana-sponsorship-audit-samples.jsonl",
  );
  let limit = 50;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--out" && args[index + 1]) {
      out = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = resolve(arg.slice("--out=".length));
      continue;
    }
    if (arg === "--limit" && args[index + 1]) {
      const parsed = Number(args[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.trunc(parsed);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length));
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.trunc(parsed);
    }
  }
  return { out, limit: Math.min(Math.max(limit, 1), 500) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findTransactionPayload(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (!value) return null;
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTransactionPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const directCandidates = [
    value.transaction,
    value.swapTransaction,
    value.swap_transaction,
    isRecord(value.tx) ? value.tx.data : null,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nested of Object.values(value)) {
    const found = findTransactionPayload(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

async function loadSamples(limit: number): Promise<SampleRow[]> {
  const executions = await pool.query<SampleRow>(
    `
      select
        'execution'::text as source,
        id::text,
        user_id::text,
        wallet_address,
        raw
      from executions
      where venue = 'kalshi'
        and raw is not null
      order by created_at desc
      limit $1
    `,
    [limit],
  );
  const bridges = await pool.query<SampleRow>(
    `
      select
        'bridge_order'::text as source,
        id::text,
        user_id::text,
        metadata as raw,
        coalesce(
          metadata->>'senderAddress',
          metadata->'across'->>'senderAddress'
        ) as wallet_address
      from bridge_orders
      where provider in ('across', 'debridge')
        and src_chain_id = '7565164'
        and metadata is not null
      order by created_at desc
      limit $1
    `,
    [limit],
  );
  return [...executions.rows, ...bridges.rows];
}

async function main(): Promise<void> {
  const { out, limit } = parseArgs();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, "", { encoding: "utf8" });

  const samples = await loadSamples(limit);
  let decoded = 0;
  for (const sample of samples) {
    const transaction = findTransactionPayload(sample.raw);
    if (!transaction) {
      await appendFile(
        out,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          source: sample.source,
          id: sample.id,
          userId: sample.user_id,
          decoded: false,
          reason: "missing_transaction_payload",
        })}\n`,
      );
      continue;
    }
    decoded += 1;
    const analysis = analyzeEmbeddedSolanaTransaction({
      signer: sample.wallet_address ?? "",
      transaction,
      includeRaw: false,
    });
    await appendFile(
      out,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        source: sample.source,
        id: sample.id,
        userId: sample.user_id,
        signer: sample.wallet_address,
        decoded: analysis.ok,
        analysis,
      })}\n`,
      { encoding: "utf8" },
    );
  }

  console.log(
    `Wrote ${samples.length} sponsorship audit samples (${decoded} decoded) to ${out}`,
  );
}

main()
  .catch((error) => {
    console.error("[solana-sponsorship-audit] failed", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
