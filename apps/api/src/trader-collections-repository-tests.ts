// @requires-db: explicit disposable PG16 target. Session-local fixtures only;
// the repository uses its normal read-only transactions on this one connection.
import assert from "node:assert/strict";
import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { TraderRepository, assetKey } from "./repos/trader-collections.js";

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
    create temp table wallets(id uuid primary key,address text,chain text,metadata jsonb,label text);
    create temp table wallet_onchain_state(wallet_id uuid primary key,owner_wallet_id uuid);
    create temp table wallet_tracking_subjects(wallet_id uuid,venue text,status text,source text);
    create temp table wallet_intel_selector_snapshot(wallet_id uuid primary key,last_activity_at timestamptz,hedge_ratio numeric,hedged_notional_usd numeric,two_sided_markets int,exposure_usd numeric,metrics_pnl_30d numeric,metrics_resolved_edge_sample_count_30d int);
    create temp table polymarket_asset_bindings(chain_id int,asset_id text,condition_id text,outcome_index int,market_id text,protocol_version text,position_contract text);
    create temp table unified_market_tokens(market_id text,token_id text,venue text,outcome_side text,updated_at timestamptz);
    create temp table unified_markets(id text primary key,venue text,title text,event_id text,category text,condition_id text,metadata jsonb,resolved_outcome text,resolved_outcome_pct numeric,status text,expiration_time timestamptz,close_time timestamptz,venue_market_id text);
    create temp table unified_events(id text primary key,category text);
    create temp table polymarket_markets(id text primary key,accepting_orders boolean,active boolean,closed boolean,archived boolean);
    create temp table unified_token_top_latest(token_id text primary key,venue text,ts timestamptz,best_ask numeric);
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
  const yes = asset("10", 0),
    no = asset("11", 1),
    old = asset("12", 1, previous);
  const wrongIndex = asset("10", 1),
    ambiguous = asset("13", 0);
  const matches = await repo.markets(
    [yes, no, old, yes, wrongIndex, ambiguous],
    end,
  );
  assert.equal(matches.size, 3);
  assert.equal(matches.has(assetKey(wrongIndex)), false);
  assert.equal(matches.has(assetKey(ambiguous)), false);
  assert.equal(matches.get(assetKey(yes))?.active, true);
  assert.equal(matches.get(assetKey(yes))?.ask, 400000n);
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
