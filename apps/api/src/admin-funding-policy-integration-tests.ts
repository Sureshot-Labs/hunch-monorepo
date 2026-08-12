#!/usr/bin/env tsx

// @requires-db

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { tx } from "@hunch/infra";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { PoolClient } from "pg";

import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import {
  DEFAULT_FUNDING_INTENT_POLICY,
  type FundingIntentPolicy,
} from "./funding/policies/funding-policy-v2.js";
import {
  registerAdminFundingRoutes,
  type AdminFundingRouteDependencies,
} from "./routes/admin-funding.js";

const suffix = crypto.randomUUID();
const adminId = crypto.randomUUID();
const legacyUserId = crypto.randomUUID();
let app: FastifyInstance | null = null;

type PublishedPolicyRow = {
  created_by: string | null;
  created_by_admin_id: string | null;
  id: string;
};

async function publishAs(
  actor: Readonly<{
    id: string;
    kind: "admin_account" | "legacy_user";
  }>,
  candidate: FundingIntentPolicy,
): Promise<PublishedPolicyRow> {
  assert.ok(app);
  const headers = {
    "x-test-actor-id": actor.id,
    "x-test-actor-kind": actor.kind,
  };
  const diffResponse = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/diff",
    headers,
    payload: { candidate },
  });
  assert.equal(diffResponse.statusCode, 200, diffResponse.body);
  const preview = diffResponse.json<{
    preview: {
      candidate: unknown;
      candidateRevision: string;
      confirmation: string;
      current: { revision: string };
      valid: boolean;
    };
  }>().preview;
  assert.equal(preview.valid, true);

  const publishResponse = await app.inject({
    method: "POST",
    url: "/admin/funding/policy/publish",
    headers,
    payload: {
      candidate: preview.candidate,
      candidateRevision: preview.candidateRevision,
      confirmation: preview.confirmation,
      expectedCurrentRevision: preview.current.revision,
      requestId: `funding_policy_${actor.kind}_${suffix}`,
    },
  });
  assert.equal(publishResponse.statusCode, 200, publishResponse.body);

  const result = await pool.query<PublishedPolicyRow>(
    `select id::text, created_by::text, created_by_admin_id::text
     from runtime_policies
     where policy_key = 'funding_control_plane'
       and (created_by = $1 or created_by_admin_id = $1)
     order by created_at desc
     limit 1`,
    [actor.id],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

try {
  await pool.query(
    `insert into admin_accounts (id, email, status, role)
     values ($1, $2, 'active', 'admin')`,
    [adminId, `funding-policy-${suffix}@example.com`],
  );
  await pool.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [legacyUserId, `funding-policy-legacy-${suffix}@example.com`],
  );

  app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAdminFundingRoutes(app, {
    db: pool,
    authorize: () => async (request, reply) => {
      const kind = request.headers["x-test-actor-kind"];
      const id = request.headers["x-test-actor-id"];
      if (
        (kind !== "admin_account" && kind !== "legacy_user") ||
        typeof id !== "string"
      ) {
        return reply.code(401).send({ error: "test_actor_required" });
      }
      request.adminActor = { id, kind };
    },
    transact: (work) => tx(pool, (client: PoolClient) => work(client)),
  } satisfies AdminFundingRouteDependencies);
  await app.ready();

  const adminPolicy = await publishAs(
    {
      id: adminId,
      kind: "admin_account",
    },
    {
      ...DEFAULT_FUNDING_INTENT_POLICY,
      receive: { assets: ["base:usdc"], privy: false },
    },
  );
  assert.equal(adminPolicy.created_by, null);
  assert.equal(adminPolicy.created_by_admin_id, adminId);

  await new Promise((resolve) => setTimeout(resolve, 2));

  const legacyPolicy = await publishAs(
    {
      id: legacyUserId,
      kind: "legacy_user",
    },
    {
      ...DEFAULT_FUNDING_INTENT_POLICY,
      receive: { assets: ["base:usdc", "polygon:pusd"], privy: false },
    },
  );
  assert.equal(legacyPolicy.created_by, legacyUserId);
  assert.equal(legacyPolicy.created_by_admin_id, null);

  console.log(
    "[admin-funding-policy-integration-tests] dedicated admin and legacy user authorship passed",
  );
} finally {
  if (app) await app.close();
  await pool.query(
    `delete from runtime_policies
     where created_by = $1 or created_by_admin_id = $2`,
    [legacyUserId, adminId],
  );
  await pool.query("delete from admin_accounts where id = $1", [adminId]);
  await pool.query("delete from users where id = $1", [legacyUserId]);
}
