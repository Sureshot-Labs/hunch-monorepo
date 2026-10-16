// @requires-db
// Explicit disposable PG16 target only. No provider or financial operations.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  HIP4_HOLDER_RESEARCH_SOURCE_SQL,
  HIP4_HOLDER_RESEARCH_POSITIONS_SQL,
  HIP4_HOLDER_RESEARCH_ACTIVITY_SQL,
  HIP4_HOLDER_RESEARCH_MARKETS_SQL,
} from "./services/holder-research-hip4-known-wallets.js";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
} from "./services/hip4-wallet-intel.js";

type FixtureRow = Record<string, unknown>;
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
type ExplainedPlan = { Plan: PlanNode; "Execution Time": number };

const schemaName = `hip4_holder_research_${randomUUID().replaceAll("-", "")}`;
const pool = await createIntegrationTestPool({
  max: 1,
  options: `-c search_path=${schemaName},public -c statement_timeout=15000`,
});
const client = await pool.connect();
const asOf = new Date("2026-10-16T12:00:00.000Z");
const snapshotAt = new Date(asOf.getTime() - 60_000);
const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const mainMarket = "hyperliquid:mainnet:outcome:41";
const otherMainMarket = "hyperliquid:mainnet:outcome:42";
const testMarket = "hyperliquid:testnet:outcome:41";
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlArray = (values: string[], type: "uuid" | "timestamptz" | "text") =>
  `array[${values.map(literal).join(",")}]::${type}[]`;
const flatten = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(flatten),
];

async function inspectPlan(input: {
  label: string;
  statement: string;
  relationLimits: Record<string, number>;
  requiredIndex?: string;
}) {
  const { rows } = await client.query(
    `explain(analyze,buffers,format json) ${input.statement}`,
  );
  const plan = (rows[0]["QUERY PLAN"] as ExplainedPlan[])[0];
  const nodes = flatten(plan.Plan);
  if (input.requiredIndex) {
    assert(
      nodes.some((node) => node["Index Name"] === input.requiredIndex),
      `${input.label}: expected ${input.requiredIndex}`,
    );
  }
  const related = nodes.filter(
    (node) => String(node["Relation Name"]) in input.relationLimits,
  );
  for (const node of related) {
    const relation = String(node["Relation Name"]);
    assert.notEqual(node["Node Type"], "Seq Scan", input.label);
    const rowsVisited =
      Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0);
    assert(
      rowsVisited <= input.relationLimits[relation],
      `${input.label}: unbounded ${relation} rows=${rowsVisited}`,
    );
  }
  const maximumPageRows = Math.max(1, ...Object.values(input.relationLimits));
  for (const node of nodes.filter((node) => node["Node Type"] === "Hash")) {
    assert(
      Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0) <=
        maximumPageRows,
      `${input.label}: global hash escaped the source page`,
    );
  }
  const buffers =
    Number(plan.Plan["Shared Hit Blocks"] ?? 0) +
    Number(plan.Plan["Shared Read Blocks"] ?? 0);
  assert(buffers <= 256, `${input.label}: shared blocks=${buffers}`);
  console.log(
    "HIP holder-research PG16 plan",
    JSON.stringify({
      case: input.label,
      executionMs: plan["Execution Time"],
      buffers,
      probes: related.map((node) => ({
        table: node["Relation Name"],
        index: node["Index Name"],
        rows: node["Actual Rows"],
        loops: node["Actual Loops"],
      })),
    }),
  );
}

let schemaCreated = false;
try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10_000,
    ),
    16,
  );
  assert.equal(
    (
      await client.query("select to_regnamespace($1) as namespace_oid", [
        schemaName,
      ])
    ).rows[0].namespace_oid,
    null,
  );
  await client.query(`create schema ${schemaName}`);
  schemaCreated = true;
  // Index shapes/names match wallet-intel migrations, not fixture-only indexes.
  await client.query(`
    create table wallets(id uuid primary key,address text,chain text,label text,metadata jsonb);
    create unique index idx_wallets_evm_chain_lower_address on wallets(chain,lower(address)) include(id,address) where chain<>'solana';
    create table wallet_follows(user_id uuid,wallet_id uuid,created_at timestamptz default now());
    create index idx_wallet_follows_wallet_id on wallet_follows(wallet_id);
    create table wallet_tracking_subjects(id uuid primary key default gen_random_uuid(),wallet_id uuid,venue text,source text default 'whale',status text,last_selected_at timestamptz,last_refresh_attempted_at timestamptz,last_refreshed_at timestamptz,unique(wallet_id,venue,source));
    create index idx_wallet_tracking_subjects_wallet on wallet_tracking_subjects(wallet_id,venue);
    create table wallet_venues(id uuid primary key default gen_random_uuid(),wallet_id uuid,venue text,metadata jsonb,updated_at timestamptz,unique(wallet_id,venue));
    create index idx_wallet_venues_wallet on wallet_venues(wallet_id);
    create table wallet_position_snapshots(id uuid primary key default gen_random_uuid(),wallet_id uuid,venue text,market_id text,outcome_side text,shares numeric,size_usd numeric,price numeric,metadata jsonb,snapshot_at timestamptz,created_at timestamptz default now(),unique(wallet_id,venue,market_id,outcome_side,snapshot_at));
    create index idx_wallet_position_snapshots_wallet_venue_time on wallet_position_snapshots(wallet_id,venue,snapshot_at desc);
    create index idx_wallet_position_snapshots_wallet_market_time on wallet_position_snapshots(wallet_id,venue,market_id,snapshot_at desc);
    create table wallet_activity_events(id uuid primary key default gen_random_uuid(),wallet_id uuid,venue text,market_id text,outcome_side text,action text,delta_shares numeric,size_usd numeric,price numeric,activity_type text,source text,source_event_key text,metadata jsonb,occurred_at timestamptz,created_at timestamptz default now());
    create index idx_wallet_activity_events_wallet_time on wallet_activity_events(wallet_id,occurred_at desc);
    create index idx_wallet_activity_events_wallet_type_time on wallet_activity_events(wallet_id,activity_type,occurred_at desc);
    create index idx_wallet_activity_events_wallet_market_time on wallet_activity_events(wallet_id,market_id,outcome_side,occurred_at desc) where activity_type in('delta','trade');
    create unique index uq_wae_source_event on wallet_activity_events(wallet_id,venue,source,source_event_key) where source_event_key is not null;
    create table unified_events(id text primary key,title text,slug text,description text,series_key text,series_title text,category text,status text,end_date timestamptz,metadata jsonb);
    create table unified_markets(id text primary key,event_id text,venue text,title text,slug text,description text,outcomes text,status text,resolved_outcome text,close_time timestamptz,expiration_time timestamptz,best_bid numeric,best_ask numeric,last_price numeric,volume_24h numeric,liquidity numeric,category text,metadata jsonb);
    insert into wallets(id,address,chain,metadata)
      select gen_random_uuid(),'0x'||lpad(to_hex(fixture_wallet.wallet_no),40,'0'),'hypercore:mainnet','{}'
      from generate_series(1,30000) fixture_wallet(wallet_no);
    insert into wallets(id,address,chain,metadata)
      select gen_random_uuid(),'0x'||lpad(to_hex(fixture_wallet.wallet_no),40,'0'),'hypercore:testnet','{}'
      from generate_series(1000001,1100000) fixture_wallet(wallet_no);
    insert into wallet_follows(user_id,wallet_id)
      select gen_random_uuid(),id from wallets where chain='hypercore:testnet';
    insert into wallet_tracking_subjects(wallet_id,venue,status,last_selected_at)
      select id,'hyperliquid','active','2026-10-16T12:00:00Z' from wallets where chain='hypercore:testnet';
    insert into wallet_venues(wallet_id,venue,metadata,updated_at)
      select id,'hyperliquid','{}','2026-10-16T12:00:00Z' from wallets where chain='hypercore:testnet';
    insert into unified_events(id,title,status,metadata)
      select 'unrelated-event-'||fixture_event.event_no,'Unrelated event','ACTIVE','{}'
      from generate_series(1000001,1100000) fixture_event(event_no);
    insert into unified_markets(id,event_id,venue,title,outcomes,status,metadata)
      select 'hyperliquid:testnet:outcome:'||fixture_market.market_no,'unrelated-event-'||fixture_market.market_no,'hyperliquid','Unrelated market','["Yes","No"]','ACTIVE','{}'
      from generate_series(1000001,1100000) fixture_market(market_no);
    insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,shares,size_usd,price,metadata,snapshot_at)
      select id,'hyperliquid','unrelated-position','YES',1,0.5,0.5,'{}','2026-10-16T11:59:00Z'
      from wallets where chain='hypercore:testnet';
    insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,action,delta_shares,size_usd,price,activity_type,source,source_event_key,metadata,occurred_at)
      select id,'hyperliquid','unrelated-activity','YES','BUY',1,0.5,0.5,'trade','hyperliquid_user_fills','unrelated-native-fill','{}','2026-10-16T11:59:59Z'
      from wallets where chain='hypercore:testnet';
  `);
  const mainWallets = (
    await client.query<{ id: string; address: string }>(
      "select id,address from wallets where chain='hypercore:mainnet' and address=any($1::text[]) order by address",
      [[address(1), address(2)]],
    )
  ).rows;
  assert.equal(mainWallets.length, 2);
  const [firstWallet, fanoutWallet] = mainWallets;
  const testWalletId = randomUUID();
  await client.query(
    "insert into wallets(id,address,chain,metadata) values($1,$2,'hypercore:testnet','{}')",
    [testWalletId, firstWallet.address],
  );
  await client.query(
    "insert into wallet_follows(user_id,wallet_id) values($1,$2)",
    [randomUUID(), firstWallet.id],
  );
  await client.query(
    "insert into wallet_follows(user_id,wallet_id) select $1,id from wallets where chain='hypercore:mainnet' and address=$2",
    [randomUUID(), address(29999)],
  );
  await client.query(
    "insert into wallet_tracking_subjects(wallet_id,venue,status,last_selected_at) values($1,'hyperliquid','active',$2)",
    [fanoutWallet.id, asOf],
  );
  await client.query(
    "insert into wallet_tracking_subjects(wallet_id,venue,status,last_selected_at) select id,'hyperliquid','active',$1::timestamptz-interval '31 days' from wallets where chain='hypercore:mainnet' and address=$2",
    [asOf, address(29998)],
  );
  for (const wallet of mainWallets) {
    await client.query(
      "insert into wallet_venues(wallet_id,venue,metadata,updated_at) values($1,'hyperliquid',$2::jsonb,$3)",
      [
        wallet.id,
        JSON.stringify({
          hip4Intel: {
            lastCompletePositionsAt: snapshotAt.toISOString(),
            coverage: {
              scope: "known_wallet_only",
              environment: "mainnet",
              chain: "hypercore:mainnet",
              accountAddress: wallet.address,
              historicalPerformance: { status: "unavailable" },
              globalHolders: { status: "unavailable" },
            },
          },
        }),
        asOf,
      ],
    );
  }
  for (const [marketId, environment] of [
    [mainMarket, "mainnet"],
    [otherMainMarket, "mainnet"],
    [testMarket, "testnet"],
  ] as const) {
    const eventId = `fixture-event-${environment}-${marketId}`;
    await client.query(
      "insert into unified_events(id,title,status,metadata) values($1,$2,'ACTIVE','{}')",
      [eventId, `Exact ${environment} event`],
    );
    await client.query(
      "insert into unified_markets(id,event_id,venue,title,outcomes,status,close_time,best_bid,best_ask,last_price,metadata) values($1,$2,'hyperliquid',$3,'[\"Yes\",\"No\"]','ACTIVE',$4,0.4,0.5,0.45,$5::jsonb)",
      [
        marketId,
        eventId,
        `Exact ${environment} market`,
        new Date(asOf.getTime() + 86_400_000),
        JSON.stringify({ environment }),
      ],
    );
  }
  for (const [at, shares] of [
    [new Date(asOf.getTime() - 7_200_000), "123"],
    [snapshotAt, "8"],
    [new Date(asOf.getTime() - 30_000), "99"],
  ] as const) {
    await client.query(
      "insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,shares,size_usd,price,metadata,snapshot_at) values($1,'hyperliquid',$2,'YES',$3,4,0.5,$4::jsonb,$5)",
      [
        firstWallet.id,
        mainMarket,
        shares,
        JSON.stringify({
          source: "hip4_known_wallet",
          tokenId: "hyperliquid:mainnet:410",
          costBasis: "unknown",
        }),
        at,
      ],
    );
  }
  await client.query(
    "insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,shares,metadata,snapshot_at) values($1,'hyperliquid',$2,'NO',9,'{\"source\":\"foreign_snapshot\"}',$3),($4,'hyperliquid',$5,'YES',500,'{}',$3),($1,'polymarket','wrong-venue','YES',700,'{}',$3)",
    [firstWallet.id, otherMainMarket, snapshotAt, testWalletId, testMarket],
  );
  await client.query(
    "insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,shares,size_usd,price,metadata,snapshot_at) select $1,'hyperliquid','fanout-position-'||fixture_position.position_no,'YES',1,0.5,0.5,'{}',$2 from generate_series(1,1000) fixture_position(position_no)",
    [fanoutWallet.id, snapshotAt],
  );
  const tiedKeys: string[] = [];
  for (let tradeId = 200; tradeId < 205; tradeId++) {
    const parsed = normalizeHip4KnownWalletFill({
      identity: hip4WalletIntelIdentity("mainnet", firstWallet.address),
      observedAt: asOf.toISOString(),
      quoteTokensByMarket: new Map([[mainMarket, "USDC"]]),
      value: {
        coin: "#410",
        px: "0.5",
        sz: "8",
        side: "B",
        time: asOf.getTime() - 1000,
        startPosition: "0",
        dir: "Buy",
        closedPnl: "0",
        hash: `0x${"1".repeat(64)}`,
        oid: 100,
        crossed: true,
        fee: "0",
        tid: tradeId,
        feeToken: "USDC",
      },
    });
    assert.equal(parsed.kind, "trade");
    if (parsed.kind !== "trade") throw new Error("fixture native fill missing");
    const fill = parsed.activity;
    tiedKeys.push(fill.sourceEventKey);
    await client.query(
      "insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,action,delta_shares,size_usd,price,activity_type,source,source_event_key,metadata,occurred_at) values($1,'hyperliquid',$2,'YES','BUY',8,4,0.5,'trade','hyperliquid_user_fills',$3,$4::jsonb,$5)",
      [
        firstWallet.id,
        mainMarket,
        fill.sourceEventKey,
        JSON.stringify({
          scope: "known_wallet_only",
          nativeFingerprint: hip4TrackedFillFingerprint(fill),
          nativeRecheck: {
            version: 1,
            provenance: "fresh_official_user_fills",
            state: "verified",
            sourceEventKey: fill.sourceEventKey,
            retainedFingerprint: hip4TrackedFillFingerprint(fill),
            lastObservedFingerprint: hip4TrackedFillFingerprint(fill),
            observationId: "synthetic-fresh-provider-observation",
            observationStartedAtMs: asOf.getTime() - 100,
            checkedAtMs: asOf.getTime(),
            conflictObservationId: null,
            conflictAtMs: null,
          },
          nativeFill: fill,
          completeHistory: false,
          costBasis: "unknown",
        }),
        fill.occurredAt,
      ],
    );
  }
  await client.query(
    "insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,action,activity_type,source,metadata,occurred_at) values($1,'hyperliquid',$2,'YES','INCREASED','delta','snapshot_delta','{}',$3),($1,'hyperliquid',$2,'YES','BUY','trade','hyperliquid_user_fills','{}',$4),($1,'hyperliquid',$2,'YES','BUY','trade','hyperliquid_user_fills','{}',$5),($6,'hyperliquid',$7,'YES','BUY','trade','hyperliquid_user_fills','{}',$3)",
    [
      firstWallet.id,
      mainMarket,
      new Date(asOf.getTime() - 500),
      new Date(asOf.getTime() + 1),
      new Date(asOf.getTime() - 25 * 3_600_000),
      testWalletId,
      testMarket,
    ],
  );
  await client.query(
    "insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,action,delta_shares,size_usd,price,activity_type,source,source_event_key,metadata,occurred_at) select $1,'hyperliquid',$2,'YES','BUY',1,0.5,0.5,'trade','hyperliquid_user_fills','fanout-native-'||fixture_fill.fill_no,'{}',$3::timestamptz-fixture_fill.fill_no*interval '1 millisecond' from generate_series(1,1000) fixture_fill(fill_no)",
    [fanoutWallet.id, otherMainMarket, new Date(asOf.getTime() - 10_000)],
  );
  await client.query(`
    analyze wallets; analyze wallet_follows; analyze wallet_tracking_subjects;
    analyze wallet_venues; analyze wallet_position_snapshots;
    analyze wallet_activity_events; analyze unified_markets; analyze unified_events;
    set plan_cache_mode=force_generic_plan;
  `);
  await client.query(
    `prepare hip4_holder_source(text,text,integer,timestamptz,integer) as ${HIP4_HOLDER_RESEARCH_SOURCE_SQL}`,
  );
  await client.query(
    `prepare hip4_holder_positions(uuid[],timestamptz[],integer) as ${HIP4_HOLDER_RESEARCH_POSITIONS_SQL}`,
  );
  await client.query(
    `prepare hip4_holder_activity(uuid[],timestamptz,numeric,integer) as ${HIP4_HOLDER_RESEARCH_ACTIVITY_SQL}`,
  );
  await client.query(
    `prepare hip4_holder_markets(text[]) as ${HIP4_HOLDER_RESEARCH_MARKETS_SQL}`,
  );

  for (const [label, after, expected] of [
    ["first", "", [address(1), address(2)]],
    ["resumed_sparse", address(29995), [address(29996), address(29997)]],
    ["resumed_ttl", address(29997), [address(29998), address(29999)]],
    ["empty_tail", address(30000), []],
  ] as const) {
    const statement = `execute hip4_holder_source('hypercore:mainnet',${literal(after)},2,${literal(asOf.toISOString())},30)`;
    const page = (await client.query<FixtureRow>(statement)).rows;
    assert.deepEqual(
      page.map((row) => row.address),
      expected,
    );
    assert(page.every((row) => row.wallet_id !== testWalletId));
    if (label === "first") {
      assert.equal(page[0].followed, true);
      assert.equal(page[1].tracked, true);
    }
    if (label === "resumed_sparse") {
      assert(
        page.every((row) => row.followed === false && row.tracked === false),
      );
    }
    if (label === "resumed_ttl") {
      assert.equal(page[0].tracked, false);
      assert.equal(page[1].followed, true);
    }
    await inspectPlan({
      label: `source_${label}`,
      statement,
      relationLimits: {
        wallets: 2,
        wallet_follows: 2,
        wallet_tracking_subjects: 2,
        wallet_venues: 2,
      },
      requiredIndex: "idx_wallets_evm_chain_lower_address",
    });
  }
  const walletIds = mainWallets.map((wallet) => wallet.id);
  const positionStatement = `execute hip4_holder_positions(${sqlArray(walletIds, "uuid")},${sqlArray(
    walletIds.map(() => snapshotAt.toISOString()),
    "timestamptz",
  )},3)`;
  const positions = (await client.query<FixtureRow>(positionStatement)).rows;
  assert.equal(
    positions.filter((row) => row.wallet_id === firstWallet.id).length,
    2,
  );
  assert.equal(
    positions.filter((row) => row.wallet_id === fanoutWallet.id).length,
    3,
  );
  assert(positions.every((row) => walletIds.includes(String(row.wallet_id))));
  assert(
    positions.every(
      (row) =>
        new Date(String(row.snapshot_at)).getTime() === snapshotAt.getTime(),
    ),
  );
  assert(
    positions.every(
      (row) => row.market_id !== testMarket && row.market_id !== "wrong-venue",
    ),
  );
  assert.equal(
    Number(positions.find((row) => row.market_id === mainMarket)?.shares),
    8,
  );
  // Sparse provenance is returned inside the raw cap for the pure projector;
  // SQL must not scan more source rows until enough usable positions appear.
  assert(
    positions.some(
      (row) => (row.metadata as FixtureRow)?.source === "foreign_snapshot",
    ),
  );
  await inspectPlan({
    label: "exact_snapshot_and_position_fanout",
    statement: positionStatement,
    relationLimits: { wallet_position_snapshots: 6 },
  });
  const activityStatement = `execute hip4_holder_activity(${sqlArray(walletIds, "uuid")},${literal(asOf.toISOString())},24,3)`;
  const activities = (await client.query<FixtureRow>(activityStatement)).rows;
  assert(activities.length <= 6);
  assert.equal(
    activities.filter((row) => row.wallet_id === fanoutWallet.id).length,
    3,
  );
  assert(activities.every((row) => walletIds.includes(String(row.wallet_id))));
  assert(activities.every((row) => row.market_id !== testMarket));
  assert(
    activities.every((row) => {
      const time = new Date(String(row.occurred_at)).getTime();
      return time <= asOf.getTime() && time >= asOf.getTime() - 24 * 3_600_000;
    }),
  );
  const native = activities.filter(
    (row) =>
      row.wallet_id === firstWallet.id &&
      row.source === "hyperliquid_user_fills",
  );
  // The newer snapshot delta consumes one raw page slot, never a native fill.
  assert.equal(native.length, 2);
  assert.equal(new Set(native.map((row) => row.source_event_key)).size, 2);
  assert(
    native.every((row) => tiedKeys.includes(String(row.source_event_key))),
  );
  for (const row of native) {
    const fill = (row.metadata as FixtureRow).nativeFill as FixtureRow;
    assert.equal(fill.marketId, mainMarket);
    assert.equal(fill.outcomeSide, "YES");
    assert.equal(fill.action, "BUY");
    assert.equal(fill.deltaShares, "8");
    assert.equal((fill.identity as FixtureRow).environment, "mainnet");
    assert.equal((row.metadata as FixtureRow).completeHistory, false);
  }
  await inspectPlan({
    label: "raw_activity_cap_sparse_native_ties",
    statement: activityStatement,
    relationLimits: { wallet_activity_events: 6 },
  });
  const marketStatement = `execute hip4_holder_markets(${sqlArray([mainMarket, otherMainMarket], "text")})`;
  const markets = (await client.query<FixtureRow>(marketStatement)).rows;
  assert.equal(markets.length, 2);
  assert.deepEqual(
    new Set(markets.map((row) => row.market_id ?? row.id)),
    new Set([mainMarket, otherMainMarket]),
  );
  assert(!JSON.stringify(markets).includes("Exact testnet"));
  await inspectPlan({
    label: "exact_market_and_event_primary_keys",
    statement: marketStatement,
    relationLimits: { unified_markets: 2, unified_events: 2 },
  });
  const emptyMarkets = await client.query(HIP4_HOLDER_RESEARCH_MARKETS_SQL, [
    [],
  ]);
  assert.equal(emptyMarkets.rows.length, 0);
  console.log(
    "HIP holder-research PG16 source continuation, sparse pages, native tied fills, exact snapshots, environment isolation and bounded generic plans passed",
  );
} finally {
  try {
    if (schemaCreated) await client.query(`drop schema ${schemaName} cascade`);
  } finally {
    client.release();
    await pool.end();
  }
}
