// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  SocialService,
  type SocialFeedInput,
} from "./services/social-service.js";
import {
  decodeSocialCursor,
  encodeSocialCursor,
  socialFingerprint,
} from "./services/social-primitives.js";

// Rollback-only fixtures. Set SOCIAL_FOLLOWING_TEST_SCALE=200000 to reproduce
// followed-author history competing with 100000 unrelated authors' scope rows.
const scale = Number(process.env.SOCIAL_FOLLOWING_TEST_SCALE ?? 0);
assert.ok(Number.isInteger(scale) && scale >= 0 && scale <= 1_000_000);
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
const db = {
  query: async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return client.query(text, values);
  },
} as unknown as Pool;
const service = new SocialService(db);
const key = randomUUID();
const viewer = randomUUID();
const author = randomUUID();
const coauthor = randomUUID();
const outsider = randomUUID();
const inactive = randomUUID();
const suspended = randomUUID();
const blocked = randomUUID();
const blocking = randomUUID();
const sparseAuthor = randomUUID();
const visibleAuthors = [viewer, author, coauthor];
const allAuthors = [
  ...visibleAuthors,
  outsider,
  inactive,
  suspended,
  blocked,
  blocking,
  sparseAuthor,
];
const eventId = `following-event:${key}`;
const otherEventId = `following-other-event:${key}`;
const marketId = `following-market:${key}`;
const siblingMarketId = `following-sibling-market:${key}`;
const otherMarketId = `following-other-market:${key}`;
const emptyMarketId = `following-empty-market:${key}`;
const emptyEventId = `following-empty-event:${key}`;
const orderId = randomUUID();
const facts = {
  version: 1,
  canonicalPurchaseKey: key,
  instrument: {
    marketId,
    tokenId: key,
    outcome: "YES",
    generation: "fixture",
    expiry: null,
    venue: "limitless",
  },
  owner: key,
  grossNotionalUsd: "10",
  grossShares: "20",
  netShares: "20",
  entryPrice: "0.5",
  feesUsd: null,
  purchasedAt: "2026-10-01T12:00:00.000Z",
  evidenceIds: [key],
  evidenceRevision: "fixture",
  verifiedAt: "2026-10-01T12:00:00.000Z",
};
const scopeFor = (input: SocialFeedInput) =>
  socialFingerprint([
    "feed",
    viewer,
    input.mode,
    input.source,
    input.authorId ?? null,
    input.marketId ?? null,
    input.eventId ?? null,
  ]);
async function seed(
  authorId: string,
  selectedMarket: string,
  selectedEvent: string,
  count: number,
  batch: string,
  visibility: "public" | "author" | "moderation" | "proof" = "public",
  timestamp = "2026-10-08 12:00:00.123456+00",
) {
  await client.query(
    `insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,published_at,author_hidden_at,moderation_hidden_at,proof_invalidated_at)
     select md5($1::text||':'||g.seq)::uuid,$2,$1::text||':'||g.seq,$3,$4,$5,$1,'YES','fixture','Following fixture',$6::jsonb,'fixture',10,$1::text||':'||g.seq,'fixture',
       $7::timestamptz-(g.seq/2)*interval '1 microsecond',
       case when $8='author' then now() end,case when $8='moderation' then now() end,case when $8='proof' then now() end
     from generate_series(1,$9::int) as g(seq)`,
    [
      `${key}:${batch}`,
      authorId,
      orderId,
      selectedMarket,
      selectedEvent,
      JSON.stringify(facts),
      timestamp,
      visibility,
      count,
    ],
  );
}
async function expected(input: SocialFeedInput) {
  const cursor = decodeSocialCursor(input.cursor, scopeFor(input));
  // Deliberately independent oracle: the fixture's visible followed authors
  // plus self, with every optional filter and visibility check before LIMIT.
  return client.query<{ id: string; sort_at: string }>(
    `select id,published_at::text as sort_at from user_theses
     where author_id=any($1::uuid[]) and author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null
       and ($2::text is null or market_id=$2) and ($3::text is null or event_id=$3) and ($4::uuid is null or author_id=$4)
       and ($5::timestamptz is null or (published_at,'thesis'::text,id)<($5,$6::text,$7::uuid))
     order by published_at desc,id desc limit $8`,
    [
      visibleAuthors,
      input.marketId ?? null,
      input.eventId ?? null,
      input.authorId ?? null,
      cursor?.timestamp ?? null,
      cursor?.kind ?? null,
      cursor?.id ?? null,
      (input.limit ?? 20) + 1,
    ],
  );
}
async function checkedPage(input: SocialFeedInput) {
  const before = calls.length;
  const page = await service.feed(viewer, input);
  const call = calls
    .slice(before)
    .find((item) => item.text.startsWith("with chosen"));
  assert.ok(call);
  const oracle = await expected(input);
  const selected = oracle.rows.slice(0, input.limit);
  assert.deepEqual(
    page.items.map((item) => item.id),
    selected.map((item) => item.id),
  );
  assert.equal(
    Boolean(page.nextCursor),
    oracle.rows.length > (input.limit ?? 20),
  );
  if (page.nextCursor) {
    const decoded = decodeSocialCursor(page.nextCursor, scopeFor(input));
    assert.equal(decoded?.timestamp, selected.at(-1)?.sort_at);
    assert.equal(decoded?.id, selected.at(-1)?.id);
  }
  return { page, call, oracle };
}
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
async function checkPlans(name: string, input: SocialFeedInput) {
  const { call, oracle } = await checkedPage(input);
  for (const generic of [false, true]) {
    await client.query(
      generic
        ? "set local plan_cache_mode=force_generic_plan"
        : "set local plan_cache_mode=force_custom_plan",
    );
    await client.query(
      `prepare social_following_scope_fixture(uuid,text,text,uuid,timestamptz,text,uuid,int) as ${call.text}`,
    );
    const literals = await client.query(
      `select array_agg(quote_nullable(arg_value) order by arg_index) as args from unnest($1::text[]) with ordinality as v(arg_value,arg_index)`,
      [call.values],
    );
    const execute = `execute social_following_scope_fixture(${literals.rows[0].args.join(",")})`;
    const result = await client.query(execute);
    assert.deepEqual(
      result.rows.map((row) => row.id),
      oracle.rows.map((row) => row.id),
    );
    const explained = await client.query(
      `explain (analyze,buffers,format json) ${execute}`,
    );
    const counts = await client.query(
      "select generic_plans::int,custom_plans::int from pg_prepared_statements where name='social_following_scope_fixture'",
    );
    assert.deepEqual(
      counts.rows[0],
      generic
        ? { generic_plans: 2, custom_plans: 0 }
        : { generic_plans: 0, custom_plans: 2 },
    );
    const plan = explained.rows[0]["QUERY PLAN"][0];
    const scans: PlanNode[] = [];
    function visit(node: PlanNode) {
      if (node["Relation Name"] === "user_theses") scans.push(node);
      node.Plans?.forEach(visit);
    }
    visit(plan.Plan);
    const visited = scans.reduce(
      (sum, node) =>
        sum +
        (Number(node["Actual Rows"]) +
          Number(node["Rows Removed by Filter"] ?? 0)) *
          Number(node["Actual Loops"]),
      0,
    );
    if (scale >= 200_000 && visited >= 1000)
      console.log(
        JSON.stringify({ scenario: name, generic, failedPlan: plan }),
      );
    if (scale >= 200_000) {
      assert.ok(
        visited < 1000,
        `${name}: unrelated history entered the scan (${visited} rows)`,
      );
      const indexes = [
        ...(input.marketId ? ["user_theses_author_market_public_page"] : []),
        ...(input.eventId ? ["user_theses_author_event_public_page"] : []),
        ...(!input.marketId && !input.eventId
          ? ["user_theses_author_public_page"]
          : []),
      ];
      // Pin coverage of each new index, not every optimizer choice: a known
      // sparse author or timestamp older than all data may have cheaper paths.
      if (/^(market|event):(first|resumed)$/.test(name))
        assert.ok(
          scans.some((node) => indexes.includes(String(node["Index Name"]))),
          `${name}: missing author+scope index`,
        );
    }
    console.log(
      JSON.stringify({
        scenario: name,
        generic,
        fixtureRows: scale + Math.floor(scale / 2),
        returned: result.rowCount,
        visited,
        executionMs: plan["Execution Time"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        scans: scans.map((node) => ({
          index: node["Index Name"],
          condition: node["Index Cond"],
          rows: node["Actual Rows"],
          removed: node["Rows Removed by Filter"] ?? 0,
          loops: node["Actual Loops"],
        })),
      }),
    );
    await client.query("deallocate social_following_scope_fixture");
  }
  await client.query("set local plan_cache_mode=auto");
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
  await client.query("set local statement_timeout='60s'");
  const indexes = await client.query(
    `select count(*)::int as total from pg_index idx join pg_class relation on relation.oid=idx.indexrelid
     where relation.relname=any($1::text[]) and idx.indisvalid and idx.indisready`,
    [
      [
        "user_theses_author_market_public_page",
        "user_theses_author_event_public_page",
      ],
    ],
  );
  assert.equal(
    indexes.rows[0].total,
    2,
    "apply 0280 concurrent indexes before running this suite",
  );
  await client.query(
    "insert into users(id,display_name) select id,'Following fixture' from unnest($1::uuid[]) as fixture(id)",
    [allAuthors],
  );
  await client.query("update users set is_active=false where id=$1", [
    inactive,
  ]);
  await client.query("update users set social_suspended_at=now() where id=$1", [
    suspended,
  ]);
  await client.query(
    "insert into user_follows(follower_user_id,followed_user_id) select $1,id from unnest($2::uuid[]) as fixture(id)",
    [viewer, allAuthors.filter((id) => id !== viewer && id !== outsider)],
  );
  await client.query(
    "insert into user_blocks(blocker_user_id,blocked_user_id) values($1,$2),($3,$1)",
    [viewer, blocked, blocking],
  );
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) select id,'limitless',id,'Following fixture','ACTIVE' from unnest($1::text[]) as fixture(id)",
    [[eventId, otherEventId, emptyEventId]],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type) select market_id,'limitless',market_id,event_id,'Following fixture','ACTIVE','binary' from unnest($1::text[],$2::text[]) as fixture(market_id,event_id)",
    [
      [marketId, siblingMarketId, otherMarketId, emptyMarketId],
      [eventId, eventId, otherEventId, emptyEventId],
    ],
  );
  await client.query(
    "insert into orders(id,user_id,status) values($1,$2,'filled')",
    [orderId, author],
  );
  for (const [index, id] of visibleAuthors.entries()) {
    await seed(id, marketId, eventId, 25, `visible:${index}`);
    await seed(id, siblingMarketId, eventId, 15, `sibling:${index}`);
    await seed(id, otherMarketId, otherEventId, 10, `other:${index}`);
  }
  for (const [index, id] of [
    outsider,
    inactive,
    suspended,
    blocked,
    blocking,
  ].entries())
    await seed(
      id,
      marketId,
      eventId,
      30,
      `unavailable:${index}`,
      "public",
      "2030-01-01T00:00:00Z",
    );
  for (const visibility of ["author", "moderation", "proof"] as const)
    await seed(
      author,
      marketId,
      eventId,
      30,
      visibility,
      visibility,
      "2030-01-01T00:00:00Z",
    );
  const cases: { name: string; args: SocialFeedInput }[] = [
    {
      name: "market",
      args: { mode: "following", source: "all", marketId, limit: 20 },
    },
    {
      name: "event",
      args: { mode: "following", source: "thesis", eventId, limit: 20 },
    },
    {
      name: "market_event",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        eventId,
        limit: 20,
      },
    },
    {
      name: "market_author",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        authorId: author,
        limit: 20,
      },
    },
    {
      name: "event_author",
      args: {
        mode: "following",
        source: "thesis",
        eventId,
        authorId: author,
        limit: 20,
      },
    },
    {
      name: "market_event_author",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        eventId,
        authorId: author,
        limit: 20,
      },
    },
    {
      name: "self",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        authorId: viewer,
        limit: 20,
      },
    },
    {
      name: "sparse_author",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        authorId: sparseAuthor,
        limit: 20,
      },
    },
    {
      name: "nonfollowed_author",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        authorId: outsider,
        limit: 20,
      },
    },
    {
      name: "mismatched_event",
      args: {
        mode: "following",
        source: "thesis",
        marketId,
        eventId: otherEventId,
        limit: 20,
      },
    },
    {
      name: "empty_market",
      args: {
        mode: "following",
        source: "thesis",
        marketId: emptyMarketId,
        limit: 20,
      },
    },
    {
      name: "empty_event",
      args: {
        mode: "following",
        source: "thesis",
        eventId: emptyEventId,
        limit: 20,
      },
    },
    {
      name: "global",
      args: { mode: "following", source: "thesis", limit: 20 },
    },
    {
      name: "global_author",
      args: {
        mode: "following",
        source: "thesis",
        authorId: author,
        limit: 20,
      },
    },
  ];
  // Traverse complete small fixtures, verifying exact order/count and microsecond
  // cursor continuity across ties, users, markets and per-author LIMITs.
  for (const { args } of cases) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const { page } = await checkedPage({ ...args, cursor });
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  assert.deepEqual(
    await service.feed(viewer, { mode: "following", source: "hunch" }),
    { items: [], nextCursor: null },
  );
  if (scale) {
    await seed(
      author,
      otherMarketId,
      otherEventId,
      scale,
      "unrelated-followed",
      "public",
      "2025-01-01T00:00:00Z",
    );
    await seed(
      outsider,
      marketId,
      eventId,
      Math.floor(scale / 2),
      "unrelated-outsider",
      "public",
      "2029-01-01T00:00:00Z",
    );
  }
  for (const table of ["user_theses", "users", "user_follows", "user_blocks"])
    await client.query(`analyze ${table}`);
  for (const { name, args } of cases) {
    await checkPlans(`${name}:first`, args);
    const { page } = await checkedPage(args);
    if (page.nextCursor)
      await checkPlans(`${name}:resumed`, { ...args, cursor: page.nextCursor });
    await checkPlans(`${name}:empty_tail`, {
      ...args,
      cursor: encodeSocialCursor({
        scope: scopeFor(args),
        timestamp: "1970-01-01 00:00:00+00",
        kind: "thesis",
        id: "00000000-0000-0000-0000-000000000000",
      }),
    });
  }
  // Exact original failure: no visible followed thesis in the requested scope,
  // despite a large followed history elsewhere and outsiders in that scope.
  await client.query(
    "update user_theses set author_hidden_at=now() where author_id=any($1::uuid[]) and event_id=$2",
    [visibleAuthors, eventId],
  );
  for (const { name, args } of cases.slice(0, 2))
    await checkPlans(`${name}:only_unrelated_rows`, args);
  console.log(JSON.stringify({ ok: true, scale, scenarios: cases.length }));
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
