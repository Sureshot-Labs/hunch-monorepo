#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createTelegramRoutes } from "./routes/telegram.js";
import type { TelegramGroupMembershipResult } from "./services/telegram-group-membership.js";

const CHECKED_AT = "2026-07-17T12:00:00.000Z";

async function buildTestApp(input: {
  authenticated: boolean;
  result?: TelegramGroupMembershipResult;
}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    createTelegramRoutes({
      authPreHandler: async (request) => {
        if (!input.authenticated) return;
        request.user = { id: "hunch-user-1" } as never;
      },
      checkGroupMembership: async (userId) => {
        assert.equal(userId, "hunch-user-1");
        return (
          input.result ?? {
            cached: false,
            checkedAt: CHECKED_AT,
            state: "member",
          }
        );
      },
    }),
  );
  return app;
}

const memberApp = await buildTestApp({ authenticated: true });
try {
  const response = await memberApp.inject({
    method: "GET",
    url: "/telegram/membership",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    cached: false,
    checkedAt: CHECKED_AT,
    state: "member",
  });
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
} finally {
  await memberApp.close();
}

const unavailableApp = await buildTestApp({
  authenticated: true,
  result: {
    cached: false,
    checkedAt: CHECKED_AT,
    state: "unavailable",
    unavailableReason: "telegram_api_error",
  },
});
try {
  const response = await unavailableApp.inject({
    method: "GET",
    url: "/telegram/membership",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    cached: false,
    checkedAt: CHECKED_AT,
    state: "unavailable",
  });
} finally {
  await unavailableApp.close();
}

const anonymousApp = await buildTestApp({ authenticated: false });
try {
  const response = await anonymousApp.inject({
    method: "GET",
    url: "/telegram/membership",
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: "Unauthorized" });
} finally {
  await anonymousApp.close();
}

console.log("[telegram-membership-routes-tests] passed 3/3");
