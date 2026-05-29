#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import type { DbQuery } from "./db.js";
import { adminUsersQuerySchema } from "./schemas/admin.js";
import { listAdminUsers } from "./services/admin-users-list.js";

type QueryCall = { sql: string; params?: unknown[] };

type FixtureUserRow = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  created_at: Date;
  points: string;
  tier_points: string;
  qualification_points: string;
  raw_points: string;
  fee_usd_total: string;
  fee_usd_collected: string;
  volume_usd: string;
};

function userRow(args: {
  id: string;
  email?: string | null;
  username?: string | null;
  displayName?: string | null;
  createdAt: string;
  points?: string;
  tierPoints?: string;
  qualificationPoints?: string;
  rawPoints?: string;
  feeUsdTotal?: string;
  feeUsdCollected?: string;
  volumeUsd?: string;
}): FixtureUserRow {
  return {
    id: args.id,
    email: args.email ?? `${args.id}@example.com`,
    username: args.username ?? args.id,
    display_name: args.displayName ?? args.id,
    created_at: new Date(args.createdAt),
    points: args.points ?? "0",
    tier_points: args.tierPoints ?? "0",
    qualification_points: args.qualificationPoints ?? "0",
    raw_points: args.rawPoints ?? "0",
    fee_usd_total: args.feeUsdTotal ?? "0",
    fee_usd_collected: args.feeUsdCollected ?? "0",
    volume_usd: args.volumeUsd ?? "0",
  };
}

function toAdminUsersRow(row: FixtureUserRow) {
  return {
    ...row,
    is_admin: false,
    kalshi_proof_bypass: false,
    is_active: true,
    last_login_at: null,
    referral_code: null,
    wallet_address: null,
    referral_count: "0",
    inbound_referral_code: null,
    inbound_referral_policy_type: null,
    inbound_referral_label: null,
    inbound_referral_multiplier_override: null,
    inbound_referral_owner_user_id: null,
    inbound_referral_referrer_user_id: null,
    inbound_referral_referrer_email: null,
    inbound_referral_referrer_username: null,
    inbound_referral_referrer_display_name: null,
    inbound_referral_referrer_wallet_address: null,
    inbound_referral_attached_at: null,
  };
}

function createAdminUsersDb(seedRows: FixtureUserRow[]): DbQuery & {
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];

  function filterRows(sql: string, params?: unknown[]): FixtureUserRow[] {
    if (!/u\.email ilike/i.test(sql)) return seedRows;
    const q = typeof params?.[0] === "string" ? params[0].toLowerCase() : "";
    if (!q) return seedRows;
    return seedRows.filter((row) =>
      [
        row.id,
        row.email ?? "",
        row.username ?? "",
        row.display_name ?? "",
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }

  function sortRows(sql: string, rows: FixtureUserRow[]): FixtureUserRow[] {
    const copy = [...rows];
    if (/order by u\.created_at asc, u\.id asc/i.test(sql)) {
      return copy.sort(
        (a, b) =>
          a.created_at.getTime() - b.created_at.getTime() ||
          a.id.localeCompare(b.id),
      );
    }
    if (/order by u\.created_at desc, u\.id desc/i.test(sql)) {
      return copy.sort(
        (a, b) =>
          b.created_at.getTime() - a.created_at.getTime() ||
          b.id.localeCompare(a.id),
      );
    }

    const metric =
      /fees\.collected_fee_usd::numeric/i.test(sql)
        ? "fee_usd_collected"
        : /fees\.total_fee_usd::numeric/i.test(sql)
          ? "fee_usd_total"
          : /points\.public_points::numeric/i.test(sql)
            ? "points"
            : /points\.raw_points::numeric/i.test(sql)
              ? "raw_points"
              : /points\.tier_points::numeric/i.test(sql)
                ? "tier_points"
                : /points\.qualification_points::numeric/i.test(sql)
                  ? "qualification_points"
                  : /points\.volume_usd::numeric/i.test(sql)
                    ? "volume_usd"
                    : null;
    if (!metric) return copy;

    const direction = new RegExp(`${metric.replaceAll("_", ".+")}.* asc`, "i")
      .test(sql)
      ? "asc"
      : "desc";
    return copy.sort((a, b) => {
      const delta = Number(a[metric]) - Number(b[metric]);
      if (delta !== 0) return direction === "asc" ? delta : -delta;
      return b.id.localeCompare(a.id);
    });
  }

  function applyCursor(sql: string, rows: FixtureUserRow[], params?: unknown[]) {
    if (!params?.length) return rows;
    if (/u\.created_at, u\.id\) </i.test(sql)) {
      const cursorCreatedAt = params[params.length - 3];
      const cursorId = params[params.length - 2];
      if (!(cursorCreatedAt instanceof Date) || typeof cursorId !== "string") {
        return rows;
      }
      return rows.filter(
        (row) =>
          row.created_at.getTime() < cursorCreatedAt.getTime() ||
          (row.created_at.getTime() === cursorCreatedAt.getTime() &&
            row.id < cursorId),
      );
    }
    if (/u\.created_at, u\.id\) >/i.test(sql)) {
      const cursorCreatedAt = params[params.length - 3];
      const cursorId = params[params.length - 2];
      if (!(cursorCreatedAt instanceof Date) || typeof cursorId !== "string") {
        return rows;
      }
      return rows.filter(
        (row) =>
          row.created_at.getTime() > cursorCreatedAt.getTime() ||
          (row.created_at.getTime() === cursorCreatedAt.getTime() &&
            row.id < cursorId),
      );
    }

    const metric =
      /fees\.collected_fee_usd::numeric/i.test(sql)
        ? "fee_usd_collected"
        : /fees\.total_fee_usd::numeric/i.test(sql)
          ? "fee_usd_total"
          : /points\.public_points::numeric/i.test(sql)
            ? "points"
            : /points\.raw_points::numeric/i.test(sql)
              ? "raw_points"
              : /points\.tier_points::numeric/i.test(sql)
                ? "tier_points"
                : /points\.qualification_points::numeric/i.test(sql)
                  ? "qualification_points"
                  : /points\.volume_usd::numeric/i.test(sql)
                    ? "volume_usd"
                    : null;
    if (!metric) return rows;

    const cursorValue = params[params.length - 3];
    const cursorId = params[params.length - 2];
    if (typeof cursorValue !== "number" || typeof cursorId !== "string") {
      return rows;
    }
    const operator = /< \$\d+ or \(/i.test(sql) ? "<" : ">";
    return rows.filter((row) => {
      const value = Number(row[metric]);
      return operator === "<"
        ? value < cursorValue || (value === cursorValue && row.id < cursorId)
        : value > cursorValue || (value === cursorValue && row.id < cursorId);
    });
  }

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });
    const filtered = filterRows(sql, params);
    if (/select count\(\*\)::text as total\s+from users u/i.test(sql)) {
      return { rows: [{ total: String(filtered.length) } as unknown as T] };
    }

    if (/select\s+u\.id,/i.test(sql) && /from users u/i.test(sql)) {
      assert.match(sql, /points\.volume_usd/);
      assert.match(sql, /case when not \(/);
      assert.match(sql, /manual:%/);
      assert.match(sql, /manual-visible:%/);
      assert.match(sql, /referral-code-visible:/);
      assert.match(sql, /referral-code-tier:/);
      assert.doesNotMatch(sql, /volume\.volume_usd/);
      assert.doesNotMatch(sql, /\)\s+volume on true/i);
      const hasOffset = /offset \$\d+/i.test(sql);
      const limitIndex = params ? params.length - (hasOffset ? 2 : 1) : -1;
      const limit = Number(params?.[limitIndex] ?? filtered.length);
      const offset = hasOffset ? Number(params?.[params.length - 1] ?? 0) : 0;
      const rows = sortRows(sql, applyCursor(sql, filtered, params))
        .slice(offset, offset + limit)
        .map(toAdminUsersRow);
      return { rows: rows as unknown as T[] };
    }

    throw new Error(`Unexpected admin users query: ${sql}`);
  };

  return {
    calls,
    query: query as DbQuery["query"],
  };
}

function encodeCursor(row: { id: string; createdAt: string }): string {
  return Buffer.from(
    JSON.stringify({ id: row.id, createdAt: row.createdAt }),
    "utf8",
  ).toString("base64url");
}

function encodeMetricCursor(input: {
  id: string;
  sortBy: string;
  sortDir: string;
  value: number;
}): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

async function buildTestApp(db: DbQuery) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.get(
    "/admin/users",
    { schema: { querystring: adminUsersQuerySchema } },
    async (request, reply) => {
      const result = await listAdminUsers(db, request.query);
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send({ error: result.error });
      }
      return reply.send(result);
    },
  );
  return app;
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-users-route-tests] ok ${name}`);
}

const seedRows = [
  userRow({
    id: "user-a",
    username: "alpha",
    createdAt: "2026-05-01T00:00:00.000Z",
    points: "15",
    tierPoints: "40",
    qualificationPoints: "70",
    rawPoints: "1000",
    feeUsdCollected: "5",
    feeUsdTotal: "7",
    volumeUsd: "100",
  }),
  userRow({
    id: "user-b",
    username: "bravo",
    createdAt: "2026-05-03T00:00:00.000Z",
    points: "30",
    tierPoints: "20",
    qualificationPoints: "90",
    rawPoints: "500",
    feeUsdCollected: "10",
    feeUsdTotal: "12",
    volumeUsd: "50",
  }),
  userRow({
    id: "user-c",
    username: "charlie",
    createdAt: "2026-05-02T00:00:00.000Z",
    points: "5",
    tierPoints: "60",
    qualificationPoints: "10",
    rawPoints: "1500",
    feeUsdCollected: "2",
    feeUsdTotal: "30",
    volumeUsd: "200",
  }),
];

await test("GET /admin/users defaults to createdAt desc and includes volumeUsd", async () => {
  const db = createAdminUsersDb(seedRows);
  const app = await buildTestApp(db);
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?limit=2",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    users: Array<{ id: string; volumeUsd: number }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>();
  assert.deepEqual(
    body.users.map((user) => user.id),
    ["user-b", "user-c"],
  );
  assert.equal(body.users[0]?.volumeUsd, 50);
  assert.equal(body.hasMore, true);
  assert.ok(body.nextCursor);
  await app.close();
});

await test("GET /admin/users sorts by collected fees", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=feeUsdCollected&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-b", "user-a", "user-c"],
  );
  await app.close();
});

await test("GET /admin/users sorts by total fees", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=feeUsdTotal&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-c", "user-b", "user-a"],
  );
  await app.close();
});

await test("GET /admin/users sorts by visible points", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=points&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response
      .json<{ users: Array<{ id: string; points: number }> }>()
      .users.map((user) => [user.id, user.points]),
    [
      ["user-b", 30],
      ["user-a", 15],
      ["user-c", 5],
    ],
  );
  await app.close();
});

await test("GET /admin/users sorts by raw points", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=rawPoints&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-c", "user-a", "user-b"],
  );
  await app.close();
});

await test("GET /admin/users sorts by tier points", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=tierPoints&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-c", "user-a", "user-b"],
  );
  await app.close();
});

await test("GET /admin/users sorts by qualification points", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=qualificationPoints&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-b", "user-a", "user-c"],
  );
  await app.close();
});

await test("GET /admin/users sorts by volume and supports asc", async () => {
  const db = createAdminUsersDb(seedRows);
  const app = await buildTestApp(db);
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=volumeUsd&sortDir=asc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-b", "user-a", "user-c"],
  );
  assert.match(db.calls[1]?.sql ?? "", /order by points\.volume_usd::numeric asc/i);
  await app.close();
});

await test("GET /admin/users combines search with metric sorting", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?q=bravo&sortBy=points&sortDir=desc",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-b"],
  );
  await app.close();
});

await test("GET /admin/users paginates metric desc sorts with cursor", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const first = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=volumeUsd&sortDir=desc&limit=2",
  });

  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{
    users: Array<{ id: string }>;
    hasMore: boolean;
    nextCursor: string | null;
  }>();
  assert.deepEqual(
    firstBody.users.map((user) => user.id),
    ["user-c", "user-a"],
  );
  assert.equal(firstBody.hasMore, true);
  assert.ok(firstBody.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: `/admin/users?sortBy=volumeUsd&sortDir=desc&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  });

  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    second.json<{ users: Array<{ id: string }>; hasMore: boolean }>().users.map(
      (user) => user.id,
    ),
    ["user-b"],
  );
  assert.equal(second.json<{ hasMore: boolean }>().hasMore, false);
  await app.close();
});

await test("GET /admin/users paginates metric asc sorts with cursor", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const first = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=volumeUsd&sortDir=asc&limit=2",
  });

  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{
    users: Array<{ id: string }>;
    nextCursor: string | null;
  }>();
  assert.deepEqual(
    firstBody.users.map((user) => user.id),
    ["user-b", "user-a"],
  );
  assert.ok(firstBody.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: `/admin/users?sortBy=volumeUsd&sortDir=asc&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  });

  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    second.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-c"],
  );
  await app.close();
});

await test("GET /admin/users metric cursor uses id desc tie breaker", async () => {
  const app = await buildTestApp(
    createAdminUsersDb([
      userRow({
        id: "user-a",
        createdAt: "2026-05-01T00:00:00.000Z",
        volumeUsd: "100",
      }),
      userRow({
        id: "user-b",
        createdAt: "2026-05-02T00:00:00.000Z",
        volumeUsd: "100",
      }),
      userRow({
        id: "user-c",
        createdAt: "2026-05-03T00:00:00.000Z",
        volumeUsd: "100",
      }),
    ]),
  );
  const first = await app.inject({
    method: "GET",
    url: "/admin/users?sortBy=volumeUsd&sortDir=desc&limit=2",
  });

  assert.equal(first.statusCode, 200);
  const firstBody = first.json<{
    users: Array<{ id: string }>;
    nextCursor: string | null;
  }>();
  assert.deepEqual(
    firstBody.users.map((user) => user.id),
    ["user-c", "user-b"],
  );
  assert.ok(firstBody.nextCursor);

  const second = await app.inject({
    method: "GET",
    url: `/admin/users?sortBy=volumeUsd&sortDir=desc&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  });

  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    second.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-a"],
  );
  await app.close();
});

await test("GET /admin/users rejects cursor with mismatched metric sort", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const cursor = encodeMetricCursor({
    id: "user-a",
    sortBy: "volumeUsd",
    sortDir: "desc",
    value: 100,
  });
  const response = await app.inject({
    method: "GET",
    url: `/admin/users?sortBy=points&sortDir=desc&cursor=${encodeURIComponent(cursor)}`,
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Cursor sort does not match request sort",
  });
  await app.close();
});

await test("GET /admin/users rejects metric cursor for createdAt sort", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const cursor = encodeMetricCursor({
    id: "user-a",
    sortBy: "createdAt",
    sortDir: "desc",
    value: 0,
  });
  const response = await app.inject({
    method: "GET",
    url: `/admin/users?sortBy=createdAt&sortDir=desc&cursor=${encodeURIComponent(cursor)}`,
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Invalid cursor" });
  await app.close();
});

await test("GET /admin/users keeps legacy createdAt cursor pagination", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const cursor = encodeCursor({
    id: "user-c",
    createdAt: "2026-05-02T00:00:00.000Z",
  });
  const response = await app.inject({
    method: "GET",
    url: `/admin/users?limit=2&cursor=${encodeURIComponent(cursor)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json<{ users: Array<{ id: string }> }>().users.map((user) => user.id),
    ["user-a"],
  );
  await app.close();
});

await test("GET /admin/users rejects invalid cursor", async () => {
  const app = await buildTestApp(createAdminUsersDb(seedRows));
  const response = await app.inject({
    method: "GET",
    url: "/admin/users?cursor=not-base64-json",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Invalid cursor" });
  await app.close();
});
