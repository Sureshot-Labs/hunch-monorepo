import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHip4FormalTerms } from "./services/hip4-formal-terms.js";

const observations = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/protocol-observations-20261012.json",
      import.meta.url,
    ),
    "utf8",
  ),
).observations as {
  environment: string;
  outcome: {
    outcome: number;
    name: string;
    description: string;
    sideSpecs: { name: string }[];
    quoteToken: string;
  };
}[];
const native = observations[0].outcome;
const parse = (description = native.description) =>
  parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: { ...native, description },
  });

test("captured native price fields are factual context, not complete formal terms", () => {
  const result = parse();
  assert.equal(result.format, "template_binary_price");
  assert.equal(result.outcome, 11553);
  assert.equal(result.observed.perp, "HYPE");
  assert.equal(result.observed.priceDescription, "HYPE-USDC perp mark");
  assert.equal(result.observed.threshold, "85.469");
  assert.equal(result.observed.declaredSeconds, 60);
  assert.equal(result.observed.timeToken, "20261012-1245");
  assert.deepEqual(result.observed.calendarToken, {
    year: 2026,
    month: 10,
    day: 12,
    hour: 12,
    minute: 45,
  });
  assert.equal(result.source?.description, native.description);
  assert.deepEqual(result.source?.sideNames, ["template:Yes", "template:No"]);
  assert.equal(result.source?.question, null);
  assert.deepEqual(result.diagnostics, [
    { code: "formal_native_template_semantics_unverified" },
  ]);
  assert.equal(result.matching.status, "review_required");
  assert.equal(result.matching.evidence, null);
  assert(result.matching.missingVerifiedTerms.includes("payout_rules"));
  assert(
    result.matching.missingVerifiedTerms.includes(
      "observation_timezone_window_and_aggregation",
    ),
  );
});

test("external feed and complex price description remain exact, not an oracle/window guess", () => {
  const source = observations[1];
  const result = parseHip4FormalTerms({
    environment: source.environment,
    nativeOutcome: source.outcome,
  });
  assert.equal(result.format, "template_binary_price_external");
  assert.equal(result.observed.feed, "CF Benchmarks BRTI");
  assert.equal(result.observed.instrument, "Bitcoin BTC/USD");
  assert.equal(result.observed.shortName, "BTCtest");
  assert.equal(result.observed.threshold, "83074.834999");
  assert.match(result.observed.priceDescription ?? "", /\[E-60s,E\)/);
  assert.match(result.observed.priceDescription ?? "", /ref=83074\.84/);
  assert.equal(result.observed.underlying, null);
  assert.equal(result.observed.perp, null);
  assert.equal(result.matching.evidence, null);
});

test("legacy priceBinary is recognized but settlements cannot fill missing formal rules", () => {
  const description =
    "class:priceBinary|underlying:BTC|expiry:20260526-0600|targetPrice:77363|period:1d";
  const result = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: {
      ...native,
      name: "Recurring",
      description,
      settleFraction: "0.0",
      details: "price:76876.9",
    },
  });
  assert.equal(result.format, "legacy_price_binary");
  assert.equal(result.observed.underlying, "BTC");
  assert.equal(result.observed.threshold, "77363");
  assert.equal(result.observed.period, "1d");
  assert.equal(result.matching.evidence, null);
});

test("source question must bind this exact outcome, not merely share a topic title", () => {
  const question = {
    question: 7,
    name: "HYPE prices",
    description: "Original native question/rules, not a generated title",
    fallbackOutcome: 900,
    namedOutcomes: [native.outcome],
  };
  const result = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: native,
    nativeQuestion: question,
  });
  assert.equal(result.source?.question?.description, question.description);
  assert.equal(result.matching.evidence, null);
  const unrelated = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: native,
    nativeQuestion: { ...question, namedOutcomes: [901] },
  });
  assert.equal(unrelated.source?.question, null);
  assert(
    unrelated.diagnostics.some(
      (entry) => entry.code === "native_question_membership_mismatch",
    ),
  );
  for (const membership of [
    { fallbackOutcome: native.outcome, namedOutcomes: [] },
    { namedOutcomes: [], settledNamedOutcomes: [native.outcome] },
  ])
    assert.ok(
      parseHip4FormalTerms({
        environment: "mainnet",
        nativeOutcome: native,
        nativeQuestion: { ...question, ...membership },
      }).source?.question,
    );
});

test("duplicate keys never choose a winning threshold or time", () => {
  const result = parse(`${native.description}|threshold:99|time:20261012-1300`);
  assert.equal(result.observed.threshold, null);
  assert.equal(result.observed.timeToken, null);
  assert.equal(result.observed.calendarToken, null);
  assert.deepEqual(
    result.fields.filter((entry) => entry.key === "threshold"),
    [
      { key: "threshold", value: "85.469" },
      { key: "threshold", value: "99" },
    ],
  );
  for (const field of ["threshold", "time"])
    assert(
      result.diagnostics.some(
        (entry) =>
          entry.code === "duplicate_native_field" && entry.field === field,
      ),
    );
});

test("malformed or absent numbers and calendars are diagnostic, never supplied from a title", () => {
  for (const [field, value, code] of [
    ["threshold", "1e3", "invalid_native_threshold"],
    ["threshold", "NaN", "invalid_native_threshold"],
    ["seconds", "9007199254740993", "invalid_native_seconds"],
    ["seconds", "0", "invalid_native_seconds"],
    ["time", "20260230-1245", "invalid_native_calendar_token"],
    ["time", "20261012-2500", "invalid_native_calendar_token"],
    ["time", "20261012", "invalid_native_calendar_token"],
  ]) {
    const description = native.description.replace(
      new RegExp(`${field}:[^|]+`),
      `${field}:${value}`,
    );
    const result = parse(description);
    assert(
      result.diagnostics.some((entry) => entry.code === code),
      description,
    );
    assert.equal(result.matching.evidence, null);
  }
  const missing = parse("perp:HYPE|threshold:|not-a-field|seconds:60");
  assert.equal(missing.observed.threshold, null);
  assert.equal(missing.observed.timeToken, null);
  assert(
    missing.diagnostics.some(
      (entry) => entry.code === "unparsed_native_description_segment",
    ),
  );
});

test("unknown templates and raw formal assertions cannot register a complete adapter", () => {
  const asserted =
    `${native.description}|comparator:>=|oracle:HyperCore|timeZone:UTC` +
    "|payoutRules:1 or 0|voidRules:never|question:Will HYPE be above the strike?";
  const result = parse(asserted);
  assert.equal(result.matching.evidence, null);
  assert(
    result.diagnostics.some(
      (entry) => entry.code === "unrecognized_native_field",
    ),
  );
  for (const name of ["template:futurePrice", "Will HYPE exceed 85.469?"])
    assert.equal(
      parseHip4FormalTerms({
        environment: "mainnet",
        nativeOutcome: { ...native, name, description: asserted },
      }).format,
      "unsupported",
    );
});

test("fingerprint is material source-bound and excludes quote/read refresh state", () => {
  const baseline = parse();
  assert.match(baseline.sourceFingerprint ?? "", /^[a-f0-9]{64}$/);
  const refreshed = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: {
      ...native,
      generation: "another-read",
      fetchedAt: "2026-10-16T12:00:00Z",
      bid: "0.9",
      ask: "0.91",
      settleFraction: "1",
    },
  });
  assert.equal(refreshed.sourceFingerprint, baseline.sourceFingerprint);
  for (const change of [
    { environment: "testnet", nativeOutcome: native },
    { environment: "mainnet", nativeOutcome: { ...native, outcome: 11554 } },
    {
      environment: "mainnet",
      nativeOutcome: {
        ...native,
        description: native.description + "|note:changed",
      },
    },
    {
      environment: "mainnet",
      nativeOutcome: { ...native, quoteToken: "OTHER" },
    },
    {
      environment: "mainnet",
      nativeOutcome: { ...native, venue: "another-native-venue" },
    },
    {
      environment: "mainnet",
      nativeOutcome: {
        ...native,
        sideSpecs: [{ name: "No" }, { name: "Yes" }],
      },
    },
  ])
    assert.notEqual(
      parseHip4FormalTerms(change).sourceFingerprint,
      baseline.sourceFingerprint,
    );
});

test("invalid environment/outcome/question is local diagnostic without guessed evidence", () => {
  for (const environment of ["hypercore:mainnet", "MAINNET", undefined]) {
    const result = parseHip4FormalTerms({ environment, nativeOutcome: native });
    assert.equal(result.environment, null);
    assert.equal(result.sourceFingerprint, null);
    assert.equal(result.matching.evidence, null);
  }
  const invalid = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: { ...native, sideSpecs: [] },
  });
  assert.equal(invalid.source, null);
  assert.equal(invalid.sourceFingerprint, null);
  const question = parseHip4FormalTerms({
    environment: "mainnet",
    nativeOutcome: native,
    nativeQuestion: { title: "HYPE prices" },
  });
  assert.equal(question.source?.question, null);
  assert(
    question.diagnostics.some(
      (entry) => entry.code === "invalid_native_question",
    ),
  );
});
