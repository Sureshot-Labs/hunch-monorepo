import {
  agentFixtureAuthors,
  agentFixtureProfiles,
} from "./fixtures/agent-theses-authors.js";
// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  DEFAULT_AGENT_THESES_POLICY,
  resolveAgentThesesPolicy,
} from "./services/agent-theses-policy.js";
import { provisionAgentAuthors } from "./services/agent-theses-provision.js";
import { publishAgentThesis } from "./services/agent-theses-publish.js";
import { SocialService } from "./services/social-service.js";
import { readVisibleSocialSource } from "./services/social-visibility.js";
import { socialThesisSchema, socialProfileResponse } from "./schemas/social.js";
import {
  paperBuySnapshotSchema,
  verifiedBuyFactsSchema,
  type PaperBuySnapshot,
} from "./schemas/social-trade.js";
import { refreshSocialTraderStatistics } from "./services/social-trader-statistics.js";
import { resolveLimitlessPositionContract } from "./services/limitless-protocol-config.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
let depth = 0;
const session = {
  query: async (sql: string, values: unknown[] = []) => {
    if (sql.toLowerCase() === "begin")
      return client.query(`savepoint agent_test_${++depth}`);
    if (sql.toLowerCase() === "commit")
      return client.query(`release savepoint agent_test_${depth--}`);
    if (sql.toLowerCase() === "rollback") {
      await client.query(`rollback to savepoint agent_test_${depth}`);
      return client.query(`release savepoint agent_test_${depth--}`);
    }
    return client.query(sql, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const key = randomUUID(),
  viewer = randomUUID();
const eventId = `agents-event:${key}`,
  marketId = `agents-market:${key}`,
  token = `agents-token:${key}`;
const positionContract = resolveLimitlessPositionContract();
const service = new SocialService(db, async () => {}, {
  limitlessPositionContract: positionContract,
});
try {
  await client.query("begin");
  await client.query("set local statement_timeout='10s'");
  const version = await client.query(
    "select current_setting('server_version_num')::int as version",
  );
  assert.ok(
    version.rows[0].version >= 160000 && version.rows[0].version < 170000,
  );
  const preview = await provisionAgentAuthors(db, agentFixtureProfiles);
  assert.equal(preview.authors.length, 3);
  const created = await provisionAgentAuthors(db, agentFixtureProfiles, true);
  assert.ok(created.authors.every((a) => a.userId));
  assert.deepEqual(
    (await provisionAgentAuthors(db, agentFixtureProfiles, true)).authors.map(
      (a) => a.userId,
    ),
    created.authors.map((a) => a.userId),
  );
  const author = created.authors[0].userId;
  assert.ok(author);
  assert.equal(
    (
      await db.query("select onboarding_version from users where id=$1", [
        author,
      ])
    ).rows[0].onboarding_version,
    0,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from user_wallets where user_id=$1",
        [author],
      )
    ).rows[0].n,
    0,
  );
  await db.query("insert into users(id,display_name) values($1,'Viewer')", [
    viewer,
  ]);
  const policy = structuredClone({
    ...DEFAULT_AGENT_THESES_POLICY,
    authors: agentFixtureAuthors,
  });
  policy.enabled = true;
  for (let i = 0; i < 3; i++) {
    const id = created.authors[i].userId;
    assert.ok(id);
    policy.authors[i].userId = id;
  }
  await db.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('agent_theses',now(),$1::jsonb)",
    [JSON.stringify(policy)],
  );
  await db.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'AI test','ACTIVE')",
    [eventId],
  );
  await db.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'AI match','ACTIVE','binary','[\"Home\",\"Away\"]')",
    [marketId, eventId],
  );
  await db.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'NO')",
    [token, marketId],
  );
  await db.query(
    "insert into unified_token_top_latest(token_id,venue,ts,best_ask,mid) values($1,'limitless',now(),'0.5','0.49')",
    [token],
  );
  const instrument = {
    marketId,
    tokenId: token,
    outcome: "NO" as const,
    generation: `8453:${positionContract}:${token}`,
    expiry: null,
    venue: "limitless" as const,
  };
  const provenance: PaperBuySnapshot["provenance"] = {
    sources: [
      {
        id: "evidence",
        kind: "external_summary",
        title: "Saved report",
        excerpt: "Known at publication",
        url: null,
        asOf: new Date().toISOString(),
      },
    ],
    policyRevision: (await resolveAgentThesesPolicy(db)).revision,
    playbookVersion: "1",
    model: policy.writerModel,
    angle: "Mechanism",
    counterargument: "Opposing data",
    changeReason: null,
    previousThesisId: null,
    argumentKey: "first",
  };
  const input = {
    db,
    userId: author,
    idempotencyKey: key,
    body: "Away has a supported advantage, but the opposing record matters.",
    instrument,
    provenance,
    maxEntryPrice: "0.51",
    assertLease: async () => {},
    limitlessPositionContract: positionContract,
  };
  await assert.rejects(
    publishAgentThesis({ ...input, userId: viewer }),
    /agent_unavailable/,
  );
  await assert.rejects(
    publishAgentThesis({
      ...input,
      assertLease: async () => {
        throw new Error("lease_lost");
      },
    }),
    /lease_lost/,
  );
  await assert.rejects(
    publishAgentThesis({ ...input, maxEntryPrice: "0.49" }),
    /price_changed/,
  );
  await assert.rejects(
    publishAgentThesis({
      ...input,
      instrument: { ...instrument, generation: "wrong" },
    }),
    /instrument_changed/,
  );
  await db.query(
    "update unified_token_top_latest set ts=now()-interval '1 hour' where token_id=$1",
    [token],
  );
  await assert.rejects(publishAgentThesis(input), /stale_quote/);
  await db.query(
    "update unified_token_top_latest set ts=clock_timestamp(),best_ask=null where token_id=$1",
    [token],
  );
  await assert.rejects(publishAgentThesis(input), /quote_unavailable/);
  await db.query(
    "update unified_token_top_latest set best_ask='0.5' where token_id=$1",
    [token],
  );
  await db.query("update unified_markets set status='CLOSED' where id=$1", [
    marketId,
  ]);
  await assert.rejects(publishAgentThesis(input), /market_closed/);
  await db.query("update unified_markets set status='ACTIVE' where id=$1", [
    marketId,
  ]);
  let leaseChecks = 0;
  await assert.rejects(
    publishAgentThesis({
      ...input,
      assertLease: async () => {
        if (++leaseChecks === 3) throw new Error("lease_lost_before_commit");
      },
    }),
    /lease_lost_before_commit/,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from user_theses where author_id=$1",
        [author],
      )
    ).rows[0].n,
    0,
  );
  // The indexer advances a quote after publication has started, before its read.
  // Old transaction-start clocks wrongly rejected this legitimate quote as future.
  let observedQuoteAt: Date | undefined;
  const advancingQuoteDb = {
    query: session.query,
    connect: async () => ({
      ...session,
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith("select best_ask::text,ts")) {
          await delay(10);
          observedQuoteAt = new Date();
          await session.query(
            "update unified_token_top_latest set ts=$2 where token_id=$1",
            [token, observedQuoteAt],
          );
        }
        return session.query(sql, values);
      },
    }),
  } as unknown as Pool;
  const published = await publishAgentThesis({
    ...input,
    db: advancingQuoteDb,
  });
  const thesis = socialThesisSchema.parse(
    await service.getThesis(viewer, published.id),
  );
  assert.equal(thesis.purchaseMode, "paper");
  assert.equal(thesis.author.isAgent, true);
  assert.equal(thesis.instrument.outcomeLabel, "Away");
  assert.equal(thesis.netShares, "200");
  assert.equal(thesis.entryQuoteAsOf, observedQuoteAt?.toISOString());
  assert.equal(thesis.canCopy, true);
  const source = await readVisibleSocialSource(db, viewer, {
    kind: "thesis",
    id: thesis.id,
  });
  assert.equal(source.kind, "thesis");
  const stored = (
    await db.query("select * from user_theses where id=$1", [thesis.id])
  ).rows[0];
  assert.equal(stored.order_id, null);
  assert.equal(stored.execution_id, null);
  assert.equal(
    verifiedBuyFactsSchema.safeParse(stored.buy_snapshot).success,
    false,
  );
  assert.equal(
    paperBuySnapshotSchema.safeParse(stored.buy_snapshot).success,
    true,
  );
  await db.query(
    "update unified_token_top_latest set best_ask='0.8' where token_id=$1",
    [token],
  );
  assert.equal((await publishAgentThesis(input)).replayed, true);
  assert.equal(
    (await service.getThesis(viewer, thesis.id)).position.entryPrice,
    "0.5",
  );
  await assert.rejects(
    publishAgentThesis({ ...input, idempotencyKey: randomUUID() }),
    /publication_cooldown/,
  );
  await service.setFollow(viewer, author, true);
  assert.ok(
    (
      await service.feed(viewer, { mode: "following", source: "thesis" })
    ).items.some((t) => t.id === thesis.id),
  );
  await db.query(
    "update unified_markets set status='SETTLED',resolved_outcome='NO' where id=$1",
    [marketId],
  );
  assert.equal(
    (await service.getThesis(viewer, thesis.id)).position.state,
    "win",
  );
  await refreshSocialTraderStatistics(db);
  const profile = socialProfileResponse.parse(
    await service.getProfile(viewer, author),
  );
  assert.equal(profile.paperPerformance?.pnlUsd, "100");
  assert.equal(profile.paperPerformance?.costUsd, "100");
  assert.equal(profile.paperPerformance?.returnFraction, "1");
  await service.hideThesis(author, thesis.id);
  assert.equal((await service.paperPerformance(author)).pnlUsd, "100");
  await db.query("update user_theses set author_hidden_at=null where id=$1", [
    thesis.id,
  ]);
  await db.query(
    "update unified_markets set resolved_outcome='YES' where id=$1",
    [marketId],
  );
  assert.equal((await service.paperPerformance(author)).pnlUsd, "-100");
  await db.query(
    "update unified_markets set resolved_outcome=null,resolved_outcome_pct=7500 where id=$1",
    [marketId],
  );
  assert.equal(
    (await service.getThesis(viewer, thesis.id)).position.pnlUsd,
    "-50",
  );
  await db.query(
    "update unified_markets set resolved_outcome='VOID',resolved_outcome_pct=null where id=$1",
    [marketId],
  );
  assert.equal((await service.paperPerformance(author)).void, 1);
  await db.query(
    "update unified_markets set resolved_outcome=null,resolved_outcome_pct=null where id=$1",
    [marketId],
  );
  const unknownResult = await service.paperPerformance(author);
  assert.equal(unknownResult.unknown, 1);
  assert.equal(unknownResult.pending, 0);
  await db.query("update users set social_suspended_at=now() where id=$1", [
    author,
  ]);
  await assert.rejects(
    service.getThesis(viewer, thesis.id),
    /thesis_not_found/,
  );
  await assert.rejects(publishAgentThesis(input), /agent_unavailable/);
  await db.query("update users set is_agent=false where id=$1", [author]);
  await assert.rejects(
    provisionAgentAuthors(db, agentFixtureProfiles, true),
    /agent_handle_owned_by_user/,
  );
  console.log(
    "agent-theses PostgreSQL publication/profile/provisioning contracts passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
