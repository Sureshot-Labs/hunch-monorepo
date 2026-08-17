#!/usr/bin/env tsx

import assert from "node:assert/strict";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeApiContentPools } from "./content-runtime.js";
import { env } from "./env.js";
import { serviceJournalRoutes } from "./routes/service-journal.js";

const original = {
  contentEnabled: env.contentEnabled,
  apiEnabled: env.journalServiceApiEnabled,
  reviewEnabled: env.journalServiceReviewSubmitEnabled,
  contentConfigEnabled: env.content.enabled,
  contentConfigApiEnabled: env.content.journalServiceApiEnabled,
  redisUrl: env.redisUrl,
};

env.contentEnabled = true;
env.journalServiceApiEnabled = true;
env.journalServiceReviewSubmitEnabled = false;
env.content.enabled = true;
env.content.journalServiceApiEnabled = true;
env.redisUrl = "";

const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

try {
  await app.register(serviceJournalRoutes);
  await app.ready();
  const expected = [
    ["GET", "/service/journal/articles"],
    ["POST", "/service/journal/articles"],
    ["GET", "/service/journal/articles/:id"],
    ["PATCH", "/service/journal/articles/:id"],
    ["POST", "/service/journal/articles/:id/checkpoint"],
    ["POST", "/service/journal/articles/:id/validate"],
    ["POST", "/service/journal/articles/:id/preview-token"],
    ["GET", "/service/journal/articles/:id/versions"],
    ["GET", "/service/journal/articles/:id/versions/:versionId"],
    ["GET", "/service/journal/articles/:id/audit"],
    ["GET", "/service/journal/assets"],
    ["POST", "/service/journal/assets"],
    ["POST", "/service/journal/assets/:id/complete"],
    ["PATCH", "/service/journal/assets/:id/metadata"],
  ] as const;
  for (const [method, url] of expected) {
    assert.equal(app.hasRoute({ method, url }), true, `${method} ${url}`);
  }

  const forbidden = [
    "/service/journal/articles/:id/approve",
    "/service/journal/articles/:id/publish",
    "/service/journal/articles/:id/schedule",
    "/service/journal/articles/:id/cancel-schedule",
    "/service/journal/articles/:id/unpublish",
    "/service/journal/articles/:id/archive",
    "/service/journal/articles/:id/restore",
    "/service/journal/assets/:id",
    "/service/users",
    "/service/finance",
    "/service/funding",
    "/service/trading",
  ];
  for (const url of forbidden) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
      assert.equal(app.hasRoute({ method, url }), false, `${method} ${url}`);
    }
  }
  assert.equal(
    app.hasRoute({
      method: "POST",
      url: "/service/journal/articles/:id/submit-review",
    }),
    false,
    "submit-review must be absent while its separate flag is disabled",
  );

  const rejectedBeforeValidation = await app.inject({
    method: "POST",
    url: "/service/journal/articles",
    payload: {},
  });
  assert.equal(rejectedBeforeValidation.statusCode, 503);
  assert.equal(
    rejectedBeforeValidation.json().error,
    "service_security_backend_unavailable",
    "fail-closed service auth must run before request body validation",
  );
  assert.equal(rejectedBeforeValidation.headers["cache-control"], "no-store");
  assert.equal(rejectedBeforeValidation.headers.pragma, "no-cache");
} finally {
  await app.close();
  await closeApiContentPools();
  env.contentEnabled = original.contentEnabled;
  env.journalServiceApiEnabled = original.apiEnabled;
  env.journalServiceReviewSubmitEnabled = original.reviewEnabled;
  env.content.enabled = original.contentConfigEnabled;
  env.content.journalServiceApiEnabled = original.contentConfigApiEnabled;
  env.redisUrl = original.redisUrl;
}
