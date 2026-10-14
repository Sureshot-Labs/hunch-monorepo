import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import { validateRelayHypercoreQuote } from "./hypercore-quote.js";
import { nativeFundingSignedRequest } from "../../funding/execution/hypercore-signed-request.js";
import { postNativeFundingSendOnce } from "../../funding/execution/hypercore-send-submission.js";
import { readHypercoreLedgerSeconds } from "./hypercore-ledger-observer.js";
import { Hip4ReadError } from "../../services/hip4-client.js";

const fixture = hypercorePlanTestFixture();
const pair = validateRelayHypercoreQuote(fixture.quoteInput.validation).actions;
const wallet = new Wallet(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
); // Public SDK key, offline only.
const typed = pair.transfer.typedData;
const request = nativeFundingSignedRequest(
  pair,
  "send_asset",
  await wallet.signTypedData(typed.domain, typed.types, typed.message),
);
assert.equal(request.stage, "send_asset");

for (const kind of [
  "ack",
  "provider_error",
  "http_error",
  "transport_error",
  "invalid_json",
  "oversized",
] as const)
  test(`native send ${kind}: exactly one fixed POST, no retry or invented receipt`, async () => {
    let calls = 0;
    const result = await postNativeFundingSendOnce(request.body, {
      timeoutMs: 1000,
      responseMaxBytes: 1024,
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url, "https://api.hyperliquid.xyz/exchange");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), request.body);
        assert.ok(init?.signal);
        if (kind === "transport_error")
          throw new Error("private payload must not escape");
        if (kind === "http_error")
          return new Response("private rejection", { status: 429 });
        return new Response(
          kind === "ack"
            ? ' {"status":"ok","response":{"type":"default"}}'
            : kind === "provider_error"
              ? '{"status":"err","response":"unknown"}'
              : kind === "oversized"
                ? "x".repeat(1025)
                : "{not json}",
        );
      },
    });
    assert.equal(calls, 1);
    assert.equal(result, kind === "ack" ? "acknowledged" : "unknown");
  });
test("invalid transport budget makes no POST", async () => {
  let calls = 0;
  assert.equal(
    await postNativeFundingSendOnce(request.body, {
      timeoutMs: 0,
      responseMaxBytes: 1024,
      fetcher: async () => {
        calls++;
        throw new Error("not called");
      },
    }),
    "unknown",
  );
  assert.equal(calls, 0);
});

test("native ledger retries rotate past already-checked seconds after budget denial", async () => {
  const calls: number[] = [];
  const first = await readHypercoreLedgerSeconds({
    seconds: [20, 10, 20],
    read: async (start) => {
      calls.push(start);
      if (start === 20000) throw new Hip4ReadError("budget_exhausted");
      return [];
    },
  });
  assert.deepEqual(calls, [10000, 20000]);
  assert.equal(first.afterSecond, 10);
  assert.equal(first.pendingReason, "native_ledger_budget_exhausted");
  const retry = await readHypercoreLedgerSeconds({
    seconds: [20, 10],
    afterSecond: first.afterSecond,
    read: async (start) => {
      assert.equal(start, 20000);
      return [{ exact: "transfer" }];
    },
    complete: (rows) => rows.length === 1,
  });
  assert.equal(retry.afterSecond, 20);
  assert.deepEqual(retry.ledger, [{ exact: "transfer" }]);
});
test("native ledger preserves proven rows across errors without leaking transport details", async () => {
  const result = await readHypercoreLedgerSeconds({
    seconds: [10, 20],
    read: async (start) => {
      if (start === 20000) throw new Error("private URL");
      return [{ exact: "transfer" }];
    },
  });
  assert.deepEqual(result.ledger, [{ exact: "transfer" }]);
  assert.equal(result.afterSecond, 20);
  assert.equal(result.pendingReason, "native_ledger_invalid");
});
