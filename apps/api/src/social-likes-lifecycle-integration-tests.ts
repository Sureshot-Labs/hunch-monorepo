// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DbQuery } from "./db.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  clearUserSocialData,
  mergeUserSocialData,
} from "./services/social-lifecycle.js";
import {
  protectedRefsSql,
  socialLikesDerivedRefsSql,
  socialLikesMarketDeleteSql,
  queryBatchSummary,
  queryPostDeleteValidation,
} from "./market-retention-selector.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const lifecycleQueries = new Map<string, unknown[]>();
const db: DbQuery = {
  query: (async (text: string, values: unknown[] = []) => {
    if (text.includes("social_likes")) lifecycleQueries.set(text, values);
    return client.query(text, values);
  }) as DbQuery["query"],
};
const fixture = randomUUID();
const marketId = `likes-market:${fixture}`;
const eventId = `likes-event:${fixture}`;
const orderId = randomUUID();
type TargetColumn = "thesis_id" | "ai_note_id" | "comment_id";
const targetColumns: TargetColumn[] = ["thesis_id", "ai_note_id", "comment_id"];

async function user() {
  const id = randomUUID();
  await client.query("insert into users(id) values($1)", [id]);
  return id;
}
async function thesis(authorId: string, id = randomUUID()) {
  await client.query(
    `insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash)
    values($1::uuid,$2,$1::uuid::text,$3,$4,$5,$4||':YES','YES','fixture','Thesis','{}','fixture',1,$1::uuid::text,$1::uuid::text)`,
    [id, authorId, orderId, marketId, eventId],
  );
  return id;
}
async function note(id = randomUUID(), supersedes: string | null = null) {
  await client.query(
    `insert into ai_notes(id,note_key,note_type,title,description,source_kind,source_id,producer_type,producer_run_id,supersedes_note_id)
    values($1::uuid,$1::uuid::text,'signal','Hunch','Description','market',$2,'holder_research',$3,$4)`,
    [id, marketId, fixture, supersedes],
  );
  return id;
}
async function comment(authorId: string, thesisId: string, id = randomUUID()) {
  await client.query(
    `insert into social_comments(id,author_id,thesis_id,body,idempotency_key,payload_hash)
    values($1::uuid,$2,$3,'Comment',$1::uuid::text,$1::uuid::text)`,
    [id, authorId, thesisId],
  );
  return id;
}
async function like(userId: string, column: TargetColumn, targetId: string) {
  await client.query(
    `insert into social_likes(user_id,${column}) values($1,$2)`,
    [userId, targetId],
  );
}
async function countLikes(userId: string) {
  return Number(
    (
      await client.query(
        "select count(*) n from social_likes where user_id=$1",
        [userId],
      )
    ).rows[0].n,
  );
}
async function rejected(sql: string, values: unknown[], code: string) {
  await client.query("savepoint rejected_like");
  try {
    await assert.rejects(client.query(sql, values), { code });
  } finally {
    await client.query("rollback to savepoint rejected_like");
    await client.query("release savepoint rejected_like");
  }
}

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  assert.ok(
    (
      await client.query(
        "select to_regclass('public.social_likes') as relation",
      )
    ).rows[0].relation,
  );
  await client.query("begin");
  const source = await user(),
    target = await user(),
    outsider = await user();
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Likes fixture','ACTIVE')`,
    [eventId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'Likes fixture','ACTIVE','binary','["YES","NO"]')`,
    [marketId, eventId],
  );
  await client.query(
    "insert into orders(id,user_id,status) values($1,$2,'filled')",
    [orderId, source],
  );
  // Equal UUIDs in distinct target tables remain distinct typed likes.
  const sharedId = randomUUID();
  await thesis(source, sharedId);
  await note(sharedId);
  await comment(source, sharedId, sharedId);
  const revision = await note(undefined, sharedId);
  for (const column of targetColumns) {
    await like(source, column, sharedId);
    await like(target, column, sharedId);
    await rejected(
      `insert into social_likes(user_id,${column}) values($1,$2)`,
      [source, sharedId],
      "23505",
    );
    await rejected(
      `insert into social_likes(user_id,${column}) values($1,$2)`,
      [source, randomUUID()],
      "23503",
    );
  }
  await rejected(
    "insert into social_likes(user_id) values($1)",
    [source],
    "23514",
  );
  await rejected(
    "insert into social_likes(user_id,thesis_id,ai_note_id) values($1,$2,$2)",
    [source, sharedId],
    "23514",
  );
  await like(source, "ai_note_id", revision);
  await mergeUserSocialData(db, source, target, true);
  await mergeUserSocialData(db, source, target, true);
  assert.equal(await countLikes(source), 0);
  assert.equal(await countLikes(target), 4);
  assert.equal(
    (
      await client.query(
        "select author_id,canonical_purchase_key from user_theses where id=$1",
        [sharedId],
      )
    ).rows[0].author_id,
    target,
  );
  assert.equal(
    (
      await client.query("select author_id from social_comments where id=$1", [
        sharedId,
      ])
    ).rows[0].author_id,
    target,
  );
  assert.equal(
    (
      await client.query(
        "select canonical_purchase_key from user_theses where id=$1",
        [sharedId],
      )
    ).rows[0].canonical_purchase_key,
    sharedId,
  );
  // keepSource=false transfers edges too; repeating does not recreate source likes.
  const mergedSource = await user();
  await like(mergedSource, "ai_note_id", revision);
  await mergeUserSocialData(db, mergedSource, outsider, false);
  await mergeUserSocialData(db, mergedSource, outsider, false);
  assert.equal(await countLikes(mergedSource), 0);
  assert.equal(await countLikes(outsider), 1);
  await client.query("delete from users where id=$1", [mergedSource]);

  // Account deactivation removes authored likes, but preserves purchase history.
  const deactivating = await user();
  const inactiveThesis = await thesis(deactivating);
  for (const column of targetColumns)
    await like(deactivating, column, sharedId);
  await like(outsider, "thesis_id", inactiveThesis);
  await clearUserSocialData(db, deactivating);
  await client.query("update users set is_active=false where id=$1", [
    deactivating,
  ]);
  await clearUserSocialData(db, deactivating);
  assert.equal(await countLikes(deactivating), 0);
  assert.equal(await countLikes(outsider), 2);
  const preserved = (
    await client.query(
      "select body,author_hidden_at,order_id from user_theses where id=$1",
      [inactiveThesis],
    )
  ).rows[0];
  assert.equal(preserved.body, "");
  assert.ok(preserved.author_hidden_at);
  assert.equal(preserved.order_id, orderId);
  // A direct hard-delete also cascades likes, without deleting another user's edges.
  const hardDeleted = await user();
  for (const column of targetColumns) await like(hardDeleted, column, sharedId);
  await client.query("delete from users where id=$1", [hardDeleted]);
  assert.equal(await countLikes(hardDeleted), 0);
  assert.equal(await countLikes(target), 4);

  await client.query(`create temporary table likes_candidates(market_id text primary key,event_id text,venue text);
    create temporary table likes_candidate_tokens(market_id text,token_id text);`);
  await client.query("insert into likes_candidates values($1,$2,'limitless')", [
    marketId,
    eventId,
  ]);
  const report = (
    await client.query(socialLikesDerivedRefsSql("likes_candidates"))
  ).rows;
  assert.deepEqual(
    Object.fromEntries(report.map((row) => [row.label, Number(row.rows)])),
    {
      social_likes_thesis: 2,
      social_likes_hunch: 3,
      social_likes_comment: 1,
    },
  );
  const protectedRows = (
    await client.query(
      protectedRefsSql("likes_candidates", "likes_candidate_tokens"),
    )
  ).rows;
  assert.ok(protectedRows.some((row) => row.reason === "user_theses_market"));
  assert.ok(protectedRows.every((row) => !row.reason.includes("likes")));
  await client.query("savepoint retained_ai_comment");
  await client.query(
    `insert into social_comments(author_id,ai_note_id,observed_ai_note_id,body,idempotency_key,payload_hash)
    values($1,$2,$3,'Retained comment','retained-ai-comment','fixture')`,
    [outsider, sharedId, revision],
  );
  await client.query(
    "update ai_notes set status='retracted' where id in ($1,$2)",
    [sharedId, revision],
  );
  await client.query(
    `insert into copy_attributions(copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference)
    values($1,$2,'{}','{}','retained-ai-copy','fixture','fixture',$3)`,
    [outsider, revision, `retained-ai-copy:${fixture}`],
  );
  const retainedCommentRefs = (
    await client.query(
      protectedRefsSql("likes_candidates", "likes_candidate_tokens"),
    )
  ).rows;
  assert.ok(
    retainedCommentRefs.some((row) => row.reason === "social_hunch_comments"),
  );
  assert.ok(
    retainedCommentRefs.some((row) => row.reason === "social_hunch_copy"),
  );
  await client.query("rollback to savepoint retained_ai_comment");
  await client.query("release savepoint retained_ai_comment");
  // Scoped cleanup removes direct AI likes only. Other target kinds survive.
  await client.query("savepoint retention_cleanup");
  const deleted = await client.query(
    `${socialLikesMarketDeleteSql("likes_candidates")} returning user_id`,
  );
  assert.equal(deleted.rowCount, 3);
  assert.equal(await countLikes(target), 2);
  assert.equal(await countLikes(outsider), 1);
  await client.query("rollback to savepoint retention_cleanup");
  await client.query("release savepoint retention_cleanup");

  await client.query("delete from ai_notes where id=$1", [revision]);
  assert.equal(await countLikes(target), 3);
  assert.equal(await countLikes(outsider), 1);
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) n from social_likes where ai_note_id=$1",
          [sharedId],
        )
      ).rows[0].n,
    ),
    1,
  );
  await client.query("delete from social_comments where id=$1", [sharedId]);
  assert.equal(await countLikes(target), 2);
  await client.query("delete from user_theses where id=$1", [sharedId]);
  assert.equal(await countLikes(target), 1);
  assert.equal(
    Number(
      (
        await client.query("select count(*) n from orders where id=$1", [
          orderId,
        ])
      ).rows[0].n,
    ),
    1,
  );

  // Synthetic-scale index coverage: 10k targets/kind, four likes/target, 2k users.
  await client.query(`insert into users(id)
    select md5('${fixture}:liker:'||sample_idx)::uuid from generate_series(1,2000) sample_idx;
    insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash)
    select md5('${fixture}:target:'||sample_idx)::uuid,'${target}','${fixture}:purchase:'||sample_idx,'${orderId}','${marketId}','${eventId}','fixture','YES','fixture','Thesis','{}','fixture',1,'${fixture}:thesis:'||sample_idx,'fixture'
    from generate_series(1,10000) sample_idx;
    insert into ai_notes(id,note_key,note_type,title,description,source_kind,source_id,producer_type,producer_run_id)
    select md5('${fixture}:target:'||sample_idx)::uuid,'${fixture}:note:'||sample_idx,'signal','Hunch','Description','market','bulk-unrelated-market:'||sample_idx,'holder_research','${fixture}'
    from generate_series(1,10000) sample_idx;
    insert into social_comments(id,author_id,thesis_id,body,idempotency_key,payload_hash)
    select md5('${fixture}:target:'||sample_idx)::uuid,'${target}',md5('${fixture}:target:'||sample_idx)::uuid,'Comment','${fixture}:comment:'||sample_idx,'fixture'
    from generate_series(1,10000) sample_idx;`);
  for (const column of targetColumns)
    await client.query(`insert into social_likes(user_id,${column})
      select md5('${fixture}:liker:'||((sample_idx+liker_idx)%2000+1))::uuid,md5('${fixture}:target:'||sample_idx)::uuid
      from generate_series(1,10000) sample_idx cross join generate_series(1,4) liker_idx`);
  await client.query(
    "analyze social_likes; analyze users; analyze user_theses; analyze ai_notes; analyze social_comments; analyze likes_candidates",
  );
  const indexNames: string[] = [];
  function collectIndexes(plan: Record<string, unknown>) {
    if (typeof plan["Index Name"] === "string")
      indexNames.push(plan["Index Name"]);
    if (Array.isArray(plan.Plans))
      for (const child of plan.Plans) collectIndexes(child);
  }
  for (const [column, index] of [
    ...targetColumns.map((column) => [
      column,
      column === "thesis_id"
        ? "social_likes_thesis_user"
        : column === "ai_note_id"
          ? "social_likes_hunch_user"
          : "social_likes_comment_user",
    ]),
    ["user_id", "social_likes_user"],
  ]) {
    const populatedId = (
      await client.query("select md5($1)::uuid as sample_id", [
        `${fixture}:${column === "user_id" ? "liker" : "target"}:1`,
      ])
    ).rows[0].sample_id;
    await client.query(
      `prepare social_likes_index_fixture(uuid) as select user_id from social_likes where ${column}=$1`,
    );
    for (const cacheMode of ["force_custom_plan", "force_generic_plan"])
      for (const probeId of [populatedId, randomUUID()]) {
        await client.query(`set local plan_cache_mode='${cacheMode}'`);
        const plan = (
          await client.query(
            `explain(analyze,buffers,format json) execute social_likes_index_fixture('${probeId}')`,
          )
        ).rows[0]["QUERY PLAN"][0];
        indexNames.length = 0;
        collectIndexes(plan.Plan);
        assert.ok(
          indexNames.includes(index),
          `${column}: ${JSON.stringify(plan)}`,
        );
        assert.equal(
          plan.Plan["Actual Rows"],
          probeId === populatedId ? (column === "user_id" ? 60 : 4) : 0,
        );
        console.log(
          `[social-likes-lifecycle-integration-tests] ${column} ${cacheMode} ${JSON.stringify({ timeMs: plan["Execution Time"], hits: plan.Plan["Shared Hit Blocks"], reads: plan.Plan["Shared Read Blocks"], rows: plan.Plan["Actual Rows"], indexes: indexNames })}`,
        );
      }
    await client.query("deallocate social_likes_index_fixture");
  }
  for (const [text, values] of lifecycleQueries) {
    const plan = (await client.query(`explain(format json) ${text}`, values))
      .rows[0]["QUERY PLAN"][0];
    indexNames.length = 0;
    collectIndexes(plan.Plan);
    assert.ok(indexNames.includes("social_likes_user"), JSON.stringify(plan));
  }
  await client.query(
    "prepare social_likes_retention_fixture(text) as with scoped_candidates as (select * from likes_candidates where market_id=$1) " +
      socialLikesDerivedRefsSql("scoped_candidates"),
  );
  await client.query("set local plan_cache_mode='force_generic_plan'");
  for (const candidate of [marketId, "missing-market"]) {
    const literal = (
      await client.query(
        "select quote_literal($1::text) as candidate_literal",
        [candidate],
      )
    ).rows[0].candidate_literal;
    const plan = (
      await client.query(
        `explain(analyze,buffers,format json) execute social_likes_retention_fixture(${literal})`,
      )
    ).rows[0]["QUERY PLAN"][0];
    console.log(
      `[social-likes-lifecycle-integration-tests] retention ${candidate === marketId ? "populated" : "empty"} ${JSON.stringify({ timeMs: plan["Execution Time"], hits: plan.Plan["Shared Hit Blocks"], rows: plan.Plan["Actual Rows"] })}`,
    );
  }
  await client.query("deallocate social_likes_retention_fixture");
  await client.query(
    `explain(format json) ${socialLikesMarketDeleteSql("likes_candidates")}`,
  );
  // Execute the complete production report, then inspect its custom/generic plans.
  await client.query(
    "update unified_markets set status='CLOSED',close_time=now()-interval '100 days' where id=$1",
    [marketId],
  );
  let fullReportSql = "";
  const reportClient = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes("derived_refs as materialized")) fullReportSql = text;
      return client.query(text, values);
    },
  } as unknown as typeof client;
  const fullReport = await queryBatchSummary(reportClient, {
    confirmDelete: false,
    execute: false,
    json: true,
    cutoffDays: 30,
    limit: 50000,
    sampleLimit: 20,
    statementTimeoutSec: 15,
    statuses: ["CLOSED"],
    venues: ["limitless"],
  });
  assert.ok(
    fullReport.some(
      (row) => row.label === "social_likes_thesis" && Number(row.rows) >= 40001,
    ),
  );
  assert.ok(
    fullReport.some(
      (row) =>
        row.label === "social_likes_comment" && Number(row.rows) >= 40000,
    ),
  );
  assert.ok(fullReportSql);
  await client.query(
    `prepare social_likes_full_retention_fixture(text[],text[],integer,integer) as ${fullReportSql}`,
  );
  for (const cacheMode of ["force_custom_plan", "force_generic_plan"])
    for (const venue of ["limitless", "empty-fixture-venue"]) {
      await client.query(`set local plan_cache_mode='${cacheMode}'`);
      const plan = (
        await client.query(
          `explain(analyze,buffers,format json) execute social_likes_full_retention_fixture(array['CLOSED'],array['${venue}'],30,50000)`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const scans: Array<Record<string, unknown>> = [];
      const collectScans = (node: Record<string, unknown>) => {
        if (
          typeof node["Relation Name"] === "string" &&
          [
            "social_likes",
            "ai_notes",
            "user_theses",
            "social_comments",
          ].includes(node["Relation Name"])
        )
          scans.push({
            relation: node["Relation Name"],
            index: node["Index Name"],
            rows: node["Actual Rows"],
            loops: node["Actual Loops"],
            filtered: node["Rows Removed by Filter"] ?? 0,
          });
        if (Array.isArray(node.Plans))
          for (const child of node.Plans) collectScans(child);
      };
      collectScans(plan.Plan);
      console.log(
        `[social-likes-lifecycle-integration-tests] full retention ${cacheMode} ${venue} ${JSON.stringify({ timeMs: plan["Execution Time"], hits: plan.Plan["Shared Hit Blocks"], reads: plan.Plan["Shared Read Blocks"], rows: plan.Plan["Actual Rows"], scans })}`,
      );
    }
  await client.query("deallocate social_likes_full_retention_fixture");

  // Exercise the complete post-delete validator: stale derived likes are detected,
  // and the normal scoped cleanup recovers without removing financial history.
  const removedMarketId = `likes-removed-market:${fixture}`;
  const orphanNoteId = await note();
  await client.query("update ai_notes set source_id=$2 where id=$1", [
    orphanNoteId,
    removedMarketId,
  ]);
  await like(outsider, "ai_note_id", orphanNoteId);
  await client.query(`create temporary table tmp_market_retention_removable_markets(market_id text,event_id text,venue text);
    create temporary table tmp_market_retention_protected_ref_tokens(market_id text,token_id text);
    create temporary table tmp_market_retention_orphan_events(event_id text,venue text);`);
  await client.query(
    "insert into tmp_market_retention_removable_markets values($1,$2,'limitless')",
    [removedMarketId, `removed-event:${fixture}`],
  );
  await assert.rejects(
    queryPostDeleteValidation(client),
    /remaining_social_likes_hunch/,
  );
  await client.query(
    socialLikesMarketDeleteSql("tmp_market_retention_removable_markets"),
  );
  await client.query(
    "drop table tmp_market_retention_post_delete_protected_refs",
  );
  const validated = await queryPostDeleteValidation(client);
  assert.ok(
    validated.some(
      (row) => row.label === "remaining_social_likes_hunch" && row.rows === "0",
    ),
  );
  assert.ok(validated.every((row) => row.rows === "0"));
  console.log(
    "[social-likes-lifecycle-integration-tests] PG16 exact typed uniqueness, revision isolation, lifecycle, merge/keepSource/idempotency, retention SQL, cascades and synthetic-scale plans PASS",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
