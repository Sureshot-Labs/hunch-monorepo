// @requires-db
// Disposable PG16 only. No real provider, wallet, ownership or financial action.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  collectHip4KnownWalletIntel,
  HIP4_ACTIVITY_SCHEMA_READY_SQL,
  HIP4_KNOWN_WALLET_SOURCE_SQL,
  HIP4_KNOWN_WALLET_METADATA_SQL,
  HIP4_TRACKED_ACTIVITY_UPSERT_SQL,
  persistHip4TrackedActivity,
} from "./services/hip4-wallet-intel-refresh.js";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
} from "./services/hip4-wallet-intel.js";
import { hip4TrackedActivityFlowProof } from "./services/hip4-wallet-intel-recheck.js";

const schemaName = `hip4_wallet_intel_${randomUUID().replaceAll("-", "")}`;
const pool = await createIntegrationTestPool({
  max: 3,
  options: `-c search_path=${schemaName},public -c statement_timeout=15000`,
});
const client = await pool.connect();
const migration = async (name: string) =>
  readFile(
    new URL(`../../../packages/db/migrations/${name}`, import.meta.url),
    "utf8",
  );
const concurrent = async (sql: string) => {
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean))
    await client.query(statement);
};
const address = (number: number) =>
  `0x${number.toString(16).padStart(40, "0")}`;
let schemaCreated = false;
try {
  const version = await client.query(
    "select current_setting('server_version_num')::int as version_num",
  );
  assert(
    version.rows[0].version_num >= 160000 &&
      version.rows[0].version_num < 170000,
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
  await client.query(`
    create table wallets(id uuid primary key,address text,chain text,metadata jsonb);
    create unique index idx_wallets_evm_chain_lower_address on wallets(chain,lower(address)) include(id,address) where chain<>'solana';
    create table wallet_follows(user_id uuid,wallet_id uuid,created_at timestamptz default now());
    create table wallet_tracking_subjects(wallet_id uuid,venue text constraint wallet_tracking_subjects_venue_check check(venue in('polymarket','limitless','kalshi')),status text,last_selected_at timestamptz,last_refresh_attempted_at timestamptz,last_refreshed_at timestamptz);
    create index subject_wallet on wallet_tracking_subjects(wallet_id,venue);
    create table wallet_venues(wallet_id uuid,venue text,metadata jsonb,updated_at timestamptz,unique(wallet_id,venue));
    create table wallet_activity_events(id uuid default gen_random_uuid(),wallet_id uuid,venue text,market_id text,outcome_side text,action text,delta_shares numeric,size_usd numeric,price numeric,activity_type text,source text,metadata jsonb,occurred_at timestamptz,
      constraint uq_wae_wallet_venue_market_side_type_occurred unique(wallet_id,venue,market_id,outcome_side,activity_type,occurred_at));
    create table wallet_position_snapshots(wallet_id uuid,venue text,market_id text,outcome_side text,shares numeric,size_usd numeric,price numeric,metadata jsonb,snapshot_at timestamptz,unique(wallet_id,venue,market_id,outcome_side,snapshot_at));
    create table unified_refresh_pipeline_state(pipeline_name text primary key,updated_at timestamptz default now());
    create table hip4_read_markets(environment text,outcome bigint,read_model jsonb,unique(environment,outcome));
    create table hip4_request_budget(scope text primary key,admissions jsonb);
    create table runtime_policies(id uuid,policy_key text,effective_at timestamptz,payload jsonb,created_by uuid,created_by_admin_id uuid,created_at timestamptz default now());
  `);
  const stage = await migration(
    "0344_wallet_activity_source_event_indexes.sql",
  );
  const finalize = await migration(
    "0345_wallet_activity_source_event_finalize.sql",
  );
  await client.query(await migration("0343_hip4_wallet_tracking_subjects.sql"));
  await client.query(stage.split(";")[0]);
  await client.query(finalize);
  assert.equal(
    (await client.query(HIP4_ACTIVITY_SCHEMA_READY_SQL)).rows[0].ready,
    false,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as total from pg_constraint where conrelid='wallet_activity_events'::regclass and conname='uq_wae_wallet_venue_market_side_type_occurred'",
      )
    ).rows[0].total,
    1,
  );
  // Interrupted stage with one valid index, followed by idempotent resumption.
  await client.query(stage.split(";")[1]);
  await concurrent(stage);
  await concurrent(stage);
  await concurrent(await migration("0346_hip4_wallet_intel_source_cursor.sql"));

  await client.query(
    `insert into wallets select gen_random_uuid(),'0x'||lpad(to_hex(wallet_no),40,'0'),'hypercore:mainnet','{}'::jsonb from generate_series(1,30000) fixture_wallet(wallet_no)`,
  );
  // Related tables must be independently large: a two-row source LIMIT does
  // not prove bounded work if PostgreSQL hashes all follows/subjects/venues.
  await client.query(
    `insert into wallets select gen_random_uuid(),'0x'||lpad(to_hex(wallet_no),40,'0'),'hypercore:testnet','{}'::jsonb from generate_series(1000001,1100000) fixture_wallet(wallet_no)`,
  );
  await client.query(
    `insert into wallet_follows(user_id,wallet_id) select gen_random_uuid(),id from wallets where chain='hypercore:testnet'`,
  );
  await client.query(
    `insert into wallet_tracking_subjects(wallet_id,venue,status,last_selected_at) select id,'hyperliquid','active',now() from wallets where chain='hypercore:testnet'`,
  );
  await client.query(
    `insert into wallet_venues(wallet_id,venue,metadata,updated_at) select id,'hyperliquid','{}'::jsonb,now() from wallets where chain='hypercore:testnet'`,
  );
  const subject = (
    await client.query("select id from wallets where address=$1", [address(1)])
  ).rows[0].id as string;
  await client.query(
    "insert into wallet_follows(user_id,wallet_id) values($1,$2)",
    [randomUUID(), subject],
  );
  await client.query(
    "insert into wallet_follows(user_id,wallet_id) select $1,id from wallets where address=$2",
    [randomUUID(), address(29999)],
  );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  for (const [key, payload] of [
    ["venue_lifecycle", lifecycle],
    ["hip4_read", { requestWeightPerMinute: 1200 }],
    ["hip4_account", { historyRepairPagesPerRefresh: 1 }],
  ] as const)
    await client.query(
      "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,$2,now()-interval '1 second',$3::jsonb)",
      [randomUUID(), key, JSON.stringify(payload)],
    );
  const now = Date.now();
  const fill = (tid: number) => ({
    coin: "#410",
    px: "0.125",
    sz: "8",
    side: "B",
    time: now - 1000,
    startPosition: "0",
    dir: "Buy",
    closedPnl: "0",
    hash: `0x${"1".repeat(64)}`,
    oid: 100,
    crossed: true,
    fee: "0",
    tid,
    feeToken: "USDC",
  });
  const requests: string[] = [];
  let observedFills: unknown[] = [fill(200), fill(201)];
  let fillsTransportFailure = false;
  const fetcher = async (_url: unknown, options?: RequestInit) => {
    const request = JSON.parse(String(options?.body));
    requests.push(request.type);
    if (request.type === "userFills" && fillsTransportFailure)
      throw new TypeError("synthetic transport failure");
    const responses: Record<string, unknown> = {
      spotMeta: {
        tokens: [
          {
            name: "USDC",
            index: 0,
            tokenId: "synthetic-usdc",
            weiDecimals: 8,
            szDecimals: 8,
          },
        ],
      },
      userRole: { role: "user" },
      userAbstraction: "disabled",
      spotClearinghouseState: {
        balances: [{ coin: "+410", total: "8", hold: "0", entryNtl: "1" }],
      },
      frontendOpenOrders: [],
      userFills: observedFills,
      userFillsByTime: [],
    };
    assert(request.type in responses);
    return Response.json(responses[request.type]);
  };
  const policy = {
    followedWalletLimit: 2,
    autoTrackedWalletEnabled: false,
    autoTrackedWalletLimit: 0,
    autoTrackedSubjectTtlDays: 30,
    autoTrackedWalletAttemptBackoffMinutes: 1,
    autoTrackedWalletRefreshHours: 1,
    snapshotHours: 1,
  };
  const partial = await collectHip4KnownWalletIntel({
    pool,
    client,
    policy,
    snapshotAt: new Date(now),
    fetcher,
  });
  assert.equal(partial.activitySchemaReady, false);
  assert.equal(partial.snapshotRows, 1);
  assert(!requests.includes("userFills"));
  await client.query(finalize);
  await client.query(finalize);
  assert.equal(
    (await client.query(HIP4_ACTIVITY_SCHEMA_READY_SQL)).rows[0].ready,
    true,
  );
  await client.query(
    "update wallet_venues set metadata='{}'::jsonb,updated_at='2000-01-01' where wallet_id=$1",
    [subject],
  );
  await client.query(
    "update unified_refresh_pipeline_state set source_cursor='{}'::jsonb",
  );
  const captured = await collectHip4KnownWalletIntel({
    pool,
    client,
    policy,
    snapshotAt: new Date(now + 1),
    fetcher,
  });
  assert.equal(captured.activityRows, 2);
  assert.equal(
    (
      await client.query(
        "select count(*)::int as total from wallet_activity_events where wallet_id=$1",
        [subject],
      )
    ).rows[0].total,
    2,
  );
  const identity = hip4WalletIntelIdentity("mainnet", address(1));
  const freshObservation = () => ({
    provenance: "fresh_official_user_fills" as const,
    observationId: randomUUID(),
    observationStartedAtMs: Date.now(),
  });
  const native = normalizeHip4KnownWalletFill({
    identity,
    value: fill(200),
    observedAt: new Date(now).toISOString(),
  });
  assert.equal(native.kind, "trade");
  if (native.kind !== "trade")
    throw new Error("synthetic native trade missing");
  assert.equal(
    (
      await persistHip4TrackedActivity(
        client,
        subject,
        native.activity,
        freshObservation(),
      )
    ).saved,
    true,
  );
  assert.equal(
    (
      await persistHip4TrackedActivity(
        client,
        subject,
        {
          ...native.activity,
          price: "0.25",
        },
        freshObservation(),
      )
    ).conflict,
    true,
  );
  assert.equal(
    (
      await client.query(
        "select price::text from wallet_activity_events where source_event_key=$1",
        [native.activity.sourceEventKey],
      )
    ).rows[0].price,
    "0.125",
  );
  const retained = async () =>
    (
      await client.query(
        "select * from wallet_activity_events where wallet_id=$1 and source='hyperliquid_user_fills' and source_event_key=$2",
        [subject, native.activity.sourceEventKey],
      )
    ).rows[0];
  const original = await retained();
  assert.equal(original.metadata.nativeRecheck.state, "disputed");
  const refresh = async () => {
    // Independent synthetic scheduler cycles; do not consume one minute's real
    // request budget repeatedly merely to exercise fixture recovery paths.
    await client.query("delete from hip4_request_budget");
    await client.query(
      "update wallet_venues set updated_at='2000-01-01' where wallet_id=$1",
      [subject],
    );
    await client.query(
      "update unified_refresh_pipeline_state set source_cursor='{}'::jsonb",
    );
    return collectHip4KnownWalletIntel({
      pool,
      client,
      policy: {
        ...policy,
        snapshotHours: 0,
        autoTrackedWalletAttemptBackoffMinutes: 0,
      },
      snapshotAt: new Date(Date.now() + 1000),
      fetcher,
    });
  };
  observedFills = [];
  assert((await refresh()).snapshotRows > 0);
  assert.equal((await retained()).metadata.nativeRecheck.state, "disputed");
  observedFills = [fill(203)];
  await refresh();
  assert.equal((await retained()).metadata.nativeRecheck.state, "disputed");
  fillsTransportFailure = true;
  await refresh();
  fillsTransportFailure = false;
  assert.equal((await retained()).metadata.nativeRecheck.state, "disputed");
  observedFills = [
    fill(200),
    { ...fill(200), px: "0.25" },
    fill(200),
    fill(203),
  ];
  assert.equal((await refresh()).fillConflicts, 1);
  assert.equal((await retained()).metadata.nativeRecheck.state, "disputed");
  observedFills = [fill(200)];
  assert.equal((await refresh()).fillConflicts, 0);
  const recovered = await retained();
  assert.equal(recovered.metadata.nativeRecheck.state, "verified");
  assert.equal(
    hip4TrackedActivityFlowProof({
      metadata: recovered.metadata,
      sourceEventKey: native.activity.sourceEventKey,
    }),
    "eligible",
  );
  for (const column of [
    "market_id",
    "outcome_side",
    "action",
    "delta_shares",
    "size_usd",
    "price",
    "occurred_at",
  ])
    assert.deepEqual(recovered[column], original[column]);
  assert.deepEqual(recovered.metadata.nativeFill, original.metadata.nativeFill);
  assert.equal(
    recovered.metadata.nativeFingerprint,
    original.metadata.nativeFingerprint,
  );

  // Current DB metadata, not the pre-provider subject snapshot, preserves the
  // legacy ambiguity diagnostic even when the new batch has no conflicts.
  await client.query(
    'update wallet_venues set metadata=\'{"hip4Intel":{"activityPersistence":"conflicting_fill_identity"}}\' where wallet_id=$1',
    [subject],
  );
  await client.query(HIP4_KNOWN_WALLET_METADATA_SQL, [
    subject,
    JSON.stringify({
      activityConflictVersion: 1,
      activityPersistence: "available",
    }),
    new Date(),
  ]);
  assert.equal(
    (
      await client.query(
        "select metadata#>>'{hip4Intel,legacyActivityAmbiguity}' as ambiguity from wallet_venues where wallet_id=$1",
        [subject],
      )
    ).rows[0].ambiguity,
    "true",
  );
  await client.query(HIP4_KNOWN_WALLET_METADATA_SQL, [
    subject,
    JSON.stringify({
      activityConflictVersion: 1,
      activityPersistence: "available",
    }),
    new Date(),
  ]);
  assert.equal(
    (
      await client.query(
        "select metadata#>>'{hip4Intel,legacyActivityAmbiguity}' as ambiguity from wallet_venues where wallet_id=$1",
        [subject],
      )
    ).rows[0].ambiguity,
    "true",
  );

  // A matching response already in flight cannot clear a later dispute. The
  // second connection holds the row until that stale upsert is submitted.
  const staleObservation = freshObservation();
  const concurrentClient = await pool.connect();
  try {
    await concurrentClient.query("begin");
    assert.equal(
      (
        await persistHip4TrackedActivity(
          concurrentClient,
          subject,
          { ...native.activity, price: "0.25" },
          freshObservation(),
        )
      ).conflict,
      true,
    );
    const staleWrite = persistHip4TrackedActivity(
      client,
      subject,
      native.activity,
      staleObservation,
    );
    await concurrentClient.query("commit");
    assert.equal((await staleWrite).conflict, true);
  } finally {
    concurrentClient.release();
  }
  assert.equal((await retained()).metadata.nativeRecheck.state, "disputed");
  observedFills = [fill(200)];
  await refresh();
  assert.equal((await retained()).metadata.nativeRecheck.state, "verified");

  // An old unversioned row, even with a previously erased wallet flag, needs a
  // fresh exact-key reread; an unrelated batch is not historical proof.
  await client.query(
    "update wallet_activity_events set metadata=metadata-'nativeRecheck' where wallet_id=$1 and source_event_key<>$2",
    [subject, native.activity.sourceEventKey],
  );
  const legacyNative = (
    await client.query(
      "select source_event_key,metadata from wallet_activity_events where wallet_id=$1 and source_event_key<>$2 limit 1",
      [subject, native.activity.sourceEventKey],
    )
  ).rows[0];
  assert.equal(
    hip4TrackedActivityFlowProof({
      metadata: legacyNative.metadata,
      sourceEventKey: legacyNative.source_event_key,
    }),
    "legacy_ambiguous",
  );
  observedFills = [];
  await refresh();
  const stillLegacy = (
    await client.query(
      "select metadata from wallet_activity_events where wallet_id=$1 and source_event_key=$2",
      [subject, legacyNative.source_event_key],
    )
  ).rows[0];
  assert.equal(
    hip4TrackedActivityFlowProof({
      metadata: stillLegacy.metadata,
      sourceEventKey: legacyNative.source_event_key,
    }),
    "legacy_ambiguous",
  );
  observedFills = [fill(201), fill(203)];
  await refresh();
  assert.equal(
    (
      await client.query(
        "select metadata#>>'{nativeRecheck,state}' as proof_state from wallet_activity_events where wallet_id=$1 and source_event_key=$2",
        [subject, legacyNative.source_event_key],
      )
    ).rows[0].proof_state,
    "verified",
  );
  const legacy = `insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,activity_type,source,occurred_at,price) values($1,'polymarket','legacy','YES','trade','legacy',$2,0.5)
    on conflict(wallet_id,venue,market_id,outcome_side,activity_type,occurred_at) where source_event_key is null do update set price=excluded.price`;
  await client.query(legacy, [subject, new Date(now)]);
  await client.query(legacy, [subject, new Date(now)]);
  assert.equal(
    (
      await client.query(
        "select count(*)::int as total from wallet_activity_events where source='legacy'",
      )
    ).rows[0].total,
    1,
  );
  await client.query(`insert into wallet_activity_events(wallet_id,venue,market_id,outcome_side,action,delta_shares,price,activity_type,source,source_event_key,metadata,occurred_at)
    select gen_random_uuid(),'hyperliquid','unrelated:'||fixture_event.event_no,'YES','BUY',1,0.5,'trade','hyperliquid_user_fills','unrelated:'||fixture_event.event_no,'{}',now()
    from generate_series(1,100000) fixture_event(event_no)`);
  await client.query("analyze wallet_activity_events");
  await client.query("set plan_cache_mode=force_generic_plan");
  // Force generic parameter plans for the actual new atomic upsert at scale.
  // EXPLAIN ANALYZE mutates only this isolated disposable fixture row's proof.
  for (const replay of [false, true]) {
    const observation = freshObservation();
    const explanation = (
      await client.query({
        name: "hip4_native_recheck_plan",
        text: `explain(analyze,buffers,format json) ${HIP4_TRACKED_ACTIVITY_UPSERT_SQL}`,
        values: [
          subject,
          native.activity.marketId,
          native.activity.outcomeSide,
          native.activity.action,
          native.activity.deltaShares,
          native.activity.sizeUsd,
          native.activity.price,
          native.activity.sourceEventKey,
          JSON.stringify({
            nativeFingerprint: hip4TrackedFillFingerprint(native.activity),
            nativeFill: native.activity,
          }),
          native.activity.occurredAt,
          observation.observationId,
          observation.observationStartedAtMs,
          false,
          null,
        ],
      })
    ).rows[0]["QUERY PLAN"][0];
    assert(JSON.stringify(explanation).includes("uq_wae_source_event"));
    const buffers =
      Number(explanation.Plan["Shared Hit Blocks"] ?? 0) +
      Number(explanation.Plan["Shared Read Blocks"] ?? 0);
    assert(buffers < 128);
    console.log(
      "HIP event-local recheck PG16 plan",
      JSON.stringify({
        replay,
        buffers,
        executionMs: explanation["Execution Time"],
      }),
    );
  }
  await client.query(
    "analyze wallets; analyze wallet_follows; analyze wallet_tracking_subjects; analyze wallet_venues",
  );
  await client.query("set plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare hip4_source_page(text,text,integer,timestamptz,integer) as ${HIP4_KNOWN_WALLET_SOURCE_SQL}`,
  );
  for (const after of ["", address(29995), address(29997), address(30000)]) {
    const plan = (
      await client.query(
        `explain(analyze,buffers,format json) execute hip4_source_page('hypercore:mainnet','${after}',2,now(),30)`,
      )
    ).rows[0]["QUERY PLAN"];
    assert(
      JSON.stringify(plan).includes("idx_wallets_evm_chain_lower_address"),
    );
    const flatten = (
      node: Record<string, unknown>,
    ): Record<string, unknown>[] => [
      node,
      ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(flatten),
    ];
    const nodes = flatten(plan[0].Plan);
    const related = nodes.filter((node) =>
      ["wallet_follows", "wallet_tracking_subjects", "wallet_venues"].includes(
        String(node["Relation Name"]),
      ),
    );
    for (const node of related) {
      assert.notEqual(
        node["Node Type"],
        "Seq Scan",
        String(node["Relation Name"]),
      );
      assert(
        Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 2,
        `related reads must stay inside the two-wallet page: ${JSON.stringify(node)}`,
      );
    }
    // Four short B-tree/heap probes per wallet, with ample height/cache margin.
    // A global related-table hash/scan at 100k rows exceeds this page budget.
    const buffers =
      Number(plan[0].Plan["Shared Hit Blocks"] ?? 0) +
      Number(plan[0].Plan["Shared Read Blocks"] ?? 0);
    assert(
      buffers <= 64 * (2 + 1),
      `two-wallet source page consumed ${buffers} shared blocks`,
    );
    console.log(
      "HIP known-wallet PG16 source plan",
      JSON.stringify({
        after,
        buffers,
        executionMs: plan[0]["Execution Time"],
        related: related.map((node) => ({
          table: node["Relation Name"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
        })),
        plan,
      }),
    );
  }
  await client.query(
    "update unified_refresh_pipeline_state set source_cursor=$1::jsonb",
    [JSON.stringify({ lastAddress: address(30000) })],
  );
  const empty = await collectHip4KnownWalletIntel({
    pool,
    client,
    policy,
    snapshotAt: new Date(),
    fetcher,
  });
  assert.equal(empty.selected, 0);
  assert.deepEqual(
    (
      await client.query(
        "select source_cursor from unified_refresh_pipeline_state",
      )
    ).rows[0].source_cursor,
    {},
  );
  console.log(
    "HIP known-wallet PG16 migrations, interrupted stages, tied fills, immutable conflicts, legacy replay, sparse/generic/resumed/empty source plans passed",
  );
} finally {
  if (schemaCreated) await client.query(`drop schema ${schemaName} cascade`);
  client.release();
  await pool.end();
}
