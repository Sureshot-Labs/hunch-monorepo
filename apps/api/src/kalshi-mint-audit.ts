import { isAbortError, isRpcRateLimit, sleep } from "@hunch/shared";
import { pool } from "./db.js";
import { env } from "./env.js";
import { fetchSolanaMintDecimals } from "./services/solana-rpc.js";

type AuditRow = {
  id: string;
  token_yes: string | null;
  token_no: string | null;
  is_initialized: boolean | null;
  status: string;
};

const DEFAULT_SELECT_TIMEOUT_MS = 30_000;

function parseArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length).trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
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
  const limit = Math.max(1, Number(parseArgValue("limit") ?? "500"));
  const batch = Math.max(
    1,
    Number(parseArgValue("batch") ?? String(Math.min(500, limit))),
  );
  const delayMs = Math.max(0, Number(parseArgValue("delay") ?? "50"));
  const retry = Math.max(0, Number(parseArgValue("retry") ?? "2"));
  const backoffMs = Math.max(0, Number(parseArgValue("backoff") ?? "250"));
  const selectTimeoutMs = Math.max(
    1_000,
    Number(parseArgValue("select-timeout-ms") ?? DEFAULT_SELECT_TIMEOUT_MS),
  );
  const status = parseArgValue("status") ?? "ACTIVE";
  const dryRun = hasFlag("dry-run");
  const includeAudited = hasFlag("include-audited");
  const legacyOnly = hasFlag("legacy-only");
  const startAfter = parseArgValue("after");

  const client = await pool.connect();
  try {
    const startedAt = Date.now();
    let checked = 0;
    let exists = 0;
    let missing = 0;
    let failed = 0;
    let updated = 0;
    let lastId = startAfter;

    while (checked < limit) {
      const batchLimit = Math.min(batch, limit - checked);
      const params: Array<string | number> = [status, batchLimit];
      let afterClause = "";
      if (lastId) {
        params.push(lastId);
        afterClause = `and id > $${params.length}`;
      }
      const missingClause = legacyOnly
        ? "and (coalesce(metadata, '{}'::jsonb) ? 'mint_exists') and not (coalesce(metadata, '{}'::jsonb) ? 'mint_exists_yes')"
        : includeAudited
          ? ""
          : "and not (coalesce(metadata, '{}'::jsonb) ? 'mint_exists')";

      let rows: { rows: AuditRow[] };
      try {
        await client.query("begin");
        await client.query("select set_config('statement_timeout', $1, true)", [
          `${selectTimeoutMs}ms`,
        ]);
        rows = await client.query<AuditRow>(
          `
            select id, token_yes, token_no, is_initialized, status::text
            from unified_markets
            where venue = 'kalshi'
              and (
                token_yes like 'sol:%'
                or token_no like 'sol:%'
              )
              and status = $1::unified_status
              ${missingClause}
              ${afterClause}
            order by id asc
            limit $2
          `,
          params,
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        if (errorCode(error) === "57014") {
          console.error("[kalshi:mint-audit] selector timed out", {
            lastId,
            batchLimit,
            checked,
            selectTimeoutMs,
            resumeWith: lastId ? `--after=${lastId}` : undefined,
          });
        }
        throw error;
      }

      if (rows.rows.length === 0) break;

      for (const row of rows.rows) {
        checked += 1;
        lastId = row.id;
        let mintYes: boolean | null = null;
        let mintNo: boolean | null = null;

        const yesMint =
          typeof row.token_yes === "string" && row.token_yes.startsWith("sol:")
            ? row.token_yes.slice(4)
            : null;
        const noMint =
          typeof row.token_no === "string" && row.token_no.startsWith("sol:")
            ? row.token_no.slice(4)
            : null;

        const checkMint = async (
          mint: string | null,
        ): Promise<boolean | null> => {
          if (!mint) return null;
          let attempt = 0;
          while (true) {
            try {
              await fetchSolanaMintDecimals({
                rpcUrls: env.solanaRpcUrls,
                mint,
                timeoutMs: env.solanaRpcTimeoutMs,
              });
              return true;
            } catch (error) {
              if (isMintNotFound(error)) return false;
              if (
                (isRpcRateLimit(error) || isAbortError(error)) &&
                attempt < retry
              ) {
                await sleep(backoffMs * Math.max(1, 2 ** attempt));
                attempt += 1;
                continue;
              }
              throw error;
            }
          }
        };

        try {
          if (yesMint) {
            mintYes = await checkMint(yesMint);
            if (mintYes === true) exists += 1;
            if (mintYes === false) missing += 1;
            await sleep(delayMs);
          }
          if (noMint) {
            mintNo = await checkMint(noMint);
            if (mintNo === true) exists += 1;
            if (mintNo === false) missing += 1;
            await sleep(delayMs);
          }
        } catch (error) {
          failed += 1;
          console.warn("[kalshi:mint-audit] rpc error", {
            marketId: row.id,
            mint: yesMint || noMint,
            error,
          });
        }

        if (mintYes == null && mintNo == null) continue;
        if (dryRun) continue;

        const mintExists = (mintYes ?? true) && (mintNo ?? true);

        await client.query(
          `
            update unified_markets
            set
              is_initialized = $2,
              metadata = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    coalesce(metadata, '{}'::jsonb),
                    '{mint_exists}',
                    to_jsonb($3::boolean),
                    true
                  ),
                  '{mint_exists_yes}',
                  to_jsonb($4::boolean),
                  true
                ),
                '{mint_exists_no}',
                to_jsonb($5::boolean),
                true
              ),
              updated_at = now()
            where id = $1
          `,
          [row.id, mintExists, mintExists, mintYes ?? false, mintNo ?? false],
        );
        updated += 1;
      }

      if (checked > 0 && checked % Math.max(1000, batch) === 0) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = elapsedSec > 0 ? checked / elapsedSec : 0;
        const remaining = Math.max(0, limit - checked);
        const etaSec = rate > 0 ? remaining / rate : null;
        console.log("[kalshi:mint-audit] progress", {
          checked,
          exists,
          missing,
          failed,
          lastId,
          rate: Number(rate.toFixed(2)),
          etaSec: etaSec != null ? Math.round(etaSec) : null,
        });
      }
    }

    console.log("[kalshi:mint-audit] done", {
      status,
      limit,
      batch,
      dryRun,
      includeAudited,
      legacyOnly,
      startAfter,
      lastId,
      checked,
      exists,
      missing,
      failed,
      updated,
    });
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error("[kalshi:mint-audit] failed", error);
  process.exitCode = 1;
});
