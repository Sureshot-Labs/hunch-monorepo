import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  account,
  boundary,
  confirmHousePreview,
  enqueue,
  hasHouseExitInFlight,
  houseAdminActivitySql,
  houseBuyEligibility,
  houseBuyEligibilitySql,
  houseSellPosition,
  pollSignals,
  recordHouseWorker,
  reserveBuy,
  reserveHouseModelCost,
  type Action,
} from "./services/house-trader-store.js";
import { houseTraderDefault } from "./services/house-trader-policy.js";
import {
  houseSweepBoundarySql,
  houseSweepRevertedSql,
} from "./services/house-trader-withdrawal.js";

const connectionString = process.env.HOUSE_FIXTURE_URL;
assert.ok(connectionString);
const target = new URL(connectionString);
assert.ok(
  target.hostname === "127.0.0.1" && target.pathname === "/house_fixture",
);
const schema = `house_trader_fixture_${randomBytes(6).toString("hex")}`;
const db = new Pool({
  connectionString,
  max: 8,
  options: `-c search_path=${schema}`,
});
const migration = (name: string) =>
  readFile(
    new URL(`../../../packages/db/migrations/${name}`, import.meta.url),
    "utf8",
  );
try {
  const {
    rows: [server],
  } = await db.query(
    "select current_database() as db, current_setting('server_version_num') as version",
  );
  assert.equal(server.db, "house_fixture");
  assert.equal(Math.floor(Number(server.version) / 10000), 16);
  await db.query(`create schema ${schema}`);
  await db.query(
    "create table users(id uuid primary key default gen_random_uuid())",
  );
  await db.query(`create table unified_markets(id text primary key,event_id text,venue text,category text,status text,
    token_yes text,token_no text,close_time timestamptz,expiration_time timestamptz)`);
  await db.query(
    "create table unified_market_tokens(market_id text, token_id text, outcome_side text)",
  );
  for (const name of ["0079_ai_notes.sql", "0302_house_trader.sql"])
    await db.query(await migration(name));
  const user = (await db.query("insert into users default values returning id"))
    .rows[0].id;
  await db.query(
    `insert into house_trader_account(user_id,deposit_wallet,active,settings,cursor_at)
    values($1,'fixture',true,$2,now()-interval '10 minutes')`,
    [user, { ...houseTraderDefault, dailyBuyUsd: "2" }],
  );
  await db.query(`insert into unified_markets values
    ('polymarket:1','event:1','polymarket','sports','ACTIVE',null,null,now()+interval '2 hours',null),
    ('polymarket:2','event:2','polymarket','sports','ACTIVE',null,null,now()+interval '2 hours',null)`);
  await db.query(`insert into unified_market_tokens values
    ('polymarket:1','100','YES'),('polymarket:1','101','NO'),('polymarket:2','200','YES')`);
  const frozen = {
    publicationDecisionV1: {
      version: 1,
      authority: "holder_research_quality_gate",
      status: "PUBLISH",
    },
    signalPriceSnapshotV1: {
      version: 1,
      marketId: "polymarket:1",
      venue: "polymarket",
      displaySide: "YES",
      displayPriceSource: "midpoint",
      displayPrice: 0.49,
      asOf: new Date(Date.now() - 120_000).toISOString(),
      YES: { ask: 0.5, bid: 0.48, mark: 0.49 },
      NO: { ask: null, bid: null, mark: null },
    },
    socialInstrumentV1: {
      marketId: "polymarket:1",
      venue: "polymarket",
      outcome: "YES",
      tokenId: "100",
      generation: "137:0x0000000000000000000000000000000000000033:v2",
    },
  };
  for (const [label, revision, status, minutes, snapshot] of [
    ["eligible", "initial", "active", 1, frozen],
    ["update", "update", "active", 1, frozen],
    ["retracted", "initial", "retracted", 1, frozen],
    ["old", "initial", "active", 20, frozen],
    [
      "no-publish",
      "initial",
      "active",
      1,
      { ...frozen, publicationDecisionV1: null },
    ],
    [
      "wrong-token",
      "initial",
      "active",
      1,
      {
        ...frozen,
        socialInstrumentV1: { ...frozen.socialInstrumentV1, tokenId: "101" },
      },
    ],
  ] as const) {
    const note = (
      await db.query(
        `insert into ai_notes(note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id,direction,lineage,metrics,created_at)
      values($1,'signal',$2,'fixture','fixture','market','polymarket:1','holder_research','run','up',
      jsonb_build_object('revision_kind',$3::text),$4,now()-$5::int*interval '1 minute') returning id`,
        [label, status, revision, snapshot, minutes],
      )
    ).rows[0].id;
    await db.query(
      "insert into ai_note_targets(note_id,target_kind,target_id,is_primary) values($1,'market','polymarket:1',true)",
      [note],
    );
  }
  await pollSignals(db);
  await pollSignals(db);
  let first = (await db.query("select * from house_trader_actions")).rows[0];
  assert.equal(first.token_id, "100");
  assert.equal(
    (await db.query("select id from house_trader_actions")).rowCount,
    1,
  );
  // Replaying the same native cursor must not enqueue a second BUY.
  await db.query(
    "update house_trader_account set cursor_at=now()-interval '90 seconds'",
  );
  await pollSignals(db);
  assert.equal(
    (await db.query("select id from house_trader_actions")).rowCount,
    1,
  );
  const a = await account(db);
  assert.ok(a);
  assert.equal(await houseBuyEligibility(db, a, first), null);
  const firstNote = first.request.noteId;
  await db.query(
    "update unified_markets set close_time=now()+interval '1 minute' where id=$1",
    [first.market_id],
  );
  assert.equal(
    await houseBuyEligibility(db, a, first),
    "market_outside_close_window",
  );
  await db.query(
    "update unified_markets set close_time=now()+interval '2 hours' where id=$1",
    [first.market_id],
  );
  assert.equal(
    await houseBuyEligibility(
      db,
      { ...a, settings: { ...houseTraderDefault, categories: ["crypto"] } },
      first,
    ),
    "category_filtered",
  );
  await db.query(
    "update ai_notes set created_at=now()-interval '31 minutes' where id=$1",
    [firstNote],
  );
  assert.equal(await houseBuyEligibility(db, a, first), "signal_expired");
  await db.query(
    "update ai_notes set created_at=now()-interval '1 minute' where id=$1",
    [firstNote],
  );
  await db.query(
    "update unified_market_tokens set token_id='102' where market_id=$1 and outcome_side='YES'",
    [first.market_id],
  );
  assert.equal(
    await houseBuyEligibility(db, a, first),
    "signal_or_instrument_inactive",
  );
  await db.query(
    "update unified_market_tokens set token_id='100' where market_id=$1 and outcome_side='YES'",
    [first.market_id],
  );
  const opposite = await enqueue(db, a, {
    key: "already_open_same_market",
    kind: "buy",
    market: first.market_id,
    event: first.event_id,
    token: "101",
    outcome: "NO",
  });
  assert.ok(opposite);
  await db.query(
    "update house_trader_actions set state='submitted',budget_raw=1 where id=$1",
    [opposite.id],
  );
  assert.equal(await houseBuyEligibility(db, a, first), "position_open");
  await db.query(
    "update house_trader_actions set state='skipped' where id=$1",
    [opposite.id],
  );
  const secondMark = {
    ...frozen,
    socialInstrumentV1: {
      ...frozen.socialInstrumentV1,
      marketId: "polymarket:2",
      tokenId: "200",
    },
  };
  const secondNote = (
    await db.query<{ id: string }>(
      `insert into ai_notes(note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id,direction,lineage,metrics)
       values('second','signal','active','fixture','fixture','market','polymarket:2','holder_research','run','up',
       '{"revision_kind":"initial"}',$1) returning id`,
      [secondMark],
    )
  ).rows[0].id;
  await db.query(
    "insert into ai_note_targets(note_id,target_kind,target_id,is_primary) values($1,'market','polymarket:2',true)",
    [secondNote],
  );
  let second = await enqueue(db, a, {
    key: "second",
    kind: "buy",
    market: "polymarket:2",
    event: "event:2",
    token: "200",
    outcome: "YES",
    request: {
      automatic: true,
      noteId: secondNote,
      generation: secondMark.socialInstrumentV1.generation,
    },
  });
  assert.ok(second);
  await db.query(
    "update house_trader_actions set state='working',claim_token=gen_random_uuid(),created_at=now()-interval '1 day' where id in ($1,$2)",
    [first.id, second.id],
  );
  first = (
    await db.query("select * from house_trader_actions where id=$1", [first.id])
  ).rows[0];
  second = (
    await db.query("select * from house_trader_actions where id=$1", [
      second.id,
    ])
  ).rows[0];
  assert.ok(second);
  await assert.rejects(
    boundary(db, first, "without-reservation"),
    /submission_already_claimed/,
  );
  await db.query(
    'update house_trader_account set settings=settings || \'{"aiDailyUsd":"0.025"}\'',
  );
  assert.equal(
    await reserveHouseModelCost(db, { ...first, claim_token: null }, 25_000n),
    "ai_budget_or_claim_unavailable",
  );
  const modelReservations = await Promise.all([
    reserveHouseModelCost(db, first, 25_000n),
    reserveHouseModelCost(db, second, 25_000n),
  ]);
  assert.equal(
    modelReservations.filter((reservation) => reservation === null).length,
    1,
  );
  assert.equal(
    await reserveHouseModelCost(db, first, 25_000n),
    "ai_budget_or_claim_unavailable",
  );
  const reserves = await Promise.all([
    reserveBuy(db, first, 1_500_000n, 10_000_000n),
    reserveBuy(db, second, 1_500_000n, 10_000_000n),
  ]);
  assert.equal(reserves.filter((value) => value === null).length, 1);
  const winner = reserves[0] === null ? first : second;
  const loser = reserves[0] === null ? second : first;
  await assert.rejects(
    boundary(
      db,
      { ...winner, claim_token: "00000000-0000-0000-0000-000000000000" },
      "stale-worker",
    ),
    /submission_already_claimed/,
  );
  await db.query(
    "update unified_markets set close_time=now()+interval '1 minute' where id=$1",
    [winner.market_id],
  );
  await assert.rejects(
    boundary(db, winner, "reject-stale-window"),
    /market_outside_close_window/,
  );
  await db.query(
    "update unified_markets set close_time=now()+interval '2 hours' where id=$1",
    [winner.market_id],
  );
  await boundary(db, winner, "fixture-hash");
  await assert.rejects(
    boundary(db, winner, "duplicate"),
    /submission_already_claimed/,
  );
  await db.query("update house_trader_actions set state='filled' where id=$1", [
    winner.id,
  ]);
  const sell = {
    ...winner,
    kind: "sell",
    request: { positionId: winner.id },
  } satisfies Action;
  assert.equal((await houseSellPosition(db, sell))?.id, winner.id);
  assert.equal(await houseSellPosition(db, { ...sell, token_id: "999" }), null);
  assert.equal(await houseSellPosition(db, { ...sell, outcome: "NO" }), null);
  assert.equal(
    await houseSellPosition(db, {
      ...sell,
      request: { positionId: "invalid" },
    }),
    null,
  );
  assert.equal(
    await reserveBuy(db, loser, 1_500_000n, 10_000_000n),
    "daily_limit",
  );
  await db.query(
    "update house_trader_account set active=false,revision=revision+1 where singleton",
  );
  await assert.rejects(
    boundary(db, loser, "paused"),
    /strategy_changed_or_paused/,
  );
  const portfolioSource = await readFile(
    new URL("./services/house-trader-runner.ts", import.meta.url),
    "utf8",
  );
  const statement = portfolioSource.match(
    /`(with actions as materialized \([\s\S]*?from actions)`/,
  );
  assert.ok(statement);
  await db.query(
    `update house_trader_actions set result='{"cashDeltaRaw":"-1500000","fillSharesRaw":"3000000"}' where id=$1`,
    [winner.id],
  );
  await db.query(
    `insert into house_trader_actions(account_user_id,action_key,kind,state,revision,request,result)
    values($1,'partial sell','sell','done',0,jsonb_build_object('positionId',$2::text),
      '{"cashDeltaRaw":"1000000","fillSharesRaw":"1500000"}')`,
    [user, winner.id],
  );
  const {
    rows: [accounting],
  } = await db.query(statement[1], [user]);
  assert.equal(accounting.pnlUsd, "0.250000");
  const explain = await db.query(
    `explain (analyze,buffers,format json) ${statement[1]}`,
    [user],
  );
  assert.ok(explain.rows[0]["QUERY PLAN"][0]["Execution Time"] >= 0);
  const handoffReference = "batch:7:2000000000";
  const withdrawal = (
    await db.query<{ id: string }>(
      `insert into house_trader_actions(account_user_id,action_key,kind,state,revision,reference,result)
       values($1,'withdrawal','withdraw','submitted',0,$2,'{"phase":"handoff","relayerId":"fixture"}')
       returning id`,
      [user, handoffReference],
    )
  ).rows[0];
  const firstLegHash = `0x${"a".repeat(64)}`;
  const revertedSweepHash = `0x${"b".repeat(64)}`;
  const nextSweepHash = `0x${"c".repeat(64)}`;
  const startSweep = (hash: string, nonce: number) =>
    db.query(houseSweepBoundarySql, [
      withdrawal.id,
      hash,
      handoffReference,
      "encrypted-fixture",
      nonce,
      firstLegHash,
    ]);
  assert.equal((await startSweep(revertedSweepHash, 10)).rowCount, 1);
  assert.equal((await startSweep(nextSweepHash, 11)).rowCount, 0);
  assert.equal(
    (await db.query(houseSweepRevertedSql, [withdrawal.id, nextSweepHash]))
      .rowCount,
    0,
  );
  assert.equal(
    (await db.query(houseSweepRevertedSql, [withdrawal.id, revertedSweepHash]))
      .rowCount,
    1,
  );
  const resumed = (
    await db.query(
      "select reference,protected_submission,result from house_trader_actions where id=$1",
      [withdrawal.id],
    )
  ).rows[0];
  assert.equal(resumed.reference, handoffReference);
  assert.equal(resumed.result.phase, "handoff");
  assert.equal(resumed.result.transactionHash, firstLegHash);
  assert.equal(resumed.protected_submission, null);
  assert.equal((await startSweep(nextSweepHash, 11)).rowCount, 1);
  const newPreview = async (label: string) => {
    const item = (
      await db.query<{ id: string }>(
        `insert into house_trader_actions(account_user_id,action_key,kind,state,revision,reason,request)
       values($1,$2,'sell','review',0,'confirm_preview',jsonb_build_object('positionId',$3::text))
       returning id`,
        [user, label, winner.id],
      )
    ).rows[0];
    return item.id;
  };
  const preview = await newPreview("preview");
  const other = await newPreview("other preview");
  assert.equal(await hasHouseExitInFlight(db, user, winner.id, true), true);
  assert.deepEqual(await confirmHousePreview(db, user, preview, "test-admin"), {
    ok: true,
  });
  assert.deepEqual(await confirmHousePreview(db, user, other, "test-admin"), {
    error: "position_exit_already_pending",
  });
  assert.deepEqual(await confirmHousePreview(db, user, preview, "test-admin"), {
    error: "preview_expired_or_used",
  });
  const eligibleAfterFailure = (
    await db.query<Action>(
      `update house_trader_actions set state='working',claim_token=gen_random_uuid(),
        request=request || jsonb_build_object('confirmedAt',now()-interval '4 minutes') where id=$1 returning *`,
      [preview],
    )
  ).rows[0];
  await assert.rejects(
    boundary(db, eligibleAfterFailure, "late-submit"),
    /manual_confirmation_expired/,
  );
  await db.query(
    "update house_trader_actions set state='skipped',updated_at=now()-interval '4 minutes' where id in ($1,$2)",
    [preview, other],
  );
  assert.equal(
    await hasHouseExitInFlight(db, user, winner.id, true),
    false,
    "expired previews don't hold a position",
  );
  await recordHouseWorker(db, user, { status: "running" });
  await recordHouseWorker(db, user, { status: "completed", observed: 1 });
  assert.deepEqual((await account(db))?.worker_status, {
    status: "completed",
    observed: 1,
  });
  await db.query(
    "update house_trader_actions set created_at=now()-interval '14 days' where id=$1",
    [withdrawal.id],
  );
  await db.query(
    `insert into house_trader_actions(account_user_id,action_key,kind,state,revision)
      select $1,'history:' || fixture_row.sequence,'buy','skipped',1
      from generate_series(1,3000) as fixture_row(sequence)`,
    [user],
  );
  await db.query("analyze house_trader_actions");
  const activity = (await db.query(houseAdminActivitySql, [user])).rows;
  assert.equal(
    activity.filter((row) => row.id === withdrawal.id).length,
    1,
    "an older pending withdrawal remains visible",
  );
  assert.ok(activity.length <= 80);
  const eligibilityBind = [
    firstNote,
    first.market_id,
    first.outcome,
    first.token_id,
    first.request.generation,
    { publicationDecisionV1: frozen.publicationDecisionV1 },
    30,
    user,
    first.id,
    first.event_id,
  ];
  const readPlan = async (sql: string, values: unknown[]) => {
    const explain = (
      await db.query(`explain (analyze,buffers,format json) ${sql}`, values)
    ).rows[0]["QUERY PLAN"][0];
    type PlanNode = { "Index Name"?: string; Plans?: PlanNode[] };
    const findIndexes = (plan: PlanNode): string[] => [
      ...(plan["Index Name"] ? [plan["Index Name"]] : []),
      ...(plan.Plans ?? []).flatMap(findIndexes),
    ];
    return {
      ms: explain["Execution Time"],
      sharedHits: explain.Plan["Shared Hit Blocks"],
      returned: explain.Plan["Actual Rows"],
      indexes: [...new Set(findIndexes(explain.Plan))],
    };
  };
  console.info("PG16 local EXPLAIN", {
    eligibility: await readPlan(houseBuyEligibilitySql, eligibilityBind),
    adminActivity: await readPlan(houseAdminActivitySql, [user]),
  });
  console.info(
    "PG16 migration, native signal admission/dedup, edits before submit, trade caps, pause fencing, confirmation fencing, portfolio and sweep recovery passed",
  );
} finally {
  await db.end();
}
