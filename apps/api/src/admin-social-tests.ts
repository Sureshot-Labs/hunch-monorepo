import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { DbQuery } from "./db.js";
import { registerAdminSocialRoutes } from "./routes/admin-social.js";
import {
  adminSocialEventsQuerySchema,
  adminSocialModerationBodySchema,
} from "./schemas/admin-social.js";
import {
  buildAdminSocialEventsQuery,
  buildAdminSocialReportsQuery,
  buildSocialModerationMutation,
  resolveAdminSocialLimits,
} from "./services/social-moderation.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";
import { encodeSocialCursor } from "./services/social-primitives.js";

const targetId = "00000000-0000-4000-8000-000000000001";
const reportId = "00000000-0000-4000-8000-000000000002";
const adminId = "00000000-0000-4000-8000-000000000003";
const eventId = "00000000-0000-4000-8000-000000000004";
const target = { kind: "thesis" as const, id: targetId };
const limits = { pageSize: 2, maxPageSize: 3, moderationReasonMaxGraphemes: 3 };
const valid = { target, action: "hide" as const, reason: "OK", reportId };

assert.equal(
  adminSocialModerationBodySchema.safeParse({
    ...valid,
    target: { kind: "user", id: targetId },
  }).success,
  false,
);
assert.equal(
  adminSocialModerationBodySchema.safeParse({ ...valid, action: "suspend" })
    .success,
  false,
);
assert.equal(
  adminSocialEventsQuerySchema.safeParse({ targetId }).success,
  false,
);
assert.equal(
  adminSocialEventsQuerySchema.safeParse({ targetKind: "user" }).success,
  false,
);
for (const kind of ["thesis", "comment"] as const)
  for (const action of ["hide", "unhide"] as const) {
    const query = buildSocialModerationMutation({ kind, id: targetId }, action);
    assert.ok(query.text.includes("moderation_hidden_at="));
    assert.ok(!query.text.includes("author_hidden_at="));
    assert.ok(!query.text.includes("proof_invalidated_at="));
  }
for (const action of ["suspend", "unsuspend"] as const) {
  const query = buildSocialModerationMutation(
    { kind: "user", id: targetId },
    action,
  );
  assert.ok(query.text.includes("social_suspended_at="));
  assert.ok(!query.text.includes("is_active="));
}
assert.throws(() => buildSocialModerationMutation(target, "suspend"));
assert.throws(() =>
  buildSocialModerationMutation({ kind: "user", id: targetId }, "hide"),
);
const reports = buildAdminSocialReportsQuery(
  { status: "open", limit: 99 },
  limits,
);
assert.equal(reports.values.at(-1), 4);
assert.ok(reports.text.indexOf("limit") < reports.text.indexOf("left join"));
const cursor = encodeSocialCursor({
  kind: "report",
  scope: `admin-social-events:thesis:${targetId}`,
  timestamp: "2026-10-08 10:10:10.123456+00",
  id: eventId,
});
const resumed = buildAdminSocialEventsQuery({ target, cursor }, limits);
assert.ok(resumed.values.includes("2026-10-08 10:10:10.123456+00"));
assert.throws(() => buildAdminSocialEventsQuery({ cursor }, limits));
let recoveryWarnings = 0;
const unavailableDb = {
  query: async () => {
    throw new Error("DB unavailable");
  },
} as unknown as DbQuery;
const recovery = await resolveAdminSocialLimits(
  unavailableDb,
  () => recoveryWarnings++,
);
assert.equal(
  recovery.moderationReasonMaxGraphemes,
  DEFAULT_SOCIAL_POLICY.moderationReasonMaxGraphemes,
);
assert.equal("minimumNotionalUsd" in recovery, false);
assert.equal(recoveryWarnings, 1);

const statements: string[] = [];
let transactionCalls = 0;
let invalidPolicy = false;
const db = {
  query: async (text: string, values: unknown[] = []) => {
    statements.push(text);
    if (text.includes("from runtime_policies"))
      return {
        rows: [
          {
            payload: invalidPolicy
              ? { pageSize: -1 }
              : {
                  pageSize: 2,
                  maxPageSize: 3,
                  moderationReasonMaxGraphemes: 3,
                },
            effective_at: new Date(),
          },
        ],
      };
    if (text.includes("with report_page"))
      return {
        rows: [
          {
            id: reportId,
            target_kind: "thesis",
            target_id: targetId,
            reporter_id: adminId,
            reason: "report",
            status: "open",
            created_at: "2026-10-08 10:00:00.123456+00",
            resolved_at: null,
            target_preview: null,
          },
        ],
      };
    if (text.includes("from social_moderation_events")) return { rows: [] };
    if (text.includes("from social_reports"))
      return {
        rows: [{ target_kind: "thesis", target_id: targetId, status: "open" }],
      };
    if (text.startsWith("update")) return { rows: [{ id: targetId }] };
    if (text.startsWith("insert into social_moderation_events"))
      return {
        rows: [
          {
            id: eventId,
            target_kind: values[0],
            target_id: values[1],
            action: values[2],
            reason: values[3],
            admin_id: values[4],
            report_id: values[5],
            created_at: "2026-10-08 10:00:00.123456+00",
          },
        ],
      };
    throw new Error(`Unexpected query: ${text}`);
  },
} as unknown as DbQuery;
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
registerAdminSocialRoutes(app, {
  db,
  transact: async (work) => {
    transactionCalls++;
    return work(db);
  },
  authorize: (permission) => async (request, reply) => {
    const role = request.headers["x-test-role"];
    if (!role)
      return reply
        .code(401)
        .send({ error: "admin_access_required", message: "Sign in" });
    if (permission === "users:write" && role !== "admin")
      return reply.code(403).send({
        error: "admin_permission_required",
        message: "Write access required",
      });
    if (request.method !== "GET" && request.headers["x-csrf-token"] !== "csrf")
      return reply
        .code(403)
        .send({ error: "admin_csrf_invalid", message: "CSRF required" });
    request.adminActor = { kind: "admin_account", id: adminId };
  },
});
try {
  assert.equal(
    (await app.inject({ method: "GET", url: "/admin/social/reports" }))
      .statusCode,
    401,
  );
  const read = await app.inject({
    method: "GET",
    url: "/admin/social/reports",
    headers: { "x-test-role": "viewer" },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["cache-control"], "private, no-store");
  assert.deepEqual(read.json().items[0].target, target);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/admin/social/moderation-events?targetId=${targetId}`,
        headers: { "x-test-role": "viewer" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/admin/social/moderation",
        payload: valid,
        headers: { "x-test-role": "viewer", "x-csrf-token": "csrf" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/admin/social/moderation",
        payload: valid,
        headers: { "x-test-role": "admin" },
      })
    ).statusCode,
    403,
  );
  const headers = { "x-test-role": "admin", "x-csrf-token": "csrf" };
  const emoji = await app.inject({
    method: "POST",
    url: "/admin/social/moderation",
    payload: { ...valid, reason: "👨‍👩‍👧‍👦" },
    headers,
  });
  assert.equal(emoji.statusCode, 200);
  assert.equal(emoji.json().event.action, "hide");
  assert.equal(transactionCalls, 1);
  const writesBefore = statements.filter(
    (sql) => sql.startsWith("update") || sql.startsWith("insert"),
  ).length;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/admin/social/moderation",
        payload: { ...valid, reason: "Four" },
        headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    statements.filter(
      (sql) => sql.startsWith("update") || sql.startsWith("insert"),
    ).length,
    writesBefore,
  );
  invalidPolicy = true;
  const recover = await app.inject({
    method: "POST",
    url: "/admin/social/moderation",
    payload: { ...valid, action: "unhide", reason: "Restore after review" },
    headers,
  });
  assert.equal(recover.statusCode, 200);
  const close = await app.inject({
    method: "POST",
    url: `/admin/social/reports/${reportId}/resolve`,
    payload: { reason: "No violation" },
    headers,
  });
  assert.equal(close.statusCode, 200);
  assert.equal(close.json().event.action, "resolve_report");
  const audit = await app.inject({
    method: "GET",
    url: "/admin/social/moderation-events",
    headers: { "x-test-role": "viewer" },
  });
  assert.equal(audit.statusCode, 200);
} finally {
  await app.close();
}
console.log(
  "[admin-social-tests] schemas, policy limits/recovery, cursor binding, permission/CSRF, separated mutations and HTTP contract PASS",
);
