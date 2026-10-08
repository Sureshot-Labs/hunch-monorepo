import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
// @requires-db
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import { getCopyAttributionStatus } from "./services/social-copy.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";
import {
  socialFeedResponse,
  socialProfileResponse,
  socialThesisSchema,
  socialCopyStatusResponse,
} from "./schemas/social.js";

// The normal integration runner provides DATABASE_URL and an exact expected DB fence; no .env loading.
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const calls: { text: string; values: unknown[] }[] = [];
let savepoint = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin") {
      savepoint++;
      return client.query(`savepoint social_method_${savepoint}`);
    }
    if (text.toLowerCase() === "commit")
      return client.query(`release savepoint social_method_${savepoint--}`);
    if (text.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint social_method_${savepoint}`,
      );
      await client.query(`release savepoint social_method_${savepoint--}`);
      return result;
    }
    calls.push({ text, values });
    return client.query(text, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const positionContract = "0x1111111111111111111111111111111111111111";
const service = new SocialService(db, async () => {}, {
  limitlessPositionContract: positionContract,
});
const key = randomUUID(),
  author = randomUUID(),
  reader = randomUUID(),
  outsider = randomUUID();
const eventId = `social-test-event:${key}`,
  marketId = `social-test-market:${key}`,
  tokenId = `social-test-token:${key}`;
const orderId = randomUUID(),
  purchaseRef = { kind: "order" as const, id: orderId };
const fact = {
  version: 1 as const,
  canonicalPurchaseKey: `test:${key}`,
  instrument: {
    marketId,
    tokenId,
    outcome: "NO" as const,
    generation: `8453:${positionContract}:${tokenId}`,
    expiry: null,
    venue: "limitless" as const,
  },
  owner: `owner:${key}`,
  grossNotionalUsd: "10",
  grossShares: "20",
  netShares: "20",
  entryPrice: "0.5",
  feesUsd: null,
  purchasedAt: new Date().toISOString(),
  evidenceIds: [`evidence:${key}`],
  evidenceRevision: "r1",
  verifiedAt: new Date().toISOString(),
};
try {
  const preflight = await client.query(
    `select current_database() as database,current_setting('server_version_num')::int as version`,
  );
  assert.equal(
    preflight.rows[0].database,
    process.env.HUNCH_TEST_EXPECT_DATABASE,
  );
  assert.ok(
    preflight.rows[0].version >= 160000 && preflight.rows[0].version < 170000,
  );
  await client.query("begin");
  await client.query("set local statement_timeout='10s'");
  // Allow the same rollback-only suite against a disposable DB migrated before the latest index-only revision.
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0272_social_theses.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of migration
    .split(";")
    .map((item) => item.trim())
    .filter((item) =>
      /^create index (?:user_theses_(?:author|market|event)_public_page|copy_attributions_instrument_market|social_reports_(?:reporter|profile_reference))\b/.test(
        item,
      ),
    ))
    await client.query(
      statement.replace("create index ", "create index if not exists "),
    );
  const aiIndexes = await readFile(
    new URL(
      "../../../packages/db/migrations/0275_social_feed_indexes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of aiIndexes
    .split(";")
    .map((item) =>
      item
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^--.*$/gm, "")
        .trim(),
    )
    .filter(Boolean))
    await client.query(
      statement.replace("create index concurrently", "create index"),
    );
  await client.query(
    `insert into users(id,display_name) values($1,'Author'),($2,'Reader'),($3,'Outsider')`,
    [author, reader, outsider],
  );
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Social fixture','ACTIVE')`,
    [eventId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'Social fixture','ACTIVE','binary','["Over","Under"]')`,
    [marketId, eventId],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'NO')`,
    [tokenId, marketId],
  );
  await client.query(
    `insert into unified_token_top_latest(token_id,venue,ts,mid) values($1,'limitless',now(),'0.6')`,
    [tokenId],
  );
  await client.query(
    `insert into orders(id,user_id,status,verified_buy_state,verified_buy_facts) values($1,$2,'filled','verified',$3::jsonb)`,
    [orderId, author, JSON.stringify(fact)],
  );
  const handle = `a_${key.slice(0, 8)}`;
  assert.equal(
    (await service.handleAvailability(reader, handle)).available,
    true,
  );
  socialProfileResponse.parse(
    await service.updateProfile(author, {
      handle,
      displayName: "Fixture author",
      bio: "👩🏽‍🚀",
    }),
  );
  assert.equal(
    (await service.handleAvailability(reader, handle.toUpperCase())).available,
    false,
  );
  await assert.rejects(
    () => service.updateProfile(reader, { handle }),
    /handle_taken/,
  );
  assert.equal(
    (await service.profileByHandle(reader, handle)).profile.id,
    author,
  );
  assert.equal((await service.eligibility(author, purchaseRef)).eligible, true);
  assert.equal(
    (await service.eligibility(reader, purchaseRef)).state,
    "missing",
  );
  assert.deepEqual(await service.refreshEligibility(author, purchaseRef), {
    ok: true,
  });
  await assert.rejects(
    () => service.refreshEligibility(reader, purchaseRef),
    /purchase_not_found/,
  );
  const publication = {
    purchaseRef,
    body: "A contract-specific fixture",
    idempotencyKey: randomUUID(),
  };
  const thesis = socialThesisSchema.parse(
    await service.publish(author, publication),
  );
  assert.equal(thesis.position.pnlUsd, "2");
  assert.equal(thesis.instrument.outcomeLabel, "Under");
  const copyKeys = [randomUUID(), randomUUID(), randomUUID()] as const;
  for (const [index, copier] of [reader, reader, author].entries())
    await client.query(
      `insert into copy_attributions(copier_user_id,source_thesis_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,canonical_purchase_key,state)
    values($1,$2,'{}',$3::jsonb,$4,'fixture','fixture',$4,$4,'confirmed')`,
      [copier, thesis.id, JSON.stringify(fact.instrument), copyKeys[index]],
    );
  const savedCopy = socialCopyStatusResponse.parse(
    await getCopyAttributionStatus(db, reader, copyKeys[0]),
  );
  assert.equal(savedCopy.state, "confirmed");
  assert.deepEqual(savedCopy.sourceRef, { kind: "thesis", id: thesis.id });
  assert.equal(await getCopyAttributionStatus(db, outsider, copyKeys[0]), null);
  assert.equal(await getCopyAttributionStatus(db, reader, randomUUID()), null);
  assert.equal(
    (await service.getThesis(reader, thesis.id)).copyCount,
    1,
    "count distinct other people, not trades or self buys",
  );
  await client.query(
    `update copy_attributions set state='revoked' where source_thesis_id=$1 and copier_user_id=$2`,
    [thesis.id, reader],
  );
  assert.equal(
    (await service.getThesis(reader, thesis.id)).copyCount,
    0,
    "revoked evidence does not count",
  );
  await client.query(
    `update unified_token_top_latest set ts=now()+interval '1 day' where token_id=$1`,
    [tokenId],
  );
  assert.equal(
    (await service.getThesis(reader, thesis.id)).position.markPrice,
    null,
    "future quotes are not a mark",
  );
  await client.query(
    `update unified_token_top_latest set ts=now()-interval '1 day' where token_id=$1`,
    [tokenId],
  );
  assert.equal(
    (await service.getThesis(reader, thesis.id)).position.markPrice,
    null,
    "stale quotes are not a mark",
  );
  await client.query(
    `update unified_token_top_latest set ts=now() where token_id=$1`,
    [tokenId],
  );
  assert.equal((await service.publish(author, publication)).id, thesis.id);
  await assert.rejects(
    () => service.publish(author, { ...publication, body: "changed" }),
    /idempotency_conflict/,
  );
  await assert.rejects(
    () =>
      service.publish(author, { ...publication, idempotencyKey: randomUUID() }),
    /purchase_already_published/,
  );
  assert.equal(
    (await service.eligibility(author, purchaseRef)).existingThesisId,
    thesis.id,
  );
  await service.setFollow(reader, author, true);
  await service.setFollow(reader, author, true);
  assert.equal(
    (await service.listProfiles(reader, { kind: "following", userId: reader }))
      .items.length,
    1,
  );
  assert.equal(
    (await service.listProfiles(author, { kind: "followers", userId: author }))
      .items.length,
    1,
  );
  assert.equal(
    (await service.listProfiles(outsider, { kind: "suggestions" })).items.some(
      (item) => item.id === author,
    ),
    true,
  );
  const comment = {
    target: { kind: "thesis" as const, id: thesis.id },
    body: "A question",
    idempotencyKey: randomUUID(),
  };
  const created = await service.createComment(reader, comment);
  assert.equal((await service.createComment(reader, comment)).id, created.id);
  await assert.rejects(
    () => service.createComment(reader, { ...comment, body: "changed" }),
    /idempotency_conflict/,
  );
  const comments = await service.listComments(author, {
    targetKind: "thesis",
    targetId: thesis.id,
    limit: 1,
  });
  assert.equal(comments.items[0]?.id, created.id);
  await service.report(reader, {
    targetKind: "profile",
    targetId: author,
    reason: "fixture",
  });
  await service.report(reader, {
    targetKind: "thesis",
    targetId: thesis.id,
    reason: "fixture",
  });
  await service.report(author, {
    targetKind: "comment",
    targetId: created.id,
    reason: "fixture",
  });
  const report = await service.report(author, {
    targetKind: "comment",
    targetId: created.id,
    reason: "again",
  });
  assert.ok(report.id);
  await service.setBlock(author, reader, true);
  assert.equal(
    (await service.listProfiles(author, { kind: "blocked" })).items.length,
    1,
  );
  await assert.rejects(
    () => service.getThesis(reader, thesis.id),
    /thesis_not_found/,
  );
  await assert.rejects(
    () => service.setFollow(reader, author, true),
    /profile_not_found/,
  );
  await service.setBlock(author, reader, false);
  assert.equal(
    (await service.getProfile(reader, author)).profile.isFollowing,
    false,
  );
  await service.setFollow(reader, author, true);
  const aiRoot = randomUUID(),
    aiUpdate = randomUUID(),
    aiContext = randomUUID();
  const publicationMetrics = {
    publicationDecisionV1: {
      status: "PUBLISH",
      authority: "holder_research_quality_gate",
    },
    hunchStrengthV1: { grade: "good" },
  };
  for (const [id, type, root, status] of [
    [aiRoot, "signal", aiRoot, "superseded"],
    [aiUpdate, "signal", aiRoot, "active"],
    [aiContext, "context", null, "active"],
  ])
    await client.query(
      `insert into ai_notes(id,note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id,lineage,metrics,created_at)
    values($1::uuid,$1::text,$2,$3,'Test','Test summary','market',$4,'holder_research','fixture',$5::jsonb,$6::jsonb,'2026-10-08 12:00:00.123456+00')`,
      [
        id,
        type,
        status,
        marketId,
        JSON.stringify({
          side: "NO",
          thesis_key: key,
          thesis_root_note_id: root,
        }),
        JSON.stringify(
          type === "context" ? { publicContextV1: {} } : publicationMetrics,
        ),
      ],
    );
  const aiComment = await service.createComment(reader, {
    target: { kind: "hunch", id: aiUpdate },
    body: "About this update",
    idempotencyKey: randomUUID(),
  });
  const legacyAi = await service.feed(reader, {
    mode: "all",
    source: "hunch",
    marketId,
  });
  assert.ok(
    legacyAi.items.every((item) => item.kind !== "hunch" || !item.canCopy),
  );
  await client.query(
    `update ai_notes set metrics=jsonb_set(metrics,'{socialInstrumentV1}',$2::jsonb) where id=$1`,
    [aiUpdate, JSON.stringify(fact.instrument)],
  );
  const enrichedAi = await service.feed(reader, {
    mode: "all",
    source: "hunch",
    marketId,
  });
  assert.equal(
    enrichedAi.items.find((item) => item.id === aiUpdate)?.canCopy,
    true,
  );
  assert.equal(
    (
      await service.listComments(reader, {
        targetKind: "hunch",
        targetId: aiRoot,
      })
    ).items[0]?.id,
    aiComment.id,
  );
  await client.query(`update ai_notes set status='retracted' where id=$1`, [
    aiUpdate,
  ]);
  assert.equal(
    (
      await service.listComments(reader, {
        targetKind: "hunch",
        targetId: aiRoot,
      })
    ).items[0]?.revisionAvailable,
    false,
  );
  await client.query(
    "update user_theses set published_at='2026-10-08 12:00:00.123456+00' where id=$1",
    [thesis.id],
  );
  const feedArgs = {
    mode: "all" as const,
    source: "all" as const,
    marketId,
    limit: 1,
  };
  let page = await service.feed(reader, feedArgs);
  let pages = 0;
  const ids = new Set<string>();
  while (page.items.length) {
    socialFeedResponse.parse(page);
    for (const item of page.items) {
      assert.equal(ids.has(item.id), false);
      ids.add(item.id);
    }
    pages++;
    if (!page.nextCursor) break;
    page = await service.feed(reader, { ...feedArgs, cursor: page.nextCursor });
  }
  assert.equal(ids.size, 3);
  assert.equal(pages, 3);
  assert.equal(
    (await service.feed(reader, { mode: "following", source: "all", marketId }))
      .items.length,
    1,
  );
  assert.equal(
    (
      await service.feed(outsider, {
        mode: "following",
        source: "all",
        marketId,
      })
    ).items.length,
    0,
  );
  assert.equal(
    (await service.feed(null, { mode: "all", source: "hunch", marketId })).items
      .length,
    2,
  );
  await service.hideComment(reader, created.id);
  assert.equal(
    (
      await service.listComments(author, {
        targetKind: "thesis",
        targetId: thesis.id,
      })
    ).items.length,
    0,
  );
  await service.hideThesis(author, thesis.id);
  await client.query(
    `update unified_markets set status='CLOSED',resolved_outcome='YES' where id=$1`,
    [marketId],
  );
  assert.equal(
    (await service.profileStatistics(author)).losses,
    1,
    "author-hidden loss remains in profile statistics",
  );
  assert.equal(
    (await service.getThesis(author, thesis.id, true)).position.state,
    "loss",
  );
  await assert.rejects(
    () => service.getThesis(reader, thesis.id),
    /thesis_not_found/,
  );
  await client.query(
    `update user_theses set proof_invalidated_at=now() where id=$1`,
    [thesis.id],
  );
  assert.equal((await service.profileStatistics(author)).invalidated, 1);
  await client.query(
    `insert into runtime_policies(policy_key,effective_at,payload) values('social',now(),$1::jsonb)`,
    [JSON.stringify({ ...DEFAULT_SOCIAL_POLICY, minimumNotionalUsd: "100" })],
  );
  assert.equal(
    (await service.publish(author, publication)).id,
    thesis.id,
    "retry survives changed threshold and hidden/invalidated publication",
  );
  assert.equal(
    (await getCopyAttributionStatus(db, reader, copyKeys[0]))?.state,
    "revoked",
    "owner can recover saved Copy status after source hide and policy changes",
  );
  await service.setFollow(reader, author, false);
  const scale = Number(process.env.SOCIAL_TEST_SCALE ?? 0);
  assert.ok(
    Number.isInteger(scale) && scale >= 0 && scale <= 1_000_000,
    "fixture scale must be explicitly bounded",
  );
  if (scale) {
    await client.query("set local statement_timeout='60s'");
    await client.query(
      `insert into user_theses(author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,published_at)
      select $1,'scale:'||$2::text||':'||g.seq,$3,$4,$5,$6,'NO','test','Scale fixture',$7::jsonb,'test',10,g.seq::text,'test',now()-g.seq*interval '1 microsecond'
      from generate_series(1,$8::int) as g(seq)`,
      [
        outsider,
        key,
        orderId,
        marketId,
        eventId,
        tokenId,
        JSON.stringify(fact),
        scale,
      ],
    );
    await client.query("analyze user_theses");
    await client.query("analyze users");
    await client.query(
      `insert into ai_notes(note_key,note_type,title,description,source_kind,source_id,producer_type,producer_run_id,created_at)
      select 'scale-ai:'||$1::text||':'||g.seq,'context','Not public','Fixture','market',$2,'other_producer','fixture',now()-g.seq*interval '1 microsecond'
      from generate_series(1,$3::int) as g(seq)`,
      [key, marketId, scale],
    );
    await client.query("analyze ai_notes");
    const emptyMarketId = `empty:${key}`;
    await client.query(
      `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type) values($1,'limitless',$1,$2,'Empty fixture','ACTIVE','binary')`,
      [emptyMarketId, eventId],
    );
    const scenarios = [
      {
        name: "first",
        args: {
          mode: "all" as const,
          source: "all" as const,
          marketId,
          limit: 20,
        },
      },
      {
        name: "sparse_following",
        args: {
          mode: "following" as const,
          source: "all" as const,
          marketId,
          limit: 20,
        },
      },
      {
        name: "empty_market",
        args: {
          mode: "all" as const,
          source: "all" as const,
          marketId: `missing:${key}`,
          limit: 20,
        },
      },
      {
        name: "existing_empty_market",
        args: {
          mode: "all" as const,
          source: "all" as const,
          marketId: emptyMarketId,
          limit: 20,
        },
      },
      {
        name: "event",
        args: {
          mode: "all" as const,
          source: "all" as const,
          eventId,
          limit: 20,
        },
      },
      {
        name: "global",
        args: { mode: "all" as const, source: "all" as const, limit: 20 },
      },
    ];
    for (const scenario of scenarios) {
      const before = calls.length;
      const first = await service.feed(reader, scenario.args);
      if (first.nextCursor)
        await service.feed(reader, {
          ...scenario.args,
          cursor: first.nextCursor,
        });
      const queries = calls
        .slice(before)
        .filter((call) => call.text.startsWith("with chosen"));
      for (const [pageIndex, call] of queries.entries()) {
        for (const generic of [false, true]) {
          if (generic) {
            await client.query("set local plan_cache_mode=force_generic_plan");
            await client.query(
              `prepare social_feed_fixture(uuid,text,text,uuid,timestamptz,text,uuid,int) as ${call.text}`,
            );
          }
          // PREPARE/EXECUTE uses literals produced by Postgres itself, never concatenated user text.
          let explained;
          if (generic) {
            const literals = await client.query(
              `select array_agg(quote_nullable(arg_value) order by arg_index) as args from unnest($1::text[]) with ordinality as v(arg_value,arg_index)`,
              [call.values],
            );
            explained = await client.query(
              `explain (analyze,buffers,format json) execute social_feed_fixture(${literals.rows[0].args.join(",")})`,
            );
            await client.query("deallocate social_feed_fixture");
            await client.query("set local plan_cache_mode=auto");
          } else
            explained = await client.query(
              `explain (analyze,buffers,format json) ${call.text}`,
              call.values,
            );
          const plan = explained.rows[0]["QUERY PLAN"][0];
          const scans: unknown[] = [];
          const visit = (node: Record<string, unknown>) => {
            if (node["Relation Name"])
              scans.push({
                table: node["Relation Name"],
                type: node["Node Type"],
                index: node["Index Name"] ?? null,
                rows: node["Actual Rows"],
                loops: node["Actual Loops"],
                removed: node["Rows Removed by Filter"] ?? 0,
              });
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              visit(child);
          };
          visit(plan.Plan);
          console.log(
            JSON.stringify({
              scenario: scenario.name,
              page: pageIndex,
              generic,
              fixtureRows: scale,
              executionMs: plan["Execution Time"],
              sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
              sharedReadBlocks: plan.Plan["Shared Read Blocks"],
              scans,
            }),
          );
        }
      }
    }
  }
  // Every executed SELECT is parsed/planned with its actual parameter types on PG16.
  let planned = 0;
  for (const call of calls) {
    if (
      !/^\s*(?:select|with)/i.test(call.text) ||
      /for update|for share/i.test(call.text)
    )
      continue;
    await client.query(`explain (format json) ${call.text}`, call.values);
    planned++;
  }
  console.log(
    JSON.stringify({
      ok: true,
      executedStatements: calls.length,
      plannedSelects: planned,
      coverage: [
        "profile",
        "handle_collision",
        "publication_replay",
        "eligibility_refresh",
        "follows",
        "blocks",
        "suggestions",
        "comments",
        "reports",
        "ai_lineage",
        "retraction",
        "microsecond_cursor",
        "following_sparse",
        "hidden_loss",
        "invalidated",
        "policy_change_retry",
      ],
    }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}

// A real max:1 pool must not wait for a second connection while report() holds
// its actor lock. Session-local tables avoid leaving committed test fixtures.
const singlePool = await createIntegrationTestPool({ max: 1 });
singlePool.options.connectionTimeoutMillis = 1_000;
try {
  for (const table of [
    "users",
    "user_blocks",
    "runtime_policies",
    "social_reports",
  ])
    await singlePool.query(
      `create temporary table ${table} (like public.${table} including all)`,
    );
  await singlePool.query(
    "insert into users(id,display_name) values($1,'Reporter'),($2,'Target')",
    [reader, author],
  );
  const isolatedService = new SocialService(singlePool);
  const saved = await isolatedService.report(reader, {
    targetKind: "profile",
    targetId: author,
    reason: "Single connection regression",
  });
  assert.ok(saved.id);
  assert.equal(singlePool.totalCount, 1);
  assert.equal(singlePool.waitingCount, 0);
  await singlePool.query(
    "insert into user_blocks(blocker_user_id,blocked_user_id) values($1,$2)",
    [author, reader],
  );
  await assert.rejects(
    () =>
      isolatedService.report(reader, {
        targetKind: "profile",
        targetId: author,
        reason: "Blocked profile",
      }),
    /profile_not_found/,
  );
  console.log(
    "ok - profile report uses only its transaction connection with PostgreSQL pool max=1",
  );
} finally {
  await singlePool.end();
}
