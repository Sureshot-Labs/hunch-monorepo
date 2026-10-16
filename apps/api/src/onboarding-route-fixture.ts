import assert from "node:assert/strict";
import { mock } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  initialOnboardingState,
  OnboardingError,
} from "./services/onboarding-state.js";
import { OnboardingService } from "./services/onboarding-service.js";
import { SocialError } from "./services/social-primitives.js";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/onboarding_route_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "onboarding-test",
  PRIVY_APP_ID: "onboarding-test",
  PRIVY_APP_SECRET: "onboarding-test",
});
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    pool: {
      query() {
        throw new Error("Unexpected DB access in route fixture");
      },
    },
  },
});
globalThis.fetch = async () => {
  throw new Error("Network forbidden in route fixture");
};
const { AuthService } = await import("./auth.js");
const { onboardingRoutes } = await import("./routes/onboarding.js");
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
mock.method(AuthService, "verifyToken", (token: string) =>
  token === "invalid"
    ? null
    : ({ userId: token === "user-b" ? ids[1] : ids[0] } as ReturnType<
        typeof AuthService.verifyToken
      >),
);
mock.method(AuthService, "validateSession", async (token: string) =>
  token === "expired"
    ? null
    : {
        id: "session",
        userId: ids[0],
        sessionToken: token,
        csrfToken: "csrf",
        walletAddress: "",
        isActive: true,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      },
);
let active = true;
mock.method(
  AuthService,
  "getUserById",
  async (id: string) =>
    ({ id, isActive: active }) as Awaited<
      ReturnType<typeof AuthService.getUserById>
    >,
);
const state = initialOnboardingState(false);
const seen: { id: string; input: unknown }[] = [];
mock.method(OnboardingService.prototype, "catalog", async () => ({
  catalogVersion: 1,
  minSelections: 3,
  items: [],
}));
mock.method(OnboardingService.prototype, "get", async (id: string) => {
  seen.push({ id, input: null });
  return state;
});
let error: Error | null = null;
mock.method(
  OnboardingService.prototype,
  "setInterests",
  async (id: string, input: unknown) => {
    seen.push({ id, input });
    if (error) throw error;
    return {
      ...state,
      revision: 1,
      status: "in_progress",
      interestIds: ["politics", "technology", "sports"],
      nextStep: "handle",
      steps: {
        ...state.steps,
        interests: { status: "completed", reason: null },
      },
    };
  },
);
mock.method(
  OnboardingService.prototype,
  "progress",
  async (id: string, input: unknown) => {
    seen.push({ id, input });
    return state;
  },
);
mock.method(
  OnboardingService.prototype,
  "complete",
  async (id: string, input: unknown) => {
    seen.push({ id, input });
    return state;
  },
);
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(onboardingRoutes);
const headers = { authorization: "Bearer user-a", "x-csrf-token": "csrf" };
const payload = {
  expectedRevision: 0,
  outcome: "completed",
  interestIds: ["politics", "technology", "sports"],
};
try {
  const catalog = await app.inject({ method: "GET", url: "/users/interests" });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().minSelections, 3);
  for (const token of [null, "invalid", "expired"]) {
    const response = await app.inject({
      method: "GET",
      url: "/users/me/onboarding",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  const privateResponse = await app.inject({
    method: "GET",
    url: "/users/me/onboarding",
    headers,
  });
  assert.equal(privateResponse.statusCode, 200);
  assert.deepEqual(
    privateResponse.json(),
    state,
    "serialized response preserves all step fields",
  );
  const saved = await app.inject({
    method: "PUT",
    url: "/users/me/interests",
    headers,
    payload,
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().interestIds, payload.interestIds);
  assert.equal(saved.json().steps.interests.status, "completed");
  await app.inject({
    method: "GET",
    url: "/users/me/onboarding",
    headers: { authorization: "Bearer user-b" },
  });
  assert.equal(
    seen.at(-1)?.id,
    ids[1],
    "owner comes from authenticated session",
  );
  for (const [method, url, body] of [
    ["PUT", "/users/me/interests", payload],
    [
      "PATCH",
      "/users/me/onboarding",
      { expectedRevision: 0, step: "photo", outcome: "skipped" },
    ],
    ["POST", "/users/me/onboarding/complete", { expectedRevision: 0 }],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: headers.authorization },
      payload: body,
    });
    assert.equal(
      response.statusCode,
      403,
      `${method} requires the existing CSRF check`,
    );
    assert.equal(
      (await app.inject({ method, url, headers, payload: body })).statusCode,
      200,
    );
  }
  for (const extra of [
    { userId: ids[1] },
    { status: "completed" },
    { completedAt: new Date().toISOString() },
  ]) {
    const response = await app.inject({
      method: "PUT",
      url: "/users/me/interests",
      headers,
      payload: { ...payload, ...extra },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_request");
  }
  active = false;
  assert.equal(
    (await app.inject({ method: "GET", url: "/users/me/onboarding", headers }))
      .statusCode,
    401,
  );
  active = true;
  error = new OnboardingError("onboarding_revision_conflict", 409, state);
  const conflict = await app.inject({
    method: "PUT",
    url: "/users/me/interests",
    headers,
    payload,
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), {
    error: "onboarding_revision_conflict",
    onboarding: state,
  });
  error = new SocialError("rate_limit_exceeded", 429);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/users/me/interests",
        headers,
        payload,
      })
    ).statusCode,
    429,
  );
  console.log(
    "[onboarding-route-tests] public/private routes, existing bearer/session/CSRF, isolation, strict bodies and serialization passed",
  );
} finally {
  await app.close();
  mock.restoreAll();
}
