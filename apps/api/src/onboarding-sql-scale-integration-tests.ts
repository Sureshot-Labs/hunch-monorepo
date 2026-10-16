// @requires-db
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { initialOnboardingState } from "./services/onboarding-state.js";
import {
  OnboardingService,
  clearUserOnboardingData,
} from "./services/onboarding-service.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=120000 -c jit=off",
});
const client = await pool.connect();
const statements = new Map<string, unknown[]>();
let depth = 0;
const session = {
  async query(text: string, values: unknown[] = []) {
    if (text === "begin")
      return client.query(`savepoint onboarding_scale_method_${++depth}`);
    if (text === "commit")
      return client.query(
        `release savepoint onboarding_scale_method_${depth--}`,
      );
    if (text === "rollback") {
      const result = await client.query(
        `rollback to savepoint onboarding_scale_method_${depth}`,
      );
      await client.query(
        `release savepoint onboarding_scale_method_${depth--}`,
      );
      return result;
    }
    statements.set(text, values);
    return client.query(text, values);
  },
  release() {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const service = new OnboardingService(db);
const id = (n: number) =>
  `a3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
const report: object[] = [];
let migrationReport: object = {};
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
  await client.query(`insert into users(id,display_name)
    select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Onboarding scale fixture'
    from generate_series(1,1000000) n`);
  // Child FK probes need representative parent statistics before bulk seeding.
  await client.query("analyze users");
  await client.query("savepoint onboarding_migration_scale");
  try {
    const before = Number(
      (await client.query("select pg_relation_size('users') as bytes")).rows[0]
        .bytes,
    );
    await client.query(
      "drop table user_interests,user_onboarding_state,onboarding_interests",
    );
    await client.query("alter table users drop column onboarding_version");
    const started = performance.now();
    await client.query(
      await readFile(
        new URL(
          "../../../packages/db/migrations/0281_user_onboarding.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const durationMs = performance.now() - started;
    const after = Number(
      (await client.query("select pg_relation_size('users') as bytes")).rows[0]
        .bytes,
    );
    assert.equal(
      after,
      before,
      "constant-default cohort migration must not rewrite a million-row heap",
    );
    assert.equal(
      (
        await client.query("select onboarding_version from users where id=$1", [
          id(1),
        ])
      ).rows[0].onboarding_version,
      0,
    );
    assert.equal(
      (
        await client.query(
          "insert into users(id) values($1) returning onboarding_version",
          [id(1000001)],
        )
      ).rows[0].onboarding_version,
      1,
    );
    migrationReport = {
      durationMs,
      heapBytesBefore: before,
      heapBytesAfter: after,
      existingCohort: 0,
      futureCohort: 1,
    };
  } finally {
    await client.query("rollback to savepoint onboarding_migration_scale");
    await client.query("release savepoint onboarding_migration_scale");
  }
  await client.query("analyze users");
  await client.query(`insert into content_assets(id,owner_user_id,kind,storage_key,original_filename,mime_type,status,public_url,byte_size,ready_at,checksum_sha256)
    select ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      ('a3000000-0000-4000-8000-'||lpad((case when n>90000 then 1 else n end)::text,12,'0'))::uuid,
      'image','onboarding-scale/'||n,'scale.jpg','image/jpeg','ready','https://example.test/scale/'||n,100,now(),repeat('b',64)
    from generate_series(1,100000) n`);
  await client.query(
    `update users set avatar_asset_id='a4000000-0000-4000-8000-000000000001' where id=$1`,
    [id(1)],
  );
  await client.query("analyze content_assets");
  const seeded = initialOnboardingState(false);
  seeded.steps.interests = { status: "completed", reason: null };
  await client.query(
    `insert into user_onboarding_state(user_id,revision,status,steps)
    select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,1,'in_progress',$1::jsonb
    from generate_series(1,100000) n`,
    [JSON.stringify(seeded.steps)],
  );
  await client.query(`insert into user_interests(user_id,interest_id)
    select ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,i
    from generate_series(1,100000) n cross join unnest(array['politics','technology','sports']) i`);
  await client.query(
    "analyze users; analyze user_onboarding_state; analyze user_interests; analyze onboarding_interests",
  );
  const selected = await service.get(id(1));
  assert.equal(selected.revision, 1);
  assert.equal((await service.get(id(1000000))).status, "not_started");
  await service.catalog();
  let state = await service.setInterests(id(1), {
    expectedRevision: 1,
    outcome: "completed",
    interestIds: ["usElections", "politics", "trump"],
  });
  for (const step of [
    "handle",
    "photo",
    "passkey",
    "notifications",
    "traders",
  ] as const) {
    state = await service.progress(id(1), {
      expectedRevision: state.revision,
      step,
      outcome: "skipped",
    });
  }
  await service.complete(id(1), state.revision);
  await clearUserOnboardingData(db, id(2));
  let ordinal = 0;
  for (const [text, recordedValues] of statements) {
    const variants = text.startsWith("select u.onboarding_version")
      ? [[id(1)], [id(1000000)], [id(1000001)]]
      : text.startsWith("delete from")
        ? [[id(1)], [id(2)]]
        : [recordedValues];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      for (const values of variants) {
        await client.query("savepoint onboarding_explain");
        try {
          // EXPLAIN ANALYZE mutates only this rollback-only disposable database.
          if (text.startsWith("insert into user_interests"))
            await client.query("delete from user_interests where user_id=$1", [
              values[0],
            ]);
          const name = `onboarding_scale_${++ordinal}`;
          await client.query(`prepare ${name} as ${text}`);
          const literals: string[] = [];
          for (const value of values)
            literals.push(
              (
                await client.query("select quote_nullable($1::text) as value", [
                  value,
                ])
              ).rows[0].value,
            );
          const explained = (
            await client.query(
              `explain (analyze,buffers,format json) execute ${name}${literals.length ? `(${literals.join(",")})` : ""}`,
            )
          ).rows[0]["QUERY PLAN"][0];
          const planNodes = nodes(explained.Plan);
          for (const node of planNodes) {
            if (node["Relation Name"] === "content_assets") {
              assert.ok(
                (node["Actual Rows"] ?? 0) +
                  (node["Rows Removed by Filter"] ?? 0) <=
                  1,
                "avatar evidence must look up one asset, including a hot owner with 10,001 assets",
              );
            }
            if (
              [
                "users",
                "user_onboarding_state",
                "user_interests",
                "content_assets",
              ].includes(node["Relation Name"] ?? "")
            ) {
              assert.notEqual(
                node["Node Type"],
                "Seq Scan",
                `${mode}: ${text}`,
              );
            }
          }
          report.push({
            sql: text.replace(/\s+/g, " ").trim(),
            mode,
            firstParameter: values[0] ?? null,
            executionMs: explained["Execution Time"],
            rows: explained.Plan["Actual Rows"],
            sharedHitBlocks: explained.Plan["Shared Hit Blocks"],
            sharedReadBlocks: explained.Plan["Shared Read Blocks"],
            indexes: planNodes
              .filter((node) => node["Index Name"])
              .map((node) => node["Index Name"]),
            scans: planNodes
              .filter((node) => node["Relation Name"])
              .map((node) => ({
                relation: node["Relation Name"],
                kind: node["Node Type"],
                rows: node["Actual Rows"],
                loops: node["Actual Loops"],
                removed:
                  "Rows Removed by Filter" in node
                    ? node["Rows Removed by Filter"]
                    : 0,
              })),
          });
          await client.query(`deallocate ${name}`);
        } finally {
          await client.query("rollback to savepoint onboarding_explain");
          await client.query("release savepoint onboarding_explain");
        }
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        suite: "onboarding-sql-scale",
        scale: {
          users: 1000000,
          states: 100000,
          interests: 300000,
          assets: 100000,
        },
        statementShapes: statements.size,
        migration: migrationReport,
        plans: report,
      },
      null,
      2,
    ),
  );
  console.log(
    "[onboarding-sql-scale-integration-tests] PG16 account-index access, empty/new/populated users, custom/generic plans and rollback-only writes passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
