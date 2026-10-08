// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DbQuery } from "./db.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  buildAdminSocialEventsQuery,
  buildAdminSocialReportsQuery,
  listAdminSocialModerationEvents,
  listAdminSocialReports,
  moderateAdminSocialTarget,
  resolveAdminSocialReport,
} from "./services/social-moderation.js";
import { encodeSocialCursor } from "./services/social-primitives.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const db: DbQuery = { query: client.query.bind(client) as DbQuery["query"] };
const limits = {
  pageSize: 2,
  maxPageSize: 10,
  moderationReasonMaxGraphemes: 100,
};
const author = randomUUID();
const thesis = randomUUID();
const comment = randomUUID();
const admin = randomUUID();
const profileReport = randomUUID();
const thesisReport = randomUUID();
const commentReport = randomUUID();
async function transaction<T>(work: () => Promise<T>): Promise<T> {
  await client.query("savepoint social_fixture_step");
  try {
    const result = await work();
    await client.query("release savepoint social_fixture_step");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint social_fixture_step");
    await client.query("release savepoint social_fixture_step");
    throw error;
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
  await client.query("begin");
  await client.query(`
    create temporary table users(id uuid primary key,handle text,display_name text,bio text,social_suspended_at timestamptz,updated_at timestamptz,is_active boolean default true);
    create temporary table user_theses(id uuid primary key,author_id uuid,body text,moderation_hidden_at timestamptz,author_hidden_at timestamptz,proof_invalidated_at timestamptz);
    create temporary table social_comments(id uuid primary key,author_id uuid,thesis_id uuid,body text,moderation_hidden_at timestamptz,author_hidden_at timestamptz);
    create temporary table social_reports(id uuid primary key,reporter_id uuid,target_profile_id uuid,thesis_id uuid,comment_id uuid,target_kind text,target_id uuid,reason text,status text,created_at timestamptz,resolved_at timestamptz);
    create index on social_reports(status,created_at desc,id desc);
    create index on social_reports(target_kind,target_id,created_at desc,id desc);
    create temporary table social_moderation_events(id uuid primary key default gen_random_uuid(),target_kind text,target_id uuid,action text,reason text check(reason<>'force-audit-failure'),admin_id uuid,report_id uuid,created_at timestamptz default now());
    create index on social_moderation_events(created_at desc,id desc);
    create index on social_moderation_events(target_kind,target_id,created_at desc,id desc);
  `);
  await client.query(
    `insert into users(id,handle,display_name,bio) values($1,'trader','Trader','Public biography')`,
    [author],
  );
  await client.query(
    `insert into user_theses(id,author_id,body,author_hidden_at,proof_invalidated_at) values($1,$2,'Frozen thesis',now(),now())`,
    [thesis, author],
  );
  await client.query(
    `insert into social_comments(id,author_id,thesis_id,body,author_hidden_at) values($1,$2,$3,'Comment text',now())`,
    [comment, author, thesis],
  );
  for (const fixture of [
    { id: profileReport, kind: "user", target: author },
    { id: thesisReport, kind: "thesis", target: thesis },
    { id: commentReport, kind: "comment", target: comment },
  ]) {
    await client.query(
      `insert into social_reports(id,reporter_id,target_profile_id,thesis_id,comment_id,target_kind,target_id,reason,status,created_at)
      values($1,$2,$3,$4,$5,$6,$7,'Reported content','open','2026-10-08 10:00:00.123456+00')`,
      [
        fixture.id,
        author,
        fixture.kind === "user" ? fixture.target : null,
        fixture.kind === "thesis" ? fixture.target : null,
        fixture.kind === "comment" ? fixture.target : null,
        fixture.kind,
        fixture.target,
      ],
    );
  }
  const first = await listAdminSocialReports(db, { status: "open" }, limits);
  assert.equal(first.items.length, 2);
  const firstCursor = first.nextCursor;
  assert.ok(firstCursor);
  const second = await listAdminSocialReports(
    db,
    { status: "open", cursor: firstCursor },
    limits,
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map((item) => item.id)).size, 3);
  assert.equal(
    all.find((item) => item.target.kind === "user")?.targetPreview?.text,
    "trader\nPublic biography",
  );
  assert.equal(
    all.find((item) => item.target.kind === "thesis")?.targetPreview
      ?.authorHidden,
    true,
  );
  assert.equal(
    all.find((item) => item.target.kind === "thesis")?.targetPreview
      ?.proofInvalidated,
    true,
  );
  assert.equal(
    all.find((item) => item.target.kind === "comment")?.targetPreview
      ?.proofInvalidated,
    true,
  );
  assert.ok(all[0].createdAt.includes("123456"));
  assert.equal(
    (await listAdminSocialReports(db, { status: "resolved" }, limits)).items
      .length,
    0,
  );
  const thesisTarget = { kind: "thesis" as const, id: thesis };
  const hidden = await transaction(() =>
    moderateAdminSocialTarget(
      db,
      {
        target: thesisTarget,
        action: "hide",
        reason: "Confirmed violation",
        reportId: thesisReport,
      },
      admin,
      limits,
    ),
  );
  assert.equal(hidden.action, "hide");
  assert.equal(
    (
      await client.query(`select status from social_reports where id=$1`, [
        thesisReport,
      ])
    ).rows[0].status,
    "resolved",
  );
  await transaction(() =>
    moderateAdminSocialTarget(
      db,
      { target: thesisTarget, action: "unhide", reason: "Reversed on review" },
      admin,
      limits,
    ),
  );
  const state = (
    await client.query(`select * from user_theses where id=$1`, [thesis])
  ).rows[0];
  assert.equal(state.moderation_hidden_at, null);
  assert.ok(state.author_hidden_at);
  assert.ok(state.proof_invalidated_at);
  for (const action of ["hide", "unhide"] as const)
    await transaction(() =>
      moderateAdminSocialTarget(
        db,
        {
          target: { kind: "comment", id: comment },
          action,
          reason: "Reviewed comment",
        },
        admin,
        limits,
      ),
    );
  assert.ok(
    (
      await client.query(
        `select author_hidden_at from social_comments where id=$1`,
        [comment],
      )
    ).rows[0].author_hidden_at,
  );
  for (const action of ["suspend", "unsuspend"] as const)
    await transaction(() =>
      moderateAdminSocialTarget(
        db,
        {
          target: { kind: "user", id: author },
          action,
          reason: "Reviewed social access",
        },
        admin,
        limits,
      ),
    );
  const user = (
    await client.query(
      `select is_active,social_suspended_at from users where id=$1`,
      [author],
    )
  ).rows[0];
  assert.equal(user.is_active, true);
  assert.equal(user.social_suspended_at, null);
  await assert.rejects(
    transaction(() =>
      moderateAdminSocialTarget(
        db,
        {
          target: thesisTarget,
          action: "hide",
          reason: "Wrong report",
          reportId: commentReport,
        },
        admin,
        limits,
      ),
    ),
    /social_report_target_mismatch/,
  );
  await assert.rejects(
    transaction(() =>
      moderateAdminSocialTarget(
        db,
        { target: thesisTarget, action: "hide", reason: "force-audit-failure" },
        admin,
        limits,
      ),
    ),
  );
  assert.equal(
    (
      await client.query(
        `select moderation_hidden_at from user_theses where id=$1`,
        [thesis],
      )
    ).rows[0].moderation_hidden_at,
    null,
  );
  await assert.rejects(
    transaction(() =>
      moderateAdminSocialTarget(
        db,
        {
          target: { kind: "user", id: randomUUID() },
          action: "suspend",
          reason: "Missing target",
        },
        admin,
        limits,
      ),
    ),
    /social_target_unavailable/,
  );
  await assert.rejects(
    transaction(() =>
      resolveAdminSocialReport(
        db,
        randomUUID(),
        "Missing report",
        admin,
        limits,
      ),
    ),
    /social_report_not_found/,
  );
  const closed = await transaction(() =>
    resolveAdminSocialReport(
      db,
      commentReport,
      "No violation found",
      admin,
      limits,
    ),
  );
  assert.equal(closed.action, "resolve_report");
  const events = await listAdminSocialModerationEvents(db, {}, limits);
  const eventCursor = events.nextCursor;
  assert.ok(eventCursor);
  const eventsTail = await listAdminSocialModerationEvents(
    db,
    { cursor: eventCursor },
    limits,
  );
  assert.equal(eventsTail.items.length, 2);
  const scoped = await listAdminSocialModerationEvents(
    db,
    { target: thesisTarget },
    limits,
  );
  assert.equal(scoped.items.length, 2);
  assert.equal(scoped.nextCursor, null);
  assert.equal(
    (
      await listAdminSocialModerationEvents(
        db,
        { target: { kind: "user", id: randomUUID() } },
        limits,
      )
    ).items.length,
    0,
  );

  // Representative administrative history: large cold prefix and sparse exact target.
  await client.query(`insert into social_reports(id,target_kind,target_id,reason,status,created_at)
    select md5('social-report-'||sample_idx)::uuid,'user',md5('social-target-'||sample_idx)::uuid,'Historical report',case when sample_idx%2=0 then 'open' else 'resolved' end,
    '2026-01-01'::timestamptz+sample_idx*interval '1 second' from generate_series(1,50000) sample_idx;
    insert into social_moderation_events(id,target_kind,target_id,action,reason,created_at)
    select md5('social-event-'||sample_idx)::uuid,'user',md5('social-target-'||sample_idx)::uuid,'resolve_report','Historical audit',
    '2026-01-01'::timestamptz+sample_idx*interval '1 second' from generate_series(1,50000) sample_idx;
    insert into users(id,display_name) select md5('social-target-'||sample_idx)::uuid,'Historical author' from generate_series(1,50000) sample_idx;
    insert into user_theses(id,author_id,body) select md5('social-thesis-'||sample_idx)::uuid,md5('social-target-'||sample_idx)::uuid,'Historical thesis' from generate_series(1,50000) sample_idx;
    insert into social_comments(id,author_id,thesis_id,body) select md5('social-comment-'||sample_idx)::uuid,md5('social-target-'||sample_idx)::uuid,md5('social-thesis-'||sample_idx)::uuid,'Historical comment' from generate_series(1,50000) sample_idx;
    analyze social_reports; analyze social_moderation_events; analyze users; analyze user_theses; analyze social_comments;
    set local plan_cache_mode=force_generic_plan;
  `);
  const queries = [
    buildAdminSocialReportsQuery({ status: "open" }, limits),
    buildAdminSocialReportsQuery(
      { status: "open", cursor: firstCursor },
      limits,
    ),
    buildAdminSocialReportsQuery({ status: "resolved" }, limits),
    buildAdminSocialEventsQuery({}, limits),
    buildAdminSocialEventsQuery({ cursor: eventCursor }, limits),
    buildAdminSocialEventsQuery({ target: thesisTarget }, limits),
    buildAdminSocialEventsQuery(
      { target: { kind: "user", id: randomUUID() } },
      limits,
    ),
    buildAdminSocialReportsQuery(
      {
        status: "open",
        cursor: encodeSocialCursor({
          kind: "report",
          scope: "admin-social-reports:open",
          id: randomUUID(),
          timestamp: "1900-01-01T00:00:00Z",
        }),
      },
      limits,
    ),
    buildAdminSocialEventsQuery(
      {
        target: thesisTarget,
        cursor: encodeSocialCursor({
          kind: "report",
          scope: `admin-social-events:thesis:${thesis}`,
          id: randomUUID(),
          timestamp: "1900-01-01T00:00:00Z",
        }),
      },
      limits,
    ),
  ];
  type PlanNode = {
    "Relation Name"?: string;
    "Actual Rows"?: number;
    "Rows Removed by Filter"?: number;
    "Node Type"?: string;
    "Index Name"?: string;
    "Actual Loops"?: number;
    "Local Hit Blocks"?: number;
    "Local Read Blocks"?: number;
    Plans?: PlanNode[];
  };
  function inspectPlan(
    label: string,
    plan: { Plan: PlanNode; "Execution Time": number },
  ) {
    const scans: Array<Record<string, unknown>> = [];
    function walk(node: PlanNode) {
      if (node["Relation Name"]) {
        const examined =
          (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0);
        assert.ok(
          examined <= limits.maxPageSize + 1,
          `${label} scanned too many rows in ${node["Relation Name"]}`,
        );
        scans.push({
          relation: node["Relation Name"],
          type: node["Node Type"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
          removed: node["Rows Removed by Filter"] ?? 0,
        });
      }
      for (const child of node.Plans ?? []) walk(child);
    }
    walk(plan.Plan);
    console.log(
      `[admin-social-integration-tests] ${label} ${JSON.stringify({ timeMs: plan["Execution Time"], hits: plan.Plan["Local Hit Blocks"], reads: plan.Plan["Local Read Blocks"], scans })}`,
    );
  }
  for (const [index, query] of queries.entries()) {
    const plan = (
      await client.query(
        `explain(analyze,buffers,format json) ${query.text}`,
        query.values,
      )
    ).rows[0]["QUERY PLAN"][0];
    inspectPlan(`query ${index}`, plan);
    const preparedName = `social_admin_probe_${index}`;
    await client.query(`prepare ${preparedName} as ${query.text}`);
    const literals = query.values
      .map((value) =>
        typeof value === "number"
          ? String(value)
          : `'${String(value).replaceAll("'", "''")}'`,
      )
      .join(",");
    const generic = (
      await client.query(
        `explain(analyze,buffers,format json) execute ${preparedName}(${literals})`,
      )
    ).rows[0]["QUERY PLAN"][0];
    inspectPlan(`generic ${index}`, generic);
    await client.query(`deallocate ${preparedName}`);
  }
  console.log(
    "[admin-social-integration-tests] PG16 query execution, exact cursors, independent hides, rollback and representative plans PASS",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
