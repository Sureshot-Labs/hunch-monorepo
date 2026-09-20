import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  getMatchedAlternatives,
  getMatchedClusters,
} from "../../../apps/api/src/services/matched-markets.js";
import { loadMatchedSignalCandidates } from "../../../apps/api/src/services/signal-matching.js";
import { randomUUID } from "node:crypto";
import {
  matchingProtectedReferences,
  matchingDerivedReferences,
} from "../../../apps/api/src/services/matching-retention.js";
import {
  DEFAULT_MARKET_MATCHING_POLICY,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
} from "@hunch/shared";
import { EXPECTED_MODEL, hash, type Contract } from "./contracts.js";
import {
  enqueue,
  claim,
  loadContracts,
  loadEvent,
  saveVersion,
  candidates,
} from "./store.js";
import {
  requestInterest,
  runDiscovery,
  warmInterest,
  revalidateLinks,
  discover,
} from "./discovery.js";
import { runJob } from "./worker.js";
import { resolveMarketLinks, resolveEventLinks } from "./resolver.js";
import { boostRelatedMarkets } from "./similar.js";
import { makeRequest, InferenceError, type JevResult } from "./jev.js";

const url = process.env.MATCHING_TEST_DATABASE_URL;
const integration = test; // No implicit default database.
const testSchema = `matching_test_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
const eq = {
  choice: "equivalent",
  confidence: 0.99,
  probabilities: {
    equivalent: 0.99,
    inverse: 0,
    different: 0.01,
    insufficient_information: 0,
  },
};
before(async () => {
  if (!url) return;
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/matching_test");
  assert.equal(parsed.port, "55439");
  pool = new Pool({
    connectionString: url,
    max: 5,
    options: `-c search_path=${testSchema}`,
  });
  const check = await pool.query(
    "select current_database() as db,current_setting('server_version_num')::int as version",
  );
  assert.equal(check.rows[0].db, "matching_test");
  assert(check.rows[0].version >= 160000 && check.rows[0].version < 170000);
  // Each invocation owns a fresh schema. Repeated tests cannot consume one
  // another's actor quotas or crowd a bounded retrieval prefix with old fixtures.
  await pool.query(`create schema ${testSchema}`);
  await pool.query(`
    create table if not exists unified_events(id text primary key,venue text,title text,description text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),updated_at_db timestamptz default now());
    create table if not exists unified_markets(id text primary key,event_id text references unified_events(id),venue text,title text,description text,status text,outcomes text,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now(),updated_at_db timestamptz default now());
    create table if not exists unified_market_tokens(market_id text,token_id text,outcome_side text);
    create table if not exists runtime_policies(id text,policy_key text,effective_at timestamptz,payload jsonb,created_by text,created_by_admin_id text,created_at timestamptz default now());`);
  await pool.query(`alter table unified_events add column if not exists end_date timestamptz,add column if not exists slug text,add column if not exists image text,add column if not exists icon text,add column if not exists category text;
    alter table unified_markets add column if not exists venue_market_id text,add column if not exists close_time timestamptz,add column if not exists expiration_time timestamptz,add column if not exists category text,add column if not exists slug text,add column if not exists resolved_outcome text,add column if not exists volume_total numeric,add column if not exists volume_24h numeric,add column if not exists liquidity numeric,add column if not exists open_interest numeric,add column if not exists best_bid numeric,add column if not exists best_ask numeric,add column if not exists last_price numeric;
    alter table unified_market_tokens add column if not exists updated_at timestamptz default now();
    create table if not exists polymarket_markets(id text,accepting_orders boolean,active boolean,closed boolean,archived boolean);
    create table if not exists unified_token_top_latest(token_id text primary key,best_bid numeric,best_ask numeric,ts timestamptz);`);
  await pool.query(
    "alter table unified_markets alter column outcomes type text using outcomes::text",
  );
  await pool.query("delete from runtime_policies where id in ('test','race')");
  await pool.query("delete from runtime_policies where id='matching-default'");
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values('matching-default','market_matching',now()-interval '1 hour',$1)",
    [
      {
        ...DEFAULT_MARKET_MATCHING_POLICY,
        workerEnabled: true,
        lazyEnabled: true,
        alternativesEnabled: true,
      },
    ],
  );
  const exists = await pool.query(
    "select to_regclass('market_links') as relation",
  );
  if (!exists.rows[0].relation)
    await pool.query(
      await readFile(
        new URL(
          "../../db/migrations/0261_market_matching.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
});

integration(
  "PG16: named outcome discovery works in both directions without event fanout",
  { skip: !url },
  async () => {
    const [a, b] = await seed("named-discovery");
    const title = `Named election ${randomUUID()} winner 2028`;
    await pool.query(
      "update unified_events set title=$1 where id=any($2::text[])",
      [title, [a.eventId, b.eventId]],
    );
    await pool.query(
      `update unified_markets set title='Who wins?',outcomes='["Alice","Bob"]' where id=$1`,
      [a.id],
    );
    await pool.query(
      "insert into unified_market_tokens(market_id,token_id,outcome_side) values($1,$2,'Alice'),($1,$3,'Bob')",
      [a.id, randomUUID(), randomUUID()],
    );
    await pool.query(
      "insert into unified_markets(id,event_id,venue,title,description,status,outcomes) values($1,$2,$3,'Malformed sibling','Rules','ACTIVE','{broken')",
      [b.id + ":malformed", b.eventId, b.venue],
    );
    const pair = await loadContracts(pool, [a.id, b.id]);
    const left = pair.find((x) => x.id === a.id),
      right = pair.find((x) => x.id === b.id);
    assert(left && right);
    assert(
      (await discover(pool, left)).contracts.some((x) => x.id === right.id),
    );
    assert(
      (await discover(pool, right)).contracts.some((x) => x.id === left.id),
    );
  },
);

integration(
  "PG16: simultaneous workers cannot oversubscribe the budget reservation",
  { skip: !url },
  async () => {
    await clearJobs();
    await pool.query(
      "update market_matching_budget set spent_usd=0,reserved_usd=0,request_count=0,lazy_spent_usd=0,lazy_reserved_usd=0,lazy_request_count=0",
    );
    for (let i = 0; i < 2; i++) {
      const [a, b] = await seed("atomic");
      await enqueue(pool, "contract", a, b, "warm");
    }
    let calls = 0;
    const slow: typeof infer = async (...args) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return infer(...args);
    };
    const results = await Promise.all([
      runJob(pool, { key: "test", infer: slow, dailyBudget: 0.01 }),
      runJob(pool, { key: "test", infer: slow, dailyBudget: 0.01 }),
    ]);
    assert.equal(calls, 1);
    assert(results.includes("budget_wait"));
    assert(results.includes("approved"));
  },
);
afterEach(async () => {
  if (pool)
    await pool.query(
      "delete from runtime_policies where id in ('test','race')",
    );
});
after(async () => {
  if (pool) await pool.end();
});

async function matchingOverride(
  patch: Partial<typeof DEFAULT_MARKET_MATCHING_POLICY>,
) {
  await pool.query("delete from runtime_policies where id='race'");
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values('race','market_matching',now()-interval '1 second',$1)",
    [
      {
        ...DEFAULT_MARKET_MATCHING_POLICY,
        workerEnabled: true,
        lazyEnabled: true,
        alternativesEnabled: true,
        ...patch,
      },
    ],
  );
}

integration(
  "PG16: runtime matching disable during inference prevents publication",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("matching-policy-race");
    await enqueue(pool, "contract", a, b, "warm");
    const outcome = await runJob(pool, {
      key: "test",
      infer: async (...args) => {
        await matchingOverride({ workerEnabled: false });
        return infer(...args);
      },
    });
    assert.equal(outcome, "stale");
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    assert.equal(await runJob(pool, { key: "test", infer }), "disabled");
    assert.equal(await runDiscovery(pool), "disabled");
  },
);

integration(
  "PG16: operational edits reuse evidence, stricter criteria hide it and requeue once",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("matching-revision");
    await enqueue(pool, "contract", a, b, "warm");
    assert.equal(await runJob(pool, { key: "test", infer }), "approved");
    await matchingOverride({ dailyBudgetUsd: 1 });
    await enqueue(pool, "contract", a, b, "warm");
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 1);
    assert.equal(await runJob(pool, { key: "test", infer }), "idle");
    await matchingOverride({ contractProbability: 1 });
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    await enqueue(pool, "contract", a, b, "warm");
    await enqueue(pool, "contract", b, a, "warm");
    const pending = await pool.query(
      "select count(*)::int as count from market_matching_jobs where status='queued' and (left_id=$1 or right_id=$1)",
      [a.id],
    );
    assert.equal(pending.rows[0].count, 1);
    assert.equal(await runJob(pool, { key: "test", infer }), "review");
  },
);

integration(
  "PG16: runtime zero budget and lazy off prevent paid requests",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("matching-zero");
    await matchingOverride({ dailyBudgetUsd: 0 });
    await enqueue(pool, "contract", a, b, "warm");
    let calls = 0;
    const counted: typeof infer = async (...args) => {
      calls++;
      return infer(...args);
    };
    assert.equal(
      await runJob(pool, { key: "test", infer: counted }),
      "budget_wait",
    );
    assert.equal(calls, 0);
    await clearJobs();
    const [c, d] = await seed("matching-lazy-stop");
    await enqueue(pool, "contract", c, d, "lazy");
    await matchingOverride({ lazyEnabled: false });
    assert.equal(await runJob(pool, { key: "test", infer: counted }), "idle");
    assert.equal(
      await requestInterest(pool, c.id, "disabled-actor"),
      "unavailable",
    );
    assert.equal(calls, 0);
  },
);
async function seed(suffix: string) {
  suffix += `-${randomUUID()}`;
  for (const venue of ["polymarket", "limitless"]) {
    await pool.query(
      "insert into unified_events(id,venue,title,description,status) values($1,$2,'Election winner 2028','','ACTIVE')",
      [`${venue}:event:${suffix}`, venue],
    );
    await pool.query(
      "insert into unified_markets(id,event_id,venue,title,description,status,outcomes) values($1,$2,$3,'Alice','YES if Alice wins the 2028 election. On cancellation NO pays 1.','ACTIVE','[\"YES\",\"NO\"]')",
      [`${venue}:${suffix}`, `${venue}:event:${suffix}`, venue],
    );
  }
  return loadContracts(pool, [`polymarket:${suffix}`, `limitless:${suffix}`]);
}
async function clearJobs() {
  await pool.query(
    "update market_matching_jobs set status='error',lease_token=null where status in ('running','queued')",
  );
}

integration(
  "PG16: same-venue discovery is opt-in, excludes self, and is rechecked before inference/publication/read",
  { skip: !url },
  async () => {
    await clearJobs();
    const initial = await seed("same-venue");
    await pool.query(
      "update unified_markets set venue='polymarket',title='DistinctiveQuorum' where id=any($1::text[])",
      [initial.map((c) => c.id)],
    );
    await pool.query(
      "update unified_events set venue='polymarket',title='DistinctiveQuorum' where id=any($1::text[])",
      [initial.map((c) => c.eventId)],
    );
    const [a, b] = await loadContracts(
      pool,
      initial.map((c) => c.id),
    );
    assert.deepEqual((await discover(pool, a)).contracts, []);
    await matchingOverride({ sameVenueEnabled: true });
    const found = await discover(pool, a);
    assert(found.contracts.some((c) => c.id === b.id));
    assert(!found.contracts.some((c) => c.id === a.id));
    assert(!found.events.includes(a.eventId));
    const event = await loadEvent(pool, a.eventId);
    assert(event);
    assert(!(await candidates(pool, "event", event)).includes(a.eventId));
    await enqueue(pool, "contract", a, b, "test");
    await matchingOverride({ sameVenueEnabled: false });
    assert.equal(
      await runJob(pool, {
        key: "test",
        infer: async () => {
          throw new Error("Inference forbidden");
        },
      }),
      "stale",
    );
    await matchingOverride({ sameVenueEnabled: true });
    await enqueue(pool, "contract", a, b, "test");
    assert.equal(await runJob(pool, { key: "test", infer }), "approved");
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 1);
    await matchingOverride({ sameVenueEnabled: false });
    assert.deepEqual(await resolveMarketLinks(pool, a.id), []);
    await matchingOverride({ sameVenueEnabled: true });
    // Re-evaluate changed rules while policy is disabled during the model request.
    await pool.query(
      "update unified_markets set description=description || ' Confirmed.' where id=any($1::text[])",
      [[a.id, b.id]],
    );
    const [changedA, changedB] = await loadContracts(pool, [a.id, b.id]);
    await enqueue(pool, "contract", changedA, changedB, "test");
    assert.equal(
      await runJob(pool, {
        key: "test",
        infer: async (...args) => {
          await matchingOverride({ sameVenueEnabled: false });
          return infer(...args);
        },
      }),
      "stale",
    );
  },
);

integration(
  "PG16: discovery backpressure preserves interest without consuming retries",
  { skip: !url },
  async () => {
    await clearJobs();
    await pool.query(
      "update market_matching_interest set status='done' where status<>'done'",
    );
    const [a, b] = await seed("backpressure-interest");
    assert.equal(
      await requestInterest(pool, a.id, "backpressure-actor"),
      "pending",
    );
    await matchingOverride({
      queuedJobs: 1,
      lazyQueuedJobs: 1,
      eventCandidates: 0,
      contractCandidates: 1,
    });
    await enqueue(pool, "contract", a, b, "warm");
    assert.equal(await runDiscovery(pool), "deferred");
    const interest = await pool.query(
      "select status,attempts,last_error from market_matching_interest where market_id=$1",
      [a.id],
    );
    assert.deepEqual(interest.rows[0], {
      status: "queued",
      attempts: 0,
      last_error: "discovery_backpressure",
    });
  },
);
const infer = async (
  kind: Parameters<typeof makeRequest>[0],
  a: unknown,
  b: unknown,
): Promise<JevResult> => {
  const request = makeRequest(kind, a, b);
  const answer =
    kind === "event"
      ? {
          choice: "same_event",
          confidence: 0.99,
          probabilities: {
            same_event: 0.99,
            related: 0.01,
            different: 0,
            insufficient_information: 0,
          },
        }
      : eq;
  return {
    answer,
    outcomeAnswers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [key, answer]),
    ),
    model: EXPECTED_MODEL,
    cost: 0.00005,
    elapsedMs: 1,
    request,
    response: { answers: { relation: answer } },
  };
};

integration(
  "PG16: trusted warm selection promotes full lazy backlog without growing pending interests",
  { skip: !url },
  async () => {
    await clearJobs();
    await pool.query("update market_matching_interest set status='done'");
    const [a, b] = await seed("full-lazy-backlog");
    const [other] = await seed("other-pending");
    await requestInterest(pool, a.id, "warm-promotion-actor");
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours' where market_id=$1",
      [a.id],
    );
    await requestInterest(pool, other.id, "warm-promotion-other");
    await enqueue(pool, "contract", a, b, "lazy");
    await pool.query(
      "update unified_markets set volume_total=1e15 where id=$1",
      [a.id],
    );
    await matchingOverride({
      queuedJobs: 1,
      lazyQueuedJobs: 1,
      pendingInterests: 1,
      lazyPendingInterests: 1,
      lazyEnabled: false,
      warmTrendingCount: 1,
      warmLimitlessCount: 0,
      seedFeedCount: 0,
      seedMapCount: 0,
      seedWhalesCount: 0,
    });
    await pool.query(
      "delete from market_matching_state where state_key='warm'",
    );
    await warmInterest(pool);
    const count = await pool.query(
      "select count(*)::int as count from market_matching_interest where status<>'done'",
    );
    assert.equal(count.rows[0].count, 1);
    await pool.query(
      "update market_matching_jobs set candidate_source='lazy' where status='queued'",
    );
    await pool.query(
      "update market_matching_interest set source='lazy',next_attempt_at=now()-interval '1 hour' where market_id=$1",
      [a.id],
    );
    await pool.query(
      "delete from market_matching_state where state_key='warm'",
    );
    await warmInterest(pool);
    const afterCooldown = await pool.query(
      "select count(*)::int as count from market_matching_interest where status<>'done'",
    );
    assert.equal(afterCooldown.rows[0].count, 1);
    const job = await claim(pool, 3, false);
    assert.equal(job?.candidate_source, "warm");
    await pool.query(
      "update unified_markets set volume_total=null where id=$1",
      [a.id],
    );
    await pool.query(
      "delete from market_matching_state where state_key='warm'",
    );
  },
);

integration(
  "PG16: confirmed link survives missing quotes; native bid/ask freshness is independent",
  { skip: !url },
  async () => {
    await clearJobs();
    const initial = await seed("quotes");
    for (const c of initial)
      for (const side of ["YES", "NO"])
        await pool.query(
          "insert into unified_market_tokens(market_id,token_id,outcome_side) values($1,$2,$3)",
          [c.id, `${c.id}:${side}`, side],
        );
    const [a, b] = await loadContracts(
      pool,
      initial.map((c) => c.id),
    );
    await enqueue(pool, "contract", a, b, "test");
    await runJob(pool, { key: "test", infer });
    const missing = await getMatchedAlternatives(pool, a.id);
    assert.equal(missing?.status, "matched");
    assert.equal(missing?.lowestYesMid, null);
    assert.equal(missing?.outcomeLinks?.length, 2);
    for (const c of [a, b])
      for (const side of ["YES", "NO"])
        await pool.query(
          "insert into unified_token_top_latest(token_id,best_bid,best_ask,ts) values($1,.4,.6,now())",
          [`${c.id}:${side}`],
        );
    const fresh = await getMatchedAlternatives(pool, a.id);
    assert.equal(fresh?.lowestYesMid?.yesMid, 0.5);
    assert.equal(fresh?.markets[0].executionOffers?.yes?.ask, 0.6);
    assert.equal(fresh?.markets[0].executionOffers?.yes?.fresh, true);
    await pool.query(
      "update unified_token_top_latest set best_ask=.55,ts=now() where token_id=$1",
      [`${b.id}:YES`],
    );
    await pool.query("delete from unified_token_top_latest where token_id=$1", [
      `${b.id}:NO`,
    ]);
    const updated = await getMatchedAlternatives(pool, a.id);
    assert.equal(updated?.alternatives[0].executionOffers?.yes?.ask, 0.55);
    assert.equal(updated?.alternatives[0].executionOffers?.no, null);
    await pool.query(
      "update unified_token_top_latest set ts=now()-interval '11 minutes' where token_id=any($1::text[])",
      [[...a.outcomes, ...b.outcomes].map((o) => o.tokenId)],
    );
    const stale = await getMatchedAlternatives(pool, a.id);
    assert.equal(stale?.status, "matched");
    assert.equal(stale?.lowestYesMid, null);
    assert.equal(stale?.markets[0].executionOffers?.yes?.fresh, false);
    const input = {
      db: pool,
      marketId: a.id,
      venues: [b.venue],
      buySide: "NO" as const,
      nowIso: new Date().toISOString(),
    };
    const deferred = await loadMatchedSignalCandidates({
      ...input,
      readiness: async (id, side) => {
        assert.equal(id, b.id);
        assert.equal(side, "NO");
        return { defer: true, orderable: true, blockers: [], buyPrice: null };
      },
    });
    assert.equal(deferred.deferred, true);
    assert.deepEqual(deferred.candidates, []);
    const ready = await loadMatchedSignalCandidates({
      ...input,
      readiness: async () => ({
        defer: false,
        orderable: true,
        blockers: [],
        buyPrice: 0.42,
        quoteAsOf: input.nowIso,
      }),
    });
    assert.equal(ready.candidates[0]?.mappedSide, "NO");
    assert.equal(ready.candidates[0]?.executablePrice, 0.42);
    assert.equal(ready.candidates[0]?.mappingMethod, "verified_outcome_link");
    const unavailable = await loadMatchedSignalCandidates({
      ...input,
      readiness: async () => ({
        defer: false,
        orderable: false,
        blockers: [],
        buyPrice: 0.42,
      }),
    });
    assert.deepEqual(unavailable.candidates, []);
    let reads = 0;
    const counted = {
      query: (...args: unknown[]) => {
        reads++;
        return (pool.query as (...values: unknown[]) => Promise<unknown>)(
          ...args,
        );
      },
    } as unknown as Pool;
    const clusters = await getMatchedClusters(counted, { limit: 100 });
    assert(
      clusters.items.some((cluster) =>
        cluster.markets.some((market) => market.marketId === a.id),
      ),
    );
    assert(reads <= 9, `Expected bounded batch reads, got ${reads}`);
    const filtered = await getMatchedClusters(pool, { venues: "polymarket" });
    assert.deepEqual(filtered.items, []);
    assert(
      clusters.items.find((c) => c.markets.some((m) => m.marketId === a.id))
        ?.outcomeLinks?.length === 2,
    );
    // Synthetic approved mapping: exercise consumer direction independently of
    // auto-approval. Jev's inverse relation still stays in review in v1.
    const [link] = await resolveMarketLinks(pool, a.id);
    const rightContract = [a, b].find((c) => c.id === link.link.right_id);
    assert(rightContract);
    // Delete/reinsert atomically to avoid transient unique-key collision on a swap.
    await pool.query(
      "with removed_mappings as (delete from market_outcome_links where market_link_id=$1 returning *) insert into market_outcome_links(market_link_id,left_outcome_id,right_outcome_id) select market_link_id,left_outcome_id,case when right_outcome_id=$2 then $3 else $2 end from removed_mappings",
      [
        link.link.id,
        rightContract.outcomes[0].id,
        rightContract.outcomes[1].id,
      ],
    );
    const inverted = await getMatchedAlternatives(pool, a.id);
    assert.equal(inverted?.alternatives[0].outcomeMapping?.sourceYesTo, "NO");
    const reverse = await getMatchedAlternatives(pool, b.id);
    assert.equal(reverse?.alternatives[0].outcomeMapping?.sourceYesTo, "NO");
    const invertedSignal = await loadMatchedSignalCandidates({
      ...input,
      buySide: "YES",
      readiness: async (id, side) => {
        assert.equal(id, b.id);
        assert.equal(side, "NO");
        return { defer: false, orderable: true, blockers: [], buyPrice: 0.32 };
      },
    });
    assert.equal(invertedSignal.candidates[0]?.mappedSide, "NO");
  },
);
integration(
  "PG16: related boost preserves embedding membership/scores and never creates exact links",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("related");
    const source = await loadEvent(pool, a.eventId),
      target = await loadEvent(pool, b.eventId);
    assert(source && target);
    await enqueue(pool, "event", source, target, "test");
    await runJob(pool, {
      key: "test",
      infer: async (...args) => {
        const result = await infer(...args);
        const answer = {
          choice: "related",
          confidence: 0.99,
          probabilities: {
            same_event: 0,
            related: 0.99,
            different: 0.01,
            insufficient_information: 0,
          },
        };
        return {
          ...result,
          answer,
          response: { answers: { relation: answer } },
        };
      },
    });
    const items = [
      { id: "polymarket:unrelated", score: 0.1 },
      { id: b.id, score: 0.3 },
    ];
    assert.deepEqual(await boostRelatedMarkets(pool, a.id, items), items);
    await matchingOverride({ similarEnabled: true });
    assert.deepEqual(await boostRelatedMarkets(pool, a.id, items), [
      items[1],
      items[0],
    ]);
    assert.deepEqual(await resolveMarketLinks(pool, a.id), []);
    assert.equal(
      (await resolveEventLinks(pool, a.eventId)).alternatives.length,
      0,
    );
    const evaluation = await pool.query(
      "select evaluation_id from event_links where left_id=$1 or right_id=$1",
      [a.eventId],
    );
    await pool.query(
      "update matching_evaluations set response_payload=jsonb_set(response_payload,'{answers,relation,confidence}','0.5') where id=$1",
      [evaluation.rows[0].evaluation_id],
    );
    assert.deepEqual(await boostRelatedMarkets(pool, a.id, items), items);
    await pool.query(
      "update matching_evaluations set response_payload=jsonb_set(response_payload,'{answers,relation,confidence}','0.99') where id=$1",
      [evaluation.rows[0].evaluation_id],
    );
    const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
    lifecycle.venues.limitless.lifecycle = "exit-only";
    await pool.query(
      "insert into runtime_policies(id,policy_key,effective_at,payload) values('test','venue_lifecycle',now()-interval '1 second',$1)",
      [lifecycle],
    );
    assert.deepEqual(await boostRelatedMarkets(pool, a.id, items), items);
    await pool.query("delete from runtime_policies where id='test'");
    await pool.query(
      "update unified_events set description='New rules' where id=$1",
      [b.eventId],
    );
    assert.deepEqual(await boostRelatedMarkets(pool, a.id, items), items);
  },
);
integration(
  "PG16: idempotent jobs, strict publication, fresh read and mutation invalidation",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("publish");
    await enqueue(pool, "contract", a, b, "test");
    await enqueue(pool, "contract", a, b, "test");
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from market_matching_jobs where status='queued'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(await runJob(pool, { key: "test", infer }), "approved");
    const links = await resolveMarketLinks(pool, a.id);
    assert.equal(links.length, 1);
    assert.equal(links[0].outcomes.length, 2);
    await pool.query(
      "update unified_events set description='Changed rules' where id=$1",
      [a.eventId],
    );
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
  },
);
integration(
  "PG16: policy disable immediately hides links without deleting history",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("policy");
    await enqueue(pool, "contract", a, b, "test");
    await runJob(pool, { key: "test", infer });
    const policy = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
    policy.venues.limitless.lifecycle = "exit-only";
    await pool.query(
      "insert into runtime_policies(id,policy_key,effective_at,payload) values('test','venue_lifecycle',now()-interval '1 second',$1)",
      [policy],
    );
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from market_links where left_id=$1 or right_id=$1",
          [a.id],
        )
      ).rows[0].n,
      1,
    );
    await pool.query("delete from runtime_policies where id='test'");
  },
);
integration(
  "PG16: racing update during inference records stale, does not publish",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("race");
    await enqueue(pool, "contract", a, b, "test");
    await runJob(pool, {
      key: "test",
      infer: async (...args) => {
        await pool.query(
          "update unified_markets set description='Changed' where id=$1",
          [a.id],
        );
        return infer(...args);
      },
    });
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    assert.equal(
      (
        await pool.query(
          "select disposition from matching_evaluations order by created_at desc limit 1",
        )
      ).rows[0].disposition,
      "stale",
    );
  },
);
integration(
  "PG16: concurrent leases are exclusive and expired lease is recoverable",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("lease");
    await enqueue(pool, "contract", a, b, "test");
    const claimed = await Promise.all([claim(pool), claim(pool)]);
    assert.equal(claimed.filter(Boolean).length, 1);
    await pool.query(
      "update market_matching_jobs set lease_until=now()-interval '1 second' where status='running'",
    );
    const next = await claim(pool);
    assert(next);
    assert.equal(next.attempts, 2);
    assert.notEqual(next.lease_token, claimed.find(Boolean)?.lease_token);
  },
);
integration(
  "PG16: exhausted budget defers without using an attempt",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("budget");
    await enqueue(pool, "contract", a, b, "test");
    assert.equal(
      await runJob(pool, { key: "test", infer, dailyBudget: 0.00001 }),
      "budget_wait",
    );
    const row = await pool.query(
      "select attempts from market_matching_jobs where status='queued'",
    );
    assert.equal(row.rows[0].attempts, 0);
  },
);
integration(
  "PG16: bounded retry records error and respects Retry-After",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("retry");
    await enqueue(pool, "contract", a, b, "test");
    assert.equal(
      await runJob(pool, {
        key: "test",
        infer: async () => {
          throw new InferenceError("http_429", true, 12000);
        },
      }),
      "retry",
    );
    const row = await pool.query(
      "select next_attempt_at>now()+interval '10 seconds' as deferred from market_matching_jobs where status='queued'",
    );
    assert(row.rows[0].deferred);
  },
);
integration(
  "PG16: event coverage becomes partial when a candidate is added",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("event");
    await enqueue(pool, "contract", a, b, "test");
    await runJob(pool, { key: "test", infer });
    const ea = await loadEvent(pool, a.eventId),
      eb = await loadEvent(pool, b.eventId);
    assert(ea && eb);
    await enqueue(pool, "event", ea, eb, "test");
    await runJob(pool, { key: "test", infer });
    assert.equal(
      (await resolveEventLinks(pool, a.eventId)).alternatives[0].coverage,
      "full",
    );
    await pool.query(
      "insert into unified_markets(id,event_id,venue,title,description,status,outcomes) values($2,$1,'limitless','Bob','Different','ACTIVE','[\"YES\",\"NO\"]')",
      [b.eventId, `${b.id}:new`],
    );
    assert.equal(
      (await resolveEventLinks(pool, a.eventId)).alternatives.length,
      0,
    );
    const changed = await loadEvent(pool, b.eventId);
    assert(changed);
    await enqueue(pool, "event", ea, changed, "test");
    await runJob(pool, { key: "test", infer });
    assert.equal(
      (await resolveEventLinks(pool, a.eventId)).alternatives[0].coverage,
      "partial",
    );
  },
);
integration(
  "PG16: bounded native candidate SQL executes; retention FKs protect snapshots",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a] = await seed("scan");
    await saveVersion(pool, "contract", a);
    assert((await candidates(pool, "contract", a)).length > 0);
    await assert.rejects(
      pool.query("delete from unified_markets where id=$1", [a.id]),
      /foreign key/,
    );
    const prefix =
      "with candidate_pool as (select id as market_id,event_id from unified_markets) ";
    const protectedRows = await pool.query(
      prefix + matchingProtectedReferences("candidate_pool"),
    );
    assert(protectedRows.rows.some((row) => row.market_id === a.id));
    const derivedRows = await pool.query(
      prefix + matchingDerivedReferences("candidate_pool"),
    );
    assert.equal(derivedRows.rows.length, 5);
    const sibling = `${a.id}:old-event-child`;
    await pool.query(
      "insert into unified_markets(id,event_id,venue,title,status) values($1,$2,$3,'Old event remaining child','CLOSED')",
      [sibling, a.eventId, a.venue],
    );
    const movedEvent = `${a.eventId}:moved`;
    await pool.query(
      "insert into unified_events(id,venue,title,status) values($1,$2,'New event','ACTIVE')",
      [movedEvent, a.venue],
    );
    await pool.query("update unified_markets set event_id=$2 where id=$1", [
      a.id,
      movedEvent,
    ]);
    const afterMove = await pool.query(
      prefix + matchingProtectedReferences("candidate_pool"),
    );
    assert(afterMove.rows.some((row) => row.market_id === sibling));
    const report = await pool.query(
      prefix + matchingDerivedReferences("candidate_pool"),
    );
    assert(
      Number(
        report.rows.find(
          (row) => row.label === "market_contract_event_versions_retained",
        )?.markets,
      ) > 0,
    );
  },
);

integration(
  "PG16: trusted enqueue promotes queued lazy work without taking running leases or resetting attempts",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("promoted-job");
    await enqueue(pool, "contract", a, b, "lazy");
    await matchingOverride({
      queuedJobs: 1,
      lazyQueuedJobs: 1,
      lazyEnabled: false,
    });
    await enqueue(pool, "contract", a, b, "warm");
    const warm = await claim(pool, 3, false);
    assert(warm);
    assert.equal(warm.candidate_source, "warm");
    await enqueue(pool, "contract", a, b, "revalidation");
    const running = await pool.query(
      "select candidate_source,attempts,lease_token from market_matching_jobs where id=$1",
      [warm.id],
    );
    assert.deepEqual(running.rows[0], {
      candidate_source: "warm",
      attempts: 1,
      lease_token: warm.lease_token,
    });
  },
);

integration(
  "PG16: lowering retry policy retires exhausted queued work and expired leases",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("retry-policy");
    await enqueue(pool, "contract", a, b, "warm");
    await pool.query(
      "update market_matching_jobs set attempts=2,next_attempt_at=now()+interval '1 hour' where status='queued'",
    );
    assert.equal(await claim(pool, 1), null);
    const remaining = await pool.query(
      "select count(*)::int as count from market_matching_jobs where status in ('queued','running')",
    );
    assert.equal(remaining.rows[0].count, 0);
  },
);

integration(
  "PG16: policy changes during inference prevent publication",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("policy-race");
    await enqueue(pool, "contract", a, b, "test");
    await runJob(pool, {
      key: "test",
      infer: async (...args) => {
        const policy = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
        policy.venues.limitless.indexerMode = "maintenance";
        await pool.query(
          "insert into runtime_policies(id,policy_key,effective_at,payload) values('race','venue_lifecycle',now()-interval '1 second',$1)",
          [policy],
        );
        return infer(...args);
      },
    });
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    await pool.query("delete from runtime_policies where id='race'");
  },
);
integration(
  "PG16: model drift persists a halt and cannot approve",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("drift");
    await enqueue(pool, "contract", a, b, "test");
    await assert.rejects(
      runJob(pool, {
        key: "test",
        infer: async (...args) => ({
          ...(await infer(...args)),
          model: "unknown-model",
        }),
      }),
      /model_drift/,
    );
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    await assert.rejects(runJob(pool, { key: "test", infer }), /model_drift/);
    await pool.query(
      "delete from market_matching_state where state_key='model_drift'",
    );
  },
);

integration(
  "PG16: demand flood is deduplicated and actor new-market quotas are durable",
  { skip: !url },
  async () => {
    await clearJobs();
    const actor = randomUUID();
    const [a] = await seed("demand");
    const flood = await Promise.all(
      Array.from({ length: 50 }, () => requestInterest(pool, a.id, actor)),
    );
    assert(flood.every((s) => s === "pending" || s === "limited"));
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from market_matching_interest where market_id=$1",
          [a.id],
        )
      ).rows[0].n,
      1,
    );
    for (let i = 0; i < 4; i++) {
      const [next] = await seed("quota");
      assert.equal(await requestInterest(pool, next.id, actor), "pending");
    }
    const [sixth] = await seed("quota-sixth");
    assert.equal(await requestInterest(pool, sixth.id, actor), "limited");
    assert.equal(await requestInterest(pool, a.id, actor), "pending");
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from market_matching_jobs where status='queued'",
        )
      ).rows[0].n,
      0,
    );
  },
);

integration(
  "PG16: discovery admits at most 2 events + 3 contracts, cooldown is global",
  { skip: !url },
  async () => {
    await clearJobs();
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours'",
    );
    const [a] = await seed("discovery");
    assert.equal(await requestInterest(pool, a.id, randomUUID()), "pending");
    assert.equal(await runDiscovery(pool), "completed");
    const jobs = await pool.query(
      "select entity_kind,count(*)::int as n from market_matching_jobs where status='queued' group by entity_kind",
    );
    assert(jobs.rows.some((r) => r.entity_kind === "contract" && r.n > 0));
    assert(jobs.rows.every((r) => r.n <= (r.entity_kind === "event" ? 2 : 3)));
    assert.equal(await requestInterest(pool, a.id, randomUUID()), "pending");
    assert.equal(await runDiscovery(pool), "idle");
    // Negative cache expires even if the source is unchanged: new targets can be found.
    await pool.query(
      "update market_matching_interest set next_attempt_at=now()-interval '1 second' where market_id=$1",
      [a.id],
    );
    assert.equal(await requestInterest(pool, a.id, randomUUID()), "pending");
  },
);

integration(
  "PG16: daily request cap and lazy share block inference before it is called",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("lazy-budget");
    await enqueue(pool, "contract", a, b, "lazy");
    await pool.query(
      "insert into market_matching_budget(budget_day,lazy_spent_usd) values((now() at time zone 'UTC')::date,$1) on conflict(budget_day) do update set reserved_usd=0,spent_usd=0,lazy_spent_usd=excluded.lazy_spent_usd,lazy_reserved_usd=0,request_count=0,lazy_request_count=0",
      [
        DEFAULT_MARKET_MATCHING_POLICY.dailyBudgetUsd *
          DEFAULT_MARKET_MATCHING_POLICY.lazyBudgetFraction,
      ],
    );
    const never = async () => {
      throw new Error("inference must not execute");
    };
    assert.equal(
      await runJob(pool, { key: "test", infer: never }),
      "budget_wait",
    );
    await pool.query(
      "update market_matching_jobs set candidate_source='warm',next_attempt_at=now() where status='queued'",
    );
    await pool.query("update market_matching_budget set request_count=$1", [
      DEFAULT_MARKET_MATCHING_POLICY.dailyRequests,
    ]);
    assert.equal(
      await runJob(pool, { key: "test", infer: never }),
      "budget_wait",
    );
    await pool.query(
      "update market_matching_budget set request_count=0,lazy_spent_usd=0",
    );
  },
);

integration(
  "PG16: event approval cannot expand into an unbounded child queue",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("no-fanout");
    const ea = await loadEvent(pool, a.eventId),
      eb = await loadEvent(pool, b.eventId);
    assert(ea && eb);
    await enqueue(pool, "event", ea, eb, "warm");
    assert.equal(await runJob(pool, { key: "test", infer }), "approved");
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from market_matching_jobs where status='queued'",
        )
      ).rows[0].n,
      0,
    );
  },
);

integration(
  "PG16: bounded warmer, revalidation and retention demand references execute",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("warm");
    await pool.query(
      "update unified_markets set volume_total=10000 where id=any($1::text[])",
      [[a.id, b.id]],
    );
    await pool.query(
      "delete from market_matching_state where state_key='warm'",
    );
    assert(
      (await warmInterest(pool)) <=
        DEFAULT_MARKET_MATCHING_POLICY.warmBatchSize,
    );
    assert.equal(await warmInterest(pool), 0);
    assert((await revalidateLinks(pool)) <= 10);
    const refs = await pool.query(
      "with candidate_pool as(select id as market_id,event_id from unified_markets) " +
        matchingProtectedReferences("candidate_pool"),
    );
    assert(refs.rows.some((r) => r.market_id === a.id));
    await assert.rejects(
      pool.query("delete from unified_markets where id=$1", [b.id]),
      /foreign key/,
    );
  },
);

integration(
  "PG16: expired contracts are hidden and never inferred",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("expired");
    await enqueue(pool, "contract", a, b, "warm");
    await pool.query(
      "update unified_markets set close_time=now()-interval '1 minute' where id=$1",
      [a.id],
    );
    assert.equal(
      await runJob(pool, {
        key: "test",
        infer: async () => {
          throw Error("must not infer");
        },
      }),
      "stale",
    );
    assert.equal(
      await requestInterest(pool, a.id, randomUUID()),
      "unavailable",
    );
  },
);

integration(
  "PG16: rolling daily actor quota and reserved warm capacity survive lazy flooding",
  { skip: !url },
  async () => {
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours'",
    );
    const actor = randomUUID();
    await pool.query(
      "insert into market_matching_demand_limits(actor_hash,market_id,requested_at) select $1,id,now()-interval '2 hours' from unified_markets order by id limit 20",
      [hash(["matching-demand", actor])],
    );
    const [a, b] = await seed("capacity");
    assert.equal(await requestInterest(pool, a.id, actor), "limited");
    const prefix = `limitless:flood:${randomUUID()}:`;
    await pool.query(
      "insert into unified_markets(id,event_id,venue,title,status,outcomes) select $1||generated_rows.n,$2,'limitless','Flood','ACTIVE','[\"YES\",\"NO\"]' from generate_series(1,100) generated_rows(n)",
      [prefix, a.eventId],
    );
    await pool.query(
      "insert into market_matching_interest(market_id,source) select id,'lazy' from unified_markets where starts_with(id,$1)",
      [prefix],
    );
    assert.equal(await requestInterest(pool, a.id, randomUUID()), "limited");
    await pool.query(
      "update unified_markets set volume_total=999999 where id=$1",
      [b.id],
    );
    await pool.query(
      "delete from market_matching_state where state_key='warm'",
    );
    assert((await warmInterest(pool)) > 0);
    assert.equal(
      (
        await pool.query(
          "select source from market_matching_interest where market_id=$1",
          [b.id],
        )
      ).rows[0].source,
      "warm",
    );
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours' where starts_with(market_id,$1)",
      [prefix],
    );
  },
);

integration(
  "PG16: unexpected provider cost latches a stop before publication",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("cost-drift");
    await enqueue(pool, "contract", a, b, "warm");
    await assert.rejects(
      runJob(pool, {
        key: "test",
        infer: async (...args) => ({ ...(await infer(...args)), cost: 0.02 }),
      }),
      /cost_drift/,
    );
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
    await assert.rejects(runJob(pool, { key: "test", infer }), /cost_drift/);
    await pool.query(
      "delete from market_matching_state where state_key='cost_drift'",
    );
  },
);

integration(
  "PG16: indexed rescue retrieves flat questions against grouped child claims without granting equivalence",
  { skip: !url },
  async () => {
    await clearJobs();
    const [a, b] = await seed("flat-group");
    await pool.query("update unified_events set title=$2 where id=$1", [
      a.eventId,
      "Will Ostium launch a token by December 31, 2026?",
    ]);
    await pool.query("update unified_events set title=$2 where id=$1", [
      b.eventId,
      "Will Ostium launch a token by ___ ?",
    ]);
    await pool.query("update unified_markets set title=$2 where id=$1", [
      a.id,
      "Will Ostium launch a token by December 31, 2026?",
    ]);
    await pool.query("update unified_markets set title=$2 where id=$1", [
      b.id,
      "December 31, 2026",
    ]);
    const [source] = await loadContracts(pool, [a.id]);
    const result = await discover(pool, source);
    assert(result.contracts.some((target) => target.id === b.id));
    assert.equal((await resolveMarketLinks(pool, a.id)).length, 0);
  },
);

integration(
  "PG16: captured Jev decisions replay through snapshots, queue, publication and resolver",
  { skip: !url },
  async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/calibration-replay.json", import.meta.url),
        "utf8",
      ),
    ) as {
      cases: {
        id: string;
        a: Contract;
        b: Contract;
        recordedResult: JevResult;
      }[];
    };
    for (const entry of fixture.cases) {
      await clearJobs();
      const marketIds: string[] = [];
      // Create isolated local identities; the recorded provider input has no venue IDs or prices.
      for (const c of [entry.a, entry.b]) {
        const id = `${c.venue}:replay:${randomUUID()}`;
        marketIds.push(id);
        await pool.query(
          "insert into unified_events(id,venue,title,description,status) values($1,$2,$3,$4,'ACTIVE')",
          [id + ":event", c.venue, c.event, c.parentRules],
        );
        await pool.query(
          "insert into unified_markets(id,event_id,venue,title,description,status,outcomes,metadata) values($1,$2,$3,$4,$5,'ACTIVE',$6,$7)",
          [
            id,
            id + ":event",
            c.venue,
            c.selection,
            c.rules[0],
            JSON.stringify(c.outcomes.map((o) => o.label)),
            {
              question: c.question,
              rulesPrimary: c.rules[1],
              rulesSecondary: c.rules[2],
            },
          ],
        );
        for (const o of c.outcomes)
          await pool.query(
            "insert into unified_market_tokens(market_id,token_id,outcome_side) values($1,$2,$3)",
            [id, `${id}:instrument:${o.label}`, o.side ?? o.label],
          );
      }
      const pair = await loadContracts(pool, marketIds);
      await enqueue(pool, "contract", pair[0], pair[1], "warm");
      const status = await runJob(pool, {
        key: "recorded-no-network",
        infer: async (kind, a, b) => {
          const request = makeRequest(kind, a, b);
          const recorded = entry.recordedResult.request;
          assert.deepEqual(
            request.state,
            recorded.state,
            `Replay evidence changed: ${entry.id}`,
          );
          assert.deepEqual(
            request.questions,
            recorded.questions,
            `Replay prompt changed: ${entry.id}`,
          );
          return { ...entry.recordedResult, request };
        },
      });
      assert.equal(status, "approved", entry.id);
      const links = await resolveMarketLinks(pool, marketIds[0]);
      assert.equal(links.length, 1, entry.id);
      assert(links[0].outcomes.length > 0, entry.id);
      await pool.query(
        "update unified_markets set description=description||' Changed cancellation rule.' where id=$1",
        [marketIds[1]],
      );
      assert.equal(
        (await resolveMarketLinks(pool, marketIds[0])).length,
        0,
        entry.id,
      );
    }
  },
);

integration(
  "PG16: policy-sized batches rotate through unseen markets, then due markets, within the bounded pool",
  { skip: !url },
  async () => {
    const [a] = await seed("selection-rotation");
    const prefix = `polymarket:rotation-${randomUUID()}-`;
    const ids = Array.from(
      { length: 650 },
      (_, i) => prefix + String(i).padStart(4, "0"),
    );
    await pool.query(
      `insert into unified_markets(id,event_id,venue,title,status,volume_total)
    select item_id,$2,'polymarket','Selection rotation','ACTIVE',1e18 from unnest($1::text[]) item_rows(item_id)`,
      [ids, a.eventId],
    );
    // Previous fixtures must not consume the pending capacity; only these high-score
    // rows fit the configured prefix. Closed rows are filtered before source quotas.
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours'",
    );
    const resetCycle = () =>
      pool.query("delete from market_matching_state where state_key='warm'");
    await matchingOverride({
      warmBatchSize: 300,
      warmTrendingCount: 300,
      warmPrefixCount: 600,
      warmLimitlessCount: 0,
      seedFeedCount: 0,
      seedMapCount: 0,
      seedWhalesCount: 0,
    });
    try {
      await resetCycle();
      assert.equal(await warmInterest(pool), 300);
      assert.equal(await warmInterest(pool), 0);
      await pool.query(
        "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours' where market_id=any($1::text[])",
        [ids],
      );
      await resetCycle();
      assert.equal(await warmInterest(pool), 300);
      const admitted = (
        await pool.query(
          "select market_id from market_matching_interest where market_id=any($1::text[]) order by market_id",
          [ids],
        )
      ).rows.map((r) => r.market_id);
      assert.deepEqual(admitted, ids.slice(0, 600));
      await resetCycle();
      assert.equal(await warmInterest(pool), 0); // pending and cooling rows cannot recycle
      await pool.query(
        "update market_matching_interest set status='done',next_attempt_at=now()-interval '1 hour' where market_id=$1",
        [ids[0]],
      );
      await resetCycle();
      assert.equal(await warmInterest(pool), 1);
      // Expanding just the policy pool exposes the remaining 50 unseen rows.
      await matchingOverride({
        warmBatchSize: 300,
        warmTrendingCount: 300,
        warmPrefixCount: 650,
        warmLimitlessCount: 0,
        seedFeedCount: 0,
        seedMapCount: 0,
        seedWhalesCount: 0,
      });
      await resetCycle();
      assert.equal(await warmInterest(pool), 50);
    } finally {
      await pool.query(
        "delete from market_matching_interest where market_id=any($1::text[])",
        [ids],
      );
      await pool.query("delete from unified_markets where id=any($1::text[])", [
        ids,
      ]);
      await resetCycle();
    }
  },
);

integration(
  "PG16: full storage skips unseen rows without starving due interests",
  { skip: !url },
  async () => {
    const [due] = await seed("stored-due");
    const [unseen] = await seed("storage-unseen");
    await pool.query(
      "update market_matching_interest set status='done',next_attempt_at=now()+interval '6 hours'",
    );
    await pool.query(
      "insert into market_matching_interest(market_id,source,status,next_attempt_at) values($1,'warm','done',now()-interval '1 hour')",
      [due.id],
    );
    await pool.query(
      "update unified_markets set volume_total=1e20 where id=any($1::text[])",
      [[due.id, unseen.id]],
    );
    const stored = (
      await pool.query(
        "select count(*)::int as total from market_matching_interest",
      )
    ).rows[0].total;
    await matchingOverride({
      warmTrendingCount: 1,
      warmPrefixCount: 2,
      warmLimitlessCount: 0,
      seedFeedCount: 0,
      seedMapCount: 0,
      seedWhalesCount: 0,
      storedInterests: stored,
      pendingInterests: 1,
      lazyStoredInterests: 0,
      lazyPendingInterests: 0,
    });
    try {
      await pool.query(
        "delete from market_matching_state where state_key='warm'",
      );
      assert.equal(await warmInterest(pool), 1);
      assert.equal(
        (
          await pool.query(
            "select status from market_matching_interest where market_id=$1",
            [due.id],
          )
        ).rows[0].status,
        "queued",
      );
      assert.equal(
        (
          await pool.query(
            "select 1 from market_matching_interest where market_id=$1",
            [unseen.id],
          )
        ).rowCount,
        0,
      );
    } finally {
      await pool.query(
        "update unified_markets set volume_total=null where id=any($1::text[])",
        [[due.id, unseen.id]],
      );
      await pool.query(
        "delete from market_matching_state where state_key='warm'",
      );
    }
  },
);
