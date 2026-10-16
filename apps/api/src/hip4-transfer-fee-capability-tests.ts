import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import {
  assertNativeTransferFeeObservation,
  zeroNativeTransferFeeObservation,
  readNativeTransferFeeCapability,
  NativeTransferFeeCapabilityError,
} from "./services/hip4-transfer-fee-capability.js";

const binding = {
  owner: `0x${"a".repeat(40)}`,
  depository: `0x${"b".repeat(40)}`,
  sourceDex: "spot" as const,
  destinationDex: "" as const,
};
const supported = {
  fee: "0.0",
  isSanctioned: false,
  userExists: true,
  userHasSentTx: true,
};
function observation() {
  return {
    binding,
    sourceCheck: supported,
    destinationCheck: supported,
    observedAt: 1000,
    expiresAt: 2000,
    now: 1500,
  };
}
test("native zero-fee capability binds exact owner/depository and each cash class", () => {
  for (const sourceDex of ["spot", ""] as const) {
    const input = { ...observation(), binding: { ...binding, sourceDex } };
    const proof = zeroNativeTransferFeeObservation(input);
    assertNativeTransferFeeObservation(proof, input.binding, 1500);
    assert.throws(() =>
      assertNativeTransferFeeObservation(
        proof,
        { ...input.binding, sourceDex: sourceDex === "spot" ? "" : "spot" },
        1500,
      ),
    );
    for (const changed of [
      { ...input.binding, owner: `0x${"c".repeat(40)}` },
      { ...input.binding, depository: `0x${"c".repeat(40)}` },
      { ...input.binding, destinationDex: "spot" as const },
    ])
      assert.throws(() =>
        assertNativeTransferFeeObservation(proof, changed, 1500),
      );
  }
});
for (const which of ["sourceCheck", "destinationCheck"] as const) {
  for (const [label, value] of Object.entries({
    missing: undefined,
    numericFee: { ...supported, fee: 0 },
    negativeFee: { ...supported, fee: "-1" },
    firstOutboundFee: { ...supported, fee: "1.00" },
    smallestFee: { ...supported, fee: "0.00000001" },
    missingAccount: { ...supported, userExists: false },
    notActivated: { ...supported, userHasSentTx: false },
    sanctioned: { ...supported, isSanctioned: true },
  }))
    test(`${which} ${label}: unsupported fees are not zero or insufficient cash`, () => {
      assert.throws(
        () =>
          zeroNativeTransferFeeObservation({
            ...observation(),
            [which]: value,
          }),
        NativeTransferFeeCapabilityError,
      );
    });
}
test("expired/future/missing observations and forwarding/system targets are not signing authority", () => {
  const proof = zeroNativeTransferFeeObservation(observation());
  for (const now of [999, 2000, NaN])
    assert.throws(() =>
      assertNativeTransferFeeObservation(proof, binding, now),
    );
  assert.throws(() =>
    assertNativeTransferFeeObservation(undefined, binding, 1500),
  );
  for (const depository of [
    binding.owner,
    `0x${"0".repeat(40)}`,
    `0x${"2".repeat(40)}`,
    "0x2000000000000000000000000000000000000000",
    "0x20000000000000000000000000000000000000ff",
  ])
    assert.throws(() =>
      zeroNativeTransferFeeObservation({
        ...observation(),
        binding: { ...binding, depository },
      }),
    );
});

function readerFixture() {
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  const policies: Record<string, unknown> = {
    venue_lifecycle: lifecycle,
    hip4_read: { environment: "mainnet", enabled: false, outcomeAllowlist: [] },
    hip4_account: { enabled: false, snapshotMaxAgeMs: 60000 },
  };
  const requests: unknown[] = [],
    weights: number[] = [];
  let fee = "0.0",
    budget = true;
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("from runtime_policies"))
        return {
          rows: [{ id: String(args[0]), payload: policies[String(args[0])] }],
        };
      assert.ok(sql.includes("insert into hip4_request_budget"));
      weights.push(Number(args[0]));
      return { rows: [], rowCount: budget ? 1 : 0 };
    },
  } as unknown as Pick<Pool, "query">;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    assert.equal(request.type, "preTransferCheck");
    assert.ok(init?.signal);
    return Response.json({ ...supported, fee });
  };
  return {
    pool,
    fetcher,
    requests,
    weights,
    setFee: (value: string) => {
      fee = value;
    },
    setBudget: (value: boolean) => {
      budget = value;
    },
  };
}
test("fresh native info checks use exact reciprocal bindings and committed shared budget, never cache", async () => {
  const f = readerFixture();
  await readNativeTransferFeeCapability(f.pool, binding, {
    fetcher: f.fetcher,
  });
  assert.deepEqual(f.requests, [
    {
      type: "preTransferCheck",
      user: binding.owner,
      source: binding.depository,
    },
    {
      type: "preTransferCheck",
      user: binding.depository,
      source: binding.owner,
    },
  ]);
  assert.deepEqual(f.weights, [20, 20]);
  f.setFee("1.00");
  await assert.rejects(
    readNativeTransferFeeCapability(f.pool, binding, { fetcher: f.fetcher }),
    NativeTransferFeeCapabilityError,
  );
  f.setFee("0");
  assertNativeTransferFeeObservation(
    await readNativeTransferFeeCapability(f.pool, binding, {
      fetcher: f.fetcher,
    }),
    binding,
  );
  assert.equal(
    f.requests.length,
    6,
    "an explicit subsequent check immediately recovers; no housekeeping delay",
  );
  f.setBudget(false);
  await assert.rejects(
    readNativeTransferFeeCapability(f.pool, binding, { fetcher: f.fetcher }),
  );
  assert.equal(f.requests.length, 6, "denied admission makes no request");
});
test("expired caller budget cannot issue even one native fee request", async () => {
  const f = readerFixture();
  await assert.rejects(
    readNativeTransferFeeCapability(f.pool, binding, {
      fetcher: f.fetcher,
      deadlineMs: Date.now() - 1,
    }),
  );
  assert.equal(f.requests.length, 0);
  assert.equal(f.weights.length, 0);
});
