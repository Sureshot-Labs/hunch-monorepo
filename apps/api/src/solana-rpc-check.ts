import { pool } from "./db.js";
import { env } from "./env.js";
import {
  fetchSolanaTokenLargestAccounts,
  fetchSolanaMintDecimals,
} from "./services/solana-rpc.js";

type MintCheckResult = {
  mint: string;
  marketIds: string[];
  ok: boolean;
  error?: string;
};

function parseArg(name: string, fallback: number): number {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!match) return fallback;
  const raw = match.split("=", 2)[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgString(name: string, fallback: string): string {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!match) return fallback;
  return match.split("=", 2)[1] ?? fallback;
}

function isMintNotFound(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not find mint") ||
    message.includes("Invalid param: could not find mint") ||
    message.includes("Invalid param")
  );
}

async function main() {
  const limit = parseArg("--limit", 25);
  const sample = parseArg("--sample", 0);
  const statusArg = parseArgString("--status", "ACTIVE").toUpperCase();
  const venue = parseArgString("--venue", "kalshi");
  const orderBy = parseArgString("--by", "volume");
  const checkMode = parseArgString("--check", "holders");
  const rpcUrls = env.solanaRpcUrls;
  const timeoutMs = env.solanaRpcTimeoutMs;

  const client = await pool.connect();
  try {
    const statusFilter = statusArg === "ANY" ? "" : "and status = $2";
    const orderClause =
      orderBy === "updated"
        ? "order by updated_at desc nulls last, id"
        : "order by volume_24h desc nulls last, updated_at desc nulls last, id";

    const params: Array<string | number> = [venue];
    if (statusArg !== "ANY") params.push(statusArg);
    params.push(limit);

    const { rows } = await client.query<{
      id: string;
      token_yes: string | null;
      token_no: string | null;
      status: string;
    }>(
      `
        select id, token_yes, token_no
        from unified_markets
        where venue = $1
          ${statusFilter}
          and (token_yes like 'sol:%' or token_no like 'sol:%')
        ${orderClause}
        limit $${params.length}
      `,
      params,
    );

    if (rows.length === 0) {
      console.log(`[solana-rpc-check] no ${venue} markets with sol mints`);
      return;
    }

    const mintToMarkets = new Map<string, Set<string>>();
    const marketStatus = new Map<string, string>();
    for (const row of rows) {
      const yes = row.token_yes?.startsWith("sol:")
        ? row.token_yes.slice(4)
        : null;
      const no = row.token_no?.startsWith("sol:")
        ? row.token_no.slice(4)
        : null;
      if (yes) {
        if (!mintToMarkets.has(yes)) mintToMarkets.set(yes, new Set());
        mintToMarkets.get(yes)?.add(row.id);
      }
      if (no) {
        if (!mintToMarkets.has(no)) mintToMarkets.set(no, new Set());
        mintToMarkets.get(no)?.add(row.id);
      }
      if (row.status) marketStatus.set(row.id, row.status);
    }

    const allMints = Array.from(mintToMarkets.keys());
    const targets = sample > 0 ? allMints.slice(0, sample) : allMints;

    const results: MintCheckResult[] = [];
    for (const mint of targets) {
      try {
        if (checkMode === "existence" || checkMode === "both") {
          await fetchSolanaMintDecimals({
            rpcUrls,
            timeoutMs,
            mint,
          });
        }
        if (checkMode === "holders" || checkMode === "both") {
          await fetchSolanaTokenLargestAccounts({
            rpcUrls,
            timeoutMs,
            mint,
          });
        }
        results.push({
          mint,
          marketIds: Array.from(mintToMarkets.get(mint) ?? []),
          ok: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          mint,
          marketIds: Array.from(mintToMarkets.get(mint) ?? []),
          ok: false,
          error: message,
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const notFound = results.filter((r) => r.error && isMintNotFound(r.error));
    const otherErrors = results.filter(
      (r) => !r.ok && !isMintNotFound(r.error),
    );

    console.log(
      `[solana-rpc-check] venue=${venue} status=${statusArg} mode=${checkMode} totalMints=${results.length} ok=${okCount} notFound=${notFound.length} otherErrors=${otherErrors.length}`,
    );

    const marketsTouched = new Set<string>();
    const marketsMissing = new Set<string>();
    for (const entry of results) {
      for (const marketId of entry.marketIds) {
        marketsTouched.add(marketId);
        if (!entry.ok) marketsMissing.add(marketId);
      }
    }

    console.log(
      `[solana-rpc-check] markets=${marketsTouched.size} marketsWithMissingMint=${marketsMissing.size}`,
    );

    const missingActive = Array.from(marketsMissing).filter(
      (id) => marketStatus.get(id) === "ACTIVE",
    );
    const missingClosed = Array.from(marketsMissing).filter(
      (id) => marketStatus.get(id) && marketStatus.get(id) !== "ACTIVE",
    );
    if (missingActive.length || missingClosed.length) {
      console.log(
        `[solana-rpc-check] missing markets by status: active=${missingActive.length} closed=${missingClosed.length}`,
      );
    }

    if (notFound.length > 0) {
      console.log("[solana-rpc-check] mint not found samples:");
      for (const entry of notFound.slice(0, 10)) {
        const marketId = entry.marketIds[0] ?? "unknown";
        console.log(`- ${marketId} ${entry.mint}`);
      }
    }

    if (otherErrors.length > 0) {
      console.log("[solana-rpc-check] other error samples:");
      for (const entry of otherErrors.slice(0, 10)) {
        const marketId = entry.marketIds[0] ?? "unknown";
        console.log(`- ${marketId} ${entry.mint} :: ${entry.error}`);
      }
    }
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error("[solana-rpc-check] failed", error);
  process.exit(1);
});
