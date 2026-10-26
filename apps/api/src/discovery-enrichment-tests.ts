import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { resolvePolymarketMarketAssets } from "@hunch/shared";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  applyDiscoveryEstimate,
  enrichDiscoveryResearch,
  estimateInputsFromRow,
  type DiscoveryEstimateInputs,
} from "./services/discovery-estimate.js";
import {
  aggregateSmartMoney,
  type SmartChange,
  type SmartPosition,
} from "./services/discovery-domain.js";
import { DiscoveryService } from "./services/discovery-service.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import {
  discoveryItemSchema,
  type DiscoveryItem,
} from "./schemas/discovery.js";
import {
  discoveryTestComponents,
  discoveryTestItem,
  discoveryTestRow,
  discoveryTestNow as now,
  discoveryTestScope,
  discoveryTestSnapshot,
  discoveryTestWallet,
} from "./discovery-test-fixtures.js";

const at = new Date(now).toISOString();
function gem(side: "YES" | "NO" = "YES"): DiscoveryItem {
  const item = discoveryTestItem("limitless:1", {
    side,
    best_bid: "0.49",
    best_ask: "0.51",
  });
  return {
    ...item,
    id: "gem:1",
    reason: {
      kind: "hidden-gems",
      strength: "strong",
      basis: "public_approved_research_not_proven_mispricing",
    },
    research: {
      noteId: randomUUID(),
      createdAt: at,
      headline: "Public headline",
      summary: "Public summary",
      side,
      strength: "strong",
      researchedPrice: "0.69",
      researchedAt: at,
      sources: [
        {
          id: "source:1",
          headline: "Public news",
          url: "https://example.com/news",
          publishedAt: at,
        },
      ],
      caveats: ["Uncertain"],
      instrument: item.selection.instrument,
    },
  };
}
function inputs(
  extra: Partial<DiscoveryEstimateInputs> = {},
): DiscoveryEstimateInputs {
  return {
    walletId: randomUUID(),
    side: "YES",
    actualWinRate: "0.6",
    expectedWinRate: "0.5",
    sampleSize: 50,
    metricsAsOf: at,
    positionAsOf: at,
    positionShares: "100",
    selectedSupportUsd: "1000",
    oppositeSupportUsd: "0",
    ...extra,
  };
}
function test(name: string, fn: () => void) {
  fn();
  console.log(`[discovery-enrichment-tests] ok ${name}`);
}

test("Frozen odds formula, decimal valuations and named YES/NO outcomes", () => {
  for (const side of ["YES", "NO"] as const) {
    const result = applyDiscoveryEstimate(gem(side), inputs({ side }), now);
    assert.equal(result.estimate?.probability, "0.55");
    assert.equal(result.estimate?.calibrated, false);
    assert.equal(result.estimate?.status, "available");
    assert.equal(result.valuation?.probabilityDifferencePp, "5");
    assert.ok(
      Math.abs(Number(result.valuation?.modelUpsideRatio) - (0.55 / 0.51 - 1)) <
        1e-10,
    );
    assert.ok(discoveryItemSchema.safeParse(result).success);
  }
});
test("Sample shrinkage, maximum odds, age decay and opposing support", () => {
  const probability = (i: DiscoveryEstimateInputs, item = gem()) =>
    Number(applyDiscoveryEstimate(item, i, now).estimate?.probability);
  assert.ok(
    probability(inputs({ sampleSize: 1 })) <
      probability(inputs({ sampleSize: 1000 })),
  );
  assert.ok(
    probability(
      inputs({
        actualWinRate: "1",
        expectedWinRate: "0.01",
        sampleSize: 100000,
      }),
    ) <=
      2 / 3 + 1e-12,
  );
  const old = gem();
  assert.ok(old.research);
  old.research.createdAt = new Date(now - 7 * 86400000).toISOString();
  assert.ok(probability(inputs(), old) < probability(inputs()));
  assert.ok(
    probability(
      inputs({ selectedSupportUsd: "0", oppositeSupportUsd: "1000" }),
    ) < 0.5,
  );
  for (const fields of [
    { selectedSupportUsd: "1000", oppositeSupportUsd: "1000" },
    { selectedSupportUsd: "0", oppositeSupportUsd: "0" },
    { actualWinRate: "0.4" },
  ]) {
    const result = applyDiscoveryEstimate(gem(), inputs(fields), now);
    assert.equal(result.estimate?.status, "market_only");
    assert.equal(result.estimate?.probability, "0.5");
  }
  const limited = applyDiscoveryEstimate(
    gem(),
    inputs({ oppositeSupportUsd: null }),
    now,
  );
  assert.equal(limited.estimate?.coverage, "representative_only");
  assert.ok(limited.estimate?.warnings.some((w) => w.includes("unknown")));
});
test("Missing, stale, future and closed inputs keep research readable without an estimate", () => {
  for (const [extra, reason] of [
    [{ walletId: null }, "representative_unavailable"],
    [{ side: "NO" }, "side_mismatch"],
    [{ actualWinRate: null }, "metrics_unavailable"],
    [{ expectedWinRate: "0" }, "metrics_unavailable"],
    [{ expectedWinRate: "1" }, "metrics_unavailable"],
    [{ sampleSize: 0 }, "metrics_unavailable"],
    [{ metricsAsOf: new Date(now - 86400001).toISOString() }, "metrics_stale"],
    [{ metricsAsOf: new Date(now + 60000).toISOString() }, "metrics_stale"],
    [{ positionShares: null }, "position_unavailable"],
    [{ positionShares: "0" }, "position_unavailable"],
    [{ positionShares: "-1" }, "position_unavailable"],
    [
      { positionAsOf: new Date(now - 86400001).toISOString() },
      "position_stale",
    ],
  ] as [Partial<DiscoveryEstimateInputs>, string][]) {
    const item = gem(),
      result = applyDiscoveryEstimate(item, inputs(extra), now);
    assert.equal(result.estimate?.reason, reason);
    assert.equal(result.valuation, null);
    assert.equal(result.research, item.research);
  }
  assert.equal(
    applyDiscoveryEstimate(gem(), undefined, now).estimate?.reason,
    "inputs_unavailable",
  );
  const changed = gem();
  assert.ok(changed.selection.instrument);
  changed.selection.instrument = {
    ...changed.selection.instrument,
    generation: "next",
  };
  assert.equal(
    applyDiscoveryEstimate(changed, inputs(), now).estimate?.reason,
    "instrument_changed",
  );
  const stale = gem();
  stale.quote.status = "stale";
  assert.equal(
    applyDiscoveryEstimate(stale, inputs(), now).estimate?.reason,
    "quote_unavailable",
  );
  for (const extreme of ["0", "1"]) {
    const boundary = gem();
    boundary.quote.midpoint = extreme;
    boundary.quote.ask = extreme;
    assert.equal(
      applyDiscoveryEstimate(boundary, inputs(), now).estimate?.reason,
      "quote_unavailable",
    );
  }
});
test("69-cent historical research never anchors valuation against a new 2-cent ask", () => {
  const item = gem();
  item.quote = {
    status: "fresh",
    bid: "0.01",
    ask: "0.02",
    midpoint: "0.015",
    asOf: at,
  };
  const result = applyDiscoveryEstimate(item, inputs(), now);
  assert.ok(Number(result.estimate?.probability) < 0.02);
  assert.ok(Number(result.valuation?.modelUpsideRatio) < 0);
  assert.equal(result.research?.researchedPrice, "0.69");
});
test("Evidence projection strips internal metadata and only references public sources", () => {
  const research = gem().research;
  assert.ok(research);
  const metric = {
    kind: "pricing_edge",
    scope: "representative_wallet",
    measurement: { kind: "scalar", value: 0.1, unit: "probability" },
    sampleSize: 50,
    horizonDays: 30,
    asOf: at,
    source: { kind: "hunch_wallet_intel" },
    context: { secret: "DO_NOT_RETURN" },
  };
  const result = enrichDiscoveryResearch(
    research,
    {
      metrics: {
        signalEvidence: [
          metric,
          {
            ...metric,
            scope: "external_market",
            source: { url: "https://private.invalid" },
          },
          {
            ...metric,
            measurement: { kind: "scalar", value: Infinity, unit: "usd" },
          },
        ],
      },
      model_meta: { prompt: "DO_NOT_RETURN" },
    },
    now,
  );
  assert.equal(result.evidenceMetrics?.length, 1);
  assert.equal(result.sourceCount, 1);
  assert.equal(result.contextHighlight?.kind, "news");
  assert.equal(result.contextHighlight?.publishedAt, at);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_RETURN"));
  assert.equal(
    enrichDiscoveryResearch({ ...research, sources: [] }, {}, now)
      .contextHighlight,
    null,
  );
  assert.equal(
    estimateInputsFromRow({ wallet_id: "not-a-uuid", sample_size: -1 })
      .walletId,
    null,
  );
  const canonical = enrichDiscoveryResearch(
    {
      ...research,
      sources: [
        {
          id: "canonical",
          url: "https://example.com/",
          headline: "Root",
          publishedAt: at,
        },
      ],
    },
    {
      metrics: {
        signalEvidence: [
          {
            ...metric,
            kind: "outside_odds",
            scope: "external_market",
            source: { url: "https://example.com" },
          },
        ],
      },
    },
    now,
  );
  assert.equal(canonical.evidenceMetrics?.[0]?.sourceId, "canonical");
});

const wallets = Array.from({ length: 5 }, () =>
  discoveryTestWallet(randomUUID()),
);
wallets[4].ownerKey = wallets[0].ownerKey;
wallets[4].qualified = false;
const positions: SmartPosition[] = wallets.map((w, i) => ({
  walletId: w.walletId,
  venue: "limitless",
  marketId: "limitless:1",
  side: i === 3 ? "NO" : "YES",
  shares: "500",
  valueUsd: "250",
  snapshotAt: at,
}));
const changes: SmartChange[] = positions.map((p) => ({
  ...p,
  netShares: "300",
  observedAt: at,
}));
const selections = aggregateSmartMoney(wallets, positions, changes);
test("Positioning and complete group list share a deduplicated cohort, including opposition below selection threshold", () => {
  assert.equal(selections.length, 1);
  const group = selections[0],
    p = group.reason.positioning;
  assert.ok(p);
  assert.equal(p.selected.ownerGroups, 3);
  assert.equal(p.selected.walletCount, 4);
  assert.equal(p.opposite.ownerGroups, 1);
  assert.equal(p.opposite.walletCount, 1);
  assert.equal(p.selected.positionValueUsd, "1000");
  assert.equal(p.opposite.positionValueUsd, "250");
  assert.equal(p.selected.observedIncreaseValueUsd, "450");
  assert.equal(p.opposite.observedIncreaseValueUsd, "150");
  assert.equal(p.selectedIncreaseShare, "0.75");
  assert.equal(group.participants?.length, 4);
  assert.equal(group.reason.traders.length, 3);
  assert.equal(group.participants?.[3].side, "NO");
  assert.ok(!JSON.stringify(group.participants).includes("ownerKey"));
});

const base = discoveryTestItem();
const smart: DiscoveryItem = {
  ...base,
  id: "smart:1",
  reason: selections[0].reason,
};
let clock = now;
assert.ok(selections[0].participants);
const parts = discoveryTestComponents([smart], () => clock),
  snapshot = {
    ...discoveryTestSnapshot([smart]),
    section: "smart-money" as const,
    smartParticipants: { [smart.id]: selections[0].participants },
  };
await parts.store.acquire("smart-money", "test");
await parts.store.publish("smart-money", "test", snapshot);
await parts.store.release("smart-money", "test");
const service = new DiscoveryService(
  parts.builder,
  async () => parts.store,
  async () => discoveryTestScope,
  () => clock,
);
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
await app.register(createDiscoveryRoutes(service));
try {
  const route = `/discovery/smart-money/limitless:1/traders?snapshotId=${snapshot.id}&side=YES&limit=2`;
  const first = await app.inject(route);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 2);
  const second = await app.inject(
    `${route}&cursor=${encodeURIComponent(first.json().nextCursor)}`,
  );
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().items.length, 2);
  assert.equal(second.json().nextCursor, null);
  assert.equal(
    new Set(
      [...first.json().items, ...second.json().items].map((p) => p.groupId),
    ).size,
    4,
  );
  assert.deepEqual(
    first.json().positioning,
    smart.reason.kind === "smart-money" ? smart.reason.positioning : null,
  );
  assert.equal(
    (await app.inject(route.replace("limit=2", "limit=51"))).statusCode,
    400,
  );
  assert.equal(
    (await app.inject(route.replace("limitless:1", "limitless:unknown")))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject(
        `${route.replace("side=YES", "side=NO")}&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      )
    ).statusCode,
    400,
  );
  assert.ok(
    parts.repo.batches.every((b) => b.length === 1),
    "trader pagination checks only its exact live market",
  );
  // A process restart can read the same Redis snapshot and cursor without rebuilding.
  const restarted = new DiscoveryService(
    parts.builder,
    async () => parts.store,
    async () => discoveryTestScope,
    () => clock,
  );
  assert.equal(
    (
      await restarted.readTraders("limitless:1", {
        snapshotId: snapshot.id,
        side: "YES",
        limit: 2,
        cursor: first.json().nextCursor,
      })
    ).items.length,
    2,
  );
  await restarted.stop();
  const liveRow = parts.repo.rows.get("limitless:1");
  assert.ok(liveRow);
  liveRow.status = "CLOSED";
  assert.equal((await app.inject(route)).statusCode, 404);
  liveRow.status = "ACTIVE";
  liveRow.token_id = "new-generation";
  assert.equal((await app.inject(route)).statusCode, 404);
  clock += 900000;
  assert.equal((await app.inject(route)).statusCode, 409);
  console.log(
    "[discovery-enrichment-tests] ok route, frozen cohort, restart, validation and expiration",
  );
} finally {
  await service.stop();
  await app.close();
}

// Existing Redis versions retain their collection contract; only the new drilldown
// needs a complete cohort. A newly completed background version restores it.
const legacyItem = structuredClone(smart);
assert.equal(legacyItem.reason.kind, "smart-money");
if (legacyItem.reason.kind === "smart-money")
  delete legacyItem.reason.positioning;
const legacyParts = discoveryTestComponents([legacyItem], () => now);
const legacySnapshot = {
  ...discoveryTestSnapshot([legacyItem]),
  section: "smart-money" as const,
};
await legacyParts.store.acquire("smart-money", "legacy");
await legacyParts.store.publish("smart-money", "legacy", legacySnapshot);
await legacyParts.store.release("smart-money", "legacy");
const legacyService = new DiscoveryService(
  legacyParts.builder,
  async () => legacyParts.store,
  async () => discoveryTestScope,
  () => now,
);
await legacyService.stop(); // no artificial background job in this version-compatibility test
assert.equal(
  (
    await legacyService.read("smart-money", {
      limit: 20,
      withResearch: "false",
    })
  ).items.length,
  1,
);
await assert.rejects(
  legacyService.readTraders("limitless:1", {
    snapshotId: legacySnapshot.id,
    limit: 20,
  }),
  (error: unknown) =>
    error instanceof Error && error.message === "discovery_unavailable",
);
await legacyParts.store.acquire("smart-money", "new-version");
await legacyParts.store.publish("smart-money", "new-version", snapshot);
await legacyParts.store.release("smart-money", "new-version");
assert.equal(
  (
    await legacyService.readTraders("limitless:1", {
      snapshotId: snapshot.id,
      limit: 20,
    })
  ).items.length,
  4,
);
console.log(
  "[discovery-enrichment-tests] ok legacy collection compatibility and new-version recovery",
);

// The production drilldown must load instrument metadata, not only prices.
// Exercise both generations and both selected sides with the real light projection.
for (const version of ["v1", "v2"] as const) {
  const conditionId = `0x01${"00".repeat(31)}`;
  const assets = [
    BigInt(conditionId).toString(),
    (BigInt(conditionId) + 1n).toString(),
  ];
  const protocol = resolvePolymarketMarketAssets({
    version,
    conditionId,
    clobTokenIds: assets,
    positionIds: assets,
    outcomes: ["Yes", "No"],
    negRisk: false,
  });
  for (const side of ["YES", "NO"] as const) {
    const marketId = `polymarket:traders-${version}-${side}`;
    const row = discoveryTestRow(marketId, {
      venue: "polymarket",
      side,
      token_id: assets[side === "YES" ? 0 : 1],
      metadata: { polymarketProtocol: protocol },
    });
    const cohort = structuredClone(selections[0]);
    assert.ok(cohort.reason.positioning);
    assert.ok(cohort.participants);
    if (side === "NO") {
      cohort.reason.positioning.selected.side = "NO";
      cohort.reason.positioning.opposite.side = "YES";
      for (const member of cohort.participants)
        member.side = member.side === "YES" ? "NO" : "YES";
    }
    const item = { ...discoveryTestItem(marketId, row), reason: cohort.reason };
    const components = discoveryTestComponents([item]);
    components.repo.rows.set(marketId, row);
    const frozen = {
      ...discoveryTestSnapshot([item]),
      section: "smart-money" as const,
      smartParticipants: { [item.id]: cohort.participants },
    };
    await components.store.acquire("smart-money", "poly");
    await components.store.publish("smart-money", "poly", frozen);
    await components.store.release("smart-money", "poly");
    const polyService = new DiscoveryService(
      components.builder,
      async () => components.store,
      async () => discoveryTestScope,
      () => now,
    );
    const polyApp = Fastify();
    polyApp.setSerializerCompiler(serializerCompiler);
    polyApp.setValidatorCompiler(validatorCompiler);
    await polyApp.register(createDiscoveryRoutes(polyService));
    try {
      const query = `snapshotId=${frozen.id}&side=${side}&limit=2`;
      const route = `/discovery/smart-money/${encodeURIComponent(marketId)}/traders?${query}`;
      const first = await polyApp.inject(route);
      assert.equal(
        first.statusCode,
        200,
        `${version}/${side} encoded market ID: ${first.body}`,
      );
      const last = await polyApp.inject(
        `${route}&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      );
      assert.equal(last.statusCode, 200);
      assert.equal(last.json().nextCursor, null);
      assert.deepEqual(
        [...first.json().items, ...last.json().items],
        frozen.smartParticipants[item.id],
      );
      assert.equal(
        (
          await polyApp.inject(
            `/discovery/smart-money/${marketId}/traders?${query}`,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (await polyApp.inject(route.replace(`&side=${side}`, ""))).statusCode,
        200,
      );
      row.metadata = {
        polymarketProtocol: protocol,
        umaResolutionStatus: "proposed",
      };
      assert.equal(
        (await polyApp.inject(route)).statusCode,
        404,
        "proposed resolution remains blocked",
      );
      row.metadata = { polymarketProtocol: protocol };
      if (version === "v1") {
        row.metadata = {
          polymarketProtocol: resolvePolymarketMarketAssets({
            version: "v2",
            conditionId,
            positionIds: assets,
            outcomes: ["Yes", "No"],
            negRisk: false,
          }),
        };
        assert.equal(
          (await polyApp.inject(route)).statusCode,
          404,
          "same numeric asset in another generation remains blocked",
        );
        row.metadata = { polymarketProtocol: protocol };
      }
      row.token_id = "999";
      assert.equal(
        (await polyApp.inject(route)).statusCode,
        404,
        "changed asset remains blocked",
      );
      row.token_id = assets[side === "YES" ? 0 : 1];
      assert.equal(
        (await polyApp.inject(route)).statusCode,
        200,
        "restored identity recovers immediately",
      );
    } finally {
      await polyService.stop();
      await polyApp.close();
    }
  }
}
console.log(
  "[discovery-enrichment-tests] ok Polymarket v1/v2 YES/NO, ID encodings, pagination and live identity safety",
);
