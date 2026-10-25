import assert from "node:assert/strict";
import { mock } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/erasure_route_test",
  REDIS_URL: "",
  JWT_SECRET: "erasure-route-fixture",
  PRIVY_APP_ID: "erasure-fixture",
  PRIVY_APP_SECRET: "erasure-fixture",
  ACCOUNT_ERASURE_JOURNAL_BUCKET: "route-private-journal",
  CONTENT_ASSET_S3_BUCKET: "route-public-assets",
  CONTENT_ASSET_PUBLIC_BASE_URL: "https://images.example.test",
});
const events: string[] = [];
let journalFails = true;
let databaseFails = false;
const { pool } = await import("./db.js");
mock.method(pool, "query", () => {
  throw new Error("Unexpected DB access");
});
// Exercise the real journal implementation. Only the remote SDK boundary is
// replaced; node:test mock.module is not supported by Bun.
mock.method(S3Client.prototype, "send", async (command: unknown) => {
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, "route-private-journal");
  assert.equal(command.input.IfNoneMatch, "*");
  events.push("journal");
  if (journalFails) throw new Error("Journal unavailable");
  return {};
});
globalThis.fetch = async () => {
  throw new Error("Network forbidden in route fixture");
};
const { AuthService } = await import("./auth.js");
const { authRoutes } = await import("./routes/auth.js");
const id = "10000000-0000-4000-8000-000000000001";
mock.method(
  AuthService,
  "verifyToken",
  () => ({ userId: id }) as ReturnType<typeof AuthService.verifyToken>,
);
mock.method(AuthService, "validateSession", async () => ({
  id: "session",
  userId: id,
  sessionToken: "test",
  csrfToken: "csrf",
  walletAddress: "",
  isActive: true,
  expiresAt: new Date("2099-01-01"),
  createdAt: new Date(),
  lastAccessedAt: new Date(),
}));
mock.method(
  AuthService,
  "getUserById",
  async () =>
    ({ id, isActive: true }) as Awaited<
      ReturnType<typeof AuthService.getUserById>
    >,
);
mock.method(
  AuthService,
  "deleteUser",
  async (
    ...[_id, _client, options]: Parameters<typeof AuthService.deleteUser>
  ) => {
    await options?.beforeErasure?.(
      { query: async () => ({ rows: [] }) } as never,
      id,
      null,
    );
    events.push("delete");
    if (databaseFails) throw new Error("DB unavailable");
    return {
      disposition: "hard_deleted",
      activeMovement: false,
      privyDeletionAllowed: false,
    } as Awaited<ReturnType<typeof AuthService.deleteUser>>;
  },
);
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(authRoutes);
const headers = { authorization: "Bearer test", "x-csrf-token": "csrf" };
try {
  const blocked = await app.inject({
    method: "DELETE",
    url: "/auth/me",
    headers,
  });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error, "account_deletion_unavailable");
  assert.deepEqual(
    events,
    ["journal"],
    "DB erasure must not begin without a durable journal acknowledgement",
  );
  journalFails = false;
  events.length = 0;
  const accepted = await app.inject({
    method: "DELETE",
    url: "/auth/me",
    headers,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().storageDeletionPending, true);
  assert.deepEqual(events, ["journal", "delete"]);
  databaseFails = true;
  events.length = 0;
  const retryable = await app.inject({
    method: "DELETE",
    url: "/auth/me",
    headers,
  });
  assert.equal(retryable.statusCode, 500);
  assert.deepEqual(
    events,
    ["journal", "delete"],
    "accepted intent precedes a failed transaction and remains replayable",
  );
} finally {
  await app.close();
  mock.restoreAll();
  await pool.end();
}
console.log(
  "[account-erasure-route] journal failure, acknowledgement ordering and pending receipt passed",
);
