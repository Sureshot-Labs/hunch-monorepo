// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { DbQuery } from "./db.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { registerAdminAgentThesesRoutes } from "./routes/admin-agent-theses.js";
import { provisionAgentProfiles } from "./services/agent-theses-provision.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const db: DbQuery = { query: client.query.bind(client) };
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Agent authors admin", version: "1" } },
  transform: jsonSchemaTransform,
});
const adminId = randomUUID();
let savepoint = 0;
registerAdminAgentThesesRoutes(app, {
  db,
  authorize: (permission) => async (request, reply) => {
    const granted = String(request.headers["x-test-permissions"] ?? "").split(
      ",",
    );
    if (!granted.includes(permission)) {
      await reply.code(granted[0] ? 403 : 401).send({ error: "forbidden" });
      return;
    }
    request.adminActor = { kind: "admin_account", id: adminId };
  },
  transact: async (work) => {
    const name = `agent_admin_test_${++savepoint}`;
    await client.query(`savepoint ${name}`);
    try {
      const result = await work(db);
      await client.query(`release savepoint ${name}`);
      return result;
    } catch (error) {
      await client.query(`rollback to savepoint ${name}`);
      await client.query(`release savepoint ${name}`);
      throw error;
    }
  },
});
const headers = { "x-test-permissions": "intel:read,intel:write,users:write" };
const root = "/admin/agent-theses";
async function getState() {
  const result = await app.inject({ url: root, headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers["cache-control"], "private, no-store");
  return result.json();
}
try {
  await client.query("begin");
  await client.query("set local statement_timeout='15s'");
  assert.ok(
    Number(
      (await client.query("show server_version_num")).rows[0]
        .server_version_num,
    ) >= 160000,
  );
  await client.query(`create temporary table users (like public.users including all);
    create temporary table content_assets (like public.content_assets including all);
    create temporary table runtime_policies (like public.runtime_policies including all);
    alter table runtime_policies alter column created_at set default clock_timestamp();`);
  await app.ready();
  for (const path of [root, `${root}/authors/{specialization}`])
    assert.ok(app.swagger().paths?.[path]);
  assert.equal((await app.inject({ url: root })).statusCode, 401);
  let state = await getState();
  assert.equal(state.policy.enabled, false);
  assert.equal(state.policy.writerModel, "openai/gpt-6.1-sol");
  assert.equal(state.profiles.length, 0);
  const createUrl = `${root}/authors/politics`;
  for (const permissions of ["intel:read", "intel:write", "users:write"]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: createUrl,
          headers: { "x-test-permissions": permissions },
          payload: { revision: state.revision },
        })
      ).statusCode,
      403,
    );
  }
  const initialRevision = state.revision;
  const created = await app.inject({
    method: "POST",
    url: createUrl,
    headers,
    payload: { revision: initialRevision },
  });
  assert.equal(created.statusCode, 200, created.body);
  state = created.json();
  assert.notEqual(state.revision, initialRevision);
  const politics = state.policy.authors.find(
    (a: { specialization: string }) => a.specialization === "politics",
  );
  assert.equal(politics.enabled, false);
  assert.ok(politics.userId);
  assert.equal(state.profiles[0].handle, "hunch_politics");
  assert.equal(state.policy.enabled, false);
  const user = (
    await client.query("select * from users where id=$1", [politics.userId])
  ).rows[0];
  assert.equal(user.is_agent, true);
  assert.equal(user.onboarding_version, 0);
  assert.equal(user.email, null);
  assert.equal(
    (
      await client.query(
        "select count(*)::int as n from user_wallets where user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: createUrl,
        headers,
        payload: { revision: initialRevision },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: createUrl,
        headers,
        payload: { revision: state.revision },
      })
    ).statusCode,
    409,
  );

  const human = randomUUID();
  await client.query(
    "insert into users(id,handle,display_name) values($1,'hunch_sports','Human')",
    [human],
  );
  const conflict = await app.inject({
    method: "POST",
    url: `${root}/authors/sports`,
    headers,
    payload: { revision: state.revision },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(
    (await client.query("select is_agent from users where id=$1", [human]))
      .rows[0].is_agent,
    false,
  );
  assert.equal((await getState()).revision, state.revision);
  await client.query("delete from users where id=$1", [human]);

  await provisionAgentProfiles(db, true, "crypto"); // Existing CLI-created profile can be connected.
  const connected = await app.inject({
    method: "POST",
    url: `${root}/authors/crypto`,
    headers,
    payload: { revision: state.revision },
  });
  assert.equal(connected.statusCode, 200, connected.body);
  state = connected.json();
  const saveBody = () => ({
    revision: state.revision,
    policy: structuredClone(state.policy),
    profiles: state.profiles.map(
      (p: { id: string; displayName: string; bio: string }) => ({
        id: p.id,
        displayName: p.displayName,
        bio: p.bio,
      }),
    ),
  });
  const malicious = saveBody();
  malicious.policy.authors[0].userId = human;
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: root,
        headers,
        payload: malicious,
      })
    ).statusCode,
    400,
  );
  const invalid = saveBody();
  invalid.policy.enabled = true;
  assert.equal(
    (await app.inject({ method: "PUT", url: root, headers, payload: invalid }))
      .statusCode,
    400,
  );
  const oversized = saveBody();
  oversized.profiles[0].displayName = "x".repeat(81);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: root,
        headers,
        payload: oversized,
      })
    ).statusCode,
    400,
  );
  const valid = saveBody();
  valid.policy.authors[0].enabled = true;
  valid.policy.authors[0].approach =
    "Question implementation incentives, not just announcements.";
  valid.policy.authors[0].interests =
    "Погода, осадки и температура в Нью-Йорке";
  valid.policy.enabled = true;
  valid.profiles.find(
    (p: { id: string }) => p.id === politics.userId,
  ).displayName = "The Political Skeptic";
  const updated = await app.inject({
    method: "PUT",
    url: root,
    headers,
    payload: valid,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().policy.enabled, true);
  assert.equal(
    updated.json().policy.authors[0].interests,
    valid.policy.authors[0].interests,
  );
  assert.equal(
    updated
      .json()
      .profiles.find((p: { id: string }) => p.id === politics.userId)
      .displayName,
    "The Political Skeptic",
  );
  assert.equal(
    (await app.inject({ method: "PUT", url: root, headers, payload: valid }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await client.query(
        "select created_by_admin_id from runtime_policies order by effective_at desc,created_at desc limit 1",
      )
    ).rows[0].created_by_admin_id,
    adminId,
  );
  state = await getState();
  const avatarA = randomUUID();
  const avatarB = randomUUID();
  const unavailableAvatar = randomUUID();
  const oversizedAvatar = randomUUID();
  const videoAvatar = randomUUID();
  for (const [assetId, status, kind, bytes] of [
    [avatarA, "ready", "image", 4096],
    [avatarB, "ready", "image", 8192],
    [unavailableAvatar, "pending", "image", 4096],
    [oversizedAvatar, "ready", "image", 5_000_001],
    [videoAvatar, "ready", "video", 4096],
  ])
    await client.query(
      `insert into content_assets(id,status,kind,storage_key,public_url,original_filename,mime_type,byte_size,ready_at,checksum_sha256)
     values($1::uuid,$2,$3,($1::uuid)::text,case when $2='ready' then $4 else null end,
       'avatar.png','image/png',$5,case when $2='ready' then now() else null end,repeat('a',64))`,
      [
        assetId,
        status,
        kind,
        `https://media.example.test/${assetId}.png`,
        bytes,
      ],
    );
  const withAvatar = (assetId: string | null) => {
    const body = saveBody();
    return {
      ...body,
      profiles: body.profiles.map((p: { id: string }) =>
        p.id === politics.userId ? { ...p, avatarAssetId: assetId } : p,
      ),
    };
  };
  for (const assetId of [
    unavailableAvatar,
    oversizedAvatar,
    videoAvatar,
    randomUUID(),
  ]) {
    const rejected = await app.inject({
      method: "PUT",
      url: root,
      headers,
      payload: withAvatar(assetId),
    });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error, "agent_avatar_unavailable");
    assert.equal((await getState()).revision, state.revision);
  }
  for (const assetId of [avatarA, avatarB, null]) {
    const savedAvatar = await app.inject({
      method: "PUT",
      url: root,
      headers,
      payload: withAvatar(assetId),
    });
    assert.equal(savedAvatar.statusCode, 200, savedAvatar.body);
    state = savedAvatar.json();
    const profile = state.profiles.find(
      (p: { id: string }) => p.id === politics.userId,
    );
    assert.equal(profile.avatarAssetId, assetId);
    assert.equal(
      profile.avatarUrl,
      assetId ? `https://media.example.test/${assetId}.png` : null,
    );
    const persisted = (
      await client.query(
        "select avatar_asset_id,avatar_url,profile_avatar_edited_at from users where id=$1",
        [politics.userId],
      )
    ).rows[0];
    assert.equal(persisted.avatar_asset_id, assetId);
    assert.equal(persisted.avatar_url, profile.avatarUrl);
    assert.ok(persisted.profile_avatar_edited_at);
  }
  // Removing an avatar detaches the profile; shared verified images are not deleted.
  assert.equal(
    (
      await client.query("select status from content_assets where id=$1", [
        avatarB,
      ])
    ).rows[0].status,
    "ready",
  );
  // Older clients omit avatarAssetId: unrelated edits must preserve a legacy URL.
  await client.query(
    "update users set avatar_url='https://media.example.test/legacy.png' where id=$1",
    [politics.userId],
  );
  state = await getState();
  const omittedAvatar = await app.inject({
    method: "PUT",
    url: root,
    headers,
    payload: saveBody(),
  });
  assert.equal(omittedAvatar.statusCode, 200, omittedAvatar.body);
  state = omittedAvatar.json();
  assert.equal(
    state.profiles.find((p: { id: string }) => p.id === politics.userId)
      .avatarUrl,
    "https://media.example.test/legacy.png",
  );
  const clearedLegacy = await app.inject({
    method: "PUT",
    url: root,
    headers,
    payload: withAvatar(null),
  });
  assert.equal(clearedLegacy.statusCode, 200, clearedLegacy.body);
  state = clearedLegacy.json();
  assert.equal(
    state.profiles.find((p: { id: string }) => p.id === politics.userId)
      .avatarUrl,
    null,
  );
  const unchangedRevision = state.revision;
  await client.query("update users set social_suspended_at=now() where id=$1", [
    politics.userId,
  ]);
  assert.notEqual((await getState()).revision, unchangedRevision);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: root,
        headers,
        payload: saveBody(),
      })
    ).statusCode,
    409,
  );
  // Representative PK lookup: three requested users among many unrelated profiles.
  await client.query(
    `insert into users(display_name) select 'Unrelated fixture' from generate_series(1,50000)`,
  );
  await client.query("analyze users");
  const plan = (
    await client.query(
      `explain(analyze,buffers,format json)
    select u.id,u.handle,u.display_name,u.bio,u.avatar_asset_id,
      coalesce(a.public_url,u.avatar_url) as avatar_url,
      u.is_active,u.social_suspended_at is not null as suspended
    from users u left join content_assets a on a.id=u.avatar_asset_id and a.status='ready'
    where u.id=any($1::uuid[]) and u.is_agent order by u.id`,
      [[politics.userId, state.policy.authors[2].userId, randomUUID()]],
    )
  ).rows[0]["QUERY PLAN"][0];
  assert.ok(JSON.stringify(plan).includes("Index"));
  console.log(
    JSON.stringify({
      agentAdminUsers: 50002,
      lookupMs: plan["Execution Time"],
    }),
  );
  console.log(
    "Agent authors admin: PG16 create/connect/edit, permissions, conflict recovery, moderation, profile isolation and OpenAPI passed",
  );
} finally {
  await app.close();
  await client.query("rollback");
  client.release();
  await pool.end();
}
