// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  configureContentTestRuntime,
  createContentTestPool,
} from "./content-test-runtime.js";
import type { ContentDocument } from "./schemas/content-blocks.js";
import { publishDueContentVersions } from "./services/content-worker.js";
import {
  cancelContentArticleSchedule,
  ContentError,
  createContentArticle,
  publishContentArticle,
  updateContentArticle,
} from "./services/content.js";

configureContentTestRuntime();

const pool = await createContentTestPool(6);
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const articleIds: string[] = [];
let assetId: string | null = null;

const document: ContentDocument = {
  schemaVersion: 1,
  blocks: [
    {
      id: randomUUID(),
      type: "paragraph",
      version: 1,
      data: { content: [{ type: "text", text: "Concurrency body" }] },
    },
  ],
};

async function createArticle(label: string) {
  if (!assetId) throw new Error("Test asset is not initialized");
  const created = await createContentArticle(
    pool,
    {
      slug: `content-concurrency-${label}-${suffix}`,
      title: `Content concurrency ${label}`,
      excerpt: "Concurrency-test excerpt",
      document,
      listCover: {
        assetId,
        alt: "Concurrency cover",
        decorative: false,
        crop: "16:9",
        presentation: "cover",
      },
    },
    null,
  );
  articleIds.push(created.article.id);
  return created.article;
}

async function scheduleArticle(label: string) {
  const article = await createArticle(label);
  const scheduled = await publishContentArticle(pool, {
    id: article.id,
    expectedRevision: article.draft.revision,
    actorAdminId: null,
    publishAt: new Date(Date.now() + 60_000),
    requireApproval: false,
  });
  await pool.query(
    `
      update content_publication_jobs
      set run_at = now()
      where article_id = $1 and status = 'pending'
    `,
    [article.id],
  );
  return scheduled.article;
}

try {
  const { rows: assetRows } = await pool.query<{ id: string }>(
    `
      insert into content_assets (
        status, kind, storage_key, public_url, original_filename, mime_type,
        byte_size, width, height, checksum_sha256, ready_at
      ) values (
        'ready', 'image', $1, 'https://cdn.example.com/concurrency.png',
        'concurrency.png', 'image/png', 1024, 1200, 630, $2, now()
      ) returning id
    `,
    [`tests/${suffix}/concurrency.png`, "1".repeat(64)],
  );
  assetId = assetRows[0].id;

  const optimistic = await createArticle("optimistic");
  const edits = await Promise.allSettled([
    updateContentArticle(
      pool,
      optimistic.id,
      { expectedRevision: 1, title: "Editor A" },
      null,
    ),
    updateContentArticle(
      pool,
      optimistic.id,
      { expectedRevision: 1, title: "Editor B" },
      null,
    ),
  ]);
  assert.equal(
    edits.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = edits.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(rejected.reason instanceof ContentError, true);
  assert.equal(
    (rejected.reason as ContentError).code,
    "content_revision_conflict",
  );

  const scheduled = await scheduleArticle("two-workers");
  const workerResults = await Promise.all([
    publishDueContentVersions(pool, 1, `test-worker-a-${suffix}`),
    publishDueContentVersions(pool, 1, `test-worker-b-${suffix}`),
  ]);
  assert.equal(workerResults[0] + workerResults[1], 1);
  const { rows: publishedRows } = await pool.query<{
    published_version_id: string | null;
    completed_jobs: string;
  }>(
    `
      select
        a.published_version_id,
        (
          select count(*)::text from content_publication_jobs j
          where j.article_id = a.id and j.status = 'completed'
        ) as completed_jobs
      from content_articles a where a.id = $1
    `,
    [scheduled.id],
  );
  assert.ok(publishedRows[0].published_version_id);
  assert.equal(publishedRows[0].completed_jobs, "1");

  for (let index = 0; index < 5; index += 1) {
    const race = await scheduleArticle(`cancel-race-${index}`);
    const results = await Promise.allSettled([
      cancelContentArticleSchedule(pool, {
        id: race.id,
        expectedRevision: race.draft.revision,
        actorAdminId: null,
      }),
      publishDueContentVersions(pool, 1, `test-race-${index}-${suffix}`),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const { rows } = await pool.query<{
      scheduled_version_id: string | null;
      pending_jobs: string;
    }>(
      `
        select
          a.scheduled_version_id,
          (
            select count(*)::text from content_publication_jobs j
            where j.article_id = a.id and j.status in ('pending', 'processing')
          ) as pending_jobs
        from content_articles a where a.id = $1
      `,
      [race.id],
    );
    assert.equal(rows[0].scheduled_version_id, null);
    assert.equal(rows[0].pending_jobs, "0");
  }

  const failing = await scheduleArticle("durable-failure");
  const routeSlug = failing.draft.slug;
  const routeOwner = await createArticle("route-owner");
  await pool.query(
    "update content_routes set article_id = $2 where slug = $1",
    [routeSlug, routeOwner.id],
  );
  assert.equal(
    await publishDueContentVersions(pool, 1, `test-failure-${suffix}`),
    0,
  );
  const { rows: failureRows } = await pool.query<{
    status: string;
    attempts: number;
    last_error: string | null;
  }>(
    `
      select status, attempts, last_error
      from content_publication_jobs
      where article_id = $1
      order by id desc limit 1
    `,
    [failing.id],
  );
  assert.equal(failureRows[0].status, "pending");
  assert.equal(failureRows[0].attempts, 1);
  assert.match(failureRows[0].last_error ?? "", /owned by another article/);

  const immutable = await scheduleArticle("immutable-version");
  const { rows: versionRows } = await pool.query<{ id: string }>(
    "select scheduled_version_id as id from content_articles where id = $1",
    [immutable.id],
  );
  await assert.rejects(
    () =>
      pool.query(
        "update content_article_versions set title = 'mutated' where id = $1",
        [versionRows[0].id],
      ),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "55000",
      ),
  );

  const deletable = await createArticle("audit-survives-delete");
  const { rows: auditRows } = await pool.query<{ id: string }>(
    `
      insert into content_audit_events (action, article_id)
      values ('test.audit_survival', $1)
      returning id::text as id
    `,
    [deletable.id],
  );
  await pool.query("delete from content_articles where id = $1", [
    deletable.id,
  ]);
  articleIds.splice(articleIds.indexOf(deletable.id), 1);
  const { rows: retainedAuditRows } = await pool.query<{ article_id: string }>(
    "select article_id from content_audit_events where id = $1",
    [auditRows[0].id],
  );
  assert.equal(retainedAuditRows[0].article_id, deletable.id);
  await pool.query("delete from content_audit_events where id = $1", [
    auditRows[0].id,
  ]);

  console.log("[content-concurrency-tests] passed");
} finally {
  if (articleIds.length > 0) {
    await pool.query(
      "delete from content_articles where id = any($1::uuid[])",
      [articleIds],
    );
  }
  if (assetId) {
    await pool.query("delete from content_assets where id = $1", [assetId]);
  }
  await pool.end();
}
