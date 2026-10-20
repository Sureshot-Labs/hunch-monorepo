import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import {
  readHip4FinancialReadCadence,
  runHip4FinancialReadPass,
} from "./hip4-account-worker-entry.js";
import { hip4AccountPolicySchema } from "./services/hip4-account-policy.js";

function policyFixture() {
  const account: Record<string, unknown> = { workerBatchSize: 0 };
  const read: Record<string, unknown> = { environment: "mainnet" };
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = {
    lifecycle: "active",
    indexerMode: "off",
  };
  const requestedPolicies: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      assert.match(sql, /from runtime_policies/u);
      const key = String(params[0]);
      requestedPolicies.push(key);
      const payload =
        key === "hip4_account"
          ? account
          : key === "hip4_read"
            ? read
            : lifecycle;
      return { rows: [{ id: key, payload }] };
    },
  } as unknown as Pool;
  return { pool, account, lifecycle, requestedPolicies };
}

test("HIP financial observer policy separates hot status, fill repair, and cold accounts", () => {
  const defaults = hip4AccountPolicySchema.parse({});
  assert.equal(defaults.workerIntervalMs, 60000);
  assert.equal(defaults.orderObservationIntervalMs, 5000);
  assert.equal(defaults.orderFillRepairIntervalMs, 15000);
  assert.equal(defaults.completedOrderRecheckIntervalMs, 3600000);
  for (const key of [
    "orderObservationIntervalMs",
    "orderFillRepairIntervalMs",
  ]) {
    for (const value of [999, 60001, 1500.5])
      assert.equal(
        hip4AccountPolicySchema.safeParse({ [key]: value }).success,
        false,
      );
    for (const value of [1000, 60000])
      assert.equal(
        hip4AccountPolicySchema.safeParse({ [key]: value }).success,
        true,
      );
  }
});

test("HIP financial cadence follows current policy without provider work", async () => {
  const fixture = policyFixture();
  const first = await readHip4FinancialReadCadence(fixture.pool);
  assert.equal(first.nextIntervalSeconds, 5);
  assert.equal(first.nextAccountIntervalSeconds, 60);
  assert.equal(first.accountReadEnvironment, "mainnet");
  fixture.account.workerIntervalMs = 1500;
  fixture.account.orderObservationIntervalMs = 9000;
  const changed = await readHip4FinancialReadCadence(fixture.pool);
  assert.equal(changed.nextIntervalSeconds, 2);
  assert.equal(changed.nextAccountIntervalSeconds, 2);
  fixture.lifecycle.venues.hyperliquid.lifecycle = "unreleased";
  const disabled = await readHip4FinancialReadCadence(fixture.pool);
  assert.equal(disabled.accountReadEnabled, false);
  assert.equal(disabled.nextIntervalSeconds, 2);
});

test("HIP direct financial passes retain account phase by default and worker hot passes can skip it", async () => {
  const fixture = policyFixture();
  const noTransport: typeof fetch = async () => {
    throw new Error("Scheduling fixture must never reach a provider");
  };
  const direct = await runHip4FinancialReadPass(fixture.pool, noTransport);
  assert.equal(direct.nextIntervalSeconds, 5);
  assert.equal(direct.nextAccountIntervalSeconds, 60);
  assert.equal(
    fixture.requestedPolicies.filter((key) => key === "hip4_read").length,
    2,
    "default pass still enters the account phase before reading next cadence",
  );
  fixture.requestedPolicies.length = 0;
  const hot = await runHip4FinancialReadPass(fixture.pool, noTransport, true, {
    skipAccounts: true,
  });
  assert.equal(hot.claimed, 0);
  assert.equal(hot.orderObservation.claimed, 0);
  assert.equal(hot.nextIntervalSeconds, 5);
  assert.equal(
    fixture.requestedPolicies.filter((key) => key === "hip4_read").length,
    1,
    "hot-only pass reads cadence but never enters the account phase",
  );
});
