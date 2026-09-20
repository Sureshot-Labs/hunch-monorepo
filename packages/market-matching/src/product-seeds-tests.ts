import test from "node:test";
import assert from "node:assert/strict";
import { collectProductSeeds, productMarketIds } from "./product-seeds.js";
import { DEFAULT_MARKET_MATCHING_POLICY } from "./policy.js";

test("product seeds accept market references, excluding event/wallet identities and disabled venues", () => {
  assert.deepEqual(
    productMarketIds({
      data: [
        {
          eventId: "polymarket:wrong",
          markets: [{ venue: "polymarket", marketId: "3517146" }],
        },
      ],
    }),
    ["polymarket:3517146"],
  );
  assert.deepEqual(
    productMarketIds({
      items: [
        {
          id: "polymarket:event",
          markets: [{ id: "polymarket:1" }, { id: "kalshi:2" }],
        },
        { id: "limitless:event", representativeMarketId: "limitless:3" },
        {
          topChanges: [
            { marketId: "polymarket:1" },
            { market_id: "polymarket:4" },
          ],
        },
        { marketId: "http://untrusted" },
      ],
    }),
    ["polymarket:1", "limitless:3", "polymarket:4"],
  );
});
test("independent selector respects source quotas, survives errors, never calls inference", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("sidebars"))
      return new Response("unavailable", { status: 503 });
    return Response.json({
      items: [{ markets: [{ id: "polymarket:1" }, { id: "limitless:2" }] }],
    });
  };
  const result = await collectProductSeeds(
    { ...DEFAULT_MARKET_MATCHING_POLICY, seedFeedCount: 1, seedWhalesCount: 0 },
    "http://api.internal",
    fetcher,
  );
  assert.deepEqual(result.ids, ["polymarket:1"]);
  assert.deepEqual(result.unavailable, ["map"]);
  assert.equal(calls.length, 3);
  assert(calls.every((url) => url.startsWith("http://api.internal/")));
  assert.equal(
    (
      await collectProductSeeds(
        DEFAULT_MARKET_MATCHING_POLICY,
        undefined,
        fetcher,
      )
    ).configured,
    false,
  );
  assert.equal(calls.length, 3);
});
test("oversized selector data is discarded before allocating an inference job", async () => {
  const result = await collectProductSeeds(
    { ...DEFAULT_MARKET_MATCHING_POLICY, seedFeedCount: 0, seedWhalesCount: 0 },
    "http://api.internal",
    async () => new Response("x".repeat(2_000_001)),
  );
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.unavailable, ["map"]);
});

test("trending cannot starve movers; zero activity and excessive children do not dominate seeds", async () => {
  const extracted = productMarketIds({
    markets: Array.from({ length: 30 }, (_, i) => ({
      venue: "polymarket",
      marketId: String(i),
      volume24h: i,
    })),
  });
  assert.deepEqual(extracted, ["polymarket:1", "polymarket:2"]);
  const result = await collectProductSeeds(
    {
      ...DEFAULT_MARKET_MATCHING_POLICY,
      seedFeedCount: 2,
      seedMapCount: 0,
      seedWhalesCount: 0,
    },
    "http://api.internal",
    async (url) =>
      Response.json({
        markets: [
          {
            id: String(url).includes("change24h")
              ? "polymarket:mover"
              : "polymarket:trending",
          },
          { id: "polymarket:second" },
        ],
      }),
  );
  assert.deepEqual(result.ids, ["polymarket:trending", "polymarket:mover"]);
});
