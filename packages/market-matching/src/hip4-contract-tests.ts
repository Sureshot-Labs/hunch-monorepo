import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MARKET_MATCHING_POLICY,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4Identity,
  type Hip4Environment,
  type Hip4ReadMarket,
} from "@hunch/shared";
import {
  approveContract,
  eligible,
  EXPECTED_MODEL,
  matchingEnvironmentsCompatible,
  normalizeContract,
  normalizeEvent,
  type MarketRow,
} from "./contracts.js";
import { inferenceEvidence } from "./jev.js";
import { loadContracts } from "./store.js";
import {
  parseMatchingResolutionEvidence,
  type Hip4MatchingEvidence,
  type MatchingResolutionEvidence,
} from "./hip4-contract.js";
import { marketMatchingPolicySchema } from "./policy.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/hip4-resolution-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  question: string;
  rules: string;
  resolution: MatchingResolutionEvidence;
  cases: {
    name: string;
    patch: Partial<MatchingResolutionEvidence>;
    approved: boolean;
  }[];
};
const answer = {
  choice: "equivalent",
  confidence: 0.99,
  probabilities: { equivalent: 0.99 },
};

function nativeRow(environment: Hip4Environment = "mainnet", outcome = 41) {
  const identity = hip4Identity(environment, outcome);
  const envelope: Hip4MatchingEvidence = {
    version: 1,
    source: "native_formal_terms",
    environment,
    outcome,
    sourceDescription: fixture.rules,
    template: "synthetic:scalar-threshold-v1",
    deployer: null,
    resolution: fixture.resolution,
  };
  const market: Hip4ReadMarket = {
    version: 1,
    venue: "hyperliquid",
    environment,
    marketId: identity.marketId,
    eventId: identity.marketId,
    outcome,
    questionId: null,
    isFallback: false,
    title: fixture.question,
    eventTitle: fixture.question,
    description: fixture.rules,
    expiry: fixture.resolution.observationTime,
    status: "observed",
    fetchedAt: "2026-10-16T12:00:00.000Z",
    generation: "read-refresh-1",
    quoteToken: "USDC",
    quoteTokenId: "USDC",
    quoteWeiDecimals: 8,
    feeScale: null,
    deployerFeeScale: null,
    sides: identity.sides.map((side) => ({
      ...side,
      label: side.sideIndex === 0 ? "Above" : "At or below",
      szDecimals: 0,
      weiDecimals: 5,
      payout: null,
      bid: null,
      ask: null,
      bookAt: null,
      bookState: "missing",
    })),
    settlement: null,
    coverage: {
      metadata: "fresh",
      trades: "missing",
      tradeObservedAt: null,
      tradeWindowStart: null,
      tradeWindowEnd: null,
      ranking: "unavailable",
      candles: "unavailable",
    },
    volumeUsd: null,
    openInterest: null,
    capabilities: {
      read: true,
      trade: false,
      copy: false,
      funding: false,
      automation: false,
    },
  };
  return {
    id: identity.marketId,
    event_id: identity.marketId,
    venue: "hyperliquid",
    title: fixture.question,
    event_title: fixture.question,
    description: fixture.rules,
    event_description: "",
    status: "ACTIVE",
    event_status: "ACTIVE",
    expiration_time: market.expiry,
    outcomes: market.sides.map((side) => side.label),
    tokens: market.sides.map((side) => ({
      token_id: side.tokenId,
      outcome_side: side.sideIndex === 0 ? "YES" : "NO",
    })),
    metadata: {
      question: fixture.question,
      hip4: market,
      hip4Matching: envelope,
    },
  };
}
function counterpart(resolution: unknown = fixture.resolution): MarketRow {
  return {
    id: "limitless:synthetic",
    event_id: "limitless:synthetic-event",
    venue: "limitless",
    title: fixture.question,
    event_title: fixture.question,
    description: fixture.rules,
    event_description: "",
    status: "ACTIVE",
    event_status: "ACTIVE",
    outcomes: ["YES", "NO"],
    tokens: [],
    metadata: { question: fixture.question, matchingResolution: resolution },
  };
}
const approval = (a: MarketRow, b = counterpart()) =>
  approveContract(
    normalizeContract(a),
    normalizeContract(b),
    answer,
    EXPECTED_MODEL,
  );

test("synthetic native formal-term fixtures preserve exact labels and reject payout differences", () => {
  for (const entry of fixture.cases) {
    const result = approval(
      nativeRow(),
      counterpart({ ...fixture.resolution, ...entry.patch }),
    );
    assert.equal(result.approved, entry.approved, entry.name);
    assert.equal(result.mapping.length, entry.approved ? 2 : 0, entry.name);
  }
  const row = nativeRow();
  row.tokens.reverse();
  const contract = normalizeContract(row);
  assert.equal(contract.outcomes[0].label, "Above");
  assert.equal(contract.outcomes[0].side, "YES");
  assert.equal(contract.outcomes[0].tokenId, "hyperliquid:mainnet:410");
  assert.equal(contract.outcomes[1].tokenId, "hyperliquid:mainnet:411");
  assert(approval(row).approved);
});

test("native evidence cannot replace original rules, question or parent context", () => {
  assert(!approval(nativeRow(), counterpart(null)).approved);
  const original = nativeRow();
  for (const changed of [
    { ...original, event_title: "BTC price in a different year" },
    { ...original, event_description: "An unrelated oracle governs payouts." },
    { ...original, description: "Same topic but another settlement rule." },
    {
      ...original,
      metadata: {
        ...original.metadata,
        question: "A different original question?",
      },
    },
    {
      ...original,
      metadata: { ...original.metadata, hip4Matching: undefined },
    },
  ])
    assert(!approval(changed).approved);
  assert(
    !approval(original, {
      ...counterpart(),
      description: "YES pays 1 according to Coinbase spot, not HyperCore mark.",
    }).approved,
  );
  const differentContext = structuredClone(original);
  differentContext.event_title = "BTC price in a different year";
  differentContext.metadata.hip4.eventTitle = differentContext.event_title;
  assert(
    approval(differentContext).blockers.includes("context_requires_review"),
  );
  const differentRules = structuredClone(original);
  differentRules.description = "An unrelated oracle governs this payout.";
  differentRules.metadata.hip4.description = differentRules.description;
  differentRules.metadata.hip4Matching.sourceDescription =
    differentRules.description;
  assert(approval(differentRules).blockers.includes("rules_require_review"));
});

test("native identity rejects prototype IDs, wrong tokens, expiry and environment", () => {
  const row = nativeRow();
  for (const changed of [
    { ...row, id: "hyperliquid:100000410" },
    { ...row, expiration_time: "2026-10-21T12:00:00.000Z" },
    { ...row, outcomes: [...row.outcomes].reverse() },
    {
      ...row,
      tokens: [{ token_id: "other", outcome_side: "YES" }, row.tokens[1]],
    },
    { ...row, metadata: { ...row.metadata, hip4: undefined } },
  ])
    assert(!approval(changed).approved);
  assert(!approval(nativeRow("testnet")).approved);
  const mainnet = normalizeContract(row);
  const testnet = normalizeContract(nativeRow("testnet"));
  assert(!matchingEnvironmentsCompatible(mainnet, testnet));
  assert(
    !matchingEnvironmentsCompatible(
      normalizeEvent({ id: row.event_id, venue: "hyperliquid" }, [mainnet]),
      normalizeEvent({ id: testnet.eventId, venue: "hyperliquid" }, [testnet]),
    ),
  );
});

test("native fingerprint excludes refresh generation/prices but includes exact instance and formal terms", () => {
  const row = nativeRow();
  const initial = normalizeContract(row);
  const refreshed = structuredClone(row);
  refreshed.metadata.hip4.generation = "read-refresh-2";
  refreshed.metadata.hip4.fetchedAt = "2026-10-16T12:01:00.000Z";
  refreshed.metadata.hip4.sides[0].bid = "0.9";
  assert.equal(initial.fingerprint, normalizeContract(refreshed).fingerprint);
  assert.notEqual(
    initial.fingerprint,
    normalizeContract(nativeRow("mainnet", 42)).fingerprint,
  );
  for (const change of [
    { template: "synthetic:changed-template" },
    { deployer: "different-native-deployer" },
    { resolution: { ...fixture.resolution, oracle: "different oracle" } },
  ]) {
    const changed = structuredClone(row);
    Object.assign(changed.metadata.hip4Matching, change);
    const contract = normalizeContract(changed);
    assert.notEqual(initial.fingerprint, contract.fingerprint);
    assert.deepEqual(initial.nativeIdentity, contract.nativeIdentity);
  }
  assert.deepEqual(
    inferenceEvidence(initial).resolutionEvidence,
    fixture.resolution,
  );
});

test("formal evidence parser rejects omitted, malformed and unknown terms", () => {
  assert(parseMatchingResolutionEvidence(fixture.resolution));
  for (const patch of [
    { oracle: "" },
    { comparator: "approximately" },
    { threshold: "NaN" },
    { observationTime: "2026-02-30T12:00:00.000Z" },
    { observationTime: "tomorrow" },
    { version: 2 },
    { assumedComplete: true },
  ])
    assert.equal(
      parseMatchingResolutionEvidence({ ...fixture.resolution, ...patch }),
      null,
    );
});

test("HIP matching requires explicit policy selection and independent full discovery lifecycle", () => {
  assert.deepEqual(DEFAULT_MARKET_MATCHING_POLICY.venues, [
    "polymarket",
    "limitless",
  ]);
  assert(
    marketMatchingPolicySchema.safeParse({ venues: ["hyperliquid"] }).success,
  );
  assert(!eligible(DEFAULT_VENUE_LIFECYCLE_POLICY, "hyperliquid"));
  const policy = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  policy.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  assert(eligible(policy, "hyperliquid"));
  policy.venues.hyperliquid.indexerMode = "maintenance";
  assert(!eligible(policy, "hyperliquid"));
});

test("bounded store projection passes native resolution evidence without changing source scope", async () => {
  let sql = "";
  const row = nativeRow();
  const db = {
    query: async (statement: string, values: unknown[]) => {
      sql = statement;
      assert.deepEqual(values, [[row.id]]);
      return { rows: [row] };
    },
  };
  const contracts = await loadContracts(db as never, [row.id]);
  assert.equal(contracts[0].nativeIdentity?.marketId, row.id);
  assert(sql.includes("'hip4Matching',m.metadata->'hip4Matching'"));
  assert(sql.includes("'matchingResolution',m.metadata->'matchingResolution'"));
  assert(sql.includes("where m.id=any($1::text[])"));
});

test("null optional store metadata leaves legacy normalization unchanged", () => {
  const row = counterpart(null);
  const oldProjection = { ...row, metadata: { question: fixture.question } };
  const newProjection = {
    ...row,
    metadata: {
      question: fixture.question,
      hip4: null,
      hip4Matching: null,
      matchingResolution: null,
    },
  };
  assert.deepEqual(
    normalizeContract(oldProjection),
    normalizeContract(newProjection),
  );
});
