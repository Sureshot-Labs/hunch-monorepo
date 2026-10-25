import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  aggregateSmartMoney,
  marketCard,
  quickEligible,
  quickReason,
  sameInstrument,
  researchFromRow,
  matchesDiscovery,
  discoveryFilterHash,
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
  type SmartChange,
  type SmartPosition,
} from "./services/discovery-domain.js";
import {
  discoveryQuerySchema,
  discoveryQuickQuerySchema,
} from "./schemas/discovery.js";
import {
  discoveryTestItem,
  discoveryTestNow as now,
  discoveryTestRow,
  discoveryTestWallet,
} from "./discovery-test-fixtures.js";

function test(name: string, run: () => void): void {
  run();
  console.log(`[discovery-domain-tests] ok ${name}`);
}

test("Quick Wins evaluates both sides and keeps named outcomes with event context", () => {
  for (const side of ["YES", "NO"]) {
    const card = marketCard(discoveryTestRow("m", { side }), now, "0xctf");
    assert.ok(card);
    assert.ok(quickEligible(card, "1000", "0.01", now));
    assert.equal(card.selection.side, side);
    assert.match(card.market.eventTitle, /election/);
    assert.equal(
      card.selection.outcomeLabel,
      side === "YES" ? "30–34 seats" : "Not 30–34",
    );
    assert.equal(card.timing.settlementAt, null);
  }
});
test("Quick Wins rejects bad quotes, liquidity, unresolved instruments and expiry without inventing values", () => {
  for (const extra of [
    { best_bid: "0.99" },
    { best_ask: "0.99" },
    { best_bid: "0.90" },
    { best_ask: null },
    { quote_at: new Date(now - 300001).toISOString() },
    { quote_at: new Date(now + 10000).toISOString() },
    { description: "" },
    { token_id: null },
    { expiration_time: new Date(now + 8 * 86400000).toISOString() },
  ]) {
    const card = marketCard(discoveryTestRow("m", extra), now, "0xctf");
    assert.ok(!card || !quickEligible(card, "1000", "10", now));
  }
  const card = discoveryTestItem();
  assert.equal(quickEligible(card, "999.99", "20", now), false);
  assert.equal(quickEligible(card, "1000", "0", now), false);
  assert.equal(
    quickReason("0.96", "1000", "100").grossReturnIfWin,
    "0.041666666666",
  );
});
test("Closed, proposed, disputed, fractional resolved outcomes and changed generations fail safely", () => {
  for (const extra of [
    { status: "CLOSED" },
    { event_status: "CLOSED" },
    { resolved_outcome: "YES" },
    { resolved_outcome_pct: "0.5" },
    { pm_closed: true },
    { pm_accepting_orders: false },
    { venue: "polymarket", metadata: { umaResolutionStatus: "proposed" } },
    {
      venue: "polymarket",
      metadata: { version: "v2", resolutionStatus: "disputed" },
    },
  ])
    assert.equal(marketCard(discoveryTestRow("m", extra), now, "0xctf"), null);
  const instrument = discoveryTestItem().selection.instrument;
  assert.ok(instrument);
  assert.equal(
    sameInstrument(instrument, { ...instrument, generation: "other" }),
    false,
  );
  assert.equal(
    sameInstrument(instrument, { ...instrument, tokenId: "other" }),
    false,
  );
});
test("Public research serializer strips private metadata, rejects private/retracted/context/map records", () => {
  const row = {
    id: randomUUID(),
    source_id: "m",
    source_kind: "market",
    producer_type: "holder_research",
    note_type: "signal",
    status: "active",
    created_at: new Date(now).toISOString(),
    title: "Opinion",
    description: "Thesis",
    lineage: { side: "NO" },
    metrics: {
      publicationDecisionV1: {
        status: "PUBLISH",
        authority: "holder_research_quality_gate",
      },
      signalPriceSnapshotV1: {
        displaySide: "NO",
        displayPrice: 0.4,
        asOf: new Date(now).toISOString(),
      },
    },
    model_meta: {
      prompt: "PRIVATE",
      caveats: ["Uncertain", 7],
      external_research: {
        citations: [
          { url: "https://example.com/source", title: "Report" },
          { url: "javascript:alert(1)" },
        ],
      },
    },
  };
  const note = researchFromRow(row);
  assert.ok(note);
  assert.equal(note.researchedPrice, "0.4");
  assert.equal(note.sources.length, 1);
  assert.deepEqual(note.caveats, ["Uncertain"]);
  assert.equal(JSON.stringify(note).includes("PRIVATE"), false);
  for (const extra of [
    { status: "retracted" },
    { producer_type: "map_signals" },
    { note_type: "context" },
    { metrics: {} },
    { lineage: { side: "MAYBE" } },
  ])
    assert.equal(researchFromRow({ ...row, ...extra }), null);
});
test("Filters precede pagination; normalized terms match parent/title/outcome and empty categories stay empty", () => {
  const item = discoveryTestItem();
  assert.ok(
    matchesDiscovery(
      item,
      discoveryQuerySchema.parse({ q: "cafe seats", categories: "politics" }),
      now,
    ),
  );
  assert.equal(
    matchesDiscovery(
      item,
      discoveryQuerySchema.parse({ categories: "crypto" }),
      now,
    ),
    false,
  );
  assert.equal(
    matchesDiscovery(
      item,
      discoveryQuerySchema.parse({ withResearch: "true" }),
      now,
    ),
    false,
  );
  assert.equal(
    discoveryFilterHash(
      "quick-wins",
      discoveryQuerySchema.parse({ q: " CAFÉ " }),
    ),
    discoveryFilterHash(
      "quick-wins",
      discoveryQuerySchema.parse({ q: "cafe" }),
    ),
  );
  assert.equal(
    discoveryQuickQuerySchema.safeParse({ horizonHours: 48 }).success,
    false,
  );
  assert.equal(discoveryQuerySchema.safeParse({ limit: 51 }).success, false);
});
test("Cursor binds filters, section, snapshot and bounded within-event position", () => {
  const value = {
    v: 1 as const,
    section: "quick-wins" as const,
    hash: "hash",
    snapshotId: randomUUID(),
    position: 12,
    member: 1,
  };
  const encoded = encodeDiscoveryCursor(value);
  assert.deepEqual(decodeDiscoveryCursor(encoded, "quick-wins", "hash"), value);
  assert.throws(() => decodeDiscoveryCursor(encoded, "hidden-gems", "hash"));
  assert.throws(() =>
    decodeDiscoveryCursor(
      encodeDiscoveryCursor({ ...value, member: -1 }),
      "quick-wins",
      "hash",
    ),
  );
});
test("Smart Money validates signed increases against retained positions and unique owners", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()],
    wallets = ids.map((id) => discoveryTestWallet(id));
  const positions: SmartPosition[] = ids.map((walletId) => ({
    walletId,
    venue: "polymarket",
    marketId: "m",
    side: "YES",
    shares: "400",
    valueUsd: "200",
    snapshotAt: new Date(now).toISOString(),
  }));
  const changes: SmartChange[] = positions.map((p) => ({
    ...p,
    netShares: "300",
    observedAt: new Date(now - 1000).toISOString(),
  }));
  const normal = aggregateSmartMoney(wallets, positions, changes);
  assert.equal(normal[0]?.reason.ownerGroups, 3);
  assert.equal(normal[0]?.reason.observedIncreaseValueUsd, "450");
  assert.equal(
    aggregateSmartMoney(
      wallets,
      positions,
      changes.map((c) => ({ ...c, netShares: "-100" })),
    ).length,
    0,
  );
  assert.equal(
    aggregateSmartMoney(
      wallets,
      positions.map((p) => ({ ...p, shares: "0" })),
      changes,
    ).length,
    0,
  );
  assert.equal(
    aggregateSmartMoney(
      wallets,
      positions.map((p) => ({
        ...p,
        snapshotAt: new Date(now - 2000).toISOString(),
      })),
      changes,
    ).length,
    0,
  );
  assert.equal(
    aggregateSmartMoney(
      wallets.map((w) => ({ ...w, ownerKey: "one-owner" })),
      positions,
      changes,
    ).length,
    0,
  );
  const hedged = [
    ...positions,
    { ...positions[0], side: "NO", valueUsd: "100" },
  ];
  assert.equal(
    aggregateSmartMoney(wallets, hedged, changes)[0]?.reason.ownerGroups,
    2,
  );
  const linked = [
    ...wallets,
    discoveryTestWallet(randomUUID(), wallets[1].ownerKey),
  ];
  hedged.push({
    ...positions[1],
    walletId: linked[3].walletId,
    side: "NO",
    valueUsd: "100",
  });
  assert.equal(aggregateSmartMoney(linked, hedged, changes).length, 0);
});
test("Smart Money exposes opposing support rather than claiming consensus", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()],
    wallets = ids.map((id) => discoveryTestWallet(id));
  const positions = ids.map((walletId, i) => ({
    walletId,
    venue: "polymarket",
    marketId: "m",
    side: i === 2 ? "NO" : "YES",
    shares: "400",
    valueUsd: "200",
    snapshotAt: new Date(now).toISOString(),
  }));
  const results = aggregateSmartMoney(
    wallets,
    positions,
    positions.map((p) => ({
      ...p,
      netShares: "300",
      observedAt: p.snapshotAt,
    })),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].reason.oppositeOwnerGroups, 1);
  assert.equal(results[0].reason.opposingViews, true);
});
test("Linked-owner transfers/SELL offsets and unqualified sibling hedges cannot create confluence", () => {
  const a = randomUUID(),
    sibling = randomUUID(),
    b = randomUUID(),
    wallets = [
      discoveryTestWallet(a),
      { ...discoveryTestWallet(sibling, a), qualified: false },
      discoveryTestWallet(b),
    ];
  const position = (walletId: string, side = "YES"): SmartPosition => ({
    walletId,
    venue: "limitless",
    marketId: "m",
    side,
    shares: "400",
    valueUsd: "200",
    snapshotAt: new Date(now).toISOString(),
  });
  const changes = [
    {
      ...position(a),
      netShares: "400",
      observedAt: new Date(now).toISOString(),
    },
    {
      ...position(sibling),
      netShares: "-400",
      observedAt: new Date(now).toISOString(),
    },
    {
      ...position(b),
      netShares: "400",
      observedAt: new Date(now).toISOString(),
    },
  ];
  assert.equal(
    aggregateSmartMoney(wallets, [position(a), position(b)], changes).length,
    0,
  );
  assert.equal(
    aggregateSmartMoney(
      wallets,
      [position(a), position(b), position(sibling, "NO")],
      changes.filter((c) => c.walletId !== sibling),
    ).length,
    0,
  );
});
