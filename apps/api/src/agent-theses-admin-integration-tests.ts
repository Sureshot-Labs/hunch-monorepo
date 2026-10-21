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
import { agentFixtureAuthors } from "./fixtures/agent-theses-authors.js";

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
  for (const path of [root, `${root}/authors`])
    assert.ok(app.swagger().paths?.[path]);
  assert.equal((await app.inject({ url: root })).statusCode, 401);
  let state = await getState();
  assert.equal(state.policy.enabled, false);
  assert.equal(state.policy.writerModel, "openai/gpt-6.1-sol");
  assert.equal(state.profiles.length, 0);

  assert.deepEqual(state.policy.authors, []);
  assert.equal(state.templates.length, 3);
  assert.equal(state.writingLimits.maxThesisGraphemes, 12000);
  assert.equal(state.writingLimits.styleExamples, 12000);
  assert.ok(!JSON.stringify(state.templates).includes("handle"));
  const createUrl = `${root}/authors`;
  const settings = { ...agentFixtureAuthors[0] };
  const { userId: _id, enabled: _enabled, ...customSettings } = settings;
  const bodyFor = (handle: string) => ({
    revision: state.revision,
    handle,
    displayName: "Weather Oracle",
    bio: "AI. Paper positions.",
    settings: { ...customSettings, interests: "New York weather and rain" },
  });
  for (const permissions of ["intel:read", "intel:write", "users:write"]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: createUrl,
          headers: { "x-test-permissions": permissions },
          payload: bodyFor("weather_one"),
        })
      ).statusCode,
      403,
    );
  }
  const initialRevision = state.revision;
  const firstBody = bodyFor("Weather_One");
  Object.assign(firstBody.settings, {
    language: "Русский с английским сленгом",
    styleExamples: "Хорошо: ".repeat(800),
    style: "Пиши развёрнуто. ".repeat(200),
    maxThesisGraphemes: 12000,
  });
  const created = await app.inject({
    method: "POST",
    url: createUrl,
    headers,
    payload: firstBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  state = created.json();
  const politics = state.policy.authors[0]; // Identity is now an arbitrary user, not a topic.
  assert.equal(politics.enabled, false);
  assert.equal(politics.style, firstBody.settings.style.trim());
  assert.equal(politics.language, firstBody.settings.language);
  assert.equal(politics.styleExamples, firstBody.settings.styleExamples.trim());
  assert.equal(politics.maxThesisGraphemes, 12000);
  assert.equal((await getState()).policy.authors[0].maxThesisGraphemes, 12000);
  assert.ok(politics.userId);
  assert.equal("specialization" in politics, false);
  assert.equal(state.profiles[0].handle, "weather_one");
  assert.equal(state.policy.enabled, false);
  assert.notEqual(state.revision, initialRevision);
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
        payload: firstBody,
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
        payload: bodyFor("WEATHER_ONE"),
      })
    ).statusCode,
    409,
  );
  const human = randomUUID();
  await client.query(
    "insert into users(id,handle,display_name) values($1,'ordinary_user','Human')",
    [human],
  );
  const conflict = await app.inject({
    method: "POST",
    url: createUrl,
    headers,
    payload: bodyFor("ordinary_user"),
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(
    (await client.query("select is_agent from users where id=$1", [human]))
      .rows[0].is_agent,
    false,
  );
  assert.equal((await getState()).revision, state.revision);
  for (const handle of ["ab", "not-valid!", "x".repeat(21)]) {
    const invalidHandle = await app.inject({
      method: "POST",
      url: createUrl,
      headers,
      payload: bodyFor(handle),
    });
    assert.equal(invalidHandle.statusCode, 400, invalidHandle.body);
  }
  for (const handle of [
    "weather_two",
    "musk_fan",
    "musk_skeptic",
    "rain_fan",
  ]) {
    const added = await app.inject({
      method: "POST",
      url: createUrl,
      headers,
      payload: bodyFor(handle),
    });
    assert.equal(added.statusCode, 200, added.body);
    state = added.json();
  }
  assert.equal(state.policy.authors.length, 5);
  assert.equal(state.profiles.length, 5);
  assert.ok(
    state.policy.authors.every((a: { enabled: boolean }) => !a.enabled),
  );
  assert.equal(
    new Set(state.policy.authors.map((a: { userId: string }) => a.userId)).size,
    5,
  );
  const failedAvatar = await app.inject({
    method: "POST",
    url: createUrl,
    headers,
    payload: { ...bodyFor("bad_avatar"), avatarAssetId: randomUUID() },
  });
  assert.equal(failedAvatar.statusCode, 409, failedAvatar.body);
  assert.equal((await getState()).revision, state.revision);
  assert.equal(
    (await client.query("select id from users where handle='bad_avatar'")).rows
      .length,
    0,
  );
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
  // Upgrade persisted v1 slots without new users or loss of configured identities/settings.
  await client.query("savepoint legacy_agents");
  const legacy = {
    ...state.policy,
    version: 1,
    authors: agentFixtureAuthors.map((a, index) => {
      const { interests: _interests, ...rest } = a;
      return {
        ...rest,
        specialization: ["politics", "sports", "crypto"][index],
        userId: index === 1 ? null : state.policy.authors[index].userId,
        enabled: index === 0,
        ...(index === 2 ? { interests: "Putin" } : {}),
      };
    }),
  };
  await client.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('agent_theses',clock_timestamp(),$1::jsonb)",
    [JSON.stringify(legacy)],
  );
  const upgraded = await getState();
  assert.equal(upgraded.policy.version, 2);
  assert.equal(upgraded.policy.authors.length, 2);
  assert.equal(
    upgraded.policy.authors[0].userId,
    state.policy.authors[0].userId,
  );
  assert.equal(upgraded.policy.authors[0].enabled, true);
  assert.equal(
    upgraded.policy.authors[0].interests,
    agentFixtureAuthors[0].interests,
  );
  assert.equal(upgraded.policy.authors[1].interests, "Putin");
  const savedLegacy = await app.inject({
    method: "PUT",
    url: root,
    headers,
    payload: {
      revision: upgraded.revision,
      policy: upgraded.policy,
      profiles: upgraded.profiles.map(
        (p: { id: string; displayName: string; bio: string }) => ({
          id: p.id,
          displayName: p.displayName,
          bio: p.bio,
        }),
      ),
    },
  });
  assert.equal(savedLegacy.statusCode, 200, savedLegacy.body);
  assert.deepEqual(savedLegacy.json().policy.authors, upgraded.policy.authors);
  await client.query("rollback to savepoint legacy_agents");
  await client.query("release savepoint legacy_agents");
  assert.equal((await getState()).revision, state.revision);
  for (const altered of ["remove", "append", "duplicate"]) {
    const payload = saveBody();
    if (altered === "remove") payload.policy.authors.pop();
    if (altered === "append")
      payload.policy.authors.push({
        ...payload.policy.authors[0],
        userId: human,
      });
    if (altered === "duplicate")
      payload.policy.authors[1] = payload.policy.authors[0];
    assert.equal(
      (await app.inject({ method: "PUT", url: root, headers, payload }))
        .statusCode,
      400,
      altered,
    );
  }
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
  // Representative PK lookup with many agents among 50k unrelated users.
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
      [
        Array.from(
          { length: 1000 },
          (_, i) => state.policy.authors[i]?.userId ?? randomUUID(),
        ),
      ],
    )
  ).rows[0]["QUERY PLAN"][0];
  assert.ok(JSON.stringify(plan).includes("Index"));
  console.log(
    JSON.stringify({
      agentAdminUsers: 50006,
      requestedAgentIds: 1000,
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
