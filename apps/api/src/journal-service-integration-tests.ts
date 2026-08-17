// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx } from "@hunch/infra";

import {
  configureContentTestRuntime,
  createContentTestPool,
} from "./content-test-runtime.js";
import { env } from "./env.js";
import { authenticateJournalServiceCredential } from "./services/journal-service-auth.js";
import {
  disableJournalServicePrincipal,
  issueJournalServiceCredential,
  rotateJournalServiceCredential,
} from "./services/journal-service-principals.js";
import {
  claimJournalIdempotency,
  claimJournalIdempotencyInTransaction,
  completeJournalIdempotency,
  journalIdempotencyRequestHash,
  JournalIdempotencyError,
  releaseJournalIdempotencyLease,
} from "./services/journal-idempotency.js";
import { serviceContentActor } from "./services/content-actor.js";
import {
  ContentError,
  createContentArticle,
  createContentArticleInTransaction,
  listContentArticleVersions,
  transitionContentArticleReview,
  updateContentArticle,
  validateContentArticleForService,
} from "./services/content.js";

configureContentTestRuntime();
const pool = await createContentTestPool(5);
const principalId = randomUUID();
const principalKey = `journal-test-${randomUUID().slice(0, 8)}`;
const adminActorId = randomUUID();
const pepper = "journal-integration-pepper-at-least-32-bytes";
const previousPepper = env.journalServiceTokenPepper;
const auditAction = `journal.integration.${randomUUID()}`;
let articleId: string | null = null;

async function expectCheckViolation(work: () => Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23514",
    );
  });
}

try {
  env.journalServiceTokenPepper = pepper;
  await pool.query(
    `insert into admin_service_principals (id, key, display_name) values ($1, $2, $3)`,
    [principalId, principalKey, "Journal Integration Test"],
  );

  await expectCheckViolation(() =>
    pool.query(
      `
        insert into admin_service_credentials (
          service_principal_id, token_hmac, token_prefix, token_last_four,
          scopes, expires_at, created_note
        ) values ($1, $2, $3, $4, $5::text[], now() + interval '1 day', 'test')
      `,
      [
        principalId,
        "a".repeat(64),
        "hjs_v1.duplicate",
        "aaaa",
        ["journal:read", "journal:read"],
      ],
    ),
  );
  await expectCheckViolation(() =>
    pool.query(
      `
        insert into admin_service_credentials (
          service_principal_id, token_hmac, token_prefix, token_last_four,
          scopes, expires_at, created_note
        ) values ($1, $2, $3, $4, $5::text[], now() + interval '1 day', 'test')
      `,
      [
        principalId,
        "b".repeat(64),
        "hjs_v1.invalid",
        "bbbb",
        ["journal:publish"],
      ],
    ),
  );
  await expectCheckViolation(() =>
    pool.query(
      `
        insert into content_machine_idempotency_keys (
          service_principal_id, operation, idempotency_key, request_hash,
          lease_expires_at, lease_owner
        ) values ($1, 'create_article', 'bad key', $2, now() + interval '1 minute', 'owner')
      `,
      [principalId, "c".repeat(64)],
    ),
  );
  await expectCheckViolation(() =>
    pool.query(
      `insert into content_audit_events (action, actor_kind, actor_label) values ('invalid.admin', 'admin', 'invalid')`,
    ),
  );
  await expectCheckViolation(() =>
    pool.query(
      `
        insert into content_assets (
          kind, storage_key, original_filename, mime_type, checksum_sha256,
          created_by_admin_id, created_by_service_principal_id
        ) values ('image', $1, 'both.png', 'image/png', $2, $3, $4)
      `,
      [
        `tests/${randomUUID()}/invalid-both`,
        "d".repeat(64),
        adminActorId,
        principalId,
      ],
    ),
  );

  const legacyAdmin = await pool.query<{
    actor_kind: string;
    actor_label: string;
  }>(
    `
      insert into content_audit_events (action, actor_admin_id)
      values ($1, $2)
      returning actor_kind, actor_label
    `,
    [`${auditAction}.legacy-admin`, adminActorId],
  );
  assert.equal(legacyAdmin.rows[0]?.actor_kind, "admin");
  assert.equal(
    legacyAdmin.rows[0]?.actor_label,
    `legacy-admin:${adminActorId}`,
  );
  const legacySystem = await pool.query<{
    actor_kind: string;
    actor_label: string;
  }>(
    `insert into content_audit_events (action) values ($1) returning actor_kind, actor_label`,
    [`${auditAction}.legacy-system`],
  );
  assert.deepEqual(legacySystem.rows[0], {
    actor_kind: "system",
    actor_label: "legacy-system",
  });

  const assetId = randomUUID();
  await pool.query(
    `
      insert into content_assets (
        id, kind, storage_key, original_filename, mime_type, checksum_sha256,
        created_by_admin_id, updated_by_admin_id
      ) values ($1, 'image', $2, 'compat.png', 'image/png', $3, $4, $4)
    `,
    [assetId, `tests/${assetId}/compat`, "e".repeat(64), adminActorId],
  );
  const serviceWrite = await pool.query<{
    updated_by_admin_id: string | null;
    updated_by_service_principal_id: string | null;
  }>(
    `
      update content_assets set updated_by_service_principal_id = $2
      where id = $1
      returning updated_by_admin_id, updated_by_service_principal_id
    `,
    [assetId, principalId],
  );
  assert.deepEqual(serviceWrite.rows[0], {
    updated_by_admin_id: null,
    updated_by_service_principal_id: principalId,
  });
  const legacyWrite = await pool.query<{
    updated_by_admin_id: string | null;
    updated_by_service_principal_id: string | null;
  }>(
    `
      update content_assets set updated_by_admin_id = $2
      where id = $1
      returning updated_by_admin_id, updated_by_service_principal_id
    `,
    [assetId, adminActorId],
  );
  assert.deepEqual(legacyWrite.rows[0], {
    updated_by_admin_id: adminActorId,
    updated_by_service_principal_id: null,
  });

  const issueResults = await Promise.allSettled(
    Array.from({ length: 3 }, (_, index) =>
      issueJournalServiceCredential(pool, {
        principalId,
        scopes: ["journal:read", "journal:validate"],
        ttlDays: 30,
        actorAdminId: null as unknown as string,
        note: `concurrent issue ${index}`,
      }),
    ),
  );
  assert.equal(
    issueResults.filter((result) => result.status === "fulfilled").length,
    2,
  );
  assert.equal(
    issueResults.filter((result) => result.status === "rejected").length,
    1,
  );

  const issued = issueResults.find(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof issueJournalServiceCredential>>
    > => result.status === "fulfilled",
  );
  assert.ok(issued);
  const authenticated = await authenticateJournalServiceCredential(
    pool,
    issued.value.token,
    {
      pepper,
    },
  );
  assert.equal(authenticated.ok, true);
  const rotated = await rotateJournalServiceCredential(pool, {
    credentialId: issued.value.id,
    scopes: ["journal:read", "journal:draft:update"],
    ttlDays: 30,
    actorAdminId: null as unknown as string,
    note: "integration rotation",
  });
  assert.equal(rotated.rotatedCredentialId, issued.value.id);
  const replacement = await authenticateJournalServiceCredential(
    pool,
    rotated.token,
    { pepper },
  );
  assert.equal(replacement.ok, true);
  if (replacement.ok) {
    assert.deepEqual(replacement.credential.scopes, [
      "journal:draft:update",
      "journal:read",
    ]);
  }
  const revoked = await authenticateJournalServiceCredential(
    pool,
    issued.value.token,
    {
      pepper,
    },
  );
  assert.equal(revoked.ok ? null : revoked.error, "revoked_service_credential");
  await assert.rejects(
    () =>
      rotateJournalServiceCredential(pool, {
        credentialId: issued.value.id,
        scopes: ["journal:read"],
        ttlDays: 30,
        actorAdminId: null as unknown as string,
        note: "must not rotate a revoked credential",
      }),
    /already been revoked/,
  );

  const key = `integration:${randomUUID()}`;
  const requestHash = journalIdempotencyRequestHash("create_article", {
    slug: principalKey,
  });
  const firstClaim = await claimJournalIdempotency(pool, {
    principalId,
    operation: "create_article",
    idempotencyKey: key,
    requestHash,
    resourceType: "article",
  });
  await assert.rejects(
    () =>
      claimJournalIdempotency(pool, {
        principalId,
        operation: "create_article",
        idempotencyKey: key,
        requestHash,
        resourceType: "article",
      }),
    (error: unknown) =>
      error instanceof JournalIdempotencyError &&
      error.code === "idempotency_in_progress",
  );
  await releaseJournalIdempotencyLease(pool, firstClaim);
  const reclaimed = await claimJournalIdempotency(pool, {
    principalId,
    operation: "create_article",
    idempotencyKey: key,
    requestHash,
    resourceType: "article",
  });
  assert.equal(reclaimed.resourceId, firstClaim.resourceId);
  await completeJournalIdempotency(pool, reclaimed, {
    httpStatus: 201,
    response: { articleId: reclaimed.resourceId },
  });
  const replay = await claimJournalIdempotency(pool, {
    principalId,
    operation: "create_article",
    idempotencyKey: key,
    requestHash,
    resourceType: "article",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.resourceId, firstClaim.resourceId);
  await assert.rejects(
    () =>
      claimJournalIdempotency(pool, {
        principalId,
        operation: "create_article",
        idempotencyKey: key,
        requestHash: journalIdempotencyRequestHash("create_article", {
          slug: "different",
        }),
        resourceType: "article",
      }),
    (error: unknown) =>
      error instanceof JournalIdempotencyError &&
      error.code === "idempotency_key_reused",
  );
  await pool.query(
    `
      update content_machine_idempotency_keys
      set created_at = now() - interval '8 days',
          expires_at = now() - interval '1 second'
      where service_principal_id = $1 and idempotency_key = $2
    `,
    [principalId, key],
  );
  const expiredKeyHash = journalIdempotencyRequestHash("create_article", {
    slug: "reused-after-expiry",
  });
  const expiredKeyClaim = await claimJournalIdempotency(pool, {
    principalId,
    operation: "create_article",
    idempotencyKey: key,
    requestHash: expiredKeyHash,
    resourceType: "article",
  });
  assert.equal(expiredKeyClaim.replay, false);
  assert.notEqual(expiredKeyClaim.resourceId, firstClaim.resourceId);
  await completeJournalIdempotency(pool, expiredKeyClaim, {
    httpStatus: 201,
    response: { articleId: expiredKeyClaim.resourceId },
  });
  const stored = await pool.query<{ response: Record<string, unknown> }>(
    `select response from content_machine_idempotency_keys where service_principal_id = $1 and idempotency_key = $2`,
    [principalId, key],
  );
  const storedJson = JSON.stringify(stored.rows[0]?.response ?? {});
  assert.doesNotMatch(storedJson, /Bearer|https?:|presigned|header/i);

  const rolledBackKey = `integration-rollback:${randomUUID()}`;
  let rolledBackArticleId: string | null = null;
  await assert.rejects(
    () =>
      tx(pool, async (db) => {
        const claim = await claimJournalIdempotencyInTransaction(db, {
          principalId,
          operation: "create_article",
          idempotencyKey: rolledBackKey,
          requestHash: journalIdempotencyRequestHash("create_article", {
            slug: `${principalKey}-rollback`,
            title: "Rollback",
          }),
          resourceType: "article",
        });
        rolledBackArticleId = claim.resourceId;
        await createContentArticleInTransaction(
          db,
          { slug: `${principalKey}-rollback`, title: "Rollback" },
          serviceContentActor(principalId, "Journal Integration Test"),
          claim.resourceId,
        );
        throw new Error("force atomic rollback");
      }),
    /force atomic rollback/,
  );
  assert.ok(rolledBackArticleId);
  const rolledBackRows = await pool.query<{
    idem_count: string;
    article_count: string;
  }>(
    `
      select
        (select count(*)::text from content_machine_idempotency_keys where service_principal_id = $1 and idempotency_key = $2) as idem_count,
        (select count(*)::text from content_articles where id = $3) as article_count
    `,
    [principalId, rolledBackKey, rolledBackArticleId],
  );
  assert.deepEqual(rolledBackRows.rows[0], {
    idem_count: "0",
    article_count: "0",
  });

  const actor = serviceContentActor(principalId, "Journal Integration Test");
  const articleCreated = await createContentArticle(
    pool,
    {
      slug: `machine-${randomUUID().slice(0, 8)}`,
      title: "Machine-created draft",
    },
    actor,
  );
  articleId = articleCreated.article.id;
  assert.equal(articleCreated.article.status, "draft");
  assert.equal(articleCreated.article.createdByServicePrincipalId, principalId);
  assert.equal(articleCreated.article.updatedByServicePrincipalId, principalId);

  const meaningful = await updateContentArticle(
    pool,
    articleId,
    { expectedRevision: 1, title: "Machine-updated draft" },
    actor,
  );
  assert.equal(meaningful.article.draft.revision, 2);
  assert.equal(meaningful.article.updatedByServicePrincipalId, principalId);
  const versionsAfterUpdate = await listContentArticleVersions(pool, {
    articleId,
    limit: 20,
  });
  assert.equal(versionsAfterUpdate.items.length, 1);
  assert.equal(versionsAfterUpdate.items[0]?.kind, "checkpoint");
  assert.equal(
    versionsAfterUpdate.items[0]?.createdByServicePrincipalId,
    principalId,
  );
  const updateAudit = await pool.query<{
    actor_kind: string;
    actor_service_principal_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `
      select actor_kind, actor_service_principal_id, metadata
      from content_audit_events
      where article_id = $1 and action = 'article.updated'
      order by id desc limit 1
    `,
    [articleId],
  );
  assert.equal(updateAudit.rows[0]?.actor_kind, "service");
  assert.equal(updateAudit.rows[0]?.actor_service_principal_id, principalId);
  assert.equal(updateAudit.rows[0]?.metadata.previousRevision, 1);
  assert.equal(updateAudit.rows[0]?.metadata.newRevision, 2);

  const noOp = await updateContentArticle(
    pool,
    articleId,
    { expectedRevision: 2, title: "Machine-updated draft" },
    actor,
  );
  assert.equal(noOp.article.draft.revision, 2);
  const noOpCounts = await pool.query<{ versions: string; updates: string }>(
    `
      select
        (select count(*)::text from content_article_versions where article_id = $1) as versions,
        (select count(*)::text from content_audit_events where article_id = $1 and action = 'article.updated') as updates
    `,
    [articleId],
  );
  assert.deepEqual(noOpCounts.rows[0], { versions: "1", updates: "1" });

  await assert.rejects(
    () =>
      transitionContentArticleReview(pool, {
        id: articleId as string,
        expectedRevision: 2,
        actor,
        status: "approved",
      }),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "content_article_not_publishable" &&
      error.statusCode === 403,
  );
  await pool.query(
    `update content_articles set editorial_status = 'approved' where id = $1`,
    [articleId],
  );
  await assert.rejects(
    () =>
      transitionContentArticleReview(pool, {
        id: articleId as string,
        expectedRevision: 2,
        actor,
        status: "in_review",
      }),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "content_article_not_publishable" &&
      error.statusCode === 409,
  );
  await pool.query(
    `update content_articles set editorial_status = 'draft' where id = $1`,
    [articleId],
  );

  await assert.rejects(
    () =>
      updateContentArticle(
        pool,
        articleId as string,
        { expectedRevision: 1, title: "Stale overwrite" },
        actor,
      ),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "content_revision_conflict" &&
      error.details?.currentRevision === 2 &&
      typeof error.details.currentContentHash === "string",
  );
  const afterConflict = await pool.query<{ versions: string; updates: string }>(
    `
      select
        (select count(*)::text from content_article_versions where article_id = $1) as versions,
        (select count(*)::text from content_audit_events where article_id = $1 and action = 'article.updated') as updates
    `,
    [articleId],
  );
  assert.deepEqual(afterConflict.rows[0], { versions: "1", updates: "1" });

  const beforeValidation = await pool.query<{
    revision: number;
    audit_count: string;
  }>(
    `
      select draft.revision,
        (select count(*)::text from content_audit_events where article_id = $1) as audit_count
      from content_article_drafts draft where draft.article_id = $1
    `,
    [articleId],
  );
  const validation = await validateContentArticleForService(pool, articleId);
  assert.equal(validation.currentRevision, 2);
  assert.equal(validation.ready, false);
  assert.ok(validation.issues.length > 0);
  const afterValidation = await pool.query<{
    revision: number;
    audit_count: string;
  }>(
    `
      select draft.revision,
        (select count(*)::text from content_audit_events where article_id = $1) as audit_count
      from content_article_drafts draft where draft.article_id = $1
    `,
    [articleId],
  );
  assert.deepEqual(afterValidation.rows[0], beforeValidation.rows[0]);

  await pool.query(
    `update content_articles set archived_at = now() where id = $1`,
    [articleId],
  );
  await assert.rejects(
    () =>
      updateContentArticle(
        pool,
        articleId as string,
        { expectedRevision: 2, title: "Implicit unarchive attempt" },
        actor,
      ),
    (error: unknown) =>
      error instanceof ContentError &&
      error.code === "content_article_archived",
  );

  await pool.query(
    `
      insert into content_audit_events (
        action, actor_kind, actor_service_principal_id, actor_label
      ) values ($1, 'service', $2, 'Journal Integration Test')
    `,
    [auditAction, principalId],
  );
  await pool.query(
    `delete from content_machine_idempotency_keys where service_principal_id = $1`,
    [principalId],
  );
  await pool.query(
    `delete from admin_service_credentials where service_principal_id = $1`,
    [principalId],
  );
  await pool.query(`delete from content_assets where id = $1`, [assetId]);
  await pool.query(`delete from content_articles where id = $1`, [articleId]);
  articleId = null;
  await disableJournalServicePrincipal(pool, {
    principalId,
    actorAdminId: null as unknown as string,
    reason: "first disable reason",
  });
  await disableJournalServicePrincipal(pool, {
    principalId,
    actorAdminId: null as unknown as string,
    reason: "second disable reason",
  });
  const disabledPrincipal = await pool.query<{
    disabled_note: string | null;
  }>(
    `select metadata ->> 'disabledNote' as disabled_note from admin_service_principals where id = $1`,
    [principalId],
  );
  assert.equal(
    disabledPrincipal.rows[0]?.disabled_note,
    "first disable reason",
  );
  await pool.query(`delete from admin_service_principals where id = $1`, [
    principalId,
  ]);
  const survivingAudit = await pool.query<{ count: string }>(
    `select count(*)::text as count from content_audit_events where action = $1 and actor_service_principal_id = $2`,
    [auditAction, principalId],
  );
  assert.equal(survivingAudit.rows[0]?.count, "1");
} finally {
  env.journalServiceTokenPepper = previousPepper;
  await pool
    .query(
      `delete from content_machine_idempotency_keys where service_principal_id = $1`,
      [principalId],
    )
    .catch(() => undefined);
  await pool
    .query(
      `delete from admin_service_credentials where service_principal_id = $1`,
      [principalId],
    )
    .catch(() => undefined);
  await pool
    .query(
      `delete from content_assets where created_by_service_principal_id = $1 or updated_by_service_principal_id = $1`,
      [principalId],
    )
    .catch(() => undefined);
  if (articleId) {
    await pool
      .query(`delete from content_articles where id = $1`, [articleId])
      .catch(() => undefined);
  }
  await pool
    .query(`delete from admin_service_principals where id = $1`, [principalId])
    .catch(() => undefined);
  await pool
    .query(`delete from content_audit_events where action like $1`, [
      `${auditAction}%`,
    ])
    .catch(() => undefined);
  await pool.end();
}
