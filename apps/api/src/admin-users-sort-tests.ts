import assert from "node:assert/strict";

import { adminUsersQuerySchema } from "./schemas/admin.js";
import { buildAdminUsersSortPlan } from "./services/admin-users-sort.js";

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-users-sort-tests] ok ${name}`);
}

await test("admin users query defaults to createdAt descending", () => {
  const parsed = adminUsersQuerySchema.parse({});
  assert.equal(parsed.sortBy, "createdAt");
  assert.equal(parsed.sortDir, "desc");
});

await test("admin users query accepts supported metric sorting", () => {
  const parsed = adminUsersQuerySchema.parse({
    sortBy: "feeUsdCollected",
    sortDir: "asc",
  });
  assert.equal(parsed.sortBy, "feeUsdCollected");
  assert.equal(parsed.sortDir, "asc");
});

await test("admin users query rejects unknown sort fields", () => {
  const parsed = adminUsersQuerySchema.safeParse({
    sortBy: "cashback",
    sortDir: "desc",
  });
  assert.equal(parsed.success, false);
});

await test("createdAt sorting supports keyset cursor in both directions", () => {
  const desc = buildAdminUsersSortPlan("createdAt", "desc");
  assert.equal(desc.cursorKind, "createdAt");
  assert.equal(desc.supportsCursor, true);
  assert.equal(desc.cursorOperator, "<");
  assert.equal(desc.metricSql, null);
  assert.equal(desc.orderBySql, "u.created_at desc, u.id desc");

  const asc = buildAdminUsersSortPlan("createdAt", "asc");
  assert.equal(asc.cursorKind, "createdAt");
  assert.equal(asc.supportsCursor, true);
  assert.equal(asc.cursorOperator, ">");
  assert.equal(asc.metricSql, null);
  assert.equal(asc.orderBySql, "u.created_at asc, u.id asc");
});

await test("metric sorting uses safe SQL mappings and deterministic tie breaker", () => {
  assert.deepEqual(buildAdminUsersSortPlan("feeUsdCollected", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "fees.collected_fee_usd::numeric",
    orderBySql: "fees.collected_fee_usd::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("feeUsdTotal", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "fees.total_fee_usd::numeric",
    orderBySql: "fees.total_fee_usd::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("points", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "points.public_points::numeric",
    orderBySql: "points.public_points::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("rawPoints", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "points.raw_points::numeric",
    orderBySql: "points.raw_points::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("tierPoints", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "points.tier_points::numeric",
    orderBySql: "points.tier_points::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("qualificationPoints", "desc"), {
    cursorKind: "metric",
    cursorOperator: "<",
    metricSql: "points.qualification_points::numeric",
    orderBySql:
      "points.qualification_points::numeric desc nulls last, u.id desc",
    supportsCursor: true,
  });
  assert.deepEqual(buildAdminUsersSortPlan("volumeUsd", "asc"), {
    cursorKind: "metric",
    cursorOperator: ">",
    metricSql: "points.volume_usd::numeric",
    orderBySql: "points.volume_usd::numeric asc nulls last, u.id desc",
    supportsCursor: true,
  });
});
