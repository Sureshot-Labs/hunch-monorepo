// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestPool } from "./test-database-target.js";
import { buildPolymarketAssetBindings } from "@hunch/db";
import { polymarketContextFromBinding } from "./services/polymarket-asset-context.js";
import {
  positionAssetKey,
  positionStorageContract,
} from "./lib/position-asset-context.js";
import {
  loadWalletIntelPolymarketLedgers,
  loadWalletIntelPolymarketMarks,
} from "./services/wallet-intel-polymarket-enrichment.js";
import { WALLET_INTEL_SCOPE_REPAIR_SQL } from "./services/wallet-intel-market-scope.js";
import type { Pool } from "@hunch/infra";
import { collectAutoTrackedWalletSnapshotRows } from "./wallet-intel-refresh.js";
import { env } from "./env.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
try {
  assert.match(
    String(
      (await client.query("show server_version_num")).rows[0]
        .server_version_num,
    ),
    /^16/,
  );
  await client.query("begin");
  await client.query(
    "set local statement_timeout='15s'; set local lock_timeout='2s'",
  );
  await client.query(`
 create temp table unified_markets(id text primary key,venue text,condition_id text,clob_token_ids text,outcomes text,metadata jsonb,token_yes text,token_no text,last_price numeric,resolved_outcome text,resolved_outcome_pct numeric,status text);
 create temp table unified_tokens(token_id text primary key,market_id text,venue text,side text);
 create temp table unified_market_tokens(market_id text,outcome_side text,token_id text,venue text,primary key(market_id,outcome_side));
 create index on unified_market_tokens(token_id);
 create temp table positions(token_id text,position_contract text,asset_context jsonb,venue text,position_scope text,is_hidden boolean,wallet_address text);
 create index on positions(token_id);
 create temp table unified_token_top_latest(token_id text primary key,ts timestamptz,best_bid numeric,best_ask numeric,mid numeric);
 `);
  await client.query(
    readFileSync(
      new URL(
        "../../../packages/db/migrations/0270_polymarket_asset_bindings.sql",
        import.meta.url,
      ),
      "utf8",
    ).replace(
      "create table polymarket_asset_bindings",
      "create temp table polymarket_asset_bindings",
    ),
  );
  const ids: string[] = [];
  const bindings: ReturnType<typeof buildPolymarketAssetBindings> = [];
  for (let group = 0; group < 28; group++) {
    const markets = [];
    const batch = [];
    for (let i = group * 1000 + 1; i <= group * 1000 + 1000; i++) {
      const base = (1n << 248n) | (BigInt(i) << 120n);
      const tokens = [base.toString(), (base | 1n).toString()];
      const source = {
        id: `polymarket:fixture-${i}`,
        venue: "polymarket",
        condition_id: `0x${base.toString(16).padStart(64, "0")}`,
        clob_token_ids: JSON.stringify([...tokens].reverse()),
        outcomes: '["Yes","No"]',
        metadata: { version: "v2", positionIds: tokens, negRisk: false },
      };
      const frozen = buildPolymarketAssetBindings({
        ...source,
        metadata: { version: "v1", negRisk: false },
      });
      const current = buildPolymarketAssetBindings(source);
      assert.equal(current.length, 2);
      assert.equal(frozen.length, 2);
      bindings.push(...frozen, ...current);
      batch.push(...frozen, ...current);
      ids.push(...tokens);
      markets.push(source);
    }
    await client.query(
      `insert into unified_markets(id,venue,condition_id,clob_token_ids,outcomes,metadata,last_price,status)
     select market_row.id,market_row.venue,market_row.condition_id,market_row.clob_token_ids,market_row.outcomes,market_row.metadata,0.4,'ACTIVE'
     from jsonb_to_recordset($1::jsonb) market_row(id text,venue text,condition_id text,clob_token_ids text,outcomes text,metadata jsonb)`,
      [JSON.stringify(markets)],
    );
    await client.query(WALLET_INTEL_SCOPE_REPAIR_SQL, [JSON.stringify(batch)]);
  }
  await client.query(`insert into unified_markets(id,venue) select 'unrelated:'||fixture_row,'limitless' from generate_series(1,172000) fixture_row;
 insert into unified_market_tokens select market_id,case outcome_index when 0 then 'YES' else 'NO' end,asset_id,'polymarket' from polymarket_asset_bindings where protocol_version='v2';
 insert into unified_tokens select token_id,market_id,venue,outcome_side from unified_market_tokens where market_id like 'polymarket:fixture-279%';
 insert into unified_token_top_latest select token_id,now(),0.39,0.41,0.4 from unified_market_tokens;
 insert into unified_token_top_latest select 'other:'||fixture_row,now(),0.39,0.41,0.4 from generate_series(1,144000) fixture_row;
 analyze unified_markets; analyze unified_tokens; analyze unified_market_tokens; analyze polymarket_asset_bindings; analyze positions; analyze unified_token_top_latest;`);
  const diagnostics: { requested: number }[] = [];
  assert.deepEqual(await loadWalletIntelPolymarketLedgers(client, []), []);
  const ledgers = await loadWalletIntelPolymarketLedgers(client, ids, (d) =>
    diagnostics.push(d),
  );
  assert.equal(ledgers.length, 2);
  assert.equal(diagnostics.length, 56);
  for (const ledger of ledgers) assert.equal(ledger.tokenContexts.size, 56000);
  assert.ok(diagnostics.every((d) => d.requested <= 1000));
  const holdings = bindings.slice(0, 2400).map((binding) => {
    const context = polymarketContextFromBinding(binding);
    assert.ok(context);
    return { tokenId: binding.asset_id, assetContext: context };
  });
  for (let page = 0; page < 5; page++)
    await client.query(
      `insert into positions(token_id,position_contract,asset_context,venue)
    select holding_row.token_id,holding_row.position_contract,holding_row.asset_context,'polymarket' from jsonb_to_recordset($1::jsonb) holding_row(token_id text,position_contract text,asset_context jsonb)`,
      [
        JSON.stringify(
          holdings.slice(0, 1000).map((h) => ({
            token_id: h.tokenId,
            position_contract: positionStorageContract({
              venue: "polymarket",
              ...h,
            }),
            asset_context: h.assetContext,
          })),
        ),
      ],
    );
  await client.query(
    "insert into positions(token_id,venue) select 'other:'||fixture_row,'polymarket' from generate_series(1,20000) fixture_row; analyze positions",
  );
  const rows = await loadWalletIntelPolymarketMarks(client, holdings);
  assert.equal(
    rows.size,
    2400,
    "all ledgers resolve without legacy unified_tokens backfill",
  );
  const firstHolding = holdings[0];
  assert.ok(firstHolding);
  const sameId = firstHolding.tokenId;
  const pair = holdings.filter((h) => h.tokenId === sameId);
  assert.equal(pair.length, 2);
  assert.deepEqual(
    new Set(
      pair.map(
        (h) =>
          rows.get(
            positionAssetKey(
              h.tokenId,
              positionStorageContract({ venue: "polymarket", ...h }),
            ),
          )?.outcome_side,
      ),
    ),
    new Set(["YES", "NO"]),
  );
  let batches = 0;
  const failing = {
    query: async (sql: string, params: unknown[]) => {
      if (++batches === 2)
        throw Object.assign(Error("fixture timeout"), { code: "57014" });
      return client.query(sql, params);
    },
  } as unknown as Pick<Pool, "query">;
  const partial = await loadWalletIntelPolymarketMarks(failing, holdings, {
    isolateBatchErrors: true,
  });
  assert.equal(partial.size, 1400);
  const failedHolding = holdings[1100];
  assert.ok(failedHolding);
  assert.ok(
    !partial.has(
      positionAssetKey(
        failedHolding.tokenId,
        positionStorageContract({ venue: "polymarket", ...failedHolding }),
      ),
    ),
  );
  const bad = {
    ...firstHolding,
    positionContract: "0x0000000000000000000000000000000000000001",
  };
  await assert.rejects(
    () => loadWalletIntelPolymarketMarks(client, [bad]),
    /ledger|storage/,
  );
  // Exact production SELECTs, both prepared-plan modes. No synthetic copy of SQL.
  const captured = new Map<string, readonly unknown[]>();
  const capture = {
    query: async (sql: string, params: readonly unknown[]) => {
      captured.set(sql, params);
      return client.query(sql, params as unknown[]);
    },
  } as unknown as Pick<Pool, "query">;
  await loadWalletIntelPolymarketLedgers(capture, ids.slice(-1000));
  await loadWalletIntelPolymarketMarks(capture, holdings.slice(0, 1000));
  let statement = 0;
  const timings: object[] = [];
  for (const [sql, params] of captured) {
    const name = `enrichment_probe_${statement++}`;
    await client.query(
      `prepare ${name}(${params.map(() => "text[]").join(",")}) as ${sql}`,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      for (const count of [0, 1, 1000]) {
        // EXECUTE arguments cannot contain subqueries: use typed array literals.
        const values = params.map(
          (p) =>
            `array[${(p as string[])
              .slice(0, count)
              .map((v) =>
                v === null ? "null" : `'${String(v).replaceAll("'", "''")}'`,
              )
              .join(",")}]::text[]`,
        );
        const plan = (
          await client.query(
            `explain(analyze,buffers,format json) execute ${name}(${values.join(",")})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const visit = (node: Record<string, unknown>) => {
          if (
            node["Relation Name"] &&
            (Number(node["Actual Rows"]) +
              Number(node["Rows Removed by Filter"] ?? 0)) *
              Number(node["Actual Loops"] ?? 1) >
              10000
          )
            assert.fail(
              `unbounded relation scan ${JSON.stringify({ statement: statement - 1, mode, count, type: node["Node Type"], relation: node["Relation Name"], rows: node["Actual Rows"], removed: node["Rows Removed by Filter"], loops: node["Actual Loops"] })}`,
            );
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        timings.push({
          statement: statement - 1,
          mode,
          count,
          ms: plan["Execution Time"],
          buffers: plan.Plan["Local Hit Blocks"],
        });
      }
    }
  }
  console.log(
    "[enrichment PG16] 56K tokens/two ledgers/generation/partial failure/exact custom+generic SQL",
    JSON.stringify(timings),
  );
  // Actual collector, not just its mark map: one complete >55K portfolio,
  // another pending after SQL failure, plus a healthy unrelated wallet.
  await client.query(`create temp table wallets(id uuid primary key,address text,chain text);
    create temp table wallet_venues(wallet_id uuid,venue text,primary key(wallet_id,venue));
    create temp table wallet_position_snapshots(wallet_id uuid,venue text,market_id text,outcome_side text,shares numeric,size_usd numeric,price numeric,metadata jsonb,snapshot_at timestamptz,unique(wallet_id,venue,market_id,outcome_side,snapshot_at));`);
  const wallets = [1, 2, 3].map((i) => ({
    wallet_id: i.toString().padStart(32, "0"),
    address: `0x${i.toString().padStart(40, "0")}`,
    chain: "polygon" as const,
    venue: "polymarket" as const,
    sources: ["whale" as const],
    priority: 1,
  }));
  for (const wallet of wallets)
    await client.query("insert into wallets values($1,$2,$3)", [
      wallet.wallet_id,
      wallet.address,
      wallet.chain,
    ]);
  const large = wallets[0],
    badWallet = wallets[1],
    small = wallets[2];
  assert.ok(large && badWallet && small);
  const badToken = ids[55000];
  assert.ok(badToken);
  const oldMarket = "polymarket:fixture-27501";
  await client.query(
    "insert into wallet_position_snapshots values($1,'polymarket',$2,'YES',10,4,0.4,'{}',now()-interval '1 hour')",
    [badWallet.wallet_id, oldMarket],
  );
  const faultDb = {
    query: async (sql: string, params: unknown[]) => {
      if (
        sql.includes("resolved_assets as") &&
        (params[0] as string[]).includes(badToken)
      )
        throw Object.assign(Error("offline batch failure"), { code: "57014" });
      return client.query(sql, params);
    },
  } as unknown as Pick<Pool, "query">;
  const priorQueue = env.priceRefreshQueueEnabled;
  env.priceRefreshQueueEnabled = false;
  const priorLog = console.log;
  let batchDiagnostics = 0;
  console.log = (message, ...rest) => {
    if (message === "[wallets:intel:refresh] enrichment batch")
      batchDiagnostics++;
    else priorLog(message, ...rest);
  };
  try {
    const at = new Date();
    const output = await collectAutoTrackedWalletSnapshotRows(faultDb, {
      autoTrackedWallets: wallets,
      previousOpenPositions: [
        {
          wallet_id: badWallet.wallet_id,
          venue: "polymarket",
          market_id: oldMarket,
          outcome_side: "YES",
          token_id: badToken,
          price: "0.4",
        },
      ],
      snapshotAt: at,
      tokenIdsByVenue: { polymarket: [], limitless: [], kalshi: [] },
      tokenIndexByVenue: {
        polymarket: new Map(),
        limitless: new Map(),
        kalshi: new Map(),
      },
      telemetry: {} as never,
      autoTrackedWalletFetchConcurrency: 2,
      touchedWalletIds: new Set(),
      discoverPolymarketPositions: async ({ owner }) => {
        const selected =
          owner === large.address
            ? ids.slice(0, 55000)
            : owner === badWallet.address
              ? ids.slice(55000)
              : ids.slice(0, 1);
        return {
          status: "complete",
          reason: "complete",
          tokens: selected.map((tokenId) => ({ tokenId, averagePrice: null })),
          pages: 1,
          pagesThisSlice: 1,
          discoveredTokens: selected.length,
          elapsedMs: 1,
          resumed: false,
          checkpointAvailable: true,
          retries: 0,
          cursorRestarts: 0,
          httpStatus: null,
          parameter: null,
          traceId: null,
          rateLimitSource: null,
          retryAfterMs: null,
          cfRay: null,
          responseFormat: null,
        };
      },
      scopePolymarketTokens: async (_db, discovered) => ({
        tokenIds: discovered.map((h) => h.tokenId),
        complete: true,
        summary: {
          scope: "hunch_catalog",
          discoveredTokens: discovered.length,
          inScopeTokens: discovered.length,
          skippedOutsideCatalog: 0,
          pendingTokens: 0,
          repairedBindings: 0,
        },
      }),
      readPolymarketBalances: async (_db, input) => {
        const actualLedgers = input.ledgers;
        assert.ok(actualLedgers);
        const current = actualLedgers.find((l) => l.storageContract !== "");
        assert.ok(current);
        return {
          ledgers: actualLedgers,
          balancesByOwner: new Map(
            input.owners.map((owner) => [
              owner,
              Array.from(current.tokenContexts).map(([tokenId, context]) => {
                assert.ok(context);
                return { tokenId, size: "1", assetContext: context };
              }),
            ]),
          ),
        };
      },
    });
    assert.deepEqual(
      output.refreshedWallets.map((w) => w.wallet_id),
      [large.wallet_id, small.wallet_id],
    );
    assert.equal(
      output.previousOpenMarketKeys.length,
      0,
      "pending wallet must not enter zero/exit delta work",
    );
    const written = (
      await client.query(
        "select wallet_id,count(*)::int as count from wallet_position_snapshots where snapshot_at=$1 group by wallet_id order by wallet_id",
        [at],
      )
    ).rows;
    assert.deepEqual(
      written.map((r) => r.count),
      [55000, 1],
    );
    assert.equal(
      (
        await client.query(
          "select shares::text from wallet_position_snapshots where wallet_id=$1",
          [badWallet.wallet_id],
        )
      ).rows[0].shares,
      "10",
    );
    assert.ok(batchDiagnostics > 100);
    priorLog(
      "[collector PG16] 55K complete holdings, unrelated wallet refreshed, failed wallet baseline retained/no exit",
    );
  } finally {
    env.priceRefreshQueueEnabled = priorQueue;
    console.log = priorLog;
  }
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
