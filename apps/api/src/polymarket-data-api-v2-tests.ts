import assert from "node:assert/strict";

import {
  fetchPolymarketDataApiV2Pages,
  parsePolymarketDataApiV2HolderGroup,
  parsePolymarketDataApiV2Page,
  parsePolymarketDataApiV2Position,
  parsePolymarketDataApiV2Trade,
  PolymarketDataApiV2Error,
  polymarketDataApiV2HolderParams,
  polymarketDataApiV2PositionParams,
} from "./services/polymarket-data-api-v2.js";

const assetId = ((1n << 256n) - 1n).toString();
const trade = parsePolymarketDataApiV2Trade({
  token_id: assetId,
  side: "SELL",
  price: 0.4,
  size: 2,
  timestamp: 1791220000,
  transaction_hash: "0xsynthetic",
});
assert.equal(trade.tokenId, assetId);
assert.equal(trade.side, "SELL");
assert.equal(trade.transactionHash, "0xsynthetic");
assert.throws(() =>
  parsePolymarketDataApiV2Trade({
    token_id: assetId,
    side: "UNKNOWN",
    price: 0.4,
    size: 2,
    timestamp: 1791220000,
  }),
);
assert.throws(() =>
  parsePolymarketDataApiV2Trade({
    token_id: Number(assetId),
    side: "BUY",
    price: 0.4,
    size: 2,
    timestamp: 1791220000,
  }),
);
const owner = "0x0000000000000000000000000000000000000001";
// Observed snake-case shape/semantics, with synthetic wallet and economics.
const position = {
  token_id: assetId,
  proxy_wallet: owner,
  condition_id: `0x${"11".repeat(32)}`,
  current_size: 2,
  total_size: 9,
  avg_price: 0.4,
  outcome_index: 999,
  redeemable: true,
  entry_cost_usdc: 0.8,
  entry_fees_usdc: 0.05,
  total_cost_usdc: 0.85,
  realized_pnl: -1,
  unrealized_pnl: -0.8,
  current_value: 0,
};
const parsed = parsePolymarketDataApiV2Position(position);
assert.equal(parsed.tokenId, assetId);
assert.equal(parsed.currentSize, 2, "total_size must not replace held size");
assert.equal(parsed.outcomeIndex, 999);
assert.equal(parsed.redeemable, true, "a zero-valued loser can be redeemable");
assert.equal(
  parsed.unrealizedPnl,
  -0.8,
  "entry fees must not be subtracted again",
);
assert.equal(
  parsePolymarketDataApiV2Position({ ...position, avg_price: null })
    .averagePrice,
  null,
);
assert.throws(() =>
  parsePolymarketDataApiV2Position({ ...position, token_id: Number(assetId) }),
);
assert.throws(() =>
  parsePolymarketDataApiV2Position({ ...position, current_size: null }),
);
assert.throws(() =>
  parsePolymarketDataApiV2Position({ ...position, avg_price: "NaN" }),
);
assert.deepEqual(polymarketDataApiV2PositionParams(owner), {
  user: owner,
  status: "OPEN",
  filter_amount: "0",
  include_archived: "true",
  limit: "500",
});
const holderGroup = {
  token_id: assetId,
  holders: [
    { proxy_wallet: owner, token_id: assetId, amount: 3, outcome_index: 0 },
  ],
};
assert.deepEqual(parsePolymarketDataApiV2HolderGroup(holderGroup), {
  tokenId: assetId,
  holders: [{ wallet: owner, shares: 3, outcomeIndex: 0 }],
});
assert.equal(
  polymarketDataApiV2HolderParams(position.condition_id, 100).include_pnl,
  "true",
);
assert.throws(() =>
  polymarketDataApiV2HolderParams(position.condition_id, 101),
);
assert.throws(() =>
  parsePolymarketDataApiV2HolderGroup({
    ...holderGroup,
    holders: [{ ...holderGroup.holders[0], token_id: "2" }],
  }),
);
for (const malformed of [
  [],
  {},
  { data: [] },
  { data: [], pagination: {} },
  { data: [], pagination: { next_cursor: "" } },
]) {
  assert.throws(() =>
    parsePolymarketDataApiV2Page(malformed, parsePolymarketDataApiV2Position),
  );
}

function pageResponse(data: unknown[], nextCursor: string | null): Response {
  return Response.json({ data, pagination: { next_cursor: nextCursor } });
}
const requests: URL[] = [];
const inputs = {
  baseUrl: "https://data-api.example.invalid/v2",
  endpoint: "positions" as const,
  params: polymarketDataApiV2PositionParams(owner),
  timeoutMs: 1000,
  parseRow: parsePolymarketDataApiV2Position,
};
const pages = await fetchPolymarketDataApiV2Pages({
  ...inputs,
  fetchImpl: (async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(url.pathname, "/v2/positions");
    assert.equal(url.searchParams.has("offset"), false);
    return requests.length === 1
      ? pageResponse([position], "opaque+/=")
      : pageResponse([{ ...position, token_id: "2" }], null);
  }) as typeof fetch,
});
assert.equal(pages.length, 2, "a short page with a cursor is not terminal");
assert.equal(requests[1]?.searchParams.get("cursor"), "opaque+/=");
for (const [key, value] of Object.entries(inputs.params)) {
  assert.equal(
    requests[1]?.searchParams.get(key),
    value,
    "cursor scope remains fixed",
  );
}
assert.equal(inputs.params.user, owner);
assert.deepEqual(
  await fetchPolymarketDataApiV2Pages({
    ...inputs,
    fetchImpl: (async () => pageResponse([], null)) as typeof fetch,
  }),
  [],
);
let failedPageCalls = 0;
await assert.rejects(
  fetchPolymarketDataApiV2Pages({
    ...inputs,
    fetchImpl: (async () => {
      failedPageCalls += 1;
      return failedPageCalls === 1
        ? pageResponse([position], "next")
        : Response.json(
            {
              code: "rate_limited",
              retryable: true,
              trace_id: "synthetic-trace",
            },
            { status: 429, headers: { "retry-after": "2" } },
          );
    }) as typeof fetch,
  }),
  (error: unknown) => {
    assert.ok(error instanceof PolymarketDataApiV2Error);
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.traceId, "synthetic-trace");
    assert.equal(error.retryable, true);
    assert.equal(error.code, "rate_limited");
    return true;
  },
);
assert.equal(
  failedPageCalls,
  2,
  "no retry storm or partial success after page failure",
);
await assert.rejects(
  fetchPolymarketDataApiV2Pages({
    ...inputs,
    fetchImpl: (async () => pageResponse([position], "same")) as typeof fetch,
  }),
  /repeated/,
);
await assert.rejects(
  fetchPolymarketDataApiV2Pages({
    ...inputs,
    maxPages: 1,
    fetchImpl: (async () => pageResponse([position], "next")) as typeof fetch,
  }),
  /bounded page count/,
);
await assert.rejects(
  fetchPolymarketDataApiV2Pages({
    ...inputs,
    params: { ...inputs.params, offset: "0" },
    fetchImpl: (async () => {
      throw new Error("must not fetch invalid params");
    }) as typeof fetch,
  }),
  /cursor is owned/,
);
await assert.rejects(
  fetchPolymarketDataApiV2Pages({
    ...inputs,
    timeoutMs: 5,
    fetchImpl: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return pageResponse([position], null);
    }) as typeof fetch,
  }),
  (error: unknown) => error instanceof Error && error.name === "AbortError",
);
// A valid subsequent request recovers after failure; no sticky local blocker.
assert.equal(
  (
    await fetchPolymarketDataApiV2Pages({
      ...inputs,
      fetchImpl: (async () => pageResponse([position], null)) as typeof fetch,
    })
  ).length,
  1,
);
console.log(
  "[polymarket-data-api-v2-tests] DTO, cursor, partial/error/timeout and recovery passed",
);
