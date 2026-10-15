// @requires-db
// Real auth/session/ownership against disposable PG16; no provider calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createIntegrationTestPool } from "./test-database-target.js";
import { registerHip4AccountRoutes } from "./routes/hip4-account.js";
import { DEFAULT_HIP4_ACCOUNT_POLICY } from "./services/hip4-account-policy.js";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";

const target = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=10000",
});
assert.equal(
  (Number(
    (await target.query("show server_version_num")).rows[0].server_version_num,
  ) /
    10000) |
    0,
  16,
);
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.JWT_SECRET = "hip4-disposable-auth-test-only";
process.env.PRIVY_APP_ID = "hip4-disposable-auth-test";
process.env.PRIVY_APP_SECRET = "hip4-disposable-auth-test";
process.env.ADMIN_AUTH_LEGACY_FALLBACK = "true";
const [
  { AuthService, createAdminMiddleware, createAuthMiddleware },
  { pool },
  { closeAcquiredRuntimeResources },
] = await Promise.all([
  import("./auth.js"),
  import("./db.js"),
  import("./runtime-resource-cleanup.js"),
]);
assert.equal(
  (await pool.query("select current_database() as target")).rows[0].target,
  process.env.HUNCH_TEST_EXPECT_DATABASE,
);
const userId = randomUUID();
const walletAddress = "0x000000000000000000000000000000000000abc1";
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
let reads = 0;
try {
  await target.query(
    "insert into users(id,is_admin,display_name) values($1,true,'HIP4 disposable auth test')",
    [userId],
  );
  await target.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified,is_primary) values($1,$2,'ethereum',true,true)",
    [userId, walletAddress],
  );
  const token = AuthService.generateToken(userId);
  await AuthService.createSession(userId, walletAddress, token);
  for (const surface of ["owned", "canary"] as const)
    registerHip4AccountRoutes(app, {
      surface,
      authorize:
        surface === "owned"
          ? createAuthMiddleware()
          : createAdminMiddleware({
              requiredAdminPermission: "analytics:read",
            }),
      owns: async (id, address) =>
        (await AuthService.getUserWallets(id)).some(
          (wallet) =>
            wallet.isVerified &&
            wallet.walletType === "ethereum" &&
            wallet.walletAddress.toLowerCase() === address,
        ),
      service: {
        market: async () => {
          reads++;
          return null;
        },
        policy: async () => ({
          readPolicy: { ...DEFAULT_HIP4_READ_POLICY, enabled: true },
          accountPolicy: { ...DEFAULT_HIP4_ACCOUNT_POLICY, enabled: true },
          revision: "fixture",
        }),
        load: async () => {
          throw new Error("not_requested");
        },
      },
      executions: async (environment, address) => {
        reads++;
        return {
          environment,
          address,
          items: [],
          nextCursor: null,
          allTimeComplete: false,
        };
      },
    });
  const url = "/markets/hyperliquid/canary/account/executions";
  assert.equal((await app.inject(url)).statusCode, 401);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-hunch-wallet": walletAddress,
  };
  const response = await app.inject({ url, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().address, walletAddress);
  assert.equal(reads, 1);
  const marketUrl =
    "/wallets/hyperliquid/account/market?marketId=hyperliquid:mainnet:outcome:8775";
  assert.equal((await app.inject(marketUrl)).statusCode, 401);
  assert.equal(reads, 1);
  const ownedMarket = await app.inject({ url: marketUrl, headers });
  assert.equal(
    ownedMarket.statusCode,
    404,
    "authorized but unobserved holding is unavailable",
  );
  assert.equal(reads, 2);
  const foreign = await app.inject({
    url,
    headers: {
      ...headers,
      "x-hunch-wallet": "0x000000000000000000000000000000000000abc2",
    },
  });
  assert.ok([401, 403].includes(foreign.statusCode));
  assert.equal(reads, 2);
  assert.ok(
    [401, 403].includes(
      (
        await app.inject({
          url: marketUrl,
          headers: {
            ...headers,
            "x-hunch-wallet": "0x000000000000000000000000000000000000abc2",
          },
        })
      ).statusCode,
    ),
  );
  assert.equal(reads, 2);
  await target.query(
    "update user_wallets set is_verified=false where user_id=$1",
    [userId],
  );
  const unverified = await app.inject({ url, headers });
  assert.equal(unverified.statusCode, 403);
  assert.equal(reads, 2);
  assert.equal((await app.inject({ url: marketUrl, headers })).statusCode, 403);
  assert.equal(reads, 2);
  console.log(
    "HIP4 PG16 real admin middleware/session/selected wallet/foreign and unverified ownership PASS",
  );
} finally {
  await app.close();
  await target.query("delete from users where id=$1", [userId]);
  await target.end();
  await closeAcquiredRuntimeResources();
}
