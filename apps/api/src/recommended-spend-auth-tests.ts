// @isolated-process
import assert from "node:assert/strict";
import Fastify from "fastify";
import { AuthService, createAuthMiddleware } from "./auth.js";
// Database is replaced before use; this test never opens a connection.
const { pool } = await import("./db.js");

const originalQuery = pool.query;
const originalUser = AuthService.getUserById;
const originalWallet = AuthService.getUserWalletByAddress;
const statements: string[] = [];
const token = AuthService.generateToken("recommendation-auth-test");
let active = true;
pool.query = (async (text: string) => {
  statements.push(text);
  if (text.includes("information_schema.columns"))
    return {
      rows: [{ column_name: "session_token_hash", is_nullable: "YES" }],
    };
  if (text.includes("FROM user_sessions"))
    return {
      rows: active
        ? [
            {
              id: "session",
              user_id: "recommendation-auth-test",
              wallet_address: "0xfunder",
              is_active: true,
              expires_at: new Date(Date.now() + 5000),
              created_at: new Date(),
              last_accessed_at: new Date(),
              csrf_token: "csrf",
            },
          ]
        : [],
    };
  if (text.startsWith("UPDATE user_sessions")) return { rows: [] };
  throw Error("unexpected query");
}) as typeof pool.query;
AuthService.getUserById = async () =>
  ({ id: "recommendation-auth-test", isActive: true }) as never;
AuthService.getUserWalletByAddress = async () => null;
const app = Fastify();
app.post(
  "/read",
  { preHandler: createAuthMiddleware({ touchSession: false }) },
  async () => ({ ok: true }),
);
try {
  const headers = { authorization: `Bearer ${token}`, "x-csrf-token": "csrf" };
  assert.equal(
    (await app.inject({ method: "POST", url: "/read", headers })).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/read",
        headers: { authorization: headers.authorization },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/read",
        headers: {
          ...headers,
          "x-hunch-wallet": "0x1111111111111111111111111111111111111111",
        },
      })
    ).statusCode,
    403,
  );
  active = false;
  assert.equal(
    (await app.inject({ method: "POST", url: "/read", headers })).statusCode,
    401,
  );
  assert.ok(
    statements.every((text) => text.startsWith("SELECT")),
    "read-only auth must never touch PostgreSQL",
  );
  active = true;
  await AuthService.validateSession(token);
  assert.equal(
    statements.filter((text) => text.startsWith("UPDATE")).length,
    1,
    "normal session behavior preserved",
  );
} finally {
  await app.close();
  pool.query = originalQuery;
  AuthService.getUserById = originalUser;
  AuthService.getUserWalletByAddress = originalWallet;
}
console.log(
  "Read-only session authentication, CSRF, ownership and normal touch compatibility passed",
);
