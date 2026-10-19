import assert from "node:assert/strict";
import { mock } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  NativeNotificationPreferencesService,
  NativeNotificationError,
  nativePreferences,
} from "./services/native-notification-preferences.js";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/native_route_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "native-route-test",
  PRIVY_APP_ID: "native-route-test",
  PRIVY_APP_SECRET: "native-route-test",
});
const preferences = nativePreferences();
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: { pool: { query: async () => ({ rows: [] }) } },
});
mock.module(new URL("./lib/rate-limit.ts", import.meta.url).href, {
  namedExports: { checkRateLimit: async () => true },
});
globalThis.fetch = async () => {
  throw new Error("Network forbidden in native route fixture");
};
const { AuthService } = await import("./auth.js");
const { SocialService } = await import("./services/social-service.js");
const { nativeNotificationsRoutes } =
  await import("./routes/native-notifications.js");
const { socialRoutes } = await import("./routes/social.js");
const user = "00000000-0000-4000-8000-000000000001",
  session = "00000000-0000-4000-8000-000000000002";
mock.method(
  AuthService,
  "verifyToken",
  () => ({ userId: user }) as ReturnType<typeof AuthService.verifyToken>,
);
mock.method(
  AuthService,
  "validateSession",
  async () =>
    ({
      id: session,
      userId: user,
      csrfToken: "csrf",
      isActive: true,
    }) as Awaited<ReturnType<typeof AuthService.validateSession>>,
);
mock.method(
  AuthService,
  "getUserById",
  async () =>
    ({ id: user, isActive: true }) as Awaited<
      ReturnType<typeof AuthService.getUserById>
    >,
);
let failure = false;
const seen: unknown[][] = [];
mock.method(
  NativeNotificationPreferencesService.prototype,
  "save",
  async (id: string, input: unknown) => {
    seen.push([id, input]);
    if (failure)
      throw new NativeNotificationError(
        "notification_preferences_conflict",
        409,
        preferences,
      );
    return { ...preferences, revision: 1 };
  },
);
mock.method(
  NativeNotificationPreferencesService.prototype,
  "register",
  async (...args: unknown[]) => {
    seen.push(args);
  },
);
mock.method(
  NativeNotificationPreferencesService.prototype,
  "unregister",
  async (...args: unknown[]) => {
    seen.push(args);
  },
);
mock.method(
  SocialService.prototype,
  "rankedProfiles",
  async (id: unknown, input: unknown) => {
    seen.push([id, input]);
    return { items: [], nextCursor: null };
  },
);
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(nativeNotificationsRoutes);
await app.register(socialRoutes);
const headers = { authorization: "Bearer user", "x-csrf-token": "csrf" };
const payload = {
  expectedRevision: 0,
  enabled: true,
  marketResolution: true,
  followedHunches: true,
  newMarkets: true,
  bigMoves: false,
};
const device = "00000000-0000-4000-8000-000000000003";
try {
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/users/me/notification-preferences",
      })
    ).statusCode,
    401,
  );
  const read = await app.inject({
    method: "GET",
    url: "/users/me/notification-preferences",
    headers,
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["cache-control"], "private, no-store");
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/users/me/notification-preferences",
        headers: { authorization: headers.authorization },
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/users/me/notification-preferences",
        headers,
        payload: { ...payload, userId: user },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/users/me/notification-preferences",
        headers,
        payload,
      })
    ).statusCode,
    200,
  );
  assert.equal(seen.at(-1)?.[0], user);
  failure = true;
  const conflict = await app.inject({
    method: "PUT",
    url: "/users/me/notification-preferences",
    headers,
    payload,
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().preferences, preferences);
  const registered = await app.inject({
    method: "PUT",
    url: `/users/me/push-devices/${device}`,
    headers,
    payload: {
      token: "ab".repeat(32),
      environment: "sandbox",
      authorization: "authorized",
    },
  });
  assert.equal(registered.statusCode, 200);
  assert.deepEqual(seen.at(-1)?.slice(0, 3), [user, session, device]);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/users/me/push-devices/${device}`,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(seen.at(-1), [user, session, device]);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/users/rankings?limit=20",
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(seen.at(-1)?.[0], user);
  console.log(
    "native notification routes: bearer, CSRF, ownership, conflict and ranking passed",
  );
} finally {
  await app.close();
}
