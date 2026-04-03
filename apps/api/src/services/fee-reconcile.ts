import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  fetchSolanaSignatureStatus,
  fetchSolanaTokenAccountNetDelta,
  formatUiAmount,
} from "./solana-rpc.js";

type FeeEventRow = {
  id: string;
  venue: string;
  source_type: string;
  fee_amount: string;
  tx_hash: string;
  collected_at: Date | null;
  updated_at: Date | null;
};

export type FeeReconcileResult = {
  checked: number;
  collected: number;
  failed: number;
  skipped: number;
  errors: number;
};

type FeeReconcileOptions = {
  limit?: number;
  minAgeSec?: number;
  dryRun?: boolean;
};

function buildPendingFeeQuery(inputs: FeeReconcileOptions) {
  const limit = Math.max(1, Math.trunc(inputs.limit ?? 25));
  const minAgeSec = Math.max(0, Math.trunc(inputs.minAgeSec ?? 0));

  const params: Array<string | number> = ["solana"];
  let whereClause = `
    where chain_id = $1
      and status = 'pending'
      and tx_hash is not null
  `;

  if (minAgeSec > 0) {
    params.push(minAgeSec);
    whereClause += ` and updated_at <= now() - ($${params.length}::int * interval '1 second')`;
  }

  params.push(limit);

  return {
    text: `
      select id, tx_hash, collected_at, updated_at
           , venue, source_type, fee_amount
      from fee_events
      ${whereClause}
      order by updated_at asc
      limit $${params.length}
    `,
    params,
  };
}

function amountsMatch(a: string, b: string): boolean {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) < 0.0000005;
}

async function verifyKalshiFeeEventAmount(row: FeeEventRow): Promise<{
  verified: boolean;
  matches: boolean;
}> {
  const feeAccount = env.dflowFeeAccount?.trim();
  if (!feeAccount || !row.tx_hash) {
    return { verified: false, matches: false };
  }
  const delta = await fetchSolanaTokenAccountNetDelta({
    rpcUrls: env.solanaRpcUrls,
    signature: row.tx_hash.trim(),
    tokenAccount: feeAccount,
    expectedMint: env.solanaUsdcMint,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
  if (delta.status !== "verified") {
    return { verified: false, matches: false };
  }
  if (delta.deltaRaw <= 0n) {
    return { verified: true, matches: false };
  }
  const actual = formatUiAmount(delta.deltaRaw, delta.decimals);
  return {
    verified: true,
    matches: amountsMatch(actual, row.fee_amount),
  };
}

async function updateFeeEventStatus(
  pool: DbQuery,
  inputs: { id: string; status: "collected" | "failed" },
): Promise<void> {
  await pool.query(
    `
      update fee_events
      set status = $2,
          collected_at = case
            when $2 = 'collected' then coalesce(collected_at, now())
            else collected_at
          end,
          updated_at = now()
      where id = $1
    `,
    [inputs.id, inputs.status],
  );
}

export async function reconcileSolanaFeeEvents(
  pool: DbQuery,
  options: FeeReconcileOptions = {},
): Promise<FeeReconcileResult> {
  const result: FeeReconcileResult = {
    checked: 0,
    collected: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
  };

  const query = buildPendingFeeQuery(options);
  const { rows } = await pool.query<FeeEventRow>(query.text, query.params);
  if (!rows.length) return result;

  for (const row of rows) {
    result.checked += 1;
    const signature = row.tx_hash.trim();
    if (!signature) {
      result.skipped += 1;
      continue;
    }

    try {
      const status = await fetchSolanaSignatureStatus({
        rpcUrls: env.solanaRpcUrls,
        signature,
        timeoutMs: env.solanaRpcTimeoutMs,
      });

      if (!status) {
        result.skipped += 1;
        continue;
      }

      if (options.dryRun) {
        if (status.status === "fulfilled") result.collected += 1;
        else if (status.status === "failed") result.failed += 1;
        else result.skipped += 1;
        continue;
      }

      if (status.status === "fulfilled") {
        if (row.venue === "kalshi" && row.source_type === "execution") {
          const verification = await verifyKalshiFeeEventAmount(row);
          if (!verification.verified || !verification.matches) {
            result.skipped += 1;
            continue;
          }
        }
        await updateFeeEventStatus(pool, { id: row.id, status: "collected" });
        result.collected += 1;
      } else if (status.status === "failed") {
        await updateFeeEventStatus(pool, { id: row.id, status: "failed" });
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
