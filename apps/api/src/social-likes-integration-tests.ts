// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { SocialService } from "./services/social-service.js";
import {
  socialCommentsResponse,
  socialFeedResponse,
  socialThesisSchema,
} from "./schemas/social.js";

// Rollback-only fixtures, with the standard explicit disposable-database fence.
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const calls: { text: string; values: unknown[] }[] = [];
let savepoint = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin")
      return client.query(`savepoint like_method_${++savepoint}`);
    if (text.toLowerCase() === "commit")
      return client.query(`release savepoint like_method_${savepoint--}`);
    if (text.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint like_method_${savepoint}`,
      );
      await client.query(`release savepoint like_method_${savepoint--}`);
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
const writeCalls: { kind: string; maximum: number }[] = [];
const positionContract = "0x1111111111111111111111111111111111111111";
const service = new SocialService(
  db,
  async (_userId, policy, kind) => {
    writeCalls.push({ kind, maximum: policy.likeRateLimit });
  },
  { limitlessPositionContract: positionContract },
);
const author = randomUUID(),
  reader = randomUUID(),
  other = randomUUID();
const key = randomUUID(),
  orderId = randomUUID();
const marketId = `social-likes-market:${key}`,
  eventId = `social-likes-event:${key}`,
  tokenId = `social-likes-token:${key}`;
const facts = {
  version: 1,
  canonicalPurchaseKey: `likes:${key}`,
  instrument: {
    marketId,
    tokenId,
    outcome: "YES",
    generation: `8453:${positionContract}:${tokenId}`,
    expiry: null,
    venue: "limitless",
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
const rootId = randomUUID(),
  updateId = randomUUID(),
  siblingId = randomUUID(),
  contextId = randomUUID(),
  privateId = randomUUID();
const policyId = randomUUID();
async function policy(payload: object) {
  await client.query(
    `update runtime_policies set payload=$2::jsonb where id=$1`,
    [policyId, JSON.stringify(payload)],
  );
}
async function expectedLikeCount(
  target: { kind: "thesis" | "hunch" | "comment"; id: string },
  count: number,
) {
  const column = {
    thesis: "thesis_id",
    hunch: "ai_note_id",
    comment: "comment_id",
  }[target.kind];
  const result = await client.query(
    `select count(*)::int as total from social_likes where ${column}=$1`,
    [target.id],
  );
  assert.equal(result.rows[0].total, count);
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
  await client.query("begin");
  await client.query("set local statement_timeout='10s'");
  await client.query(
    `insert into users(id,display_name) values($1,'Author'),($2,'Reader'),($3,'Other')`,
    [author, reader, other],
  );
  await client.query(
    `insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'social',now(),'{}')`,
    [policyId],
  );
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Likes fixture','ACTIVE')`,
    [eventId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'Likes fixture','ACTIVE','binary','["YES","NO"]')`,
    [marketId, eventId],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')`,
    [tokenId, marketId],
  );
  await client.query(
    `insert into orders(id,user_id,status,verified_buy_state,verified_buy_facts) values($1,$2,'filled','verified',$3::jsonb)`,
    [orderId, author, JSON.stringify(facts)],
  );
  const thesis = await service.publish(author, {
    purchaseRef: { kind: "order", id: orderId },
    body: "Likeable thesis",
    idempotencyKey: randomUUID(),
  });
  const thesisTarget = { kind: "thesis" as const, id: thesis.id };
  for (const [id, type] of [
    [rootId, "signal"],
    [updateId, "signal"],
    [siblingId, "signal"],
    [contextId, "context"],
    [privateId, "signal"],
  ]) {
    await client.query(
      `insert into ai_notes(id,note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id,lineage,metrics)
      values($1::uuid,$1::text,$2,'active','Likeable note','Summary','market',$3,'holder_research','fixture',$4::jsonb,$5::jsonb)`,
      [
        id,
        type,
        marketId,
        JSON.stringify({
          side: "YES",
          thesis_key: key,
          thesis_root_note_id: rootId,
        }),
        JSON.stringify(
          id === privateId
            ? {}
            : type === "context"
              ? { publicContextV1: {} }
              : {
                  publicationDecisionV1: {
                    status: "PUBLISH",
                    authority: "holder_research_quality_gate",
                  },
                },
        ),
      ],
    );
  }
  const comment = await service.createComment(author, {
    target: thesisTarget,
    body: "Flat comment",
    idempotencyKey: randomUUID(),
  });
  const commentTarget = { kind: "comment" as const, id: comment.id };
  const hunchTarget = { kind: "hunch" as const, id: updateId };
  const targets = [thesisTarget, hunchTarget, commentTarget];
  writeCalls.length = 0;
  for (const target of targets) {
    assert.deepEqual(await service.setLike(reader, target, true), { ok: true });
    assert.deepEqual(await service.setLike(reader, target, true), { ok: true });
    await expectedLikeCount(target, 1);
    await service.setLike(other, target, true);
    await expectedLikeCount(target, 2);
    await service.setLike(reader, target, false);
    await service.setLike(reader, target, false);
    await expectedLikeCount(target, 1);
    await service.setLike(reader, target, true);
  }
  assert.equal(
    writeCalls.length,
    9,
    "only newly inserted likes consume rate budget",
  );
  assert.ok(
    writeCalls.every((item) => item.kind === "like" && item.maximum === 120),
  );
  await service.setLike(author, thesisTarget, true);
  assert.equal(
    (await service.getThesis(author, thesis.id)).likeCount,
    3,
    "self likes allowed",
  );
  await service.setLike(author, thesisTarget, false);

  const assertMapper = (
    item: { likeCount: number; isLiked: boolean } | undefined,
    liked = true,
  ) => {
    assert.ok(item);
    assert.equal(item.likeCount, 2);
    assert.equal(item.isLiked, liked);
    assert.equal("likers" in item, false);
    assert.equal("likes" in item, false);
  };
  assertMapper(
    socialThesisSchema.parse(await service.getThesis(reader, thesis.id)),
  );
  assertMapper(
    socialThesisSchema.parse(await service.getThesis(null, thesis.id)),
    false,
  );
  for (const filters of [{}, { authorId: author }, { marketId }, { eventId }]) {
    const page = socialFeedResponse.parse(
      await service.feed(reader, { mode: "all", source: "thesis", ...filters }),
    );
    assertMapper(page.items.find((item) => item.id === thesis.id));
  }
  await service.setFollow(reader, author, true);
  assertMapper(
    (
      await service.feed(reader, { mode: "following", source: "thesis" })
    ).items.find((item) => item.id === thesis.id),
  );
  const ai = socialFeedResponse.parse(
    await service.feed(reader, { mode: "all", source: "hunch", marketId }),
  );
  assertMapper(ai.items.find((item) => item.id === updateId));
  assert.equal(
    ai.items.find((item) => item.id === rootId)?.likeCount,
    0,
    "AI update likes never roll up to the root",
  );
  assert.equal(ai.items.find((item) => item.id === siblingId)?.isLiked, false);
  assertMapper(
    socialCommentsResponse.parse(
      await service.listComments(reader, {
        targetKind: "thesis",
        targetId: thesis.id,
      }),
    ).items[0],
  );
  assertMapper(
    (
      await service.listComments(null, {
        targetKind: "thesis",
        targetId: thesis.id,
      })
    ).items[0],
    false,
  );
  assert.equal(
    (
      await service.feed(null, { mode: "all", source: "hunch", marketId })
    ).items.find((item) => item.id === updateId)?.isLiked,
    false,
  );
  await service.setLike(reader, { kind: "hunch", id: contextId }, true);
  assert.equal(
    (
      await service.feed(reader, { mode: "all", source: "hunch", marketId })
    ).items.find((item) => item.id === contextId)?.likeCount,
    1,
  );
  await assert.rejects(
    () => service.setLike(reader, { kind: "hunch", id: privateId }, true),
    /hunch_not_found/,
  );

  // Active but socially suspended likers are excluded from counts, while their
  // saved state remains available to them for unlike/retry recovery.
  await client.query(`update users set social_suspended_at=now() where id=$1`, [
    reader,
  ]);
  const suspended = await service.getThesis(reader, thesis.id);
  assert.equal(suspended.likeCount, 1);
  assert.equal(suspended.isLiked, true);
  for (const target of targets) {
    await service.setLike(reader, target, true);
    await service.setLike(reader, target, false);
    await assert.rejects(
      () => service.setLike(reader, target, true),
      /social_suspended/,
    );
  }
  await client.query(`update users set social_suspended_at=null where id=$1`, [
    reader,
  ]);
  await client.query(`update users set is_active=false where id=$1`, [other]);
  assert.equal((await service.getThesis(reader, thesis.id)).likeCount, 0);
  await assert.rejects(
    () => service.setLike(other, thesisTarget, false),
    /user_unavailable/,
  );
  await client.query(`update users set is_active=true where id=$1`, [other]);

  // Both block directions apply to post authors, comment authors and the
  // author of a comment's thesis, using the same actor row lock as setBlock.
  for (const [blocker, blocked] of [
    [reader, author],
    [author, reader],
  ]) {
    await service.setBlock(blocker, blocked, true);
    for (const target of [thesisTarget, commentTarget])
      await assert.rejects(
        () => service.setLike(reader, target, true),
        /(?:thesis|comment)_not_found/,
      );
    await service.setBlock(blocker, blocked, false);
  }
  const otherComment = await service.createComment(other, {
    target: thesisTarget,
    body: "Other author's comment",
    idempotencyKey: randomUUID(),
  });
  await service.setBlock(reader, author, true);
  await assert.rejects(
    () =>
      service.setLike(reader, { kind: "comment", id: otherComment.id }, true),
    /thesis_not_found/,
  );
  await service.setBlock(reader, author, false);

  for (const hidden of [
    "author_hidden_at",
    "moderation_hidden_at",
    "proof_invalidated_at",
  ]) {
    await client.query(`update user_theses set ${hidden}=now() where id=$1`, [
      thesis.id,
    ]);
    await assert.rejects(
      () => service.setLike(reader, thesisTarget, true),
      /thesis_not_found/,
    );
    await assert.rejects(
      () => service.setLike(reader, commentTarget, true),
      /thesis_not_found/,
    );
    await client.query(`update user_theses set ${hidden}=null where id=$1`, [
      thesis.id,
    ]);
  }
  for (const hidden of ["author_hidden_at", "moderation_hidden_at"]) {
    await client.query(
      `update social_comments set ${hidden}=now() where id=$1`,
      [comment.id],
    );
    await assert.rejects(
      () => service.setLike(reader, commentTarget, true),
      /comment_not_found/,
    );
    await client.query(
      `update social_comments set ${hidden}=null where id=$1`,
      [comment.id],
    );
  }
  await client.query(`update users set social_suspended_at=now() where id=$1`, [
    author,
  ]);
  await assert.rejects(
    () => service.setLike(reader, thesisTarget, true),
    /thesis_not_found/,
  );
  await assert.rejects(
    () => service.setLike(reader, commentTarget, true),
    /comment_not_found/,
  );
  await client.query(`update users set social_suspended_at=null where id=$1`, [
    author,
  ]);

  const aiComment = await service.createComment(author, {
    target: hunchTarget,
    body: "Observed update",
    idempotencyKey: randomUUID(),
  });
  const aiCommentTarget = { kind: "comment" as const, id: aiComment.id };
  await client.query(`update ai_notes set status='retracted' where id=$1`, [
    updateId,
  ]);
  await assert.rejects(
    () => service.setLike(reader, hunchTarget, true),
    /hunch_not_found/,
  );
  await service.setLike(reader, aiCommentTarget, true);
  assert.equal(
    (
      await service.listComments(reader, {
        targetKind: "hunch",
        targetId: rootId,
      })
    ).items[0].revisionAvailable,
    false,
  );
  assert.ok(
    (
      await service.report(reader, {
        targetKind: "comment",
        targetId: aiComment.id,
        reason: "Still visible discussion",
      })
    ).id,
  );
  await service.setLike(reader, aiCommentTarget, false);
  await client.query(`update ai_notes set status='retracted' where id=$1`, [
    rootId,
  ]);
  await service.setLike(reader, aiCommentTarget, true);
  assert.ok(
    (
      await service.report(reader, {
        targetKind: "comment",
        targetId: aiComment.id,
        reason: "Sibling grants thread access",
      })
    ).id,
  );
  await service.setLike(reader, aiCommentTarget, false);
  await client.query(`update ai_notes set status='retracted' where id=$1`, [
    siblingId,
  ]);
  await assert.rejects(
    () => service.setLike(reader, aiCommentTarget, true),
    /hunch_not_found/,
  );
  await assert.rejects(
    () =>
      service.report(reader, {
        targetKind: "comment",
        targetId: aiComment.id,
        reason: "No accessible thread",
      }),
    /hunch_not_found/,
  );
  await client.query(
    `update ai_notes set status='active' where id=any($1::uuid[])`,
    [[rootId, updateId, siblingId]],
  );

  // Policy failure, disabled likes and suspended/hidden/blocked content do not
  // prevent safe retries or removing an interaction. New likes still fail.
  for (const override of [
    { likesEnabled: false },
    { enabled: false },
    { likeRateLimit: 0 },
  ]) {
    for (const target of targets) await service.setLike(reader, target, true);
    await policy(override);
    const before: number = writeCalls.length;
    for (const target of targets) {
      await service.setLike(reader, target, true);
      await service.setLike(reader, target, false);
      await service.setLike(reader, target, false);
      await assert.rejects(
        () => service.setLike(reader, target, true),
        /(?:likes_disabled|Social policy is temporarily unavailable)/,
      );
    }
    assert.equal(writeCalls.length, before);
    await policy({});
  }
  await policy({ likeRateLimit: 7 });
  await service.setLike(reader, thesisTarget, true);
  assert.deepEqual(writeCalls.at(-1), { kind: "like", maximum: 7 });
  await service.setBlock(reader, author, true);
  await service.setLike(reader, thesisTarget, true);
  await service.setLike(reader, thesisTarget, false);
  await service.setBlock(reader, author, false);
  await service.setLike(reader, thesisTarget, true);
  await service.hideThesis(author, thesis.id);
  await service.setLike(reader, thesisTarget, true);
  await service.setLike(reader, thesisTarget, false);
  await service.setLike(other, hunchTarget, true);
  await client.query(`update ai_notes set status='retracted' where id=$1`, [
    updateId,
  ]);
  await service.setLike(other, hunchTarget, true);
  await service.setLike(other, hunchTarget, false);
  await client.query(`update ai_notes set status='active' where id=$1`, [
    updateId,
  ]);
  await client.query(
    `update user_theses set author_hidden_at=null where id=$1`,
    [thesis.id],
  );
  await policy({});

  // Optional bounded unrelated-like population makes sparse hydration plan
  // regressions visible without changing or scanning production data.
  const scale = Number(process.env.SOCIAL_LIKES_TEST_SCALE ?? 0);
  assert.ok(Number.isInteger(scale) && scale >= 0 && scale <= 100_000);
  if (scale) {
    await client.query("set local statement_timeout='30s'");
    await client.query(
      `insert into users(id) select md5($1::text || fixture.number::text)::uuid from generate_series(1,$2::int) fixture(number)`,
      [key, scale],
    );
    await client.query(
      `insert into social_likes(user_id,ai_note_id) select md5($1::text || fixture.number::text)::uuid,$3::uuid from generate_series(1,$2::int) fixture(number)`,
      [key, scale, privateId],
    );
    await client.query("analyze social_likes");
    await client.query("analyze users");
    await service.setLike(reader, hunchTarget, true);
    calls.length = 0;
    await service.getThesis(reader, thesis.id);
    await service.feed(reader, {
      mode: "all",
      source: "hunch",
      marketId,
      limit: 2,
    });
    await service.listComments(reader, {
      targetKind: "thesis",
      targetId: thesis.id,
      limit: 1,
    });
    const hydration = calls.filter((call) =>
      call.text.includes("as like_count"),
    );
    assert.equal(hydration.length, 3);
    await client.query(`update ai_notes set metrics=$2::jsonb where id=$1`, [
      privateId,
      JSON.stringify({
        publicationDecisionV1: {
          status: "PUBLISH",
          authority: "holder_research_quality_gate",
        },
      }),
    ]);
    for (const [index, call] of hydration.entries()) {
      const scenarios =
        index === 1
          ? [
              { name: "sparse", values: [reader, [updateId]] },
              { name: "empty", values: [reader, [rootId]] },
              { name: "popular", values: [reader, [privateId]] },
            ]
          : [{ name: "selected", values: call.values }];
      for (const scenario of scenarios)
        for (const generic of [false, true]) {
          let plan;
          if (generic) {
            await client.query("set local plan_cache_mode=force_generic_plan");
            await client.query(
              `prepare likes_hydration_fixture as ${call.text}`,
            );
            const literals: string[] = [];
            for (const value of scenario.values) {
              const literal = await client.query(
                "select quote_nullable($1::text) as parameter_literal",
                [value],
              );
              literals.push(literal.rows[0].parameter_literal);
            }
            plan = await client.query(
              `explain (analyze,buffers,format json) execute likes_hydration_fixture(${literals.join(",")})`,
            );
            await client.query("deallocate likes_hydration_fixture");
            await client.query("set local plan_cache_mode=auto");
          } else
            plan = await client.query(
              `explain (analyze,buffers,format json) ${call.text}`,
              scenario.values,
            );
          const details = plan.rows[0]["QUERY PLAN"][0];
          assert.match(
            JSON.stringify(details.Plan),
            /social_likes_(?:thesis|hunch|comment)_user/,
          );
          const likeScans: object[] = [];
          const inspect = (node: Record<string, unknown>) => {
            if (
              node["Relation Name"] === "social_likes" ||
              node.Alias === "liker"
            ) {
              assert.notEqual(node["Node Type"], "Seq Scan");
              likeScans.push({
                index: node["Index Name"],
                rows: node["Actual Rows"],
                loops: node["Actual Loops"],
                removed: node["Rows Removed by Filter"] ?? 0,
                hits: node["Shared Hit Blocks"],
                reads: node["Shared Read Blocks"],
              });
            }
            for (const child of (node.Plans ?? []) as Record<string, unknown>[])
              inspect(child);
          };
          inspect(details.Plan);
          console.log(
            JSON.stringify({
              likesHydration: index,
              scenario: scenario.name,
              generic,
              fixtureLikes: scale,
              executionMs: details["Execution Time"],
              hits: details.Plan["Shared Hit Blocks"],
              reads: details.Plan["Shared Read Blocks"],
              likeScans,
            }),
          );
        }
    }
  }
  console.log(
    "ok - likes for theses, exact public AI revisions and flat comments; idempotency, visibility, policy recovery and bounded mappers",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
