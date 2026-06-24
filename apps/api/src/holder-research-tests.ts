import assert from "node:assert/strict";

import {
  holderResearchAgentOutputV1Schema,
  parseHolderResearchAgentOutputV1,
} from "./schemas/holder-research.js";
import {
  holderResearchWalletNotesBodySchema,
  signalsQuerySchema,
} from "./schemas/signals.js";
import {
  buildDeterministicHolderResearchDecision,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchDecisionSnapshot,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchWalletTargets,
  diffHolderResearchDecisionSnapshots,
  evaluateHolderResearchDecisionCache,
  isSharpHolder,
  selectHolderResearchCandidates,
  type HolderResearchHolder,
  type HolderResearchMarketInput,
  type HolderResearchSide,
} from "./services/holder-research.js";
import {
  getIntelPolicyDefaults,
  resolveIntelPolicy,
  type HolderResearchPolicy,
} from "./services/runtime-policies.js";

function policy(overrides: Partial<HolderResearchPolicy> = {}) {
  return {
    ...getIntelPolicyDefaults("holder_research"),
    ...overrides,
  };
}

function side(
  sideName: "YES" | "NO",
  overrides: Partial<HolderResearchSide> = {},
): HolderResearchSide {
  return {
    side: sideName,
    usd: 0,
    wallets: 0,
    openPnlUsd: null,
    sharpHolders: 0,
    sharpUsd: 0,
    bestEdge: null,
    bestZScore: null,
    bestSampleCount: null,
    bestResolvedStakeUsd: null,
    bestTrades30d: null,
    ...overrides,
  };
}

function holder(
  sideName: "YES" | "NO",
  overrides: Partial<HolderResearchHolder> = {},
): HolderResearchHolder {
  return {
    walletId: `00000000-0000-0000-0000-0000000000${sideName === "YES" ? "01" : "02"}`,
    address: sideName === "YES" ? "0xyes" : "0xno",
    chain: "polygon",
    label: null,
    side: sideName,
    positionUsd: 10_000,
    openPnlUsd: null,
    resolvedWinRateEdge30d: 0.16,
    resolvedEdgeZScore30d: 2.1,
    resolvedEdgeSampleCount30d: 24,
    resolvedStakeUsd30d: 6_000,
    trades30d: 18,
    winRate30d: 0.65,
    volume30dUsd: 90_000,
    walletKind: "safe",
    ownerAddress: "0xowner",
    walletUsdLikeBalance: 500,
    ownerUsdLikeBalance: 10_000,
    relatedOpenPositions: [],
    ...overrides,
  };
}

function market(
  overrides: Partial<HolderResearchMarketInput> = {},
): HolderResearchMarketInput {
  return {
    marketId: "polymarket:test-market",
    eventId: "polymarket:test-event",
    venue: "polymarket",
    marketTitle: "Will the test market resolve Yes?",
    marketSlug: "will-the-test-market-resolve-yes",
    marketDescription: null,
    eventTitle: "Test event",
    eventSlug: "test-event",
    eventDescription: null,
    seriesKey: null,
    seriesTitle: null,
    resolutionSource: null,
    category: "Politics",
    closeTime: new Date(Date.now() + 86_400_000).toISOString(),
    expirationTime: null,
    yesProbability: 0.55,
    volume24h: 100_000,
    liquidity: 25_000,
    sides: {
      YES: side("YES", { usd: 120_000, wallets: 5 }),
      NO: side("NO", {
        usd: 32_000,
        wallets: 2,
        sharpHolders: 1,
        sharpUsd: 10_000,
        bestEdge: 0.16,
        bestZScore: 2.1,
        bestSampleCount: 24,
        bestResolvedStakeUsd: 6_000,
        bestTrades30d: 18,
      }),
    },
    holders: [holder("NO")],
    recentActivityUsd: 0,
    recentActivityAt: null,
    crossMarketWalletCount: 0,
    previousNote: null,
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: "sharp holder requires exposure, edge, z-score, samples, stake, and trades",
    run: () => {
      const p = policy();
      assert.equal(isSharpHolder(holder("YES"), p), true);
      assert.equal(
        isSharpHolder(
          holder("YES", {
            resolvedEdgeSampleCount30d: p.minResolvedEdgeSampleCount30d - 1,
          }),
          p,
        ),
        false,
      );
      assert.equal(
        isSharpHolder(
          holder("YES", { positionUsd: p.minHolderPositionUsd - 1 }),
          p,
        ),
        false,
      );
    },
  },
  {
    name: "sharp minority candidate clears conservative publish threshold",
    run: () => {
      const p = policy();
      const candidates = buildHolderResearchCandidatesFromMarket(market(), p);
      const sharpMinority = candidates.find(
        (candidate) => candidate.bucket === "sharp_minority",
      );
      assert.ok(sharpMinority);
      assert.equal(sharpMinority.side, "NO");
      assert.equal(sharpMinority.score >= p.publishMinScore, true);
      assert.equal(
        sharpMinority.evidence.some((ev) => ev.kind === "holder"),
        true,
      );
    },
  },
  {
    name: "near-certain odds suppress non-timing holder research candidates",
    run: () => {
      const candidates = buildHolderResearchCandidatesFromMarket(
        market({ yesProbability: 0.995 }),
        policy(),
      );
      assert.equal(candidates.length, 0);
    },
  },
  {
    name: "selection honors quotas, cooldowns, and one candidate per market",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 2,
        maxCandidatesPerRun: 2,
        quotaSharpMinority: 1,
        quotaSharpSide: 1,
        quotaCleanDisagreement: 0,
      });
      const first = buildHolderResearchCandidatesFromMarket(market(), p);
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:second",
          sides: {
            YES: side("YES", { usd: 80_000, wallets: 4 }),
            NO: side("NO", {
              usd: 30_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 12_000,
              bestEdge: 0.17,
              bestZScore: 2.3,
              bestSampleCount: 30,
              bestResolvedStakeUsd: 8_000,
              bestTrades30d: 21,
            }),
          },
          holders: [
            holder("NO", { walletId: "00000000-0000-0000-0000-000000000003" }),
          ],
        }),
        p,
      );
      const cooled = first.map((candidate) => ({
        ...candidate,
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      }));
      const result = selectHolderResearchCandidates([...cooled, ...second], p);
      assert.equal(result.selected.length, 1);
      assert.equal(result.selected[0]?.market.marketId, "polymarket:second");
      assert.equal(
        result.skipped.some((entry) => entry.reason === "cooldown"),
        true,
      );
    },
  },
  {
    name: "zero-quota weak concentration candidate is not selected by refill",
    run: () => {
      const p = policy({
        quotaConcentrationRisk: 0,
        publishMinScore: 0.9,
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
      });
      const concentrationOnly = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 90_000, wallets: 1 }),
            NO: side("NO", { usd: 0, wallets: 0 }),
          },
          holders: [holder("YES", { positionUsd: 85_000 })],
          yesProbability: 0.7,
        }),
        p,
      ).filter((candidate) => candidate.bucket === "concentration_risk");
      assert.equal(concentrationOnly.length, 1);
      const selected = selectHolderResearchCandidates(concentrationOnly, p);
      assert.equal(selected.selected.length, 0);
    },
  },
  {
    name: "external search input is redacted but keeps public market context",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          marketDescription:
            "This market resolves Yes if the official public dataset reaches the threshold before the deadline.",
          resolutionSource: "Official public dataset",
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              address: "0xabc",
              ownerAddress: "0xowner",
              walletUsdLikeBalance: 50_000,
              ownerUsdLikeBalance: 75_000,
              relatedOpenPositions: [
                {
                  marketId: "polymarket:other",
                  marketTitle: "Other hidden bet",
                  eventTitle: "Other event",
                  side: "NO",
                  positionUsd: 12_000,
                  yesProbability: 0.4,
                  snapshotAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
                },
              ],
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const externalInput = buildHolderResearchExternalSearchInput(candidate);
      const serializedExternal = JSON.stringify(externalInput);
      assert.match(
        serializedExternal,
        /official public dataset reaches the threshold/i,
      );
      assert.match(serializedExternal, /Official public dataset/);
      assert.doesNotMatch(serializedExternal, /0xabc/i);
      assert.doesNotMatch(serializedExternal, /0xowner/i);
      assert.doesNotMatch(serializedExternal, /walletId/i);
      assert.doesNotMatch(serializedExternal, /walletUsdLikeBalance/i);
      assert.doesNotMatch(serializedExternal, /ownerUsdLikeBalance/i);
      assert.doesNotMatch(serializedExternal, /Other hidden bet/i);

      const internalInput = buildHolderResearchCandidatePromptJson(candidate);
      const serializedInternal = JSON.stringify(internalInput);
      assert.match(serializedInternal, /0xabc/i);
      assert.match(serializedInternal, /0xowner/i);
      assert.match(serializedInternal, /walletUsdLikeBalance/i);
      assert.match(serializedInternal, /Other hidden bet/i);
    },
  },
  {
    name: "decision snapshot ignores balance-only noise",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const previous = buildHolderResearchDecisionSnapshot(candidate);
      const balanceOnly = {
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            walletUsdLikeBalance: (entry.walletUsdLikeBalance ?? 0) + 1_000_000,
            ownerUsdLikeBalance: (entry.ownerUsdLikeBalance ?? 0) + 1_000_000,
          })),
        },
      };
      const current = buildHolderResearchDecisionSnapshot(balanceOnly);
      assert.deepEqual(
        diffHolderResearchDecisionSnapshots(previous, current, p),
        [],
      );
    },
  },
  {
    name: "meaningful delta rules detect odds, exposure, holder, flow, and related-position changes",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const previous = buildHolderResearchDecisionSnapshot(candidate);

      const oddsMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: { ...candidate.market, yesProbability: 0.6 },
      });
      assert.deepEqual(
        diffHolderResearchDecisionSnapshots(previous, oddsMoved, p),
        ["odds_move"],
      );

      const sideMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          sides: {
            ...candidate.market.sides,
            NO: { ...candidate.market.sides.NO, usd: 57_000 },
          },
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, sideMoved, p).includes(
          "side_exposure_move:NO",
        ),
      );

      const holderMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            positionUsd: entry.positionUsd + 5_000,
          })),
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, holderMoved, p).includes(
          "holder_position_move:NO",
        ),
      );

      const freshFlow = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          recentActivityUsd: p.minRecentActivityUsd,
          recentActivityAt: "2026-01-01T01:00:00.000Z",
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(
          previous,
          freshFlow,
          p,
          "2026-01-01T00:00:00.000Z",
        ).includes("fresh_flow"),
      );

      const relatedMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            relatedOpenPositions: [
              {
                marketId: "polymarket:related",
                marketTitle: "Related market",
                eventTitle: "Related event",
                side: "YES",
                positionUsd: p.minHolderPositionUsd,
                yesProbability: 0.4,
                snapshotAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          })),
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, relatedMoved, p).includes(
          "related_position_changed",
        ),
      );
    },
  },
  {
    name: "decision cache suppresses skip/context before cooldown and bypasses on delta or force",
    run: () => {
      const p = policy({
        skipCooldownHours: 12,
        contextCooldownHours: 6,
        forceRecheckAfterHours: 48,
      });
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const checkedAt = new Date("2026-01-01T00:00:00.000Z");
      const cachedSkip = buildHolderResearchDecisionCacheRecord({
        candidate,
        output: { status: "SKIP", rationale: "Weak evidence." },
        model: p.model,
        policy: p,
        now: checkedAt,
      });
      const beforeCooldown = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(beforeCooldown.action, "skip");
      assert.equal(beforeCooldown.reason, "decision_cache");

      const movedCandidate = {
        ...candidate,
        market: { ...candidate.market, yesProbability: 0.61 },
      };
      const delta = evaluateHolderResearchDecisionCache({
        candidate: movedCandidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(delta.action, "analyze");
      assert.equal(delta.reason, "meaningful_delta");
      assert.deepEqual(delta.meaningfulDeltaReasons, ["odds_move"]);

      const forced = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-03T01:00:00.000Z"),
      });
      assert.equal(forced.action, "analyze");
      assert.equal(forced.reason, "force_recheck");

      const cachedContext = buildHolderResearchDecisionCacheRecord({
        candidate,
        output: { status: "CONTEXT", rationale: "Useful context only." },
        model: p.model,
        policy: p,
        now: checkedAt,
      });
      const contextBeforeCooldown = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedContext,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(contextBeforeCooldown.action, "skip");
      assert.equal(contextBeforeCooldown.cachedStatus, "CONTEXT");
    },
  },
  {
    name: "holder research wallet targets come from selected holder evidence",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000011",
              positionUsd: 12_345,
              openPnlUsd: -123,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000012",
              positionUsd: 54_321,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "market:polymarket:test-market",
        "holder:00000000-0000-4000-8000-000000000011:YES",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(
        targets[0]?.walletId,
        "00000000-0000-4000-8000-000000000011",
      );
      assert.equal(targets[0]?.rank, 10);
      assert.equal(targets[0]?.meta.side, "YES");
      assert.equal(targets[0]?.meta.positionUsd, 12_345);
      assert.equal(targets[0]?.meta.openPnlUsd, -123);
    },
  },
  {
    name: "holder research wallet targets fall back to strongest candidate holder",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 12_000,
              bestEdge: 0.18,
              bestZScore: 2.2,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000021",
              positionUsd: 12_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000022",
              positionUsd: 60_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "market:polymarket:test-market",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(
        targets[0]?.walletId,
        "00000000-0000-4000-8000-000000000021",
      );
      assert.equal(targets[0]?.meta.side, "YES");
    },
  },
  {
    name: "holder research signal schemas accept wallet scope and batch wallet notes",
    run: () => {
      const query = signalsQuerySchema.parse({
        scope: "wallet",
        targetId: "00000000-0000-4000-8000-000000000001",
        includeTraders: "true",
        traderLimit: "2",
      });
      assert.equal(query.scope, "wallet");
      assert.equal(query.includeTraders, true);
      assert.equal(query.traderLimit, 2);

      const body = holderResearchWalletNotesBodySchema.parse({
        walletIds: ["00000000-0000-4000-8000-000000000001"],
        limitPerWallet: 0,
        compact: "true",
      });
      assert.deepEqual(body.walletIds, [
        "00000000-0000-4000-8000-000000000001",
      ]);
      assert.equal(body.limitPerWallet, 0);
      assert.equal(body.compact, true);
    },
  },
  {
    name: "deterministic decision emits strict holder research json",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const decision = buildDeterministicHolderResearchDecision(candidate, p);
      const parsed = holderResearchAgentOutputV1Schema.parse(decision);
      assert.equal(parsed.version, "holder_research_v1");
      assert.equal(parsed.status, "PUBLISH");
      assert.equal(parsed.evidence_ids.length > 0, true);
    },
  },
  {
    name: "model output parser repairs minor strict-json drift",
    run: () => {
      const parsed = parseHolderResearchAgentOutputV1({
        version: "holder_research_v1",
        status: "CONTEXT",
        bucket: "sharp_side",
        confidence: 0.7,
        signal_type: "update",
        direction: "mixed",
        headline: "Sharp holder context",
        summary:
          "A sharp holder signal exists, but this test intentionally keeps the body compact.",
        rationale: "x".repeat(600),
        evidence_ids: ["market:1"],
        caveats:
          "No public context found; this may be private information or noise.",
        extra: "ignored",
      });
      assert.equal(parsed.rationale.length <= 260, true);
      assert.deepEqual(parsed.caveats, [
        "No public context found; this may be private information or noise.",
      ]);
    },
  },
  {
    name: "holder research policy is a separate runtime policy with external search budget",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000099",
              policy_key: "holder_research",
              effective_at: new Date("2026-01-02T00:00:00.000Z"),
              payload: {
                enabled: true,
                dryRun: "false",
                externalSearchEnabled: "true",
                maxExternalSearchCallsPerRun: 5,
                externalSearchMinScore: 0.8,
                maxAgentCallsPerRun: 100,
                maxOutputTokens: 1,
              },
              created_by: null,
              created_at: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "holder_research");
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.enabled, true);
      assert.equal(resolved.effective.dryRun, false);
      assert.equal(resolved.effective.externalSearchEnabled, true);
      assert.equal(resolved.effective.maxExternalSearchCallsPerRun, 5);
      assert.equal(resolved.effective.externalSearchMinScore, 0.8);
      assert.equal(resolved.effective.maxAgentCallsPerRun, 100);
      assert.equal(resolved.effective.maxOutputTokens, 100);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[holder-research-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[holder-research-tests] passed ${passed}/${tests.length}`);
