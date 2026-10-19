import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { createHip4OrderSpotMetadataRead } from "./services/hip4-order-spot-metadata.js";

function fixture() {
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  let enabled = true;
  let admitted = true;
  let fail = false;
  let calls = 0;
  const weights: number[] = [];
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      if (sql.includes("from runtime_policies")) {
        const key = String(parameters[0]);
        return {
          rows: [
            {
              id: key,
              payload:
                key === "venue_lifecycle"
                  ? enabled
                    ? lifecycle
                    : DEFAULT_VENUE_LIFECYCLE_POLICY
                  : {},
            },
          ],
        };
      }
      assert.ok(sql.includes("insert into hip4_request_budget"));
      weights.push(Number(parameters[0]));
      return { rows: [], rowCount: admitted ? 1 : 0 };
    },
  } as unknown as Pick<Pool, "query">;
  let beforeResponse: (() => void) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    assert.deepEqual(JSON.parse(String(init?.body)), { type: "spotMeta" });
    beforeResponse?.();
    return fail
      ? new Response("unavailable", { status: 503 })
      : Response.json({
          tokens: [
            {
              name: "USDC",
              index: 0,
              tokenId: HYPERCORE_MAINNET_USDC.assetId,
              szDecimals: 8,
              weiDecimals: 8,
            },
          ],
        });
  };
  return {
    pool,
    fetcher,
    weights,
    calls: () => calls,
    setEnabled: (value: boolean) => (enabled = value),
    setAdmitted: (value: boolean) => (admitted = value),
    setFail: (value: boolean) => (fail = value),
    beforeResponse: (next: () => void) => (beforeResponse = next),
  };
}

test("one fresh observation bundle coalesces public quote metadata and isolates caller mutation", async () => {
  const f = fixture();
  const read = createHip4OrderSpotMetadataRead(f.pool, f.fetcher);
  const [fee, cash] = await Promise.all([read(), read()]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.weights, [20]);
  assert.equal(fee.observedAt, cash.observedAt);
  assert.notEqual(fee.metadata, cash.metadata);
  fee.metadata.tokens[0].name = "mutated";
  assert.equal(cash.metadata.tokens[0].name, "USDC");
  assert.equal((await read()).metadata.tokens[0].name, "USDC");
  assert.equal(f.calls(), 1);
  await createHip4OrderSpotMetadataRead(f.pool, f.fetcher)();
  assert.equal(
    f.calls(),
    2,
    "a new strict observation always reads fresh metadata",
  );
  assert.deepEqual(f.weights, [20, 20]);
});

test("shared metadata timestamps start before IO, never at a later joining branch", async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const startedAt = now;
    f.beforeResponse(() => {
      now += 1000;
    });
    const read = createHip4OrderSpotMetadataRead(f.pool, f.fetcher);
    const first = await read();
    now += 1000;
    const second = await read();
    assert.equal(first.observedAt, startedAt);
    assert.equal(second.observedAt, startedAt);
    assert.equal(f.calls(), 1);
  } finally {
    Date.now = originalNow;
  }
});

test("lifecycle/budget failures precede transport; new ordinary bundles recover without retrying in place", async () => {
  const f = fixture();
  f.setEnabled(false);
  await assert.rejects(
    createHip4OrderSpotMetadataRead(f.pool, f.fetcher)(),
    /native_account_read_unavailable/u,
  );
  assert.equal(f.calls(), 0);
  f.setEnabled(true);
  f.setAdmitted(false);
  const denied = createHip4OrderSpotMetadataRead(f.pool, f.fetcher);
  await assert.rejects(denied(), /budget_exhausted/u);
  await assert.rejects(denied(), /budget_exhausted/u);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.weights, [20]);
  f.setAdmitted(true);
  f.setFail(true);
  await assert.rejects(
    createHip4OrderSpotMetadataRead(f.pool, f.fetcher)(),
    /http_error/u,
  );
  f.setFail(false);
  await createHip4OrderSpotMetadataRead(f.pool, f.fetcher)();
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.weights, [20, 20, 20]);
});
