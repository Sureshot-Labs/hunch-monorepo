import { chunkArray, sleep } from "@hunch/shared";
import { pool } from "./db.js";

type MarketRow = {
  id: string;
  venue: string;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
};

type TokenRow = {
  market_id: string;
  token_id: string;
  venue: string;
  outcome_side: "YES" | "NO" | null;
};

function parseArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length).trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseClobTokenIds(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((token) => typeof token === "string") as string[];
  } catch {
    return [];
  }
}

function buildTokenRows(market: MarketRow): TokenRow[] {
  const tokens: TokenRow[] = [];
  const seen = new Set<string>();

  const pushToken = (
    token_id: string | null,
    outcome_side: "YES" | "NO" | null,
  ) => {
    if (!token_id) return;
    if (seen.has(token_id)) return;
    seen.add(token_id);
    tokens.push({
      market_id: market.id,
      token_id,
      venue: market.venue,
      outcome_side,
    });
  };

  pushToken(market.token_yes, "YES");
  pushToken(market.token_no, "NO");
  const clobTokens = parseClobTokenIds(market.clob_token_ids);
  if (clobTokens.length > 0) {
    pushToken(clobTokens[0], "YES");
    pushToken(clobTokens[1], "NO");
    for (const token of clobTokens.slice(2)) {
      pushToken(token, null);
    }
  }

  return tokens;
}

async function fetchMarketBatch(after: string | null, limit: number) {
  const result = await pool.query<MarketRow>(
    `
      select id, venue, token_yes, token_no, clob_token_ids
      from unified_markets
      where ($1::text is null or id > $1)
      order by id
      limit $2
    `,
    [after, limit],
  );
  return result.rows;
}

async function upsertTokens(marketIds: string[], tokenRows: TokenRow[]) {
  await pool.query("begin");
  try {
    await pool.query(
      `
        delete from unified_market_tokens
        where market_id = any($1::text[])
      `,
      [marketIds],
    );

    if (tokenRows.length > 0) {
      await pool.query(
        `
          insert into unified_market_tokens (market_id, token_id, venue, outcome_side)
          select market_id, token_id, venue, outcome_side
          from jsonb_to_recordset($1::jsonb) as x(
            market_id text,
            token_id text,
            venue text,
            outcome_side text
          )
          on conflict (market_id, token_id) do update
            set venue = excluded.venue,
                outcome_side = excluded.outcome_side
        `,
        [JSON.stringify(tokenRows)],
      );
    }

    await pool.query("commit");
  } catch (err) {
    await pool.query("rollback");
    throw err;
  }
}

async function main() {
  const limitRaw = parseArgValue("limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : null;
  const batch = Math.max(1, Number(parseArgValue("batch") ?? "1000"));
  const delayMs = Math.max(0, Number(parseArgValue("delay") ?? "0"));
  const dryRun = hasFlag("dry-run");
  const startAfter = parseArgValue("after");

  const startedAt = Date.now();
  let processed = 0;
  let updated = 0;
  let tokenRowsCount = 0;
  let pages = 0;
  let lastId: string | null = startAfter;

  while (true) {
    const remaining = limit ? limit - processed : null;
    if (remaining !== null && remaining <= 0) break;
    const pageLimit = remaining ? Math.min(batch, remaining) : batch;

    const markets = await fetchMarketBatch(lastId, pageLimit);
    if (markets.length === 0) break;

    pages += 1;
    processed += markets.length;
    lastId = markets[markets.length - 1]?.id ?? lastId;

    const tokenRows = markets.flatMap(buildTokenRows);
    tokenRowsCount += tokenRows.length;

    if (!dryRun) {
      const marketIds = markets.map((row) => row.id);
      const chunks = chunkArray(marketIds, 1000);
      for (const chunk of chunks) {
        const chunkSet = new Set(chunk);
        const chunkTokens = tokenRows.filter((row) =>
          chunkSet.has(row.market_id),
        );
        await upsertTokens(chunk, chunkTokens);
      }
      updated += markets.length;
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log("[market:token-backfill] done", {
    limit,
    batch,
    delayMs,
    dryRun,
    pages,
    markets: processed,
    tokenRows: tokenRowsCount,
    updated,
    lastId,
    elapsedSec,
  });
}

main().catch((err) => {
  console.error("[market:token-backfill] failed", err);
  process.exit(1);
});
