import assert from "node:assert/strict";

import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchTriageSystemPrompt,
  buildHolderResearchTriageUserPrompt,
  holderResearchAgentOutputV1Schema,
  parseHolderResearchAgentOutputV1,
  parseHolderResearchTriageOutputV1,
  type HolderResearchAgentOutputV1,
} from "./schemas/holder-research.js";
import {
  parseHolderResearchRunArgs,
  parseHolderResearchTriageModelContent,
  selectHolderResearchTriageFallbackCandidates,
} from "./ai-holder-research-run.js";
import {
  holderResearchWalletNotesBodySchema,
  signalsQuerySchema,
} from "./schemas/signals.js";
import {
  applyHolderResearchPublishQualityGate,
  buildHolderResearchActorSummary,
  buildDeterministicHolderResearchDecision,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchDecisionSnapshot,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchTriageCandidatePromptJson,
  buildHolderResearchQualityAssessment,
  buildHolderResearchWalletTargets,
  diffHolderResearchDecisionSnapshots,
  evaluateResolvedHolderResearchNotes,
  evaluateHolderResearchDecisionCache,
  isSharpHolder,
  loadHolderResearchCandidateMarkets,
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
    positionShares: null,
    openPnlUsd: null,
    realizedPnlUsd: null,
    totalPnlUsd: null,
    avgEntryPrice: null,
    currentPrice: null,
    entryToCurrentDelta: null,
    approxReliable: null,
    approxPnlSource: null,
    positionSnapshotAt: null,
    pnl30dUsd: 2_500,
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
    marketMovementContext: {
      yesProbabilityNow: 0.55,
      yesChange24h: null,
      volume24h: 100_000,
      volumeChange24h: null,
      volumeChangePct24h: null,
      liquidity: 25_000,
      liquidityChange24h: null,
      liquidityChangePct24h: null,
      openInterestChange24h: null,
      openInterestChangePct24h: null,
      updatedAt: null,
      previousDecisionYesProbability: null,
      yesChangeSincePreviousDecision: null,
      previousDecisionCheckedAt: null,
    },
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

function publishOutput(
  candidate: ReturnType<typeof buildHolderResearchCandidatesFromMarket>[number],
  overrides: Partial<HolderResearchAgentOutputV1> = {},
): HolderResearchAgentOutputV1 {
  return {
    version: "holder_research_v1",
    status: "PUBLISH",
    bucket: candidate.bucket,
    confidence: 0.82,
    signal_type: candidate.signalType,
    direction: candidate.direction,
    headline: "Sharp holder signal",
    summary:
      "A capable holder side adds a concise directional read for this market.",
    rationale: "Holder evidence clears the publish quality gate.",
    evidence_ids: candidate.evidence.map((evidence) => evidence.id).slice(0, 3),
    caveats: [],
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: "holder research CLI parses triage overrides separately from synthesis budget",
    run: () => {
      const args = parseHolderResearchRunArgs([
        "--max-agent-calls=2",
        "--triage-batch-size=6",
        "--triage-max-batches=2",
      ]);
      assert.equal(args.maxAgentCalls, 2);
      assert.equal(args.triageBatchSize, 6);
      assert.equal(args.triageMaxBatches, 2);
    },
  },
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
    name: "holder research loader keeps holder 30d pnl",
    run: async () => {
      const p = policy();
      let querySql = "";
      let queryParams: unknown[] = [];
      const client = {
        query: async (sql: unknown, params?: unknown[]) => {
          querySql = String(sql ?? "");
          queryParams = Array.isArray(params) ? params : [];
          return {
            command: "SELECT",
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [
              {
                market_id: "polymarket:pnl-market",
                event_id: "polymarket:pnl-event",
                venue: "polymarket",
                market_title: "Pnl market",
                market_slug: null,
                market_description: null,
                event_title: "Pnl event",
                event_slug: null,
                event_description: null,
                series_key: null,
                series_title: null,
                resolution_source: null,
                category: null,
                close_time: null,
                expiration_time: null,
                best_bid: "0.30",
                best_ask: "0.32",
                last_price: null,
                volume_24h: null,
                liquidity: null,
                yes_usd: "0",
                no_usd: "25000",
                yes_wallets: "0",
                no_wallets: "1",
                yes_sharp_holders: "0",
                no_sharp_holders: "1",
                yes_sharp_usd: "0",
                no_sharp_usd: "25000",
                yes_best_edge: null,
                no_best_edge: "0.16",
                yes_best_z_score: null,
                no_best_z_score: "2.1",
                yes_best_sample_count: null,
                no_best_sample_count: "24",
                yes_best_resolved_stake_usd: null,
                no_best_resolved_stake_usd: "6000",
                yes_best_trades_30d: null,
                no_best_trades_30d: "18",
                largest_holder_usd: "25000",
                recent_activity_usd: "0",
                recent_activity_at: null,
                cross_market_wallet_count: "0",
                top_holders: [
                  {
                    address: "0xabc",
                    chain: "polygon",
                    label: null,
                    ownerAddress: null,
                    ownerUsdLikeBalance: null,
                    pnl30dUsd: 12_345,
                    positionUsd: 25_000,
                    resolvedEdgeSampleCount30d: 24,
                    resolvedEdgeZScore30d: 2.1,
                    resolvedStakeUsd30d: 6_000,
                    resolvedWinRateEdge30d: 0.16,
                    side: "NO",
                    trades30d: 18,
                    volume30dUsd: 90_000,
                    walletId: "00000000-0000-4000-8000-000000000061",
                    walletKind: "safe",
                    walletUsdLikeBalance: null,
                    winRate30d: 0.65,
                  },
                ],
              },
            ],
          };
        },
      };

      const markets = await loadHolderResearchCandidateMarkets(
        client as unknown as Parameters<
          typeof loadHolderResearchCandidateMarkets
        >[0],
        p,
      );
      assert.equal(markets[0]?.holders[0]?.pnl30dUsd, 12_345);
      assert.match(querySql, /candidate_wallets as materialized/);
      assert.match(querySql, /from wallet_intel_selector_snapshot sel/);
      assert.match(querySql, /join lateral/);
      assert.doesNotMatch(
        querySql,
        /from wallet_position_snapshots ws\s+where ws\.snapshot_at/s,
      );
      assert.equal(
        queryParams[10],
        Math.min(5_000, Math.max(1_000, p.maxCandidatePool * 25)),
      );
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
                  snapshotAt: new Date(
                    "2026-01-01T00:00:00.000Z",
                  ).toISOString(),
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
    name: "holder research follow-up reuses previous note holder target",
    run: () => {
      const p = policy();
      const yesWalletId = "00000000-0000-4000-8000-000000000031";
      const noWalletId = "00000000-0000-4000-8000-000000000032";
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("YES", {
              walletId: yesWalletId,
              positionUsd: 13_000,
            }),
            holder("NO", {
              walletId: noWalletId,
              positionUsd: 35_000_000,
            }),
          ],
          previousNote: {
            cooldownUntil: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputDigest: "previous",
            noteId: "00000000-0000-4000-8000-000000000099",
            title: "Previous YES holder note",
            walletTargets: [{ side: "YES", walletId: yesWalletId }],
          },
        }),
        p,
      ).find((item) => item.bucket === "followup_existing");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "note:00000000-0000-4000-8000-000000000099",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(targets[0]?.walletId, yesWalletId);
      assert.equal(targets[0]?.meta.side, "YES");
    },
  },
  {
    name: "holder research follow-up does not fall back to unrelated largest holder",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000041",
              positionUsd: 13_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000042",
              positionUsd: 35_000_000,
            }),
          ],
          previousNote: {
            cooldownUntil: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputDigest: "previous",
            noteId: "00000000-0000-4000-8000-000000000098",
            title: "Previous note without holder target",
            walletTargets: [],
          },
        }),
        p,
      ).find((item) => item.bucket === "followup_existing");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "note:00000000-0000-4000-8000-000000000098",
      ]);
      assert.equal(targets.length, 0);
    },
  },
  {
    name: "holder research quality gate keeps directional sharp signals publishable",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const output = publishOutput(candidate);
      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output,
        policy: p,
      });
      assert.equal(gated.status, "PUBLISH");
    },
  },
  {
    name: "holder research quality assessment classifies sports singles and contradicted credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Czechia vs. Mexico",
          marketTitle: "Mexico",
          closeTime: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 32_000,
              pnl30dUsd: -25_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const quality = buildHolderResearchQualityAssessment(candidate, p);
      assert.equal(quality.marketType, "single_game_sports");
      assert.equal(quality.credentialStrength, "contradicted");
      assert.equal(quality.actorStrength, "weak_single");
      assert.equal(quality.reasons.includes("negative_30d_pnl"), true);
    },
  },
  {
    name: "holder research quality assessment prioritizes explicit sports context",
    run: () => {
      const p = policy();
      const sportsSingle = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Iran vs. Russia",
          marketTitle: "Iran",
          closeTime: new Date(Date.now() + 3 * 3_600_000).toISOString(),
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(sportsSingle);
      assert.equal(
        buildHolderResearchQualityAssessment(sportsSingle, p).marketType,
        "single_game_sports",
      );

      const sportsOutright = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "World Cup Winner",
          marketTitle: "Ukraine",
          closeTime: new Date(Date.now() + 120 * 24 * 3_600_000).toISOString(),
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(sportsOutright);
      assert.equal(
        buildHolderResearchQualityAssessment(sportsOutright, p).marketType,
        "sports_outright",
      );

      const geo = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Politics",
          eventTitle: "Strait of Hormuz traffic returns to normal",
          marketTitle: "By July 31?",
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(geo);
      assert.equal(
        buildHolderResearchQualityAssessment(geo, p).marketType,
        "politics_geo",
      );
    },
  },
  {
    name: "holder research quality gate downgrades weak sports singles",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Morocco vs. Haiti",
          marketTitle: "Morocco",
          closeTime: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", { usd: 80_000, wallets: 4 }),
            NO: side("NO", {
              usd: 35_000,
              wallets: 1,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.1,
              bestZScore: 1.8,
              bestSampleCount: 12,
              bestResolvedStakeUsd: 2_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              positionUsd: 10_000,
              pnl30dUsd: -500,
              winRate30d: 0.6,
              resolvedWinRateEdge30d: 0.1,
              resolvedEdgeSampleCount30d: 12,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Single-game sports/);
    },
  },
  {
    name: "holder research quality gate allows exceptional sports singles and clusters",
    run: () => {
      const p = policy();
      const exceptional = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "South Africa vs. Korea Republic",
          marketTitle: "Korea Republic",
          closeTime: new Date(Date.now() + 4 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", { usd: 350_000, wallets: 5 }),
            NO: side("NO", {
              usd: 230_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 30_000,
              bestEdge: 0.19,
              bestZScore: 2.2,
              bestSampleCount: 22,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 310_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.19,
              resolvedEdgeSampleCount30d: 22,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(exceptional);
      assert.equal(
        applyHolderResearchPublishQualityGate({
          candidate: exceptional,
          output: publishOutput(exceptional),
          policy: p,
        }).status,
        "PUBLISH",
      );

      const cluster = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Apogee Esports vs OG",
          marketTitle: "Match Winner",
          closeTime: new Date(Date.now() + 1 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", {
              usd: 50_000,
              wallets: 3,
              sharpHolders: 2,
              sharpUsd: 35_000,
              bestEdge: 0.18,
              bestZScore: 2.3,
              bestSampleCount: 40,
              bestResolvedStakeUsd: 8_000,
              bestTrades30d: 20,
            }),
            NO: side("NO", { usd: 48_000, wallets: 3 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000071",
              positionUsd: 20_000,
              pnl30dUsd: 250_000,
            }),
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000072",
              positionUsd: 15_000,
              pnl30dUsd: 150_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(cluster);
      assert.equal(
        applyHolderResearchPublishQualityGate({
          candidate: cluster,
          output: publishOutput(cluster),
          policy: p,
        }).status,
        "PUBLISH",
      );
    },
  },
  {
    name: "holder research quality gate downgrades same-event sports conflicts",
    run: () => {
      const p = policy();
      const first = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:germany",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Germany",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:ecuador",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Ecuador",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(first);
      assert.ok(second);

      const gated = applyHolderResearchPublishQualityGate({
        candidate: first,
        output: publishOutput(first),
        policy: p,
        publishedRunDecisions: [
          {
            candidate: second,
            output: publishOutput(second),
          },
        ],
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Same-event sports/);
    },
  },
  {
    name: "holder research quality gate does not downgrade non-conflicting same-event sports",
    run: () => {
      const p = policy();
      const first = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:germany",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Germany",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:ecuador",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Ecuador",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", {
              usd: 70_000,
              wallets: 3,
              sharpHolders: 1,
              sharpUsd: 30_000,
              bestEdge: 0.18,
              bestZScore: 2.2,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 40_000, wallets: 2 }),
          },
          holders: [
            holder("YES", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(first);
      assert.ok(second);

      const gated = applyHolderResearchPublishQualityGate({
        candidate: first,
        output: publishOutput(first),
        policy: p,
        publishedRunDecisions: [
          {
            candidate: second,
            output: publishOutput(second),
          },
        ],
      });
      assert.equal(gated.status, "PUBLISH");
    },
  },
  {
    name: "holder research quality gate downgrades mixed publishes",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          recentActivityUsd: 50_000,
          recentActivityAt: "2026-01-01T00:00:00.000Z",
        }),
        p,
      ).find((item) => item.bucket === "recent_flow");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "mixed" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Mixed holder reads/);
    },
  },
  {
    name: "holder research quality gate downgrades non-actionable buckets",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "clean_disagreement");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "down" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /not a directional publish signal/);
    },
  },
  {
    name: "holder research quality gate downgrades side conflicts",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "up" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /did not match/);
    },
  },
  {
    name: "holder research actor summary uses plain-language credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "single_holder");
      assert.deepEqual(actor.credentialBullets.slice(0, 3), [
        "Up $2.5K over the last 30 days",
        "Won 65% of recent trades",
        "Beat market prices by 16 points on recent resolved bets",
      ]);
      assert.equal(
        actor.credentialBullets.some((bullet) =>
          /sample|n=|resolved edge/i.test(bullet),
        ),
        false,
      );
    },
  },
  {
    name: "holder research actor summary ignores non-positive pnl as profit",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("NO", {
              pnl30dUsd: -500,
              winRate30d: 0.5,
              resolvedWinRateEdge30d: 0.01,
              resolvedEdgeSampleCount30d: 24,
              volume30dUsd: 1_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "none");
      assert.equal(
        actor.credentialBullets.some((bullet) => /Up /i.test(bullet)),
        false,
      );
    },
  },
  {
    name: "holder research actor summary detects sharp clusters",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 120_000, wallets: 5 }),
            NO: side("NO", {
              usd: 45_000,
              wallets: 2,
              sharpHolders: 2,
              sharpUsd: 45_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000051",
              positionUsd: 25_000,
              pnl30dUsd: 10_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000052",
              positionUsd: 20_000,
              pnl30dUsd: 4_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "sharp_cluster");
      assert.equal(actor.cluster?.sharpHolders, 2);
      assert.equal(actor.cluster?.pnl30dUsd, 14_000);
      assert.deepEqual(actor.credentialBullets.slice(0, 2), [
        "Up $14.0K combined over the last 30 days",
        "2 strong wallets on the same side",
      ]);
    },
  },
  {
    name: "holder research actor summary omits incomplete cluster pnl",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 120_000, wallets: 5 }),
            NO: side("NO", {
              usd: 45_000,
              wallets: 3,
              sharpHolders: 3,
              sharpUsd: 45_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000061",
              positionUsd: 20_000,
              pnl30dUsd: 10_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000062",
              positionUsd: 15_000,
              pnl30dUsd: null,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000063",
              positionUsd: 10_000,
              pnl30dUsd: 4_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "sharp_cluster");
      assert.equal(actor.cluster?.sharpHolders, 3);
      assert.equal(actor.cluster?.pnl30dUsd, null);
      assert.deepEqual(actor.credentialBullets.slice(0, 2), [
        "3 strong wallets on the same side",
        "$45.0K tracked by sharp wallets",
      ]);
      assert.equal(
        actor.credentialBullets.some((bullet) => /combined/i.test(bullet)),
        false,
      );
    },
  },
  {
    name: "holder research quality gate downgrades sharp signals without credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("NO", {
              pnl30dUsd: 0,
              winRate30d: 0.5,
              resolvedWinRateEdge30d: 0.01,
              volume30dUsd: 90_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /No strong holder credential/);
    },
  },
  {
    name: "holder research prompt keeps credential facts out of summary copy",
    run: () => {
      const prompt = buildHolderResearchSystemPrompt();
      assert.match(prompt, /do not repeat the bullets verbatim/i);
      assert.match(prompt, /do not invent credentials/i);
      assert.match(prompt, /marketMovementContext/i);
      assert.match(prompt, /holderEntryContext/i);
    },
  },
  {
    name: "candidate prompt includes movement and holder entry context",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          yesProbability: 0.6,
          marketMovementContext: {
            ...market().marketMovementContext,
            yesProbabilityNow: 0.6,
            yesChange24h: 0.08,
            volumeChange24h: 50_000,
            liquidityChange24h: -2_000,
            openInterestChange24h: 15_000,
          },
          holders: [
            holder("NO", {
              avgEntryPrice: 0.3,
              currentPrice: 0.4,
              entryToCurrentDelta: 0.1,
              totalPnlUsd: 1_200,
              approxReliable: true,
              approxPnlSource: "activity",
              positionSnapshotAt: "2026-01-01T00:00:00.000Z",
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const promptJson = buildHolderResearchCandidatePromptJson(candidate, p);
      const record = promptJson as Record<string, unknown>;
      assert.equal(
        (record.quality as Record<string, unknown>).marketType,
        "politics_geo",
      );
      assert.deepEqual(
        (record.marketMovementContext as Record<string, unknown>).yesChange24h,
        0.08,
      );
      const entry = (
        record.holderEntryContext as Array<Record<string, unknown>>
      )[0];
      assert.equal(entry?.avgEntryPrice, 0.3);
      assert.equal(entry?.currentPrice, 0.4);
      assert.equal(entry?.entryToCurrentDelta, 0.1);
      assert.equal(entry?.approxReliable, true);
    },
  },
  {
    name: "triage prompt uses thin candidate context and parser rejects unknown keys",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const triageCandidate = buildHolderResearchTriageCandidatePromptJson(
        candidate,
        p,
      );
      const serialized = JSON.stringify(triageCandidate);
      assert.match(serialized, /marketMovementContext/);
      assert.match(serialized, /holderEntryContext/);
      assert.match(serialized, /quality/);
      assert.doesNotMatch(serialized, /0xno/i);
      const prompt = buildHolderResearchTriageUserPrompt({
        candidates: [triageCandidate],
        maxInvestigate: 1,
        calibrationMemo: ["Recent failed pattern: weak sports singles."],
      });
      assert.match(prompt, /holder_research_triage_v1/);
      assert.match(prompt, /Recent failed pattern/);
      assert.match(buildHolderResearchTriageSystemPrompt(), /investigate/);

      const parsed = parseHolderResearchTriageOutputV1(
        {
          version: "holder_research_triage_v1",
          decisions: [
            {
              key: candidate.key,
              action: "investigate",
              priority: 0.8,
              needs_external_search: true,
              reason: "Clear sharp holder read with movement context.",
            },
          ],
        },
        [candidate.key],
      );
      assert.equal(parsed.decisions[0]?.action, "investigate");
      const fenced = parseHolderResearchTriageModelContent(
        [
          "```json",
          JSON.stringify({
            version: "holder_research_triage_v1",
            decisions: [
              {
                key: candidate.key,
                action: "watch",
                priority: 0.4,
                needs_external_search: false,
                reason: "Interesting but not strong enough.",
              },
            ],
          }).replace(/}]}$/, "},]}"),
          "```",
        ].join("\n"),
        [candidate.key],
      );
      assert.equal(fenced.decisions[0]?.action, "watch");
      const truncated = parseHolderResearchTriageModelContent(
        `Here is JSON: {"version":"holder_research_triage_v1","decisions":[{"key":"${candidate.key}","action":"investigate","priority":0.91,"needs_external_search":true,"reason":"Clear sharp holder read."},{"key":"${candidate.key}","action":"watch"`,
        [candidate.key],
      );
      assert.equal(truncated.decisions.length, 1);
      assert.equal(truncated.decisions[0]?.action, "investigate");
      const ignoredIncomplete = parseHolderResearchTriageOutputV1(
        {
          version: "holder_research_triage_v1",
          decisions: [
            {
              key: candidate.key,
              action: "skip",
              reason: "Missing priority should be ignored.",
            },
            {
              key: candidate.key,
              action: "investigate",
              priority: 0.8,
              needs_external_search: true,
              reason: "Complete entry is kept.",
            },
          ],
        },
        [candidate.key],
      );
      assert.equal(ignoredIncomplete.decisions.length, 1);
      assert.equal(ignoredIncomplete.decisions[0]?.action, "investigate");
      assert.throws(() =>
        parseHolderResearchTriageOutputV1(
          {
            version: "holder_research_triage_v1",
            decisions: [
              {
                key: "unknown",
                action: "watch",
                priority: 0.5,
                needs_external_search: false,
                reason: "Unknown key.",
              },
            ],
          },
          [candidate.key],
        ),
      );
      assert.throws(() =>
        parseHolderResearchTriageModelContent(
          '{"version":"holder_research_triage_v1","decisions":[{"key":"unknown","action":"watch","priority":0.5,"needs_external_search":false,"reason":"Unknown key."}]}',
          [candidate.key],
        ),
      );
    },
  },
  {
    name: "triage fallback selects clear-side deterministic candidates",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const followup = {
        ...candidate,
        key: "holder_research:v1:followup:test:YES",
        bucket: "followup_existing" as const,
        score: candidate.score + 100,
        side: "YES" as const,
        direction: "up" as const,
      };
      const recentFlow = {
        ...candidate,
        key: "holder_research:v1:recent_flow:test:YES",
        bucket: "recent_flow" as const,
        score: candidate.score + 200,
        side: "YES" as const,
        direction: "up" as const,
      };
      const mixed = {
        ...candidate,
        key: "holder_research:v1:sharp_side:test:mixed",
        bucket: "sharp_side" as const,
        side: null,
        direction: "mixed" as const,
      };

      const selected = selectHolderResearchTriageFallbackCandidates(
        [recentFlow, followup, mixed, candidate],
        2,
      );
      assert.deepEqual(
        selected.map((item) => item.bucket),
        ["sharp_minority", "followup_existing"],
      );

      const excludedOnly = selectHolderResearchTriageFallbackCandidates(
        [recentFlow],
        1,
      );
      assert.equal(excludedOnly[0]?.bucket, "recent_flow");
      assert.equal(
        selectHolderResearchTriageFallbackCandidates([mixed], 1).length,
        0,
      );
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
    name: "resolved evaluator writes outcome metadata for closed holder notes",
    run: async () => {
      const p = policy();
      const updates: Array<Record<string, unknown>> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/select\s+n\.id\s+as\s+note_id/i.test(sql)) {
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000081",
                  direction: "down",
                  confidence: 0.74,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    market: { yesProbability: 0.52 },
                  },
                  model_meta: {
                    primary_holder_credentials: {
                      mode: "single_holder",
                      primaryHolder: {
                        positionUsd: 32_000,
                        pnl30dUsd: 120_000,
                        openPnlUsd: 1_000,
                      },
                    },
                  },
                  market_id: "polymarket:resolved",
                  market_title: "Mexico",
                  event_title: "Czechia vs. Mexico",
                  category: "Sports",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 0.999,
                  best_ask: 1,
                  last_price: 1,
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                },
              ],
            };
          }
          if (/update\s+ai_notes/i.test(sql)) {
            updates.push(JSON.parse(String(params?.[1])) as Record<string, unknown>);
            return { rows: [] };
          }
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      const stats = await evaluateResolvedHolderResearchNotes(db, p);
      assert.equal(stats.considered, 1);
      assert.equal(stats.evaluated, 1);
      assert.equal(stats.wrong, 1);
      assert.equal(updates[0]?.outcome, "wrong");
      assert.equal(updates[0]?.marketType, "single_game_sports");
      assert.equal(updates[0]?.sideAdjustedPriceDelta, -0.48);
    },
  },
  {
    name: "holder research policy is a separate runtime policy with external search budget",
    run: async () => {
      assert.equal(
        getIntelPolicyDefaults("holder_research").model,
        "openai/gpt-5.5",
      );

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
                triageEnabled: "true",
                triageBatchSize: 12,
                triageMaxBatchesPerRun: 3,
                triageMaxOutputTokens: 900,
                movementContextEnabled: "false",
                holderEntryContextEnabled: "false",
                minTriageInvestigatePriority: 0.7,
                qualityGateEnabled: "true",
                resolvedEvaluationEnabled: "true",
                resolvedEvaluationLookbackHours: 72,
                calibrationMemoEnabled: "false",
                singleGameSportsStrictMode: "true",
                singleGameSportsMinHolderUsd: 30_000,
                singleGameSportsMinEdge: 0.2,
                singleGameSportsMinSamples: 30,
                singleGameSportsMinWinRate: 0.7,
                singleGameSportsRequirePositivePnl: "false",
                priceAgainstSignalBlockPp: 0.08,
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
      assert.equal(resolved.defaults.maxOutputTokens, 2_000);
      assert.equal(resolved.defaults.model, "openai/gpt-5.5");
      assert.equal(resolved.effective.externalSearchEnabled, true);
      assert.equal(resolved.effective.maxExternalSearchCallsPerRun, 5);
      assert.equal(resolved.effective.externalSearchMinScore, 0.8);
      assert.equal(resolved.defaults.triageEnabled, true);
      assert.equal(resolved.defaults.triageBatchSize, 8);
      assert.equal(resolved.defaults.triageMaxOutputTokens, 2_000);
      assert.equal(resolved.effective.triageEnabled, true);
      assert.equal(resolved.effective.triageBatchSize, 12);
      assert.equal(resolved.effective.triageMaxBatchesPerRun, 3);
      assert.equal(resolved.effective.triageMaxOutputTokens, 900);
      assert.equal(resolved.effective.movementContextEnabled, false);
      assert.equal(resolved.effective.holderEntryContextEnabled, false);
      assert.equal(resolved.effective.minTriageInvestigatePriority, 0.7);
      assert.equal(resolved.defaults.qualityGateEnabled, true);
      assert.equal(resolved.defaults.resolvedEvaluationEnabled, true);
      assert.equal(resolved.effective.resolvedEvaluationLookbackHours, 72);
      assert.equal(resolved.effective.calibrationMemoEnabled, false);
      assert.equal(resolved.effective.singleGameSportsMinHolderUsd, 30_000);
      assert.equal(resolved.effective.singleGameSportsMinEdge, 0.2);
      assert.equal(resolved.effective.singleGameSportsMinSamples, 30);
      assert.equal(resolved.effective.singleGameSportsMinWinRate, 0.7);
      assert.equal(resolved.effective.singleGameSportsRequirePositivePnl, false);
      assert.equal(resolved.effective.priceAgainstSignalBlockPp, 0.08);
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
