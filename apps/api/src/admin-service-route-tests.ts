#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { adminServicePrincipalRoutes } from "./routes/admin-service-principals.js";

const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

try {
  await app.register(adminServicePrincipalRoutes);
  await app.ready();
  for (const [method, url] of [
    ["GET", "/admin/service-principals"],
    ["POST", "/admin/service-principals"],
    ["POST", "/admin/service-principals/:id/credentials"],
    ["POST", "/admin/service-credentials/:credentialId/revoke"],
    ["POST", "/admin/service-principals/:id/disable"],
  ] as const) {
    assert.equal(app.hasRoute({ method, url }), true, `${method} ${url}`);
  }
} finally {
  await app.close();
}

const root = path.resolve(import.meta.dirname, "../../..");
const rootPackage = readFileSync(path.join(root, "package.json"), "utf8");
const routeIndex = readFileSync(
  path.join(root, "apps/api/src/routes/index.ts"),
  "utf8",
);
const authSource = readFileSync(
  path.join(root, "apps/api/src/auth.ts"),
  "utf8",
);
const adminMiddleware = authSource.slice(
  authSource.indexOf("export function createAdminMiddleware"),
);
assert.equal(
  existsSync(path.join(root, "apps/journal-mcp/package.json")),
  false,
);
assert.doesNotMatch(rootPackage, /journal-mcp/);
assert.doesNotMatch(routeIndex, /service-journal|\/service\/journal/);
assert.match(routeIndex, /adminServicePrincipalRoutes/);
assert.ok(
  adminMiddleware.indexOf("authenticateAdminServiceCredential") <
    adminMiddleware.indexOf("if (options.minAdminRole)"),
  "API keys must authenticate before human-only routes reject them",
);
assert.equal(
  existsSync(path.join(root, ".agents/skills/hunch-content-api/SKILL.md")),
  true,
);

console.log("[admin-service-route-tests] passed");
