import { agentFixtureAuthors } from "./fixtures/agent-theses-authors.js";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_THESES_POLICY,
  agentThesesPolicySchema,
  agentInterests,
  normalizeAgentThesesPolicy,
  AGENT_WRITING_LIMITS,
  agentAuthorSettingsSchema,
} from "./services/agent-theses-policy.js";
import { validatePaperQuote } from "./services/agent-theses-publish.js";
import {
  agentProvenance,
  agentModelReserveUsd,
  AGENT_WRITER_MAX_REQUEST_BYTES,
  createAgentModelClient,
  AGENT_TOPIC_FIT_RULES,
  selectAgentCandidate,
  writeAgentThesis,
  type AgentModelClient,
} from "./services/agent-theses-model.js";
import {
  paperBuySnapshotSchema,
  verifiedBuyFactsSchema,
} from "./schemas/social-trade.js";
import { socialPublishBody } from "./schemas/social.js";
import { adminIntelPolicyKeySchema } from "./schemas/admin.js";
import { socialPositionMetrics } from "./services/social-primitives.js";
import {
  loadAgentMarketPool,
  selectAgentShortlist,
  type AgentCandidate,
} from "./services/agent-theses-context.js";
import {
  marketMapActiveKey,
  marketMapRunNodesGlobalKey,
  marketMapRunNodeEventsKey,
} from "./services/market-map.js";
import { AGENT_THESES_PREFIX } from "./services/agent-theses-state.js";
import { agentPoolOwnerIndex } from "./services/agent-theses-runner.js";
import {
  jevRequestModel,
  jevResponseModelMatches,
} from "./lib/jev-model-identity.js";

const now = new Date("2026-10-08T12:00:00Z");
const policy = agentThesesPolicySchema.parse({
  ...DEFAULT_AGENT_THESES_POLICY,
  authors: agentFixtureAuthors,
});
assert.equal(
  adminIntelPolicyKeySchema.safeParse("agent_theses").success,
  false,
  "Generic policy writes must not bypass agent permissions/revision/binding checks",
);
assert.equal(policy.enabled, false);
assert.equal(policy.writerModel, "openai/gpt-6.1-sol");
assert.equal(policy.jevModel, "typesafe/jev-1.14-20261014");
for (const [family, revision] of [
  ["typesafe/jev-1.13", "typesafe/jev-1.13-20260917"],
  ["typesafe/jev-1.14", "typesafe/jev-1.14-20261014"],
]) {
  assert.equal(jevRequestModel(revision), family);
  assert.equal(jevRequestModel(family), family);
  assert.ok(jevResponseModelMatches(family, revision));
  assert.ok(jevResponseModelMatches(revision, revision));
  assert.equal(jevResponseModelMatches(revision, `${revision}-other`), false);
}
assert.equal(
  jevResponseModelMatches("typesafe/jev-1.14", "typesafe/jev-1.13-20260917"),
  false,
);
assert.deepEqual(DEFAULT_AGENT_THESES_POLICY.authors, []);
assert.deepEqual(normalizeAgentThesesPolicy({}).authors, []);
const legacyPolicy = normalizeAgentThesesPolicy({
  ...policy,
  version: 1,
  authors: agentFixtureAuthors.map(
    ({ interests: _interests, ...author }, index) => ({
      ...author,
      specialization: ["politics", "sports", "crypto"][index],
      userId: index === 1 ? null : author.userId,
    }),
  ),
});
assert.equal(legacyPolicy.version, 2);
assert.equal(legacyPolicy.authors.length, 2);
assert.equal(
  agentInterests(legacyPolicy.authors[0]),
  policy.authors[0].interests,
);
assert.equal(legacyPolicy.authors[1].userId, policy.authors[2].userId);
assert.equal("specialization" in legacyPolicy.authors[0], false);
const manyAuthors = Array.from({ length: 10 }, (_, i) => ({
  ...policy.authors[0],
  userId: `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
}));
assert.equal(
  agentThesesPolicySchema.parse({ ...policy, authors: manyAuthors }).authors
    .length,
  10,
);
assert.throws(() => normalizeAgentThesesPolicy({ version: 3 }));
assert.throws(() =>
  agentThesesPolicySchema.parse({
    ...policy,
    authors: [{ ...policy.authors[0], userId: null }],
  }),
);
assert.throws(() =>
  agentThesesPolicySchema.parse({
    ...policy,
    authors: policy.authors.map((a) => ({ ...a, interests: "  " })),
  }),
);
assert.equal(policy.dayBudgetUsd, 2);
assert.equal(policy.previewDayBudgetUsd, 2);
const { previewDayBudgetUsd: _testBudget, ...oldBudgetPolicy } = policy;
assert.equal(
  normalizeAgentThesesPolicy(oldBudgetPolicy).previewDayBudgetUsd,
  2,
);
assert.equal(policy.publishIntervalSeconds, 14400);
assert.equal(policy.maxMarkets, 120);
assert.equal(policy.authors[0].maxThesisGraphemes, 6000);
for (const version of [1, 2]) {
  const older = { ...policy.authors[0] } as Partial<
    (typeof policy.authors)[number]
  >;
  delete older.language;
  delete older.styleExamples;
  delete older.maxThesisGraphemes;
  const normalized = normalizeAgentThesesPolicy({
    ...policy,
    version,
    authors: [
      { ...older, ...(version === 1 ? { specialization: "politics" } : {}) },
    ],
  });
  assert.equal(normalized.authors[0].language, "");
  assert.equal(normalized.authors[0].styleExamples, "");
  assert.equal(normalized.authors[0].maxThesisGraphemes, 6000);
}
const expandedSettings = agentAuthorSettingsSchema.parse({
  interests: "i".repeat(6000),
  approach: "a".repeat(12000),
  style: "s".repeat(6000),
  language: "Русский",
  styleExamples: "Ж".repeat(12000),
  maxThesisGraphemes: 12000,
  paperAmountUsd: "100",
});
for (const key of [
  "interests",
  "approach",
  "style",
  "language",
  "styleExamples",
] as const)
  assert.equal(
    agentAuthorSettingsSchema.safeParse({
      ...expandedSettings,
      [key]: "x".repeat(AGENT_WRITING_LIMITS[key] + 1),
    }).success,
    false,
  );
for (const maxThesisGraphemes of [0, 12001, 1.5, null])
  assert.equal(
    agentAuthorSettingsSchema.safeParse({
      ...expandedSettings,
      maxThesisGraphemes,
    }).success,
    false,
  );
assert.throws(() =>
  agentThesesPolicySchema.parse({
    ...policy,
    authors: [policy.authors[0], policy.authors[0], policy.authors[2]],
  }),
);
const quote = {
  ask: "0.5",
  asOf: now,
  now,
  maxAgeSeconds: 900,
  maxEntryPrice: "0.5",
};
assert.deepEqual(validatePaperQuote(quote), {
  ask: "0.5",
  asOf: now.toISOString(),
});
for (const ask of [null, "", "NaN", "-1", "0", "1.01"])
  assert.throws(
    () => validatePaperQuote({ ...quote, ask }),
    /quote_unavailable/,
  );
assert.throws(
  () => validatePaperQuote({ ...quote, ask: "0.500000000000000001" }),
  /price_changed/,
);
for (const asOf of [
  null,
  new Date(now.getTime() + 1),
  new Date(now.getTime() - 901000),
])
  assert.throws(() => validatePaperQuote({ ...quote, asOf }), /stale_quote/);
const instrument = {
  marketId: "fixture:politics",
  tokenId: "yes-token",
  outcome: "YES" as const,
  generation: "fixture-generation",
  venue: "polymarket" as const,
  expiry: null,
};
const candidate: AgentCandidate = {
  marketId: instrument.marketId,
  title: "Election first-round winner?",
  condition: "Resolves only on the first round, not the runoff.",
  category: "politics",
  eventTitle: "Election",
  closesAt: null,
  sides: [
    {
      label: "Candidate A",
      instrument,
      ask: "0.5",
      quoteAsOf: now.toISOString(),
    },
  ],
  sources: [
    {
      id: "s1",
      kind: "external_summary",
      title: "Dated first-round poll",
      excerpt: "Lead is within the reported margin of error.",
      url: "https://example.org/poll",
      asOf: now.toISOString(),
      confirmation: "unconfirmed",
      sourceTier: "social",
      caveats: ["Unconfirmed claim; do not state as established fact."],
      citedSources: [
        {
          title: "Earlier attribution",
          url: "https://example.org/earlier",
          asOf: now.toISOString(),
        },
      ],
    },
  ],
};
const decision = {
  decision: "publish" as const,
  marketId: candidate.marketId,
  outcome: "YES" as const,
  body: "A narrow first-round lead is evidence, not certainty; a runoff is a different contract.",
  sourceIds: ["s1"],
  counterargument: "The poll's margin of error.",
  maxEntryPrice: "0.52",
  changeReason: null,
};
const many = Array.from({ length: 90 }, (_, i) => ({
  ...candidate,
  marketId: `m${i}`,
}));
const freshIds = many.slice(0, 30).map((c) => c.marketId);
const first = selectAgentShortlist(
  many,
  freshIds,
  many.map(() => null),
  24,
);
assert.equal(first.filter((c) => !freshIds.includes(c.marketId)).length, 16);
const second = selectAgentShortlist(
  many,
  freshIds,
  many.map((c) => (first.some((f) => f.marketId === c.marketId) ? 100 : null)),
  24,
);
assert.ok(second.every((c) => !first.some((f) => f.marketId === c.marketId)));
const customTopics = [
  ...many,
  {
    ...candidate,
    marketId: "weather",
    title: "New York rainfall tomorrow?",
    category: "weather",
  },
  {
    ...candidate,
    marketId: "musk",
    title: "Elon Musk and Tesla milestone?",
    category: "business",
  },
];
const interestShortlist = selectAgentShortlist(
  customTopics,
  freshIds,
  customTopics.map(() => null),
  4,
  "Elon Musk Tesla",
);
assert.equal(interestShortlist[0].marketId, "musk");
assert.equal(
  selectAgentShortlist(
    customTopics,
    freshIds,
    customTopics.map(() => null),
    24,
    "Локальная погода",
    ["weather"],
  ).at(0)?.marketId,
  "weather",
  "semantic match survives language mismatch",
);
const mixedMap = new Map<string, string>([
  [marketMapActiveKey(), "mixed"],
  [
    marketMapRunNodesGlobalKey("mixed"),
    JSON.stringify([{ id: "leaf", childIds: [] }]),
  ],
  [
    marketMapRunNodeEventsKey("mixed", "leaf"),
    JSON.stringify([{ eventId: "rotation" }]),
  ],
]);
const mixedPool = await loadAgentMarketPool(
  {
    query: async (sql: string) => ({
      rows: sql.includes("recent_notes")
        ? Array.from({ length: 30 }, (_, i) => ({ source_id: `fresh:${i}` }))
        : Array.from({ length: 30 }, (_, i) => ({ id: `rotation:${i}` })),
    }),
  } as unknown as Parameters<typeof loadAgentMarketPool>[0],
  {
    get: async (key: string) => mixedMap.get(key) ?? null,
  } as unknown as Parameters<typeof loadAgentMarketPool>[1],
  120,
  "owner",
  Array.from({ length: 60 }, (_, i) => `semantic:${i}`),
);
assert.equal(mixedPool.marketIds.length, 120);
for (const group of ["semantic:", "fresh:", "rotation:"])
  assert.ok(mixedPool.marketIds.some((id) => id.startsWith(group)));
assert.equal(
  mixedPool.marketIds.filter((id) => id.startsWith("semantic:")).length,
  60,
);
assert.ok(
  interestShortlist.some((c) => c.marketId !== "musk"),
  "Interest boosts never remove exploration",
);
assert.ok(
  selectAgentShortlist(
    customTopics,
    [],
    customTopics.map(() => null),
    4,
    "New York rainfall",
  ).some((c) => c.marketId === "weather"),
);
assert.deepEqual(
  selectAgentShortlist(many.slice(0, 2), ["m0"], [100, null], 1).map(
    (c) => c.marketId,
  ),
  ["m1"],
);
assert.deepEqual(
  selectAgentShortlist(many.slice(0, 2), ["m0"], [100, 200], 1).map(
    (c) => c.marketId,
  ),
  ["m0"],
);
for (const maximum of [1, 2, 3]) {
  const pool = await loadAgentMarketPool(
    {
      query: async () => ({ rows: [{ source_id: "fresh-note-market" }] }),
    } as unknown as Parameters<typeof loadAgentMarketPool>[0],
    { get: async () => null } as unknown as Parameters<
      typeof loadAgentMarketPool
    >[1],
    maximum,
  );
  assert.deepEqual(pool.marketIds, ["fresh-note-market"]);
  assert.ok(pool.diagnostics.includes("map_unavailable"));
}
// Large leaves must not restart at their head after every map rebuild.
// Also cover a rebuilt map removing visited events and moving a tail elsewhere.
for (const moveEvents of [false, true]) {
  const stored = new Map<string, string>();
  const allEvents = Array.from({ length: 200 }, (_, i) => ({
    eventId: `a:${String(i).padStart(3, "0")}`,
  }));
  const seen = new Set<string>();
  const rotationDb = {
    query: async (sql: string, values: unknown[] = []) => ({
      rows: sql.includes("recent_notes") ? [] : [{ id: String(values[0]) }],
    }),
  } as unknown as Parameters<typeof loadAgentMarketPool>[0];
  const rotationRedis = {
    get: async (key: string) => stored.get(key) ?? null,
  } as unknown as Parameters<typeof loadAgentMarketPool>[1];
  for (let pass = 0; pass < 48; pass++) {
    const runId = `rotation:${Math.floor(pass / 12)}`;
    const moved = moveEvents && pass >= 12;
    stored.set(marketMapActiveKey(), runId);
    stored.set(
      marketMapRunNodesGlobalKey(runId),
      JSON.stringify([
        { id: "a", childIds: [] },
        { id: "b", childIds: [] },
      ]),
    );
    stored.set(
      marketMapRunNodeEventsKey(runId, "a"),
      JSON.stringify(moved ? allEvents.slice(20, 180) : allEvents),
    );
    stored.set(
      marketMapRunNodeEventsKey(runId, "b"),
      JSON.stringify([
        ...(moved ? allEvents.slice(180) : []),
        { eventId: "b:000" },
      ]),
    );
    const pool = await loadAgentMarketPool(rotationDb, rotationRedis, 120);
    assert.ok(
      pool.marketIds.length <= 12,
      "Keep the existing event-work bound",
    );
    for (const id of pool.marketIds) seen.add(id);
    stored.set(`${AGENT_THESES_PREFIX}:cursor`, JSON.stringify(pool.cursor));
  }
  assert.equal(
    seen.size,
    201,
    "Rebuilds must not starve the leaf tail or later leaves",
  );
}
// Thirty-minute ticks + four-hour publication cooldown must not consume unseen
// pages. An always-ready peer must not advance a cooling author's own cursor.
for (const cadence of ["solo", "staggered", "two-ready-peers"]) {
  const stored = new Map<string, string>();
  const runId = "schedule-rotation";
  stored.set(marketMapActiveKey(), runId);
  stored.set(
    marketMapRunNodesGlobalKey(runId),
    JSON.stringify([
      { id: "a", childIds: [] },
      { id: "b", childIds: [] },
    ]),
  );
  stored.set(
    marketMapRunNodeEventsKey(runId, "a"),
    JSON.stringify(
      Array.from({ length: 48 }, (_, i) => ({ eventId: `a:${i}` })),
    ),
  );
  stored.set(
    marketMapRunNodeEventsKey(runId, "b"),
    JSON.stringify(
      Array.from({ length: 48 }, (_, i) => ({ eventId: `b:${i}` })),
    ),
  );
  const db = {
    query: async (sql: string, values: unknown[] = []) => ({
      rows: sql.includes("recent_notes") ? [] : [{ id: String(values[0]) }],
    }),
  } as unknown as Parameters<typeof loadAgentMarketPool>[0];
  const redis = {
    get: async (key: string) => stored.get(key) ?? null,
  } as unknown as Parameters<typeof loadAgentMarketPool>[1];
  const seen = [new Set<string>(), new Set<string>(), new Set<string>()];
  const ownershipTurns = [0, 0, 0];
  let turn = 0;
  for (let tick = 0; tick < 256; tick++) {
    const ready =
      cadence === "two-ready-peers"
        ? [tick % 8 === 0 ? 0 : -1, 1, 2].filter((i) => i >= 0)
        : cadence === "staggered"
          ? [tick % 8 === 0 ? 0 : -1, 1, tick % 8 === 4 ? 2 : -1].filter(
              (i) => i >= 0,
            )
          : tick % 8 === 0
            ? [0]
            : [];
    if (!ready.length) continue;
    const owner = agentPoolOwnerIndex(
      ready,
      ready.map((i) => ownershipTurns[i]),
    );
    const keys = [0, 1, 2].map(
      (i) => `${AGENT_THESES_PREFIX}:cursor:author-${i}`,
    );
    const before = keys.map((key) => stored.get(key));
    const pool = await loadAgentMarketPool(db, redis, 120, `author-${owner}`);
    for (const i of ready) for (const id of pool.marketIds) seen[i].add(id);
    stored.set(keys[owner], JSON.stringify(pool.cursor));
    ownershipTurns[owner] = ++turn;
    for (const i of [0, 1, 2])
      if (i !== owner) assert.equal(stored.get(keys[i]), before[i]);
  }
  assert.equal(seen[0].size, 96, "Cooling author must see the entire map");
  if (cadence !== "solo") {
    assert.equal(seen[1].size, 96);
    assert.equal(
      seen[2].size,
      96,
      "Staggered author must not alias into a fixed page",
    );
  }
}
const provenance = agentProvenance({
  decision,
  candidate,
  previous: undefined,
  revision: "p1",
  model: policy.writerModel,
  angle: "mechanism",
});
const paper = paperBuySnapshotSchema.parse({
  version: 1,
  canonicalPurchaseKey: "paper:test",
  instrument,
  grossNotionalUsd: "100",
  grossShares: "200",
  netShares: "200",
  entryPrice: "0.5",
  feesUsd: null,
  purchasedAt: now.toISOString(),
  quoteAsOf: now.toISOString(),
  simulation: "top_ask_no_depth_fees_or_slippage",
  provenance,
});
assert.equal(verifiedBuyFactsSchema.safeParse(paper).success, false);
assert.deepEqual(
  paper.provenance.sources[0].caveats,
  candidate.sources[0].caveats,
);
assert.deepEqual(
  paper.provenance.sources[0].citedSources,
  candidate.sources[0].citedSources,
);
assert.equal(
  socialPublishBody.safeParse({
    purchaseMode: "paper",
    body: "x",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  }).success,
  false,
);
const metrics = (
  outcome: string,
  resolvedOutcome: string | null,
  pct: string | null = null,
  mark: string | null = null,
) =>
  socialPositionMetrics({
    notional: "100",
    grossShares: "200",
    netShares: "200",
    outcome,
    resolvedOutcome,
    resolvedOutcomePct: pct,
    active: mark !== null,
    mark,
  });
assert.equal(metrics("YES", "YES").pnlUsd, "100");
assert.equal(metrics("NO", "YES").pnlUsd, "-100");
assert.equal(metrics("NO", "NO").pnlUsd, "100");
assert.equal(metrics("YES", null, "2500").pnlUsd, "-50");
assert.equal(metrics("YES", "VOID").pnlUsd, null);
assert.equal(metrics("YES", null, null, "1").state, "open");

const args = {
  author: policy.authors[0],
  candidates: [candidate],
  history: [],
  policy,
  now,
};
function jev(market: string) {
  return {
    model: policy.jevModel,
    answers: {
      market: {
        type: "choice",
        choice: market,
        confidence: 0.9,
        probabilities: {
          c0: market === "c0" ? 0.9 : 0.1,
          none: market === "none" ? 0.9 : 0.1,
        },
      },
      angle: {
        type: "choice",
        choice: "mechanism",
        confidence: 0.8,
        probabilities: { mechanism: 0.8, countercase: 0.1, change: 0.1 },
      },
    },
  };
}
assert.equal(
  (await selectAgentCandidate({ ...args, model: async () => jev("c0") }))
    .candidate?.marketId,
  candidate.marketId,
);
await selectAgentCandidate({
  ...args,
  author: { ...args.author, interests: "Путин, переговоры, погода в Москве" },
  model: async (call) => {
    const body = call.body as {
      model: string;
      state: { author: Record<string, unknown> };
    };
    assert.equal(body.model, "typesafe/jev-1.14");
    assert.equal(
      body.state.author.interests,
      "Путин, переговоры, погода в Москве",
    );
    assert.equal(body.state.author.specialization, undefined);
    return jev("c0");
  },
});
await assert.rejects(
  selectAgentCandidate({
    ...args,
    model: async () => ({ ...jev("c0"), model: "typesafe/jev-1.13-20260917" }),
  }),
  /jev_model_mismatch/,
);
assert.equal(
  (await selectAgentCandidate({ ...args, model: async () => jev("none") }))
    .candidate,
  null,
);
await assert.rejects(
  selectAgentCandidate({ ...args, model: async () => jev("invented") }),
);
// Screenshot regression: the contract topic, not generic macro impact, must fit.
// The mock verifies the prompt/none contract; it is not a live quality evaluation.
const offTopic = await selectAgentCandidate({
  ...args,
  author: {
    ...args.author,
    interests: "Crypto, Bitcoin, protocols and token positioning",
  },
  candidates: [
    {
      ...candidate,
      title: "No Hormuz Agreement",
      category: "Politics",
      condition: "Will the Senate approve the Hormuz Agreement by October 23?",
    },
  ],
  model: async (call) => {
    const body = call.body as {
      questions: {
        market: { instructions: string; criteria: Record<string, string> };
      };
    };
    assert.ok(
      body.questions.market.instructions.includes(AGENT_TOPIC_FIT_RULES),
    );
    assert.ok(body.questions.market.criteria.none.includes("off-topic"));
    assert.ok(body.questions.market.criteria.c0.includes("generic downstream"));
    return jev("none");
  },
});
assert.equal(offTopic.candidate, null);
const writer: AgentModelClient = async (call) => {
  assert.equal(call.stage, "writer");
  assert.ok(!("tools" in (call.body as object)));
  const prompt = (call.body as { messages: Array<{ content: string }> })
    .messages[0].content;
  assert.ok(prompt.includes("profanity are allowed"));
  assert.ok(prompt.includes("not an accuracy/edge gate"));
  assert.ok(prompt.includes("Do not invent news"));
  assert.ok(prompt.includes(AGENT_TOPIC_FIT_RULES));
  assert.ok(!prompt.includes("Avoid certainty"));
  assert.ok(!prompt.includes("never forces a side"));
  return {
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(decision) } },
    ],
  };
};
assert.equal(
  (await writeAgentThesis({ ...args, model: writer, angle: "mechanism" }))
    .decision,
  "publish",
);
const outspoken = await writeAgentThesis({
  ...args,
  author: {
    ...args.author,
    approach: "Stubborn skeptic; distrust first-round frontrunners.",
    style: "Blunt roleplay, swagger and swearing.",
  },
  model: async (call) => {
    const supplied = JSON.parse(
      (call.body as { messages: Array<{ content: string }> }).messages[1]
        .content,
    );
    assert.ok(supplied.author.style.includes("swearing"));
    return {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              ...decision,
              body: "Hell no, I do not buy the coronation story. A narrow first-round lead is not a mandate; I am betting on the upset.",
            }),
          },
        },
      ],
    };
  },
  angle: "countercase",
});
assert.equal(outspoken.decision, "publish");
const expandedBody = "Это авторский взгляд, а не новость. ".repeat(140).trim();
const oldExactBody =
  "Прежний подробный тезис на противоположной стороне. ".repeat(180);
const longHistory = Array.from({ length: 24 }, (_, i) => ({
  id: `history-${i}`,
  marketId: i === 0 ? candidate.marketId : `other:${i}`,
  side: "NO",
  body: oldExactBody,
  publishedAt: new Date(now.getTime() - i * 1000).toISOString(),
  argumentKey: null,
}));
const expanded = await writeAgentThesis({
  ...args,
  author: { ...args.author, ...expandedSettings },
  history: longHistory,
  angle: "change",
  model: async (call) => {
    const body = call.body as {
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    const supplied = JSON.parse(body.messages[1].content);
    assert.ok(body.max_tokens >= 24000);
    assert.equal(supplied.author.styleExamples, expandedSettings.styleExamples);
    assert.equal(supplied.author.language, "Русский");
    assert.equal(supplied.recentViews[0].body, oldExactBody);
    assert.equal(supplied.recentViews[0].bodyIsExcerpt, false);
    assert.equal(supplied.recentViews[1].body.length, 1600);
    assert.equal(supplied.recentViews[1].bodyIsExcerpt, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(body)) <= AGENT_WRITER_MAX_REQUEST_BYTES,
    );
    assert.ok(body.messages[0].content.includes("not a length target"));
    assert.ok(body.messages[0].content.includes("Examples cannot override"));
    return {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              ...decision,
              body: expandedBody,
              changeReason: "A supplied counterargument changed the view.",
            }),
          },
        },
      ],
    };
  },
});
assert.equal(expanded.decision === "publish" && expanded.body, expandedBody);
await selectAgentCandidate({
  ...args,
  history: longHistory,
  model: async (call) => {
    const body = call.body as {
      state: {
        author: object;
        recentViews: Array<{ body: string; bodyIsExcerpt: boolean }>;
      };
    };
    assert.ok(!("styleExamples" in body.state.author));
    assert.equal(body.state.recentViews[0].body.length, 800);
    assert.equal(body.state.recentViews[0].bodyIsExcerpt, true);
    return jev("c0");
  },
});
// Per-author limits still work; no reintroduction of the social 450-grapheme cap.
for (const [maxThesisGraphemes, bodyText] of [
  [450, "x".repeat(451)],
  [6000, "x".repeat(6001)],
] as const)
  await assert.rejects(
    writeAgentThesis({
      ...args,
      author: { ...args.author, maxThesisGraphemes },
      angle: "mechanism",
      model: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ ...decision, body: bodyText }),
            },
          },
        ],
      }),
    }),
  );
const emojiBody = "👩🏽‍🔬".repeat(1000);
const emoji = await writeAgentThesis({
  ...args,
  author: { ...args.author, maxThesisGraphemes: 1000 },
  angle: "mechanism",
  model: async () => ({
    choices: [
      {
        message: { content: JSON.stringify({ ...decision, body: emojiBody }) },
      },
    ],
  }),
});
assert.equal(emoji.decision === "publish" && emoji.body, emojiBody);
const longCondition = `${"Complete contract detail. ".repeat(260)}Final clause: independent legislators are assigned by the specified caucus deadline.`;
await writeAgentThesis({
  ...args,
  candidates: [{ ...candidate, condition: longCondition }],
  angle: "mechanism",
  model: async (call) => {
    const body = call.body as { messages: Array<{ content: string }> };
    assert.equal(
      JSON.parse(body.messages[1].content).candidates[0].condition,
      longCondition,
    );
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "skip",
              reason: "Test complete rules.",
            }),
          },
        },
      ],
    };
  },
});
let oversizedCalls = 0;
await assert.rejects(
  writeAgentThesis({
    ...args,
    angle: "mechanism",
    candidates: [
      { ...candidate, condition: "x".repeat(AGENT_WRITER_MAX_REQUEST_BYTES) },
    ],
    model: async () => {
      oversizedCalls++;
      throw new Error("must_not_call");
    },
  }),
  /writer_context_too_large/,
);
assert.equal(oversizedCalls, 0);
// Ordinary next-candidate recovery needs no policy/cooldown reset.
assert.equal(
  (await writeAgentThesis({ ...args, model: writer, angle: "mechanism" }))
    .decision,
  "publish",
);
await writeAgentThesis({
  ...args,
  angle: "mechanism",
  candidates: Array.from({ length: 3 }, (_, i) => ({
    ...candidate,
    marketId: `large:${i}`,
    condition: "x".repeat(150000),
  })),
  model: async (call) => {
    assert.ok(
      Buffer.byteLength(JSON.stringify(call.body)) <=
        AGENT_WRITER_MAX_REQUEST_BYTES,
    );
    const body = call.body as { messages: Array<{ content: string }> };
    const supplied = JSON.parse(body.messages[1].content).candidates;
    assert.equal(supplied.length, 1);
    assert.equal(
      supplied[0].condition.length,
      150000,
      "Reduce fallback count, never settlement rules",
    );
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "skip",
              reason: "Test bounded fallback.",
            }),
          },
        },
      ],
    };
  },
});
for (const patch of [
  { marketId: "made-up" },
  { outcome: "NO" },
  { sourceIds: ["made-up"] },
  { body: "a".repeat(args.author.maxThesisGraphemes + 1) },
]) {
  await assert.rejects(
    writeAgentThesis({
      ...args,
      angle: "mechanism",
      model: async () => ({
        choices: [
          { message: { content: JSON.stringify({ ...decision, ...patch }) } },
        ],
      }),
    }),
  );
}
await assert.rejects(
  writeAgentThesis({
    ...args,
    model: writer,
    angle: "change",
    history: [
      {
        id: "old",
        marketId: candidate.marketId,
        side: "NO",
        body: "Old view",
        publishedAt: now.toISOString(),
        argumentKey: null,
      },
    ],
  }),
);

// Reserve before network; both unknown timeout and malformed response retain accounting.
const events: string[] = [];
const client = createAgentModelClient({
  apiKey: "test-only",
  runId: "test",
  reserve: async () => {
    events.push("reserve");
  },
  settle: async (_id, cost) => {
    events.push(`settle:${cost}`);
  },
  record: () => {
    events.push("record");
  },
  fetchImpl: async () => {
    events.push("fetch");
    throw new Error("timeout");
  },
});
await assert.rejects(client({ stage: "writer", body: {}, reserveUsd: 0.25 }));
assert.deepEqual(events, ["reserve", "fetch", "settle:null", "record"]);
const paid = createAgentModelClient({
  apiKey: "test-only",
  runId: "paid",
  reserve: async () => {},
  settle: async (_id, cost) => assert.equal(cost, 0.012),
  record: () => {},
  fetchImpl: async () =>
    new Response(
      JSON.stringify({ usage: { cost: 0.012 }, error: { message: "failed" } }),
    ),
});
await assert.rejects(paid({ stage: "writer", body: {}, reserveUsd: 0.25 }));
const bigRequest = {
  model: policy.writerModel,
  max_tokens: 26048,
  messages: [{ content: "Ж".repeat(50000) }],
};
const bigReserve = agentModelReserveUsd(policy.writerModel, bigRequest, 0.25);
assert.ok(bigReserve > 0.4 && bigReserve < policy.dayBudgetUsd);
assert.equal(
  agentModelReserveUsd(policy.writerModel, { max_tokens: 1800 }, 0.25),
  0.25,
);
assert.ok(agentModelReserveUsd("custom/unknown", bigRequest, 0.25) > 0.25);
let fetched = false;
const overBudget = createAgentModelClient({
  apiKey: "test",
  runId: "budget",
  reserve: async (_id, amount) => {
    assert.equal(amount, bigReserve);
    throw new Error("budget_exhausted");
  },
  settle: async () => assert.fail("no call to settle"),
  record: () => assert.fail("no paid call"),
  fetchImpl: async () => {
    fetched = true;
    throw new Error("must_not_fetch");
  },
});
await assert.rejects(
  overBudget({ stage: "writer", body: bigRequest, reserveUsd: 0.25 }),
  /budget_exhausted/,
);
assert.equal(fetched, false);
const timedOut = createAgentModelClient({
  apiKey: "test",
  runId: "timeout",
  reserve: async (_id, amount) => assert.equal(amount, bigReserve),
  settle: async (_id, cost) => assert.equal(cost, null),
  record: (record) => assert.equal(record.chargedUsd, bigReserve),
  fetchImpl: async () => {
    throw new Error("timeout");
  },
});
await assert.rejects(
  timedOut({ stage: "writer", body: bigRequest, reserveUsd: 0.25 }),
  /timeout/,
);
await assert.rejects(
  writeAgentThesis({
    ...args,
    angle: "mechanism",
    model: async () => ({
      choices: [
        {
          finish_reason: "length",
          message: {
            content: JSON.stringify({ ...decision, body: expandedBody }),
          },
        },
      ],
    }),
  }),
);
console.log("agent-theses unit contracts passed");
