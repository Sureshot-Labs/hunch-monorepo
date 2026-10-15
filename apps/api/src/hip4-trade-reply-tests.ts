import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHip4SingleTradeReply } from "./services/hip4-trade-reply.js";
import { canonicalHip4TradeAction } from "./services/hip4-trade-signing.js";
import { postHyperliquidExchangeOnce } from "./services/hyperliquid-exchange.js";

const cloid = `0x${"12".repeat(16)}`;
const order = (tif = "Gtc", buy = true) =>
  canonicalHip4TradeAction({
    type: "order",
    orders: [
      {
        a: 100115530,
        b: buy,
        p: "0.5",
        s: "25",
        r: false,
        t: { limit: { tif } },
        c: cloid,
      },
    ],
    grouping: "na",
  });
const reply = (status: unknown, type = "order") => ({
  status: "ok",
  response: { type, data: { statuses: [status] } },
});

test("HIP order ACK preserves exact order IDs and partial IOC quantities", () => {
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      order(),
      reply({ resting: { oid: Number.MAX_SAFE_INTEGER, cloid } }),
    ),
    { kind: "resting", orderId: String(Number.MAX_SAFE_INTEGER) },
  );
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      order("Ioc"),
      reply({ filled: { oid: 1, totalSz: "3", avgPx: "0.422123456789" } }),
    ),
    {
      kind: "filled_summary",
      orderId: "1",
      filledQuantity: "3",
      averagePrice: "0.422123456789",
      fullSize: false,
    },
  );
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      order(),
      reply({ filled: { oid: 1, totalSz: "25.00000", avgPx: "0.5" } }),
    ),
    {
      kind: "filled_summary",
      orderId: "1",
      filledQuantity: "25.00000",
      averagePrice: "0.5",
      fullSize: true,
    },
  );
});

test("HIP malformed, mixed, wrong-side and oversized summaries require exact reconciliation", () => {
  for (const payload of [
    null,
    "error",
    { status: "err", response: "nonce already used" },
    reply("success"),
    reply({ resting: { oid: Number.MAX_SAFE_INTEGER + 1 } }),
    reply({ resting: { oid: 1, cloid: `0x${"34".repeat(16)}` } }),
    reply({ resting: { oid: 1 }, error: "minimum" }),
    reply({ filled: { oid: 1, totalSz: "26", avgPx: "0.5" } }),
    reply({ filled: { oid: 1, totalSz: "0", avgPx: "0.5" } }),
    reply({ filled: { oid: 1, totalSz: "2", avgPx: "0.50001" } }),
    reply({ filled: { oid: 1, totalSz: "2", avgPx: "0" } }),
    reply({ error: "Duplicate cloid" }),
    reply({ error: "unknown provider error" }),
    {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }] },
      },
    },
  ])
    assert.equal(
      classifyHip4SingleTradeReply(order(), payload).kind,
      "reconcile_required",
    );
  assert.equal(
    classifyHip4SingleTradeReply(order("Ioc"), reply({ resting: { oid: 1 } }))
      .kind,
    "reconcile_required",
  );
  assert.equal(
    classifyHip4SingleTradeReply(
      order("Ioc", false),
      reply({ filled: { oid: 1, totalSz: "2", avgPx: "0.49" } }),
    ).kind,
    "reconcile_required",
  );
});

test("only known exact native rejections become no-fill/rejected", () => {
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      order("Ioc"),
      reply({
        error: "Order could not immediately match against any resting orders.",
      }),
    ),
    { kind: "no_fill", reason: "ioc_no_match" },
  );
  for (const [message, reason] of [
    ["Price must be divisible by tick size.", "tick"],
    ["Order must have minimum value of $1.", "minimum"],
    ["Order must have minimum value of 1 USDC.", "minimum"],
    ["Order has insufficient spot balance to trade", "balance"],
  ])
    assert.deepEqual(
      classifyHip4SingleTradeReply(order(), reply({ error: message })),
      { kind: "rejected", reason },
    );
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      order("Alo"),
      reply({
        error: "Post only order would have immediately matched, bbo was 0.4",
      }),
    ),
    { kind: "rejected", reason: "post_only" },
  );
});

test("cancel acknowledgement and missing order never prove zero fills or release money", () => {
  const cancel = canonicalHip4TradeAction({
    type: "cancelByCloid",
    cancels: [{ asset: 100115530, cloid }],
  });
  assert.deepEqual(
    classifyHip4SingleTradeReply(cancel, reply("success", "cancel")),
    { kind: "cancel_acknowledged" },
  );
  assert.deepEqual(
    classifyHip4SingleTradeReply(
      cancel,
      reply(
        { error: "Order was never placed, already canceled, or filled." },
        "cancel",
      ),
    ),
    { kind: "reconcile_required", reason: "cancel_state_unknown" },
  );
  assert.equal(
    classifyHip4SingleTradeReply(cancel, reply("success")).kind,
    "reconcile_required",
  );
});

test("shared exchange transport sends once to the frozen environment, even on ambiguous errors", async () => {
  for (const environment of ["mainnet", "testnet"] as const)
    for (const mode of ["ok", "http", "throw", "bad_json", "large"] as const) {
      let calls = 0;
      const result = await postHyperliquidExchangeOnce(
        environment,
        { action: order() },
        {
          timeoutMs: 1000,
          responseMaxBytes: 256,
          fetcher: async (url, input) => {
            calls++;
            assert.equal(
              url,
              environment === "mainnet"
                ? "https://api.hyperliquid.xyz/exchange"
                : "https://api.hyperliquid-testnet.xyz/exchange",
            );
            assert.equal(input?.redirect, "error");
            assert.equal(input?.method, "POST");
            assert.deepEqual(JSON.parse(String(input?.body)), {
              action: order(),
            });
            if (mode === "throw")
              throw new Error("private signature must not escape");
            return new Response(
              mode === "ok"
                ? JSON.stringify(reply({ resting: { oid: 1 } }))
                : mode === "large"
                  ? "x".repeat(257)
                  : "bad JSON",
              { status: mode === "http" ? 400 : 200 },
            );
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(result.kind, mode === "ok" ? "response" : "unknown");
    }
});

test("invalid exchange resource budgets cause no network call", async () => {
  let calls = 0;
  for (const options of [
    { timeoutMs: 0, responseMaxBytes: 10 },
    { timeoutMs: 1, responseMaxBytes: 0 },
  ]) {
    assert.deepEqual(
      await postHyperliquidExchangeOnce(
        "mainnet",
        {},
        {
          ...options,
          fetcher: async () => {
            calls++;
            throw new Error("unexpected network");
          },
        },
      ),
      { kind: "unknown" },
    );
  }
  assert.equal(calls, 0);
});

test("streamed overflow cancels the response without retrying", async () => {
  let calls = 0,
    cancelled = 0;
  const result = await postHyperliquidExchangeOnce(
    "mainnet",
    {},
    {
      timeoutMs: 1000,
      responseMaxBytes: 8,
      fetcher: async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5));
              controller.enqueue(new Uint8Array(5));
            },
            cancel() {
              cancelled++;
            },
          }),
        );
      },
    },
  );
  assert.deepEqual(result, { kind: "unknown" });
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("timeout while reading a body stays ambiguous and never resubmits", async () => {
  let calls = 0;
  // Keep the fake response alive as a real network socket would. AbortSignal's
  // unref'ed timer alone is not sufficient to keep a Node test running.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const result = await postHyperliquidExchangeOnce(
      "testnet",
      {},
      {
        timeoutMs: 10,
        responseMaxBytes: 1024,
        fetcher: async (_url, input) => {
          calls++;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                input?.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new Error("private transport failure")),
                  { once: true },
                );
              },
            }),
          );
        },
      },
    );
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("single-order reply cannot resolve a batch, corrupt filled identity or unknown environment", async () => {
  const single = order();
  assert.ok(single.type === "order");
  const batched = canonicalHip4TradeAction({
    ...single,
    orders: [...single.orders, ...single.orders],
  });
  assert.equal(
    classifyHip4SingleTradeReply(batched, reply({ resting: { oid: 1 } })).kind,
    "reconcile_required",
  );
  for (const fields of [
    { oid: Number.MAX_SAFE_INTEGER + 1 },
    { oid: -1 },
    { oid: "123" },
    { cloid: `0x${"ff".repeat(16)}` },
    { cloid: "bad" },
  ]) {
    assert.equal(
      classifyHip4SingleTradeReply(
        single,
        reply({ filled: { oid: 1, totalSz: "1", avgPx: "0.4", ...fields } }),
      ).kind,
      "reconcile_required",
    );
  }
  let calls = 0;
  assert.deepEqual(
    await postHyperliquidExchangeOnce(
      "invalid" as "mainnet",
      {},
      {
        timeoutMs: 1000,
        responseMaxBytes: 1024,
        fetcher: async () => {
          calls++;
          throw new Error("unexpected request");
        },
      },
    ),
    { kind: "unknown" },
  );
  assert.equal(calls, 0);
});
