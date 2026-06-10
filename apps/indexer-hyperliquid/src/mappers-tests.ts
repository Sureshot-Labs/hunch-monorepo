import assert from "node:assert/strict";
import {
  buildHyperliquidSideAsset,
  mapHyperliquidSnapshot,
  parseHyperliquidDescription,
  resolveHyperliquidCategory,
} from "./mappers.js";
import type {
  HyperliquidOutcome,
  HyperliquidOutcomeMetaResponse,
  HyperliquidSpotMetaAndAssetCtxsResponse,
} from "./types.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const outcomeMeta: HyperliquidOutcomeMetaResponse = {
  outcomes: [
    {
      outcome: 5,
      name: "Recurring",
      description:
        "class:priceBinary|underlying:BTC|expiry:20260508-0600|targetPrice:81041|period:1d",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
    {
      outcome: 6,
      name: "Recurring Fallback",
      description: "other",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
    {
      outcome: 7,
      name: "Recurring Named Outcome",
      description: "index:0",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
    {
      outcome: 8,
      name: "Recurring Named Outcome",
      description: "index:1",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
    {
      outcome: 9,
      name: "Recurring Named Outcome",
      description: "index:2",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
    },
  ],
  questions: [
    {
      question: 0,
      name: "Recurring",
      description:
        "class:priceBucket|underlying:BTC|expiry:20260508-0600|priceThresholds:79303,82540|period:1d",
      fallbackOutcome: 6,
      namedOutcomes: [7, 8, 9],
      settledNamedOutcomes: [],
    },
  ],
};

const spotMetaAndAssetCtxs: HyperliquidSpotMetaAndAssetCtxsResponse = [
  { universe: [], tokens: [] },
  [
    {
      prevDayPx: "0.52013",
      dayNtlVlm: "1.0",
      markPx: "0.269",
      midPx: "0.26945",
      circulatingSupply: "233506.0",
      coin: "#50",
      totalSupply: "184467440737095.53125",
      dayBaseVlm: "1217805.0",
    },
    {
      prevDayPx: "0.47987",
      dayNtlVlm: "2.0",
      markPx: "0.731",
      midPx: "0.73055",
      circulatingSupply: "233506.0",
      coin: "#51",
      totalSupply: "184467440737095.53125",
      dayBaseVlm: "1217805.0",
    },
    {
      prevDayPx: "0.0",
      dayNtlVlm: "0.0",
      markPx: "0.5",
      midPx: null,
      circulatingSupply: "14238.0",
      coin: "#60",
      totalSupply: "184467440737095.53125",
      dayBaseVlm: "0.0",
    },
    {
      prevDayPx: "0.0",
      dayNtlVlm: "0.0",
      markPx: "0.5",
      midPx: null,
      circulatingSupply: "0.0",
      coin: "#61",
      totalSupply: "184467440737095.53125",
      dayBaseVlm: "0.0",
    },
  ],
];

test("parseHyperliquidDescription parses structured expiry and fields", () => {
  const parsed = parseHyperliquidDescription(
    "class:priceBinary|underlying:BTC|expiry:20260508-0600|targetPrice:81041|period:1d",
  );
  assert.equal(parsed.structured, true);
  assert.equal(parsed.class, "priceBinary");
  assert.equal(parsed.underlying, "BTC");
  assert.equal(parsed.targetPrice, 81041);
  assert.equal(parsed.expiryTime?.toISOString(), "2026-05-08T06:00:00.000Z");
});

test("resolveHyperliquidCategory maps crypto price descriptions to crypto", () => {
  const parsed = parseHyperliquidDescription(
    "class:priceBucket|underlying:BTC|expiry:20260508-0600|priceThresholds:79303,82540|period:1d",
  );
  assert.equal(resolveHyperliquidCategory(parsed), "crypto");
});

test("parseHyperliquidDescription extracts prose metadata and UTC deadline", () => {
  const parsed = parseHyperliquidDescription(
    "The market resolves after the Game, provided the NBA officially declares a winner by July 19, 2026 at 23:59 UTC. metadata=category:sports|subCategory:basketball",
  );
  assert.equal(parsed.metadata?.category, "sports");
  assert.equal(parsed.metadata?.subCategory, "basketball");
  assert.equal(parsed.values.category, "sports");
  assert.equal(resolveHyperliquidCategory(parsed), "sports");
  assert.equal(parsed.deadlineTime?.toISOString(), "2026-07-19T23:59:00.000Z");
  assert.equal(
    Object.keys(parsed.values).some((key) => key.includes("market resolves")),
    false,
  );
});

test("parseHyperliquidDescription extracts macro scheduled and date-only deadline", () => {
  const parsed = parseHyperliquidDescription(
    "The May CPI release is scheduled for June 10, 2026 at 8:30 AM ET. If CPI is not published by July 15, 2026, this market resolves no.",
  );
  assert.equal(parsed.scheduledTime?.toISOString(), "2026-06-10T12:30:00.000Z");
  assert.equal(parsed.scheduledSource, "scheduled_et");
  assert.equal(parsed.deadlineTime?.toISOString(), "2026-07-16T03:59:00.000Z");
  assert.equal(parsed.deadlineSource, "date_only_us_eastern_deadline");
  assert.equal(
    resolveHyperliquidCategory(
      parsed,
      "May CPI",
      "The May CPI release is scheduled for June 10, 2026 at 8:30 AM ET.",
    ),
    "macro",
  );
});

test("buildHyperliquidSideAsset uses documented encoding and URL-safe token id", () => {
  const outcome: HyperliquidOutcome = {
    outcome: 5,
    name: "Recurring",
    sideSpecs: [{ name: "Yes" }, { name: "No" }],
  };
  const yesSide = outcome.sideSpecs[0];
  assert.ok(yesSide);
  const asset = buildHyperliquidSideAsset(outcome, yesSide, 0);
  assert.equal(asset.encoding, 50);
  assert.equal(asset.coin, "#50");
  assert.equal(asset.tokenName, "+50");
  assert.equal(asset.officialAssetId, 100000050);
  assert.equal(asset.hunchTokenId, "hyperliquid:100000050");
});

test("mapHyperliquidSnapshot maps questions to events and outcomes to markets", () => {
  const snapshot = mapHyperliquidSnapshot({
    outcomeMeta,
    spotMetaAndAssetCtxs,
  });

  assert.deepEqual(snapshot.diagnostics, {
    outcomeCount: 5,
    questionCount: 1,
    eventCount: 2,
    marketCount: 5,
    tokenCount: 10,
    standaloneOutcomeCount: 1,
  });

  const questionEvent = snapshot.events.find(
    (event) => event.venue_event_id === "question:0",
  );
  assert.ok(questionEvent);
  assert.equal(questionEvent.id, "hyperliquid:question:0");
  assert.equal(questionEvent.category, "crypto");

  const standaloneEvent = snapshot.events.find(
    (event) => event.venue_event_id === "outcome:5",
  );
  assert.ok(standaloneEvent);
  assert.equal(standaloneEvent.id, "hyperliquid:outcome:5");

  const standaloneMarket = snapshot.markets.find(
    (market) => market.venue_market_id === "outcome:5",
  );
  assert.ok(standaloneMarket);
  assert.equal(standaloneMarket.event_id, "hyperliquid:outcome:5");
  assert.equal(standaloneMarket.token_yes, "hyperliquid:100000050");
  assert.equal(standaloneMarket.token_no, "hyperliquid:100000051");
  assert.equal(standaloneMarket.volume_total, undefined);
  assert.equal(standaloneMarket.volume_24h, 1217805);
  assert.equal(standaloneMarket.duration_minutes, 1440);
  assert.equal(standaloneMarket.liquidity, undefined);
  assert.equal(standaloneMarket.open_interest, undefined);
  assert.equal(standaloneMarket.last_price, 0.269);

  const metadata = standaloneMarket.metadata as {
    hyperliquid: {
      sideAssets: Array<{ coin: string; hunchTokenId: string }>;
      volumeTotalAvailable: boolean;
      volume24hSource: string;
      liquidityAvailable: boolean;
      openInterestAvailable: boolean;
      acceptingOrders?: boolean;
    };
  };
  assert.deepEqual(
    metadata.hyperliquid.sideAssets.map((asset) => asset.coin),
    ["#50", "#51"],
  );
  assert.equal(metadata.hyperliquid.volumeTotalAvailable, false);
  assert.equal(
    metadata.hyperliquid.volume24hSource,
    "max_side_dayBaseVlm_rolling_24h",
  );
  assert.equal(metadata.hyperliquid.liquidityAvailable, false);
  assert.equal(metadata.hyperliquid.openInterestAvailable, false);
  assert.equal(metadata.hyperliquid.acceptingOrders, undefined);

  const bucketMarket = snapshot.markets.find(
    (market) => market.venue_market_id === "outcome:8",
  );
  assert.ok(bucketMarket);
  assert.equal(bucketMarket.event_id, "hyperliquid:question:0");
  assert.equal(
    bucketMarket.title,
    "Will BTC be between 79303 and 82540 at 2026-05-08 06:00 UTC?",
  );
  assert.equal(bucketMarket.category, "crypto");
  assert.equal(bucketMarket.duration_minutes, 1440);
  assert.equal(
    bucketMarket.expiration_time?.toISOString(),
    "2026-05-08T06:00:00.000Z",
  );

  const fallbackMarket = snapshot.markets.find(
    (market) => market.venue_market_id === "outcome:6",
  );
  assert.ok(fallbackMarket);
  assert.equal(fallbackMarket.status, "ARCHIVED");
  assert.equal(fallbackMarket.last_price, undefined);
  assert.equal(fallbackMarket.volume_24h, undefined);
  const fallbackMetadata = fallbackMarket.metadata as {
    hyperliquid: {
      isFallbackOutcome?: boolean;
      hiddenReason?: string;
    };
  };
  assert.equal(fallbackMetadata.hyperliquid.isFallbackOutcome, true);
  assert.equal(
    fallbackMetadata.hyperliquid.hiddenReason,
    "hyperliquid_fallback_outcome",
  );
});

test("mapHyperliquidSnapshot maps side tokens for unified token writes", () => {
  const snapshot = mapHyperliquidSnapshot({
    outcomeMeta,
    spotMetaAndAssetCtxs,
  });
  const token = snapshot.tokens.find(
    (row) => row.token_id === "hyperliquid:100000050",
  );
  assert.ok(token);
  assert.equal(token.market_id, "hyperliquid:outcome:5");
  assert.equal(token.side, "YES");
});

test("mapHyperliquidSnapshot keeps resolution rules out of display titles", () => {
  const snapshot = mapHyperliquidSnapshot({
    outcomeMeta: {
      outcomes: [
        {
          outcome: 100,
          name: "Fallback",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
        },
        {
          outcome: 101,
          name: "Canada",
          description: "This outcome resolves to Yes if Canada wins the Game.",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
        },
        {
          outcome: 102,
          name: "Draw (This outcome resolves to Yes if the Game ends in a draw.)",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
        },
      ],
      questions: [
        {
          question: 19,
          name: "World Cup: Canada vs Bosnia and Herzegovina",
          description:
            "The market resolves after the Game, provided FIFA officially declares a winner by July 19, 2026 at 23:59 UTC. metadata=category:sports",
          fallbackOutcome: 100,
          namedOutcomes: [101, 102],
          settledNamedOutcomes: [],
        },
      ],
    },
  });

  const canada = snapshot.markets.find(
    (market) => market.venue_market_id === "outcome:101",
  );
  assert.ok(canada);
  assert.equal(canada.title, "Canada");
  assert.equal(
    canada.description,
    "This outcome resolves to Yes if Canada wins the Game.",
  );

  const draw = snapshot.markets.find(
    (market) => market.venue_market_id === "outcome:102",
  );
  assert.ok(draw);
  assert.equal(draw.title, "Draw");
  assert.equal(
    draw.description,
    "This outcome resolves to Yes if the Game ends in a draw.",
  );
});
