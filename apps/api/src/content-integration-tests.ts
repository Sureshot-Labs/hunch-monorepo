// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  configureContentTestRuntime,
  createContentTestPool,
} from "./content-test-runtime.js";
import type { ContentDocument } from "./schemas/content-blocks.js";
import {
  publishDueContentVersions,
  runContentRetention,
} from "./services/content-worker.js";
import {
  cancelContentArticleSchedule,
  ContentError,
  createContentArticle,
  createContentArticleCheckpoint,
  getContentArticleVersion,
  getPublicContentArticle,
  listAdminContentArticles,
  listContentArticleVersions,
  listPublicContentArticles,
  publishContentArticle,
  restoreContentArticleVersion,
  unpublishContentArticle,
  updateContentArticle,
} from "./services/content.js";

configureContentTestRuntime();

const pool = await createContentTestPool(2);
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const originalSlug = `content-integration-${suffix}`;
const updatedSlug = `${originalSlug}-updated`;
let cleanupArticleId: string | null = null;
let cleanupRelatedArticleId: string | null = null;
let assetId: string | null = null;
let relatedAssetId: string | null = null;

const baseDocument: ContentDocument = {
  schemaVersion: 1,
  blocks: [
    {
      id: randomUUID(),
      type: "heading",
      version: 1,
      data: {
        level: 2,
        content: [{ type: "text", text: "Integration heading" }],
      },
    },
    {
      id: randomUUID(),
      type: "paragraph",
      version: 1,
      data: { content: [{ type: "text", text: "Integration article body." }] },
    },
  ],
};

try {
  const { rows: assetRows } = await pool.query<{ id: string }>(
    `
      insert into content_assets (
        status, kind, storage_key, public_url, original_filename, mime_type,
        byte_size, width, height, checksum_sha256, ready_at
      ) values (
        'ready', 'image', $1, 'https://cdn.example.com/cover.png',
        'cover.png', 'image/png', 1024, 1200, 630, $2, now()
      ) returning id
    `,
    [`tests/${suffix}/cover.png`, "0".repeat(64)],
  );
  assetId = assetRows[0].id;

  const { rows: relatedAssetRows } = await pool.query<{ id: string }>(
    `
      insert into content_assets (
        status, kind, storage_key, public_url, original_filename, mime_type,
        byte_size, width, height, checksum_sha256, ready_at
      ) values (
        'ready', 'image', $1, 'https://cdn.example.com/related.png',
        'related.png', 'image/png', 1024, 1200, 630, $2, now()
      ) returning id
    `,
    [`tests/${suffix}/related.png`, "1".repeat(64)],
  );
  relatedAssetId = relatedAssetRows[0].id;

  const relatedSlug = `${originalSlug}-related`;
  const relatedCreated = await createContentArticle(
    pool,
    {
      slug: relatedSlug,
      title: "Related integration article",
      excerpt: "Related integration-test excerpt",
      document: baseDocument,
      listCover: {
        assetId: relatedAssetId,
        alt: "Related integration cover",
        decorative: false,
        crop: "16:9",
        presentation: "cover",
      },
      author: {
        name: "Hunch",
        url: null,
        bio: null,
        avatarAssetId: null,
        showByline: true,
      },
      tags: [{ slug: "integration", label: "Integration" }],
    },
    null,
  );
  cleanupRelatedArticleId = relatedCreated.article.id;
  await publishContentArticle(pool, {
    id: relatedCreated.article.id,
    expectedRevision: 1,
    actorAdminId: null,
    requireApproval: false,
  });

  const document: ContentDocument = {
    ...baseDocument,
    blocks: [
      ...baseDocument.blocks,
      {
        id: randomUUID(),
        type: "relatedArticles",
        version: 1,
        data: {
          title: "Related articles",
          articleIds: [relatedCreated.article.id],
        },
      },
    ],
  };

  const created = await createContentArticle(
    pool,
    {
      slug: originalSlug,
      title: "Content integration article",
      excerpt: "Integration-test excerpt",
      document,
      listCover: {
        assetId,
        alt: "Integration cover",
        decorative: false,
        crop: "16:9",
        presentation: "cover",
      },
      author: {
        name: "Hunch",
        url: null,
        bio: null,
        avatarAssetId: null,
        showByline: true,
      },
      tags: [{ slug: "integration", label: "Integration" }],
    },
    null,
  );
  const articleId = created.article.id;
  cleanupArticleId = articleId;
  assert.equal(created.article.draft.revision, 1);
  assert.equal(created.article.status, "draft");
  const adminSearch = await listAdminContentArticles(pool, {
    limit: 10,
    q: "Content integration article",
  });
  assert.equal(
    adminSearch.items.some((item) => item.id === articleId),
    true,
  );
  const adminSummary = adminSearch.items[0];
  assert.ok(adminSummary);
  assert.equal("document" in adminSummary.draft, false);

  const firstPublished = await publishContentArticle(pool, {
    id: articleId,
    expectedRevision: 1,
    actorAdminId: null,
    requireApproval: false,
  });
  assert.equal(firstPublished.article.status, "published");
  assert.equal(firstPublished.article.draft.revision, 2);
  assert.equal(
    (await getPublicContentArticle(pool, originalSlug))?.kind,
    "article",
  );
  const publicWithRelated = await getPublicContentArticle(pool, originalSlug);
  assert.equal(publicWithRelated?.kind, "article");
  if (publicWithRelated?.kind === "article") {
    assert.deepEqual(
      publicWithRelated.article.relatedArticles.map((article) => article.id),
      [relatedCreated.article.id],
    );
    assert.equal(
      publicWithRelated.article.assets.some(
        (asset) => asset.id === relatedAssetId && asset.publicUrl,
      ),
      true,
    );
  }

  const checkpoint = await createContentArticleCheckpoint(pool, {
    id: articleId,
    expectedRevision: 2,
    actorAdminId: null,
  });
  assert.equal(checkpoint.kind, "checkpoint");
  const duplicateCheckpoint = await createContentArticleCheckpoint(pool, {
    id: articleId,
    expectedRevision: 2,
    actorAdminId: null,
  });
  assert.equal(duplicateCheckpoint.id, checkpoint.id);

  const updated = await updateContentArticle(
    pool,
    articleId,
    {
      expectedRevision: 2,
      slug: updatedSlug,
      title: "Updated draft title",
    },
    null,
  );
  assert.equal(updated.article.draft.revision, 3);
  assert.equal(updated.article.hasUnpublishedChanges, true);

  await assert.rejects(
    () =>
      updateContentArticle(
        pool,
        articleId,
        { expectedRevision: 2, excerpt: "Stale edit" },
        null,
      ),
    (error) =>
      error instanceof ContentError &&
      error.code === "content_revision_conflict",
  );

  const stillLive = await getPublicContentArticle(pool, originalSlug);
  assert.equal(stillLive?.kind, "article");
  if (stillLive?.kind === "article") {
    assert.equal(stillLive.article.title, "Content integration article");
  }
  assert.equal(await getPublicContentArticle(pool, updatedSlug), null);

  const republished = await publishContentArticle(pool, {
    id: articleId,
    expectedRevision: 3,
    actorAdminId: null,
    requireApproval: false,
  });
  assert.equal(republished.article.draft.revision, 4);
  assert.deepEqual(await getPublicContentArticle(pool, originalSlug), {
    kind: "redirect",
    slug: updatedSlug,
  });
  const publicUpdated = await getPublicContentArticle(pool, updatedSlug);
  assert.equal(publicUpdated?.kind, "article");
  if (publicUpdated?.kind === "article") {
    assert.equal(publicUpdated.article.title, "Updated draft title");
    assert.equal(
      publicUpdated.article.assets.some(
        (asset) => asset.id === assetId && asset.publicUrl,
      ),
      true,
    );
  }

  const publicList = await listPublicContentArticles(pool, { limit: 10 });
  const summary = publicList.items.find((article) => article.id === articleId);
  assert.ok(summary);
  assert.equal("document" in summary, false);
  assert.equal(
    publicList.assets.some((asset) => asset.id === assetId && asset.publicUrl),
    true,
  );

  const versions = await listContentArticleVersions(pool, {
    articleId,
    limit: 10,
  });
  assert.deepEqual(
    versions.items.map((version) => version.kind),
    ["published", "checkpoint", "published"],
  );
  assert.equal("snapshot" in versions.items[0], false);
  const firstVersion = versions.items.at(-1);
  assert.ok(firstVersion);
  const versionDetail = await getContentArticleVersion(
    pool,
    articleId,
    firstVersion.id,
  );
  assert.equal(versionDetail?.snapshot.slug, originalSlug);

  const restored = await restoreContentArticleVersion(pool, {
    id: articleId,
    versionId: firstVersion.id,
    expectedRevision: 4,
    actorAdminId: null,
  });
  assert.equal(restored.article.draft.slug, originalSlug);
  assert.equal(restored.article.draft.revision, 5);
  assert.deepEqual(await getPublicContentArticle(pool, originalSlug), {
    kind: "redirect",
    slug: updatedSlug,
  });

  const unpublished = await unpublishContentArticle(pool, {
    id: articleId,
    expectedRevision: 5,
    actorAdminId: null,
  });
  assert.equal(unpublished.article.status, "draft");
  assert.equal(unpublished.article.draft.revision, 6);
  assert.equal(await getPublicContentArticle(pool, updatedSlug), null);

  const scheduled = await publishContentArticle(pool, {
    id: articleId,
    expectedRevision: 6,
    actorAdminId: null,
    publishAt: new Date(Date.now() + 60_000),
    requireApproval: false,
  });
  assert.equal(scheduled.article.status, "scheduled");
  assert.equal(scheduled.article.draft.revision, 7);
  assert.equal(await getPublicContentArticle(pool, originalSlug), null);
  const cancelled = await cancelContentArticleSchedule(pool, {
    id: articleId,
    expectedRevision: 7,
    actorAdminId: null,
  });
  assert.equal(cancelled.article.scheduled, null);
  assert.equal(cancelled.article.draft.revision, 8);
  assert.equal(await publishDueContentVersions(pool, 10), 0);

  const rescheduled = await publishContentArticle(pool, {
    id: articleId,
    expectedRevision: 8,
    actorAdminId: null,
    publishAt: new Date(Date.now() + 60_000),
    requireApproval: false,
  });
  assert.equal(rescheduled.article.status, "scheduled");
  assert.equal(rescheduled.article.draft.revision, 9);
  await pool.query(
    `update content_publication_jobs set run_at = now() where article_id = $1 and status = 'pending'`,
    [articleId],
  );
  assert.equal(await publishDueContentVersions(pool, 10), 1);
  assert.equal(
    (await getPublicContentArticle(pool, originalSlug))?.kind,
    "article",
  );
  assert.deepEqual(await getPublicContentArticle(pool, updatedSlug), {
    kind: "redirect",
    slug: originalSlug,
  });

  const retentionKey = `retention:${suffix}`;
  await pool.query(
    `
      insert into content_outbox (
        event_type, article_id, dedupe_key, payload, processed_at, created_at
      ) values (
        'article_updated', $1, $2,
        '{"event":"article_updated"}'::jsonb,
        now() - interval '200 days', now() - interval '200 days'
      )
    `,
    [articleId, retentionKey],
  );
  await pool.query(
    `
      insert into content_storage_deletion_jobs (
        storage_key, status, completed_at, created_at
      ) values ($1, 'completed', now() - interval '200 days', now() - interval '200 days')
    `,
    [retentionKey],
  );
  const { rows: oldAuditRows } = await pool.query<{ id: string }>(
    `
      insert into content_audit_events (action, article_id, created_at)
      values ('test.retention', $1, now() - interval '800 days')
      returning id::text as id
    `,
    [articleId],
  );
  assert.ok((await runContentRetention(pool, 100)) >= 3);
  const { rows: retainedRows } = await pool.query<{ count: string }>(
    `
      select (
        (select count(*) from content_outbox where dedupe_key = $1) +
        (select count(*) from content_storage_deletion_jobs where storage_key = $1) +
        (select count(*) from content_audit_events where id = $2)
      )::text as count
    `,
    [retentionKey, oldAuditRows[0].id],
  );
  assert.equal(retainedRows[0].count, "0");

  console.log("[content-integration-tests] passed");
} finally {
  if (cleanupArticleId) {
    await pool.query("delete from content_articles where id = $1", [
      cleanupArticleId,
    ]);
  }
  if (cleanupRelatedArticleId) {
    await pool.query("delete from content_articles where id = $1", [
      cleanupRelatedArticleId,
    ]);
  }
  if (assetId)
    await pool.query("delete from content_assets where id = $1", [assetId]);
  if (relatedAssetId)
    await pool.query("delete from content_assets where id = $1", [
      relatedAssetId,
    ]);
  await pool.end();
}
