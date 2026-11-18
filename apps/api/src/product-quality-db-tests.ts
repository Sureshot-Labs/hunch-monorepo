// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { SocialService } from "./services/social-service.js";
import {
  decodeSocialCursor,
  socialFingerprint,
} from "./services/social-primitives.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { fetchFeedMarkets } from "./repos/unified-read.js";
import {
  TRADER_LOCAL_MARKETS_SQL,
  TRADER_MARKETS_SQL,
} from "./repos/trader-collections.js";
import {
  buildMarketMapSidebarQuery,
  emptyMarketMapSidebarQualityFloors,
  type MarketMapSidebarKind,
} from "./repos/market-map-sidebar-candidates.js";

const db = await createIntegrationTestPool({ max: 1 });
const c = await db.connect();
try {
  await c.query("begin");
  await c.query("set local statement_timeout='8s'");
  await c.query(`insert into unified_events(id,venue,venue_event_id,title,status,end_date)
    select 'qa_unique_movers:'||n,'polymarket','qa_unique_movers:'||n,'QA mover','ACTIVE',now()+interval '1 day'
    from generate_series(1,5000) n`);
  await c.query(`insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,expiration_time)
    select id||':market',venue,id||':market',id,title,'ACTIVE','binary',end_date
    from unified_events where id like 'qa_unique_movers:%'`);
  await c.query(`insert into unified_event_activity_metrics_24h(event_id,venue,volume_last_24h,volume_prev_24h,
    volume_last_24h_change,volume_last_24h_change_pct,volume_valid,liquidity_now,liquidity_24h_ago,
    liquidity_change_24h,liquidity_change_pct_24h,liquidity_valid)
    select 'qa_unique_movers:'||n,'polymarket',1000+n,
      case when n%100=0 then .00000000000003 else 100 end,900+n,
      case when n%100=0 then 1e16 else (1000+n)/100.0 end,true,1000+n,
      case when n%100=0 then .00000000000003 else 100 end,900+n,
      case when n%100=0 then 1e16 else (1000+n)/100.0 end,true
    from generate_series(1,5000) n`);
  await c.query("analyze unified_events");
  await c.query("analyze unified_markets");
  await c.query("analyze unified_event_activity_metrics_24h");
  for (const kind of [
    "volumeMovers24h",
    "liquidityMovers24h",
    "newVolumeActivity",
    "newLiquidityActivity",
  ] satisfies MarketMapSidebarKind[]) {
    const query = buildMarketMapSidebarQuery({
      kind,
      venues: ["polymarket"],
      limit: 10,
      quality: emptyMarketMapSidebarQualityFloors(),
    });
    const result = await c.query(
      `explain (analyze, buffers, format json) ${query.text}`,
      query.values,
    );
    assert.equal(result.rows.length, 1);
    const plan = result.rows[0]["QUERY PLAN"][0];
    const ranked = (await c.query(query.text, query.values)).rows;
    assert.equal(
      ranked[0]?.event_id,
      kind.startsWith("new")
        ? "qa_unique_movers:5000"
        : "qa_unique_movers:4999",
    );
    if (kind.startsWith("new")) {
      assert.equal(ranked[0]?.volume_last_24h_change_pct, null);
      assert.equal(ranked[0]?.liquidity_change_pct_24h, null);
    }
    console.log("sidebar plan", {
      kind,
      ms: plan["Execution Time"],
      buffers: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"],
    });
  }
  const socialPlans: { text: string; values: unknown[] }[] = [];
  const feedCursorSecret = "fake-product-quality-pg-fixture";
  const social = new SocialService(
    {
      query: async (text: string, values: unknown[] = []) => {
        if (
          text.startsWith("with chosen as") &&
          text.includes("pg_visible_in_snapshot")
        )
          socialPlans.push({ text, values });
        return c.query(text, values);
      },
    } as unknown as Pool,
    async () => {},
    { feedCursorSecret },
  );
  const author = randomUUID();
  const eventId = `limitless:${randomUUID()}`;
  const marketId = eventId + "-market";
  await c.query(
    "insert into users(id,display_name,is_agent) values($1,'QA author',true)",
    [author],
  );
  await c.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'QA event','ACTIVE')",
    [eventId],
  );
  await c.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes,liquidity) values($1,'limitless',$1,$2,'QA contract','ACTIVE','binary','[\"YES\",\"NO\"]',50)",
    [marketId, eventId],
  );
  await c.query(
    "insert into unified_market_trade_24h(market_id,volume_24h,trades) values($1,215,8)",
    [marketId],
  );
  await c.query(
    `insert into user_theses(author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,
    instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,purchase_mode,published_at)
    select $1::uuid,'paper:qa-scale:'||n,$2::text,$3::text,'qa-token','YES','8453:fixture','QA older paper fixture',
      jsonb_build_object('instrument',jsonb_build_object('marketId',$2::text,'venue','limitless','tokenId','qa-token',
        'outcome','YES','generation','8453:fixture','expiry',null),
        'grossNotionalUsd','1','netShares','2','grossShares','2','entryPrice','0.5','purchasedAt',now()-interval '2 days'),
      'fixture',1,'qa-scale-'||n,'fixture','paper',now()-interval '2 days'-n*interval '1 second'
    from generate_series(1,5000) n`,
    [author, marketId, eventId],
  );
  await c.query("analyze user_theses");
  const clock = new Date();
  const feed = await fetchFeedMarkets(
    { query: c.query.bind(c) } as unknown as Pool,
    {
      limit: 1,
      offset: 0,
      minVol: 0,
      minLiquidity: 0,
      view: "events",
      sort: "trending_v2",
      nowParam: clock.toISOString(),
      sevenDaysAgo: new Date(clock.getTime() - 7 * 86400_000).toISOString(),
      sevenDaysFromNow: new Date(clock.getTime() + 7 * 86400_000).toISOString(),
    },
    [eventId],
    { compactResponseMetadata: true, transactionClient: c },
  );
  assert.equal(Number(feed[0]?.representative_volume_24h), 215);
  await c.query(TRADER_MARKETS_SQL, ["[]", clock]);
  await c.query(TRADER_LOCAL_MARKETS_SQL, ["[]", clock]);
  const referenceTime = Date.now();
  const post = async (
    seconds: number,
    previous: string | null,
    generation = "8453:fixture",
    hidden = false,
  ) => {
    const id = randomUUID();
    const publishedAt = new Date(referenceTime + seconds * 1000).toISOString();
    const key = `paper:fixture:${id}`;
    const instrument = {
      marketId,
      venue: "limitless",
      tokenId: "qa-token",
      outcome: "YES",
      expiry: null,
      generation,
    };
    const buy = {
      version: 1,
      canonicalPurchaseKey: key,
      instrument,
      grossNotionalUsd: "1",
      grossShares: "2",
      netShares: "2",
      entryPrice: "0.5",
      feesUsd: null,
      purchasedAt: publishedAt,
      quoteAsOf: publishedAt,
      simulation: "top_ask_no_depth_fees_or_slippage",
      provenance: {
        sources: [],
        policyRevision: "fixture",
        playbookVersion: "1",
        model: "fixture",
        angle: "condition",
        counterargument: "unknown",
        changeReason: previous ? "New printed condition." : null,
        previousThesisId: previous,
        argumentKey: id,
      },
    };
    await c.query(
      `insert into user_theses(id,author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,instrument_generation,
       body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,purchase_mode,published_at,author_hidden_at)
       values($1,$2,$3,$4,$5,'qa-token','YES',$6,'Fixture',$7::jsonb,'test',1,$3,$3,'paper',$8,case when $9::boolean then now() end)`,
      [
        id,
        author,
        key,
        marketId,
        eventId,
        generation,
        JSON.stringify(buy),
        publishedAt,
        hidden,
      ],
    );
    return id;
  };
  const independent = await post(-10, null);
  const initial = await post(-9, null);
  const hiddenIntermediate = await post(-8, initial, "8453:fixture", true);
  const latest = await post(-7, hiddenIntermediate);
  const otherGeneration = await post(-6, latest, "8453:replacement");
  const input = { mode: "all", source: "thesis", limit: 1 } as const;
  const first = await social.feed(null, input);
  assert.equal(first.items[0]?.id, otherGeneration);
  assert.ok(first.nextCursor);
  assert.match(first.nextCursor, /^s2:v1:/);
  const visibility = decodeSocialCursor(
    first.nextCursor,
    socialFingerprint(["feed", null, "all", "thesis", null, null, null]),
    feedCursorSecret,
  )?.paperVisibility;
  assert.ok(visibility);
  const lateCommit = await post(-6.5, latest);
  // It carries a publication timestamp before page one, but its simulated
  // origin is outside the captured database snapshot and not our test xid.
  await c.query(
    "update user_theses set paper_created_xid=(pg_snapshot_xmax($2::pg_snapshot)::text::bigint+100000)::text::xid8 where id=$1",
    [lateCommit, visibility],
  );
  const future = await post(60, latest);
  const second = await social.feed(null, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0]?.id, latest);
  assert.ok(second.nextCursor);
  const third = await social.feed(null, {
    ...input,
    cursor: second.nextCursor,
  });
  assert.equal(third.items[0]?.id, independent);
  await c.query(
    "update user_theses set moderation_hidden_at=now() where id=$1",
    [latest],
  );
  const afterHide = await social.feed(null, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(
    afterHide.items[0]?.id,
    independent,
    "post hidden after first page is not returned, and its ancestor does not reappear",
  );
  const profileHistory = await social.feed(null, {
    ...input,
    authorId: author,
    limit: 20,
  });
  assert.ok(profileHistory.items.some((p) => p.id === initial));
  assert.ok(profileHistory.items.some((p) => p.id === future));
  assert.ok(socialPlans.length >= 2);
  for (const [page, query] of socialPlans.slice(0, 2).entries()) {
    const plan = (
      await c.query(
        "explain (analyze,buffers,format json) " + query.text,
        query.values,
      )
    ).rows[0]["QUERY PLAN"][0];
    console.log("public paper feed plan", {
      page: page === 0 ? "first" : "next",
      ms: plan["Execution Time"],
      buffers: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"],
    });
  }
  console.log(
    "product-quality PG16 Movers, Trending and social feed SQL passed",
  );
} finally {
  await c.query("rollback").catch(() => {});
  c.release();
  await db.end();
}
