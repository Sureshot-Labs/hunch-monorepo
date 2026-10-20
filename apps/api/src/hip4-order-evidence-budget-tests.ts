import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { hip4ReadPolicySchema } from "@hunch/shared";
import { admitHip4OrderEvidenceRequest } from "./services/hip4-order-evidence-budget.js";

test("periodic heavy order evidence shares background limits, not the interactive reserve", async () => {
  const admissions: unknown[][] = [];
  const db = {
    query: async (_sql: unknown, parameters: unknown[]) => {
      admissions.push(parameters);
      return { rowCount: 1 };
    },
  } as unknown as Pick<Pool, "query">;
  const policy = hip4ReadPolicySchema.parse({});
  for (const input of [
    { periodic: true, weight: 120 },
    { periodic: true, weight: 2 },
    { periodic: false, weight: 120 },
  ]) {
    const receipt = await admitHip4OrderEvidenceRequest(db, {
      environment: "mainnet",
      policy,
      ...input,
    });
    assert.ok(receipt);
    assert.equal(receipt.reservedWeight, input.weight);
  }
  assert.deepEqual(
    admissions.map((parameters) => parameters.slice(0, 5)),
    [
      [120, 1200, "background_repair", 220, 300],
      [2, 1200, null, null, null],
      [120, 1200, null, null, null],
    ],
  );
});

test("periodic evidence preserves explicit operator limits and never raises provider capacity", async () => {
  const admissions: unknown[][] = [];
  const db = {
    query: async (_sql: unknown, parameters: unknown[]) => {
      admissions.push(parameters);
      return { rowCount: 0 };
    },
  } as unknown as Pick<Pool, "query">;
  const policy = hip4ReadPolicySchema.parse({ requestWeightPerMinute: 600 });
  assert.equal(
    await admitHip4OrderEvidenceRequest(db, {
      environment: "mainnet",
      policy,
      periodic: true,
      weight: 120,
    }),
    false,
  );
  assert.deepEqual(
    admissions.map((parameters) => parameters.slice(0, 5)),
    [[120, 600, "background_repair", 220, 300]],
  );
});
