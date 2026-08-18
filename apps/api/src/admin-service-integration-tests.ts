// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { env } from "./env.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { authenticateAdminServiceCredential } from "./services/admin-service-auth.js";
import {
  createAdminServicePrincipal,
  issueAdminServiceCredential,
  revokeAdminServiceCredential,
} from "./services/admin-service-principals.js";
import { serviceContentActor } from "./services/content-actor.js";
import {
  createContentArticle,
  listContentArticleAudit,
  updateContentArticle,
} from "./services/content.js";

const pool = await createIntegrationTestPool({ max: 2 });
const pepper = "admin-service-integration-pepper-32-bytes";
const previousPepper = env.adminServiceTokenPepper;
const actorAdminId = randomUUID();
const slug = `service-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let principalId: string | null = null;
let credentialId: string | null = null;
let articleId: string | null = null;

try {
  env.adminServiceTokenPepper = pepper;
  await pool.query(
    `
      insert into admin_accounts (id, email, status, role)
      values ($1, $2, 'active', 'sadmin')
    `,
    [actorAdminId, `admin-service-${actorAdminId}@example.test`],
  );
  const principal = await createAdminServicePrincipal(pool, {
    key: `integration-${actorAdminId.slice(0, 8)}`,
    displayName: "Integration key",
    actorAdminId,
    note: "integration test",
  });
  principalId = principal.id;
  const credential = await issueAdminServiceCredential(pool, {
    principalId,
    permissions: ["content:read", "content:write"],
    ttlDays: 1,
    actorAdminId,
    note: "integration test",
  });
  credentialId = credential.id;

  const authenticated = await authenticateAdminServiceCredential(
    pool,
    credential.token,
    { pepper },
  );
  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) throw new Error("Expected API key authentication");
  assert.deepEqual(authenticated.credential.permissions, [
    "content:read",
    "content:write",
  ]);

  const actor = serviceContentActor(
    authenticated.principal.id,
    authenticated.principal.displayName,
  );
  const created = await createContentArticle(
    pool,
    { slug, title: "Service-created article" },
    actor,
  );
  articleId = created.article.id;
  const updated = await updateContentArticle(
    pool,
    articleId,
    { expectedRevision: 1, title: "Service-updated article" },
    actor,
  );
  assert.equal(updated.article.draft.revision, 2);

  const articleRow = await pool.query<{ created_by_admin_id: string | null }>(
    `select created_by_admin_id from content_articles where id = $1`,
    [articleId],
  );
  assert.equal(articleRow.rows[0]?.created_by_admin_id, null);

  const audit = await listContentArticleAudit(pool, {
    articleId,
    limit: 10,
  });
  assert.deepEqual(
    audit.items.slice(0, 2).map((event) => [event.action, event.actor]),
    [
      [
        "article.updated",
        { kind: "service", id: principalId, label: "Integration key" },
      ],
      [
        "article.created",
        { kind: "service", id: principalId, label: "Integration key" },
      ],
    ],
  );

  await revokeAdminServiceCredential(pool, {
    credentialId,
    actorAdminId,
    reason: "integration test complete",
  });
  const revoked = await authenticateAdminServiceCredential(
    pool,
    credential.token,
    { pepper },
  );
  assert.equal(
    revoked.ok ? null : revoked.error,
    "revoked_admin_service_credential",
  );
} finally {
  env.adminServiceTokenPepper = previousPepper;
  if (principalId) {
    await pool.query(
      `delete from content_audit_events where actor_service_principal_id = $1`,
      [principalId],
    );
  }
  if (articleId) {
    await pool.query(`delete from content_articles where id = $1`, [articleId]);
  }
  if (credentialId) {
    await pool.query(`delete from admin_service_credentials where id = $1`, [
      credentialId,
    ]);
  }
  if (principalId) {
    await pool.query(`delete from admin_service_principals where id = $1`, [
      principalId,
    ]);
  }
  await pool.query(`delete from admin_accounts where id = $1`, [actorAdminId]);
  await pool.end();
}

console.log("[admin-service-integration-tests] passed");
