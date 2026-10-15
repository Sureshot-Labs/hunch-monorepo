import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  readHip4TradingPolicy,
  readHip4CancelPolicy,
  readHip4MarketQuotePolicy,
} from "./repos/hip4-trading-policy.js";
import {
  DEFAULT_HIP4_TRADING_POLICY,
  hip4TradingPolicySchema,
} from "./services/hip4-trading-policy.js";

test("HIP financial policy defaults only for absent override and has no activation switch", async () => {
  const db = { query: async () => ({ rows: [] }) } as unknown as Parameters<
    typeof readHip4TradingPolicy
  >[0];
  const policy = await readHip4TradingPolicy(db);
  assert.equal(policy.minimumBuyNotionalUsd, "1.00");
  assert.equal(policy.version, 1);
  assert.equal((await readHip4TradingPolicy(db)).revision, policy.revision);
  assert.deepEqual(DEFAULT_HIP4_TRADING_POLICY, {
    version: 1,
    minimumBuyNotionalUsd: "1.00",
    cancelSignatureTtlMs: 60000,
    marketSlippageBps: 30,
  });
  assert.equal(
    hip4TradingPolicySchema.safeParse({ enabled: true }).success,
    false,
  );
});

test("market quote slippage is policy-owned without coupling SELL to BUY or cancellation settings", async () => {
  let payload: unknown = {};
  const db = {
    query: async () => ({ rows: [{ id: "test", payload }] }),
  } as unknown as Parameters<typeof readHip4MarketQuotePolicy>[0];
  assert.equal((await readHip4MarketQuotePolicy(db)).marketSlippageBps, 30);
  payload = {
    minimumBuyNotionalUsd: "broken",
    cancelSignatureTtlMs: -1,
    marketSlippageBps: 75,
  };
  assert.equal((await readHip4MarketQuotePolicy(db)).marketSlippageBps, 75);
  for (const invalid of [-1, 10001, 0.1, "30", null]) {
    payload = { marketSlippageBps: invalid };
    await assert.rejects(
      readHip4MarketQuotePolicy(db),
      /market_quote_policy_invalid/u,
    );
  }
  payload = { marketSlippageBps: 0 };
  assert.equal((await readHip4MarketQuotePolicy(db)).marketSlippageBps, 0);
});

test("cancel authorization lifetime is policy-owned and independent of BUY limits", async () => {
  let payload: unknown = {
    minimumBuyNotionalUsd: "broken",
    cancelSignatureTtlMs: 15000,
  };
  const db = {
    query: async () => ({ rows: [{ id: "test", payload }] }),
  } as unknown as Parameters<typeof readHip4CancelPolicy>[0];
  assert.equal((await readHip4CancelPolicy(db)).cancelSignatureTtlMs, 15000);
  await assert.rejects(readHip4TradingPolicy(db), /policy_invalid/u);
  for (const invalid of [0, -1, 1.5, "60000", Number.MAX_SAFE_INTEGER + 1]) {
    payload = { cancelSignatureTtlMs: invalid };
    await assert.rejects(
      readHip4CancelPolicy(db),
      /hip4_cancel_policy_invalid/u,
    );
  }
  payload = { version: 2 };
  await assert.rejects(readHip4CancelPolicy(db), /hip4_cancel_policy_invalid/u);
  payload = {};
  assert.equal((await readHip4CancelPolicy(db)).cancelSignatureTtlMs, 60000);
});

test("unknown, invalid and unavailable policy never silently lowers the threshold", async () => {
  for (const payload of [
    null,
    { version: 2 },
    { minimumBuyNotionalUsd: "0" },
    { minimumBuyNotionalUsd: "1e3" },
    { minimumBuyNotionalUsd: "NaN" },
    { minimumBuyNotionalUsd: "01" },
    { minimumBuyNotionalUsd: "-1" },
    { minimumBuyNotionalUsd: 10 },
    { minimumBuyNotionalUsd: "1".repeat(129) },
  ]) {
    const db = {
      query: async () => ({ rows: [{ id: "test", payload }] }),
    } as unknown as Parameters<typeof readHip4TradingPolicy>[0];
    await assert.rejects(
      readHip4TradingPolicy(db),
      /hip4_trading_policy_invalid/u,
    );
  }
  for (const code of ["42P01", "57P01", "timeout"]) {
    const db = {
      query: async () => {
        throw Object.assign(new Error("private transport detail"), { code });
      },
    };
    await assert.rejects(
      readHip4TradingPolicy(
        db as unknown as Parameters<typeof readHip4TradingPolicy>[0],
      ),
      { message: "hip4_trading_policy_unavailable" },
    );
    if (code === "42P01")
      assert.equal(
        await fetchActiveRuntimePolicy(db, "unrelated"),
        null,
        "legacy callers retain their missing-table compatibility",
      );
  }
});

test("each financial read resolves current revision and repairs after valid replacement", async () => {
  let payload: unknown = { minimumBuyNotionalUsd: "5.00" };
  let id = "first";
  const db = {
    query: async () => ({ rows: [{ id, payload }] }),
  } as unknown as Parameters<typeof readHip4TradingPolicy>[0];
  const first = await readHip4TradingPolicy(db);
  payload = { minimumBuyNotionalUsd: "0" };
  await assert.rejects(readHip4TradingPolicy(db), /policy_invalid/u);
  id = "next";
  payload = { minimumBuyNotionalUsd: "0.1" };
  const next = await readHip4TradingPolicy(db);
  assert.equal(next.minimumBuyNotionalUsd, "0.1");
  assert.notEqual(next.revision, first.revision);
});
