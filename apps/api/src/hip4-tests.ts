import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_HIP4_READ_POLICY,
  hip4Complement,
  hip4BinaryPayout,
  hip4Identity,
  isHip4CanaryId,
  hip4RawUnits,
  hip4ReadMarketSchema,
  hip4ReadPolicySchema,
  hip4TradeSchema,
  parseHip4Coin,
} from "@hunch/shared";
import {
  ageHip4Market,
  applyHip4Book,
  mapHip4Market,
} from "./services/hip4-mapping.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../src/fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
const date = fixture.collectedAt;
function mapped(outcome = 8775) {
  return mapHip4Market({
    ...main,
    settlement: null,
    fetchedAt: date,
    generation: "test",
    outcome,
  });
}
test("HIP identities separate environment, instance, side and native protocol encodings", () => {
  const mainnet = hip4Identity("mainnet", 123);
  assert.notEqual(mainnet.marketId, hip4Identity("testnet", 123).marketId);
  assert.deepEqual(mainnet.sides[1], {
    sideIndex: 1,
    tokenId: "hyperliquid:mainnet:1231",
    coin: "#1231",
    tokenName: "+1231",
    assetId: 100001231,
  });
  assert.deepEqual(parseHip4Coin("#1231"), { outcome: 123, sideIndex: 1 });
  for (const value of ["+1231", "#1232", "#01230", "#1e4", "#-1"])
    assert.throws(() => parseHip4Coin(value));
  assert.throws(() => hip4Identity("mainnet", 1.2));
  assert.equal(isHip4CanaryId("hyperliquid:mainnet:1230"), true);
  assert.equal(isHip4CanaryId("hyperliquid:1230"), false);
});
test("exact decimal conversions never round a raw unit up or down", () => {
  assert.equal(hip4RawUnits("1.000001", 6), 1000001n);
  assert.equal(hip4RawUnits("1.000001", 8), 100000100n);
  assert.equal(
    hip4RawUnits("9007199254740993.01", 8),
    900719925474099301000000n,
  );
  assert.throws(() => hip4RawUnits("0.00000001", 6));
  assert.equal(hip4Complement("0.375"), "0.625");
  assert.throws(() => hip4Complement("1.1"));
  assert.throws(() => hip4Complement("1.0000000000000000001"));
  assert.equal(hip4BinaryPayout("0.99999999999999999999"), null);
  assert.equal(hip4BinaryPayout("0.00000000000000000001"), null);
  assert.equal(hip4BinaryPayout("1.00000"), 1);
});
test("observed mainnet templates resolve side labels and preserve unknown token precision", () => {
  const { market } = mapped();
  hip4ReadMarketSchema.parse(market);
  assert.equal(market.title, "Detroit Lions vs Arizona Cardinals");
  assert.deepEqual(
    market.sides.map((side) => side.label),
    ["Lions", "Cardinals"],
  );
  assert.equal(market.quoteWeiDecimals, 8);
  assert.equal(market.sides[0].szDecimals, null);
  assert.equal(market.volumeUsd, null);
  assert.equal(market.capabilities.trade, false);
});
test("dated mainnet/testnet metadata preserves native units and fee multipliers without inventing execution terms", () => {
  const current = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/hip4/protocol-observations-20261012.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const markets = current.observations.map(
    (observation: {
      environment: "mainnet" | "testnet";
      collectedAt: string;
      feeScale: string;
      outcome: { outcome: number };
      quote: { tokenId: string };
      outcomeTokens: unknown[];
    }) => {
      const { market, raw } = mapHip4Market({
        environment: observation.environment,
        outcome: observation.outcome.outcome,
        metadata: {
          outcomes: [observation.outcome],
          feeScale: observation.feeScale,
        },
        spotMetadata: {
          tokens: [observation.quote, ...observation.outcomeTokens],
        },
        fetchedAt: observation.collectedAt,
        generation: "public-protocol-observation",
      });
      assert.equal(market.feeScale, "1.0");
      assert.equal(market.deployerFeeScale, "1.0");
      assert.equal(raw.feeScale, "1.0");
      assert.equal(market.quoteWeiDecimals, 8);
      assert.equal(market.quoteTokenId, observation.quote.tokenId);
      assert.deepEqual(
        market.sides.map((side) => [side.szDecimals, side.weiDecimals]),
        [
          [null, null],
          [null, null],
        ],
      );
      assert.equal(market.capabilities.trade, false);
      assert.equal(market.capabilities.funding, false);
      assert.ok(market.expiry);
      return market;
    },
  );
  assert.notEqual(markets[0].quoteTokenId, markets[1].quoteTokenId);
});
test("question fallback belongs to the same event, not a standalone market", () => {
  const fallback = mapped(11116).market;
  const named = mapped(11117).market;
  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.eventId, named.eventId);
  assert.notEqual(fallback.marketId, named.marketId);
  assert.equal(named.title, "FK Bodo/Glimt");
  assert.equal(fallback.title, "Other");
});
test("date-only template deadlines end at the next UTC midnight, never imply settlement", () => {
  for (const [expiry, expected] of [
    ["20261012", "2026-10-13T00:00:00.000Z"],
    ["20261231", "2027-01-01T00:00:00.000Z"],
    ["20280229", "2028-03-01T00:00:00.000Z"],
    ["20260229", null],
    ["20261301", null],
    ["20261012-1245", "2026-10-12T12:45:00.000Z"],
    ["20261012-2500", null],
  ]) {
    const outcome = {
      ...main.metadata.outcomes[0],
      description: `expiry:${expiry}`,
    };
    const { market } = mapHip4Market({
      ...main,
      metadata: { ...main.metadata, outcomes: [outcome], questions: [] },
      settlement: null,
      outcome: outcome.outcome,
      fetchedAt: "2026-10-12T23:59:59.999Z",
      generation: "date-hint",
    });
    assert.equal(market.expiry, expected);
    assert.equal(market.sides[0].payout, null);
    if (expiry === "20261012") {
      assert.ok(expected);
      assert.equal(market.status, "observed");
      assert.equal(
        ageHip4Market(market, Date.parse(expected), DEFAULT_HIP4_READ_POLICY)
          .status,
        "expired",
      );
    }
  }
});
test("expiry and 0/1 books cannot produce an official outcome; fractional payouts stay fractional", () => {
  const expired = ageHip4Market(
    mapped().market,
    Date.parse("2027-01-01"),
    DEFAULT_HIP4_READ_POLICY,
  );
  assert.equal(expired.status, "expired");
  assert.equal(expired.sides[0].payout, null);
  const settled = mapHip4Market({
    ...main,
    outcome: 95,
    fetchedAt: date,
    generation: "test",
    settlement: { ...main.settlement, settleFraction: "0.375" },
  }).market;
  assert.equal(settled.status, "settled");
  assert.deepEqual(
    settled.sides.map((s) => s.payout),
    ["0.375", "0.625"],
  );
  assert.throws(() =>
    mapHip4Market({
      ...main,
      outcome: 95,
      fetchedAt: date,
      generation: "test",
      settlement: {
        ...main.settlement,
        spec: { ...main.settlement.spec, outcome: 96 },
      },
    }),
  );
});
test("books distinguish empty/stale/error from valid zero, reject wrong identity and crossed books", () => {
  const market = mapped().market;
  const now = Date.parse(date);
  const book = {
    coin: market.sides[0].coin,
    time: now,
    levels: [[{ px: "0", sz: "1", n: 1 }], [{ px: "1", sz: "2", n: 1 }]],
  };
  const priced = applyHip4Book(market, 0, book, now, 1000);
  assert.equal(priced.sides[0].bid, "0");
  assert.equal(priced.sides[0].bookState, "fresh");
  assert.equal(
    applyHip4Book(market, 0, { ...book, levels: [[], []] }, now, 1000).sides[0]
      .bookState,
    "empty",
  );
  assert.equal(
    applyHip4Book(market, 0, book, now + 1001, 1000).sides[0].bookState,
    "stale",
  );
  assert.throws(() => applyHip4Book(market, 1, book, now, 1000));
  assert.throws(() =>
    applyHip4Book(
      market,
      0,
      {
        ...book,
        levels: [
          [{ px: "0.8", sz: "1", n: 1 }],
          [{ px: "0.2", sz: "1", n: 1 }],
        ],
      },
      now,
      1000,
    ),
  );
});
test("observed testnet custom labels are not rewritten YES/NO; participants are not retained", () => {
  const observation = fixture.observations[1];
  const { market } = mapHip4Market({
    ...observation,
    outcome: 10225,
    fetchedAt: date,
    generation: "test",
  });
  assert.deepEqual(
    market.sides.map((s) => s.label),
    ["Change", "No Change"],
  );
  const trade = hip4TradeSchema.parse({
    ...main.trades[0],
    users: ["private", "private"],
  });
  assert.equal("users" in trade, false);
});
test("canary is off by default and policy does not admit financial switches", () => {
  assert.equal(DEFAULT_HIP4_READ_POLICY.enabled, false);
  assert.throws(() => hip4ReadPolicySchema.parse({ tradeEnabled: true }));
  assert.throws(() =>
    hip4ReadPolicySchema.parse({ requestWeightPerMinute: 1201 }),
  );
});

test("settled and incomplete question membership retain confirmed contract context", () => {
  const previous = mapped(11117);
  const metadata = structuredClone(main.metadata);
  metadata.outcomes = metadata.outcomes.filter(
    (row: { outcome: number }) => row.outcome !== 11117,
  );
  const question = metadata.questions.find(
    (row: { question: number }) => row.question === 418,
  );
  question.namedOutcomes = question.namedOutcomes.filter(
    (id: number) => id !== 11117,
  );
  question.settledNamedOutcomes = [11117];
  const settlement = {
    spec: previous.raw.outcome,
    settleFraction: "1",
    details: "official",
  };
  for (const partial of [false, true]) {
    if (partial) question.settledNamedOutcomes = [];
    const next = mapHip4Market({
      ...main,
      metadata,
      previous,
      outcome: 11117,
      fetchedAt: date,
      generation: "next",
      settlement,
    });
    assert.equal(next.market.eventId, previous.market.eventId);
    assert.equal(next.market.expiry, previous.market.expiry);
    assert.equal(next.market.description, previous.market.description);
  }
  question.settledNamedOutcomes = [11117];
  question.description = "";
  const partial = mapHip4Market({
    ...main,
    metadata,
    previous,
    outcome: 11117,
    fetchedAt: date,
    generation: "partial",
    settlement,
  });
  assert.equal(partial.market.expiry, previous.market.expiry);
  assert.equal(partial.market.description, previous.market.description);
});
test("mapping preserves book order and cached settlement provenance", () => {
  const previous = mapped();
  const now = Date.parse(date);
  const book = {
    coin: previous.market.sides[0].coin,
    time: now,
    levels: [[{ px: "0.6", sz: "1", n: 1 }], []],
  };
  previous.market = applyHip4Book(previous.market, 0, book, now, 1000);
  const next = mapHip4Market({
    ...main,
    outcome: 8775,
    previous,
    settlement: null,
    fetchedAt: new Date(now + 100).toISOString(),
    generation: "new",
  });
  for (const time of [now - 4000, now]) {
    const result = applyHip4Book(
      next.market,
      0,
      { ...book, time, levels: [[{ px: "0.4", sz: "1", n: 1 }], []] },
      now + 100,
      1000,
    );
    assert.equal(result.sides[0].bid, "0.6");
    assert.equal(result.sides[0].bookAttempt?.result, "stale_observation");
  }
  const settled = mapHip4Market({
    ...main,
    outcome: 95,
    fetchedAt: date,
    generation: "one",
  });
  const cached = mapHip4Market({
    ...main,
    outcome: 95,
    previous: settled,
    fetchedAt: new Date(now + 60000).toISOString(),
    generation: "two",
  });
  assert.equal(
    cached.market.settlement?.observedAt,
    settled.market.settlement?.observedAt,
  );
  assert.equal(
    cached.market.settlement?.checkedAt,
    settled.market.settlement?.checkedAt,
  );
  assert.equal(cached.market.fetchedAt, settled.market.fetchedAt);
});
test("metadata pair budget minimum, freshness deadlines and policy recovery", () => {
  assert.throws(() =>
    hip4ReadPolicySchema.parse({ requestWeightPerMinute: 20 }),
  );
  for (const budget of [40, 42, 600])
    assert.equal(
      hip4ReadPolicySchema.parse({ requestWeightPerMinute: budget })
        .requestWeightPerMinute,
      budget,
    );
  const aged = ageHip4Market(
    mapped().market,
    Date.parse(date) + 300001,
    DEFAULT_HIP4_READ_POLICY,
  );
  assert.equal(aged.coverage.metadata, "stale");
  assert.equal(
    aged.metadataValidUntil,
    new Date(Date.parse(date) + 300000).toISOString(),
  );
});
test("a null settlement check cannot refresh an absent outcome spec", () => {
  const previous = mapped();
  const later = new Date(Date.parse(date) + 600000).toISOString();
  const missing = mapHip4Market({
    ...main,
    metadata: { ...main.metadata, outcomes: [] },
    outcome: 8775,
    previous,
    settlement: null,
    settlementCheckedAt: later,
    fetchedAt: later,
    generation: "null-settlement-check",
  });
  assert.equal(missing.market.fetchedAt, previous.market.fetchedAt);
  assert.equal(missing.market.generation, previous.market.generation);
  assert.equal(
    ageHip4Market(missing.market, Date.parse(later), DEFAULT_HIP4_READ_POLICY)
      .coverage.metadata,
    "stale",
  );
});

test("full catalog templates use public names instead of serialized condition fields", () => {
  for (const [
    questionName,
    description,
    outcomeName,
    outcomeDescription,
    expectedEvent,
    expectedTitle,
  ] of [
    [
      "template:sportsTournamentWinner",
      "competition:NBA |season:2026/2027|resolutionDeadline:20270630-2359",
      "template:sportsTournamentParticipant",
      "participant:Chicago Bulls",
      "NBA · 2026/2027 · Winner",
      "Chicago Bulls",
    ],
    [
      "template:companyIpoConfirmed",
      "company:Anthropic|dateTime:20261031-2359",
      "template:companyIpoConfirmed",
      "",
      "Anthropic · IPO confirmation",
      "Anthropic · IPO confirmation",
    ],
    [
      "template:companyIpoFirstDayMarketCap",
      "company:Anthropic|listingDeadline:20261231-2359|marketCapThresholdB:2000",
      "template:companyIpoFirstDayMarketCap",
      "",
      "Anthropic · IPO first-day market cap · $2000B",
      "Anthropic · IPO first-day market cap · $2000B",
    ],
    [
      "template:unrecognizedContract",
      "unknown:value|officialSource:Source",
      "template:unrecognizedContract",
      "",
      "Unrecognized Contract",
      "Unrecognized Contract",
    ],
    [
      "template:awardWinner",
      "award:Ballon d'Or|period:2026",
      "template:awardCandidate",
      "candidate:Kylian Mbappe |subject:Kylian Mbappe (Real Madrid, France)",
      "Ballon d'Or · 2026",
      "Kylian Mbappe",
    ],
    [
      "template:policyRateDecision",
      "institution:Federal Reserve|decisionLabel:October 2026 FOMC|decisionDeadline:20261104-1800",
      "template:policyRateNoChange",
      "",
      "Federal Reserve · October 2026 FOMC",
      "No rate change",
    ],
    [
      "template:sportsContestResult",
      "participantA:Benfica|participantB:Celtic FC",
      "template:sportsContestDraw2",
      "",
      "Benfica vs Celtic FC",
      "Draw",
    ],
  ]) {
    const spec = {
      ...main.metadata.outcomes[0],
      outcome: 8775,
      name: outcomeName,
      description: outcomeDescription,
    };
    const result = mapHip4Market({
      ...main,
      outcome: 8775,
      settlement: null,
      fetchedAt: date,
      generation: "catalog-template",
      metadata: {
        ...main.metadata,
        outcomes: [spec],
        questions: [
          {
            question: 999,
            name: questionName,
            description,
            fallbackOutcome: 999999,
            namedOutcomes: [8775],
          },
        ],
      },
    });
    assert.equal(result.market.eventTitle, expectedEvent);
    assert.equal(result.market.title, expectedTitle);
    if (questionName === "template:policyRateDecision")
      assert.equal(result.market.expiry, "2026-11-04T18:00:00.000Z");
    if (questionName === "template:companyIpoConfirmed")
      assert.equal(result.market.expiry, "2026-10-31T23:59:00.000Z");
    assert.ok(!result.market.eventTitle.includes("|"));
    assert.ok(!result.market.title.includes("|"));
    assert.ok(result.market.description.includes(description));
  }
});
