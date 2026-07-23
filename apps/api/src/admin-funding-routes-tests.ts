#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  type FundingRuntimePolicy,
} from "./funding/policies/funding-policy.js";
import {
  registerAdminFundingRoutes,
  type AdminFundingPermission,
  type AdminFundingRouteDependencies,
} from "./routes/admin-funding.js";
import { adminHasPermission, type AdminRole } from "./services/admin-auth.js";

type StoredPolicyRow = {
  created_at: Date;
  created_by: string | null;
  effective_at: Date;
  id: string;
  payload: unknown;
  policy_key: string;
};

function createPolicyDb() {
  const rows: StoredPolicyRow[] = [];
  const db = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [{ locked: true } as unknown as T] };
      }
      if (sql.includes("insert into runtime_policies")) {
        const effectiveAt = params[1] as Date;
        const row: StoredPolicyRow = {
          id: `policy_${rows.length + 1}`,
          policy_key: String(params[0]),
          effective_at: effectiveAt,
          payload: JSON.parse(String(params[2])) as unknown,
          created_by: params[3] == null ? null : String(params[3]),
          created_at: effectiveAt,
        };
        rows.push(row);
        return { rows: [row as unknown as T] };
      }
      if (sql.includes("from runtime_policies")) {
        const key = String(params[0]);
        const active = rows
          .filter((row) => row.policy_key === key)
          .sort(
            (left, right) =>
              right.effective_at.getTime() - left.effective_at.getTime(),
          )[0];
        return { rows: active ? [active as unknown as T] : [] };
      }
      throw new Error(`unexpected funding route query: ${sql}`);
    },
  } as unknown as AdminFundingRouteDependencies["db"];
  return { db, rows };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildAuthorizer(permission: AdminFundingPermission) {
  return async (
    request: Parameters<
      ReturnType<Parameters<typeof registerAdminFundingRoutes>[1]["authorize"]>
    >[0],
    reply: Parameters<
      ReturnType<Parameters<typeof registerAdminFundingRoutes>[1]["authorize"]>
    >[1],
  ) => {
    const role = readHeader(request.headers["x-test-admin-role"]) as
      | AdminRole
      | undefined;
    if (!role) {
      return reply.code(401).send({ error: "admin_access_required" });
    }
    if (!adminHasPermission(role, permission)) {
      return reply.code(403).send({ error: "admin_permission_required" });
    }
    if (
      request.method !== "GET" &&
      readHeader(request.headers["x-csrf-token"]) !== "test-csrf"
    ) {
      return reply.code(403).send({ error: "admin_csrf_invalid" });
    }
    request.adminActor = {
      kind: "admin_account",
      id: `admin_${role}`,
      email: `${role}@example.com`,
      role,
    };
  };
}

async function buildTestApp(fixture: ReturnType<typeof createPolicyDb>) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAdminFundingRoutes(app, {
    db: fixture.db,
    authorize: buildAuthorizer,
    transact: (work) => work(fixture.db),
  });
  await app.ready();
  return app;
}

function mutableDefaultPolicy(): FundingRuntimePolicy {
  return structuredClone(DEFAULT_FUNDING_RUNTIME_POLICY);
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-funding-routes-tests] ok ${name}`);
}

await test("GET requires auth and gives viewers the fail-closed snapshot", async () => {
  const fixture = createPolicyDb();
  const app = await buildTestApp(fixture);

  const anonymous = await app.inject({
    method: "GET",
    url: "/admin/funding/policy",
  });
  assert.equal(anonymous.statusCode, 401);

  const viewer = await app.inject({
    method: "GET",
    url: "/admin/funding/policy",
    headers: { "x-test-admin-role": "viewer" },
  });
  assert.equal(viewer.statusCode, 200);
  const body = viewer.json<{
    ok: boolean;
    resolved: {
      source: string;
      policy: { creationMode: string };
    };
  }>();
  assert.equal(body.ok, true);
  assert.equal(body.resolved.source, "default");
  assert.equal(body.resolved.policy.creationMode, "off");
  await app.close();
});

await test("diff requires funding:write and CSRF", async () => {
  const fixture = createPolicyDb();
  const app = await buildTestApp(fixture);
  const candidate = mutableDefaultPolicy();

  const viewer = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/diff",
    headers: {
      "x-csrf-token": "test-csrf",
      "x-test-admin-role": "viewer",
    },
    payload: { candidate },
  });
  assert.equal(viewer.statusCode, 403);
  assert.equal(
    viewer.json<{ error: string }>().error,
    "admin_permission_required",
  );

  const missingCsrf = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/diff",
    headers: { "x-test-admin-role": "admin" },
    payload: { candidate },
  });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(
    missingCsrf.json<{ error: string }>().error,
    "admin_csrf_invalid",
  );
  await app.close();
});

await test("previews, exact-confirms, and rejects a stale republish", async () => {
  const fixture = createPolicyDb();
  const app = await buildTestApp(fixture);
  const candidate = structuredClone(
    DEFAULT_FUNDING_RUNTIME_POLICY,
  ) as FundingRuntimePolicy & {
    placement: { maximumFeeUsd: string };
  };
  candidate.placement.maximumFeeUsd = "1";
  const headers = {
    "x-csrf-token": "test-csrf",
    "x-test-admin-role": "admin",
  };

  const diffResponse = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/diff",
    headers,
    payload: { candidate },
  });
  assert.equal(diffResponse.statusCode, 200);
  const preview = diffResponse.json<{
    preview: {
      candidate: FundingRuntimePolicy;
      candidateRevision: string;
      confirmation: string;
      current: { revision: string };
      diff: Array<{ path: string }>;
      valid: true;
    };
  }>().preview;
  assert.equal(preview.valid, true);
  assert.deepEqual(
    preview.diff.map((entry) => entry.path),
    ["placement.maximumFeeUsd"],
  );

  const publishPayload = {
    candidate: preview.candidate,
    candidateRevision: preview.candidateRevision,
    confirmation: "PUBLISH THE WRONG POLICY",
    expectedCurrentRevision: preview.current.revision,
    requestId: "funding_request_123",
  };
  const mismatch = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/publish",
    headers,
    payload: publishPayload,
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json<{ code: string }>().code, "confirmation_mismatch");
  assert.equal(fixture.rows.length, 0);

  const published = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/publish",
    headers,
    payload: {
      ...publishPayload,
      confirmation: preview.confirmation,
    },
  });
  assert.equal(published.statusCode, 200);
  const publishedBody = published.json<{
    requestId: string;
    resolved: { revision: string; source: string };
  }>();
  assert.equal(publishedBody.requestId, "funding_request_123");
  assert.equal(publishedBody.resolved.source, "db");
  assert.equal(publishedBody.resolved.revision, preview.candidateRevision);
  assert.equal(fixture.rows.length, 1);
  assert.equal(fixture.rows[0]?.created_by, "admin_admin");

  const stale = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/publish",
    headers,
    payload: {
      ...publishPayload,
      confirmation: preview.confirmation,
      requestId: "funding_request_456",
    },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(
    stale.json<{ code: string }>().code,
    "current_revision_mismatch",
  );
  assert.equal(fixture.rows.length, 1);
  await app.close();
});

console.log("[admin-funding-routes-tests] complete");
