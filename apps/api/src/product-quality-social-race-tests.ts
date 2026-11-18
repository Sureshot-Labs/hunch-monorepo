// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import type { PoolClient } from "@hunch/infra";

const db = await createIntegrationTestPool({ max: 3 });
const svc = new SocialService(db, async () => {});
const actor = randomUUID();
const event = `limitless:qa-race-${randomUUID()}`;
const market = event + ":market";
const clock = Date.now();
const args = { mode: "all", source: "thesis", limit: 1 } as const;
const writer = await db.connect();
const append = async (
  c: Pick<PoolClient, "query">,
  age: number,
  parent: string | null,
) => {
  const id = randomUUID();
  const when = new Date(clock - age * 1000).toISOString();
  const key = `paper:race:${id}`;
  const instrument = {
    marketId: market,
    venue: "limitless",
    tokenId: "fixture",
    outcome: "YES",
    generation: "8453:fixture",
    expiry: null,
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
    purchasedAt: when,
    quoteAsOf: when,
    simulation: "top_ask_no_depth_fees_or_slippage",
    provenance: {
      sources: [],
      policyRevision: "fixture",
      playbookVersion: "1",
      model: "fixture",
      angle: "fixture",
      counterargument: "unknown",
      changeReason: "Paper revision with new condition.",
      previousThesisId: parent,
      argumentKey: id,
    },
  };
  await c.query(
    `insert into user_theses(id,author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,
      instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,purchase_mode,
      published_at,paper_revision_checked,paper_revision_parent_id)
    values($1,$2,$3,$4,$5,'fixture','YES','8453:fixture','Fixture',$6::jsonb,'fixture',1,$3,$3,'paper',$7,true,$8)`,
    [id, actor, key, market, event, JSON.stringify(buy), when, parent],
  );
  return id;
};
const next = async (cursor: string | null) => {
  assert.ok(cursor);
  return (await svc.feed(null, { ...args, cursor })).items[0]?.id;
};
try {
  await db.query(
    "insert into users(id,display_name,is_agent) values($1,'QA race author',true)",
    [actor],
  );
  await db.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'QA race','ACTIVE')",
    [event],
  );
  await db.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    values($1,'limitless',$1,$2,'QA race','ACTIVE','binary')`,
    [market, event],
  );
  const older = await append(db, 40, null);
  const ancestor = await append(db, 30, null);
  const firstItem = await append(db, 10, null);
  await writer.query("begin");
  const revision = await append(writer, 20, ancestor);
  const beforeCommit = await svc.feed(null, args);
  assert.equal(beforeCommit.items[0]?.id, firstItem);
  await writer.query("commit");
  assert.equal(
    await next(beforeCommit.nextCursor),
    ancestor,
    "late commit must neither appear nor remove ancestor",
  );
  const afterCommit = await svc.feed(null, args);
  assert.equal(await next(afterCommit.nextCursor), revision);
  await writer.query("begin");
  await writer.query(
    "update user_theses set moderation_hidden_at=now() where id=$1",
    [revision],
  );
  const beforeHide = await svc.feed(null, args);
  await writer.query("commit");
  assert.equal(
    await next(beforeHide.nextCursor),
    older,
    "late hide suppresses the hidden revision without bringing back its ancestor",
  );
  const duringHide = await svc.feed(null, args);
  await db.query(
    "update user_theses set moderation_hidden_at=null where id=$1",
    [revision],
  );
  assert.equal(
    await next(duringHide.nextCursor),
    ancestor,
    "late unhide does not change old membership",
  );
  const afterUnhide = await svc.feed(null, args);
  assert.equal(await next(afterUnhide.nextCursor), revision);
  console.log(
    "product quality paper feed two-session commit, hide and unhide passed",
  );
} finally {
  await writer.query("rollback").catch(() => {});
  writer.release();
  await db.query(
    "delete from user_theses where author_id=$1 and market_id=$2",
    [actor, market],
  );
  await db.query("delete from unified_events where id=$1", [event]);
  await db.query("delete from users where id=$1", [actor]);
  await db.end();
}
