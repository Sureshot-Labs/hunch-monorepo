import assert from "node:assert/strict";

import { fetchPolymarketHolders } from "./services/holders-core.js";

const conditionId = `0x${"11".repeat(32)}`;
const originalFetch = globalThis.fetch;
const group = (tokenId: string, ordinal: number, count: number) => ({
  token_id: tokenId,
  holders: Array.from({ length: count }, (_, i) => ({
    token_id: tokenId,
    proxy_wallet: `0x${BigInt(ordinal + i)
      .toString(16)
      .padStart(40, "0")}`,
    amount: 1000 - ordinal - i,
    outcome_index: tokenId === "1" ? 0 : 1,
  })),
});
const page = (data: unknown[], cursor: string | null) =>
  Response.json({ data, pagination: { next_cursor: cursor } });
try {
  let calls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v2/holders");
    assert.equal(url.searchParams.get("condition"), conditionId);
    assert.equal(
      url.searchParams.get("include_pnl"),
      "true",
      "preserve GROSS per-side ranking",
    );
    assert.equal(url.searchParams.get("limit"), "100");
    calls++;
    if (calls === 1)
      return page([group("1", 1, 100), group("2", 1, 2)], "next");
    assert.equal(url.searchParams.get("cursor"), "next");
    return page([group("1", 100, 2), group("2", 2, 100)], "unused");
  }) as typeof fetch;
  const rows = await fetchPolymarketHolders({
    conditionId,
    limit: 101,
    tokenIds: ["1", "2"],
  });
  assert.equal(calls, 2);
  assert.equal(rows.filter((row) => row.tokenId === "1").length, 101);
  assert.equal(rows.filter((row) => row.tokenId === "2").length, 101);
  assert.equal(
    new Set(rows.map((row) => `${row.tokenId}:${row.wallet}`)).size,
    202,
  );
  calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1
      ? page([group("1", 1, 100)], "next")
      : Response.json(
          { code: "unavailable", retryable: true },
          { status: 503 },
        )) as typeof fetch;
  await assert.rejects(
    fetchPolymarketHolders({ conditionId, limit: 101, tokenIds: ["1", "2"] }),
    /503/,
  );
  assert.equal(calls, 2, "no partial ranking or retry storm");
  globalThis.fetch = (async () => page([], "same")) as typeof fetch;
  await assert.rejects(
    fetchPolymarketHolders({ conditionId, limit: 101, tokenIds: ["1", "2"] }),
    /repeated/,
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "[polymarket-holders-v2-tests] GROSS, per-side top-N, overlap, short-page/error bounds passed",
);
