import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEmbeddingEventTitles,
  embeddingInputFingerprint,
  embeddingEnqueueStateKey,
  type EmbedQueueItem,
} from "./ai-embed.js";

const market: EmbedQueueItem = {
  entity_type: "market",
  market_id: "polymarket:1",
  venue: "polymarket",
  status: "ACTIVE",
  market_title: "NO: BTC below $90,000 by December 31?",
  event_title: "Bitcoin 2026",
  description: "Not before December 31.",
  category: "crypto",
  outcomes: '["Yes","No"]',
  market_type: "binary",
};

test("fingerprint ignores refresh timestamps, source labels and numeric catalog metrics", () => {
  const first = embeddingInputFingerprint(market);
  assert.equal(
    first,
    embeddingInputFingerprint({
      ...market,
      updated_at: new Date(),
      source: "other",
      ...{ volume_24h: 100000, last_price: 0.99, liquidity: 999 },
    }),
  );
  assert.equal(
    first,
    embeddingInputFingerprint({
      ...market,
      market_title: "  NO: BTC below $90,000 by December 31?  ",
      updated_at: 0,
    }),
  );
});
test("every rendered text field and lifecycle change invalidates", () => {
  for (const changed of [
    { market_title: "YES: BTC below $90,000 by December 31?" },
    { event_title: "Bitcoin 2027" },
    { description: "Before December 30." },
    { category: "economics" },
    { outcomes: '["Over 90,000","Under 90,000"]' },
    { market_type: "range" },
    { status: "CLOSED" },
    { venue: "limitless" },
  ])
    assert.notEqual(
      embeddingInputFingerprint(market),
      embeddingInputFingerprint({ ...market, ...changed }),
    );
});
test("terminal text/price updates do not requeue, but reopen and settlement do", () => {
  const closed = { ...market, status: "CLOSED" };
  assert.equal(
    embeddingInputFingerprint(closed),
    embeddingInputFingerprint({
      ...closed,
      market_title: "renamed",
      description: "changed",
      updated_at: 123,
    }),
  );
  assert.notEqual(
    embeddingInputFingerprint(closed),
    embeddingInputFingerprint({ ...closed, status: "SETTLED" }),
  );
  assert.notEqual(
    embeddingInputFingerprint(closed),
    embeddingInputFingerprint(market),
  );
});
test("event child context is stable under ranking/order changes, includes new and closed titles", () => {
  const rows = [
    { title: "Below $1", status: "ACTIVE", volume_24h: 10 },
    { title: "Above $2", status: "ACTIVE", volume_24h: 1 },
    { title: "Old", status: "CLOSED" },
  ];
  const event: EmbedQueueItem = {
    entity_type: "event",
    event_id: "event:1",
    status: "ACTIVE",
    event_title: "Price range",
    top_markets: buildEmbeddingEventTitles(rows),
  };
  const reordered = [...rows]
    .reverse()
    .map((row) => ({ ...row, volume_24h: 999 }));
  assert.deepEqual(buildEmbeddingEventTitles(reordered), [
    "Above $2",
    "Below $1",
  ]);
  assert.equal(
    embeddingInputFingerprint(event),
    embeddingInputFingerprint({
      ...event,
      top_markets: buildEmbeddingEventTitles(reordered),
    }),
  );
  assert.notEqual(
    embeddingInputFingerprint(event),
    embeddingInputFingerprint({ ...event, top_markets: ["Above $2"] }),
  );
  assert.notEqual(
    embeddingInputFingerprint(event),
    embeddingInputFingerprint({
      ...event,
      top_markets: ["Above $2", "Below $1", "Exactly $3"],
    }),
  );
});
test("candidate child titles are not truncated using a different collation from PostgreSQL", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    title: `Outcome ${i}`,
    status: "ACTIVE",
  }));
  assert.equal(buildEmbeddingEventTitles(rows).length, 40);
  assert.ok(buildEmbeddingEventTitles(rows).includes("Outcome 39"));
});
test("state keys separate kind and stream without storing raw ID or source text", () => {
  const first = embeddingEnqueueStateKey("stream:a", "market", "private-id");
  assert.notEqual(
    first,
    embeddingEnqueueStateKey("stream:a", "event", "private-id"),
  );
  assert.notEqual(
    first,
    embeddingEnqueueStateKey("stream:b", "market", "private-id"),
  );
  assert.ok(!first.includes("private-id"));
});
