import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Hip4ReadError } from "./services/hip4-client.js";
import {
  hip4TradingFailureReason,
  hip4TradingRouteError,
} from "./routes/hip4-trading.js";

test("native quote budget exhaustion has a recoverable public error", () => {
  const error = new Hip4ReadError("budget_exhausted");
  assert.deepEqual(hip4TradingRouteError(error), {
    status: 503,
    error: "hip4_quote_rate_limited",
  });
  assert.equal(hip4TradingFailureReason(error), "provider_budget_exhausted");
  assert.deepEqual(
    hip4TradingRouteError(new Error("hip4_preparation_buy_below_minimum")),
    { status: 409, error: "hip4_preparation_buy_below_minimum" },
  );
});

test("provider failure diagnostics contain only fixed safe labels", () => {
  for (const reason of [
    "http_error",
    "timeout",
    "transport_error",
    "response_too_large",
    "invalid_response",
  ] as const) {
    const error = new Hip4ReadError(reason);
    error.message = "https://private-provider.test/key?signature=secret";
    assert.equal(hip4TradingFailureReason(error), `provider_${reason}`);
    assert.deepEqual(hip4TradingRouteError(error), {
      status: 503,
      error: "trade_temporarily_unavailable",
    });
  }
  for (const error of [
    new Error("https://private-provider.test/key?signature=secret"),
    new Error("budget_exhausted"),
    { message: "secret", reason: "budget_exhausted" },
    null,
  ]) {
    assert.equal(hip4TradingFailureReason(error), "unknown");
    assert.deepEqual(hip4TradingRouteError(error), {
      status: 503,
      error: "trade_temporarily_unavailable",
    });
  }
  const invalid = new Hip4ReadError("http_error");
  Object.assign(invalid, { reason: "https://private.test/signature-secret" });
  assert.equal(hip4TradingFailureReason(invalid), "unknown");
  const contract = z.object({ secret: z.string() }).safeParse({});
  assert.equal(contract.success, false);
  if (!contract.success)
    assert.equal(
      hip4TradingFailureReason(contract.error),
      "invalid_runtime_contract",
    );
});
