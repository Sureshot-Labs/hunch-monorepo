// @requires-db: explicit disposable PG16 target. Session-local fixtures only;
// the repository uses its normal read-only transactions on this one connection.
import assert from "node:assert/strict";
import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { TraderRepository, assetKey } from "./repos/trader-collections.js";
import { GlobalMoveRepository } from "./repos/trader-global-moves.js";

const pool = await createIntegrationTestPool({ max: 1 });
const end = Date.parse("2026-11-12T12:00:00Z") / 1000;
const addr = (i: number) => "0x" + String(i).repeat(40);
const condition = "0x" + "1".repeat(64);
const previous = "0x" + "2".repeat(64);
const contract = POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase();
const pm = POLYMARKET_PROTOCOL_CONTRACTS.positionManager.toLowerCase();
const asset = (token: string, index: number, c = condition) => ({
  condition: c,
  token,
  index,
  label: index === 0 ? "Team A" : "Team B",
});
try {
  assert.match(
    (await pool.query("show server_version_num")).rows[0].server_version_num,
    /^16/,
  );
  await pool.query(`
    set search_path=pg_temp,pg_catalog;
    create temp table wallets(id uuid primary key,address text,chain text,metadata jsonb,label text,first_seen_at timestamptz);
    create temp table wallet_onchain_state(wallet_id uuid primary key,owner_wallet_id uuid);
    create temp table wallet_tracking_subjects(wallet_id uuid,venue text,status text,source text);
    create temp table wallet_activity_events(id uuid primary key,wallet_id uuid,occurred_at timestamptz,venue text,activity_type text,action text,metadata jsonb,size_usd numeric,source text,delta_shares numeric,market_id text,outcome_side text,price numeric,created_at timestamptz);
    create index on wallet_activity_events(wallet_id, occurred_at desc);
    create temp table wallet_position_snapshots(wallet_id uuid,venue text,market_id text,outcome_side text,snapshot_at timestamptz,shares numeric,metadata jsonb,price numeric);
    create temp table wallet_intel_selector_snapshot(wallet_id uuid primary key,last_activity_at timestamptz,hedge_ratio numeric,hedged_notional_usd numeric,two_sided_markets int,exposure_usd numeric,metrics_pnl_30d numeric,metrics_resolved_edge_sample_count_30d int);
    create temp table polymarket_asset_bindings(chain_id int,asset_id text,condition_id text,outcome_index int,market_id text,protocol_version text,position_contract text);
    create temp table unified_market_tokens(market_id text,token_id text,venue text,outcome_side text,updated_at timestamptz);
    create temp table unified_markets(id text primary key,venue text,title text,event_id text,category text,condition_id text,metadata jsonb,resolved_outcome text,resolved_outcome_pct numeric,status text,expiration_time timestamptz,close_time timestamptz,venue_market_id text,resolution_observed_at timestamptz);
    create temp table unified_events(id text primary key,category text);
    create temp table polymarket_markets(id text primary key,accepting_orders boolean,active boolean,closed boolean,archived boolean);
    create temp table unified_token_top_latest(token_id text primary key,venue text,ts timestamptz,best_ask numeric,best_bid numeric);
    insert into wallets select md5(n::text)::uuid,'0x'||repeat(n::text,40),case n when 6 then 'base' else 'polygon' end,'{}','Private label' from generate_series(1,7) n;
    insert into wallet_intel_selector_snapshot select id,'2026-11-12T11:00Z',0,0,0,1,100,21 from wallets;
    insert into wallet_tracking_subjects select id,'polymarket',case when id=md5('7')::uuid then 'paused' else 'active' end,'whale' from wallets where id<>md5('4')::uuid;
    insert into wallet_tracking_subjects values(md5('1')::uuid,'polymarket','active','signal_candidate');
    insert into wallet_onchain_state values(md5('2')::uuid,md5('1')::uuid);
    update wallets set metadata=jsonb_build_object('ownerAddress','0x'||repeat('3',40)) where id=md5('2')::uuid;
    update wallets set metadata=jsonb_build_object('ownerAddress','0x'||repeat('1',40),'identityNames',jsonb_build_object('polymarket',jsonb_build_object('status','ok','username','0x'||repeat('3',40)))) where id=md5('3')::uuid;
    update wallets set metadata='{"identityNames":{"polymarket":{"status":"ok","username":"public-name"}}}' where id=md5('1')::uuid;
    update wallets set metadata='{"identityNames":{"primary":{"source":"polymarket","name":"formerly-public"},"polymarket":{"status":"not_found"}}}' where id=md5('5')::uuid;
    insert into unified_events values('e','Sports');
    insert into polymarket_markets values('p',true,true,false,false);
  `);
  await pool.query(
    `insert into unified_markets(id,venue,title,event_id,condition_id,metadata,status,expiration_time,close_time,venue_market_id)
     values ('m','polymarket','Title','e',$1,$2,'ACTIVE','2026-11-14T00:00Z','2026-11-13T00:00Z','p')`,
    [
      condition,
      JSON.stringify({
        polymarketProtocol: {
          assets: ["10", "11"],
          conditionId: condition,
          protocolVersion: "v1",
          positionContract: contract,
        },
      }),
    ],
  );
  await pool.query(
    `insert into polymarket_asset_bindings values
     (137,'10',$1,0,'m','v1',$3),(137,'11',$1,1,'m','v1',$3),
     (137,'12',$2,1,'m','v1',$3),
     (137,'13',$1,0,'m','v1',$3),(137,'13',$1,0,'m','v2',$4)`,
    [condition, previous, contract, pm],
  );
  await pool.query(`
    insert into unified_market_tokens values('m','10','polymarket','YES',now()),('m','11','polymarket','NO',now());
    insert into unified_token_top_latest select n::text,'polymarket','2026-11-12T11:59Z',0.4 from generate_series(10,13) n`);
  const repo = new TraderRepository(pool);
  const owners = await repo.owners(end, 1000);
  const owner = (n: number) => {
    const row = owners.find((r) => r.address === addr(n));
    assert.ok(row, "owner fixture missing");
    return row;
  };
  assert.equal(owners.length, 4); // not private-follow-only, wrong chain, or paused
  assert.equal(owner(1).family, owner(1).id);
  assert.equal(owner(2).family, owner(1).family); // onchain beats conflicting legacy link
  assert.equal(owner(3).family, owner(1).family); // legacy link uses the same key
  assert.equal(owner(1).name, "public-name");
  assert.equal(owner(2).name, null); // no private label fallback
  assert.equal(owner(3).name, null); // raw address is never a display name
  assert.equal(owner(5).name, null); // stale primary no longer verified public
  // A known protocol address can have stronger wallet metrics than a trader.
  // Exclude it case-insensitively before the final cap, never by contract type.
  const burnAddress = "0xa5ef39c3d3e10d0b270233af41cac69796b12966";
  await pool.query(
    `insert into wallets
     select md5('new-'||n)::uuid,case when n=0 then '0x'||upper(substr($1::text,3)) else '0x'||lpad(to_hex(n),40,'0') end,
       'polygon','{"kind":"safe"}',null from generate_series(0,50) n`,
    [burnAddress],
  );
  await pool.query(`
    insert into wallet_intel_selector_snapshot
     select md5('new-'||n)::uuid,timestamptz '2026-11-12T11:30:00Z'-n*interval '1 second',0,0,0,1,100,21 from generate_series(0,50) n;
    insert into wallet_tracking_subjects
     select md5('new-'||n)::uuid,'polymarket','active','whale' from generate_series(0,50) n`);
  const traderRoster = await repo.owners(end, 1000);
  assert.ok((await repo.owners(end, 1000, 100)).length > 50);
  const allMoves = new GlobalMoveRepository(pool);
  assert.equal(
    (await allMoves.owners([owner(1).id], 1000))[0].name,
    "public-name",
  );
  assert.deepEqual(await allMoves.balances([], end - 86400, end), []);
  assert.deepEqual(await allMoves.deltas(end - 3600, end, end), []);
  await pool.query(`insert into wallet_activity_events(id,wallet_id,occurred_at,venue,activity_type,action,metadata,source,delta_shares,market_id,outcome_side,price,created_at) values
  (md5('global')::uuid,md5('1')::uuid,'2026-11-12T11:15Z','polymarket','delta','BUY','{"snapshotSource":"polymarket","tokenId":"44","prevShares":"1","currShares":"1001"}','snapshot_delta',1000,'global','YES',0.5,'2026-11-12T11:16Z');
  insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,snapshot_at,shares,metadata) values
  (md5('1')::uuid,'polymarket','global','YES','2026-11-12T10:15Z',1,'{"source":"polymarket","tokenId":"44"}'),
  (md5('1')::uuid,'polymarket','global','YES','2026-11-12T11:15Z',1001,'{"source":"polymarket","tokenId":"44"}')`);
  const scope = await allMoves.deltas(end - 3600, end, end);
  assert.equal(scope.length, 1);
  assert.equal(Number(scope[0].cash), 500);
  // NUMERIC multiplication can exceed 18 decimal places for ordinary JS
  // midpoint prices. Apply the $500 gate BEFORE rounding the public amount.
  await pool.query(
    "update wallet_activity_events set delta_shares=2000.12,price=0.41000000000000003 where id=md5('global')::uuid",
  );
  assert.equal(
    (await allMoves.deltas(end - 3600, end, end))[0].cash,
    "820.049200",
  );
  await pool.query(
    "update wallet_activity_events set delta_shares=1000,price=0.499999999999 where id=md5('global')::uuid",
  );
  assert.deepEqual(await allMoves.deltas(end - 3600, end, end), []);
  const inventory = await allMoves.balances(
    [{ w: owner(1).id, m: "global" }],
    end - 3600,
    end,
  );
  assert.deepEqual(
    inventory.map((r) => r.shares),
    ["1", "1001"],
  );
  assert.deepEqual(
    traderRoster.map((entry) => entry.address),
    Array.from(
      { length: 50 },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
    ),
  );
  await pool.query(`insert into wallet_activity_events values
    (md5('close')::uuid,md5('1')::uuid,'2026-11-12T10:15Z','polymarket','delta','SELL','{"snapshotSource":"polymarket","prevShares":"3.5","currShares":"0.000"}',12,'snapshot_delta',3.5,'m','YES'),
    (md5('buy')::uuid,md5('2')::uuid,'2026-11-12T11:15Z','polymarket','delta','BUY','{"snapshotSource":"polymarket"}',505,'snapshot_delta',1010,'m','YES'),
    (md5('private')::uuid,md5('3')::uuid,'2026-11-12T11:15Z','polymarket','trade','BUY','{}',99999,'hunch_order_fill',200000,'m','YES'),
    (md5('synthetic')::uuid,md5('5')::uuid,'2026-11-12T11:15Z','polymarket','delta','SELL','{"snapshotSource":"polymarket","prevShares":"2","currShares":"0"}',99999,'snapshot_delta',2,'m','YES');
    insert into wallet_position_snapshots values(md5('1')::uuid,'polymarket','m','YES','2026-11-12T10:15Z',0,'{"source":"polymarket","tokenId":"10"}'),
    (md5('5')::uuid,'polymarket','m','YES','2026-11-12T11:15Z',0,'{"source":"snapshot_zero","tokenId":"10"}')`);
  const hinted = await repo.owners(end, 1000);
  assert.equal(hinted.length, 50);
  assert.equal(new Set(hinted.map((o) => o.id)).size, 50);
  assert.deepEqual(
    hinted.slice(0, 2).map((o) => o.address),
    [addr(1), addr(2)],
  );
  assert.ok(
    !hinted.some((o) => o.address === addr(3) || o.address === addr(5)),
  );
  await pool.query(`insert into unified_markets(id,event_id,venue,resolved_outcome,resolution_observed_at) values ('settled','e','polymarket','NO','2026-11-12T11:59Z');
   insert into wallet_activity_events values(md5('old-holding')::uuid,md5('5')::uuid,'2026-11-09T09:00Z','polymarket','delta','BUY','{"snapshotSource":"polymarket","prevShares":"0","currShares":"10"}',4,'snapshot_delta',10,'settled','NO')`);
  assert.equal(
    (await repo.owners(end, 1000))[0].address,
    addr(5),
    "an observed holding in a newly settled market supplies a closure hint without a zero snapshot",
  );
  const yes = asset("10", 0),
    no = asset("11", 1),
    old = asset("12", 1, previous);
  const wrongIndex = asset("10", 1),
    ambiguous = asset("13", 0);
  const matches = await repo.markets(
    [yes, no, old, yes, wrongIndex, ambiguous],
    end,
  );
  const boundMarket = matches.get(assetKey(yes))?.instrument.marketId;
  assert.ok(boundMarket);
  const localKey = { ...yes, condition: boundMarket };
  const localMarkets = await repo.markets([localKey], end, undefined, true);
  assert.equal(
    localMarkets.get(assetKey(localKey))?.instrument.marketId,
    boundMarket,
  );
  assert.equal(localMarkets.get(assetKey(localKey))?.winner, null);
  await pool.query(
    `insert into wallet_activity_events(id,wallet_id,occurred_at,created_at,venue,market_id,outcome_side,activity_type,action,source,delta_shares,price,metadata)
    select md5('micro-'||n)::uuid,md5('7')::uuid,timestamptz '2026-11-12T11:00:00.123456Z','2026-11-12T11:00Z','polymarket',$1,'YES','delta','BUY','snapshot_delta',10,.4,'{"snapshotSource":"polymarket","tokenId":"10","prevShares":"0","currShares":"10"}'::jsonb from generate_series(1,1003) n`,
    [boundMarket],
  );
  const microid = (await pool.query("select md5('7')::uuid as id")).rows[0].id;
  const firstPage = await repo.localPage(
    microid,
    "2026-11-12T10:00Z",
    "00000000-0000-0000-0000-000000000000",
    end,
  );
  assert.equal(firstPage.length, 1000);
  const last = firstPage.at(-1);
  assert.ok(last);
  assert.ok(last.stamp.includes(".123456"));
  const nextPage = await repo.localPage(microid, last.stamp, last.id, end);
  assert.equal(nextPage.length, 3);
  assert.equal(
    new Set([...firstPage, ...nextPage].map((r) => r.id)).size,
    1003,
  );
  assert.equal(nextPage[0].token, "10");
  assert.equal(nextPage[0].comparable_before, false);
  assert.equal(nextPage[0].has_prior_snapshot, false);
  await pool.query(
    `insert into wallet_position_snapshots values(md5('7')::uuid,'polymarket','m','YES','2026-11-12T10:00Z',0,'{"source":"snapshot_zero","tokenId":"10"}',.4)`,
  );
  assert.equal(
    (await repo.localPage(microid, last.stamp, last.id, end))[0]
      .comparable_before,
    false,
  );
  await pool.query(
    `update wallet_position_snapshots set metadata='{"source":"polymarket","tokenId":"11"}' where wallet_id=md5('7')::uuid`,
  );
  assert.equal(
    (await repo.localPage(microid, last.stamp, last.id, end))[0]
      .comparable_before,
    false,
  );
  await pool.query(
    `update wallet_position_snapshots set metadata='{"source":"polymarket","tokenId":"10"}' where wallet_id=md5('7')::uuid`,
  );
  assert.equal(
    (await repo.localPage(microid, last.stamp, last.id, end))[0]
      .comparable_before,
    true,
  );
  assert.equal(matches.size, 3);
  assert.equal(matches.has(assetKey(wrongIndex)), false);
  assert.equal(matches.has(assetKey(ambiguous)), false);
  assert.equal(matches.get(assetKey(yes))?.active, true);
  assert.equal(matches.get(assetKey(yes))?.ask, 400000n);
  assert.equal(matches.get(assetKey(yes))?.quoteAt, end - 60);
  assert.equal((await repo.markets([], end)).size, 0);
  assert.equal(
    matches.get(assetKey(yes))?.tradableUntil,
    Date.parse("2026-11-13T00:00Z") / 1000,
  );
  assert.equal(matches.get(assetKey(no))?.instrument.side, "NO");
  assert.equal(matches.get(assetKey(no))?.instrument.outcomeLabel, "Team B");
  assert.equal(matches.get(assetKey(no))?.category, "sports");
  const history = matches.get(assetKey(old));
  assert.ok(history);
  assert.equal(history.instrument.side, "NO"); // even without any current mapping
  assert.equal(history.instrument.generation, `137:${contract}:v1`);
  assert.equal(history.active, false);
  assert.equal(history.ask, null);
  assert.equal(history.quoteAt, null);
  const sparse = [
    ...Array.from({ length: 249 }, (_, i) => asset(String(1000 + i), 0)),
    yes,
  ];
  assert.deepEqual(
    [...(await repo.markets(sparse, end))],
    [[assetKey(yes), matches.get(assetKey(yes))]],
  );
  await pool.query("update unified_markets set category='FiNaNcE'");
  await pool.query("update polymarket_markets set accepting_orders=false");
  const paused = (await repo.markets([yes], end)).get(assetKey(yes));
  assert.equal(paused?.category, "finance");
  assert.equal(paused?.active, false);
  assert.equal(paused?.ask, null);
  assert.equal(paused?.quoteAt, null);
  await pool.query("update polymarket_markets set accepting_orders=true");
  await pool.query("delete from unified_token_top_latest where token_id='11'");
  const unquoted = (await repo.markets([no], end)).get(assetKey(no));
  assert.equal(unquoted?.active, true);
  assert.equal(unquoted?.ask, null);
  assert.equal(unquoted?.quoteAt, null);
  await pool.query(
    "update unified_market_tokens set outcome_side='NO' where token_id='10'",
  );
  assert.equal(
    (await repo.markets([yes], end)).get(assetKey(yes))?.active,
    false,
  );
  await pool.query(
    "update unified_market_tokens set outcome_side='YES' where token_id='10'",
  );
  await pool.query(
    "update unified_markets set metadata=jsonb_set(metadata,'{polymarketProtocol,protocolVersion}',to_jsonb('v2'::text))",
  );
  assert.equal(
    (await repo.markets([yes], end)).get(assetKey(yes))?.active,
    false,
  );
  await pool.query("update unified_markets set resolved_outcome='YES'");
  assert.equal(
    (await repo.markets([old], end)).get(assetKey(old))?.terminal,
    false,
  );
  assert.equal(
    (await repo.markets([yes], end)).get(assetKey(yes))?.terminal,
    true,
  );
  const cancel = new AbortController();
  let acquisitions = 0;
  const cancellable = new TraderRepository({
    async connect() {
      acquisitions++;
      const c = await pool.connect();
      cancel.abort(Error("lease_lost"));
      return c;
    },
  } as Pick<typeof pool, "connect">);
  await assert.rejects(
    cancellable.markets(
      Array.from({ length: 251 }, (_, i) => asset(String(i), 0)),
      end,
      cancel.signal,
    ),
    /lease_lost/,
  );
  await assert.rejects(
    cancellable.markets([yes], end, cancel.signal),
    /lease_lost/,
  );
  assert.equal(acquisitions, 1);
  console.log(
    "ok - PG16 public owner identity, frozen/canonical instrument separation, conflicting indices, expiry and cancelled batching",
  );
} finally {
  await pool.end();
}
