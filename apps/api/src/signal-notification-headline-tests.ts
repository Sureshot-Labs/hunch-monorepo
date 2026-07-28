import assert from "node:assert/strict";

import type { SignalEvidenceMetricV1 } from "./services/holder-research-signal-evidence.js";
import { buildMarketSideCopy } from "./services/market-side-copy.js";
import { buildSignalBotStructuredNarrative } from "./services/signal-bot-editorial-copy.js";
import {
  buildSignalNotificationHeadline,
  buildSignalNotificationSubject,
  isSignalNotificationSubjectComplete,
} from "./services/signal-notification-headline.js";
import {
  normalizeTelegramPresentationAliases,
  resolveTelegramMarketPresentation,
} from "./services/telegram-market-presentation.js";

function subject(input: {
  eventTitle?: string;
  marketTitle?: string;
  outcomes?: unknown;
  side?: "NO" | "YES";
}) {
  const side = input.side ?? "YES";
  const sideCopy = buildMarketSideCopy({
    eventTitle: input.eventTitle,
    marketTitle: input.marketTitle,
    outcomes: input.outcomes,
    side,
  });
  return buildSignalNotificationSubject({
    eventTitle: input.eventTitle,
    marketTitle: input.marketTitle,
    side,
    sideCopy,
  });
}

function trackRecordEvidence(value: number): SignalEvidenceMetricV1[] {
  return [
    {
      asOf: "2026-07-27T00:00:00.000Z",
      context: null,
      horizonDays: 30,
      id: "representative_wallet:track_record:30d",
      kind: "track_record",
      measurement: { kind: "scalar", unit: "usd", value },
      quality: "verified",
      sampleSize: null,
      scope: "representative_wallet",
      source: {
        kind: "hunch_wallet_intel",
        label: "Representative wallet",
        url: null,
      },
    },
  ];
}

const tests: Array<{ name: string; run: () => void }> = [
  {
    name: "approved presentation normalizes exact esports aliases",
    run: () => {
      const resolved = resolveTelegramMarketPresentation({
        eventTitle: "League of Legends winner",
        marketTitle: "Bilibili Gaming",
        metadata: {
          hunch: {
            telegramPresentationV1: {
              version: 1,
              reviewStatus: "approved",
              subject: "League of Legends winner",
              predicate: "Bilibili Gaming wins",
              threshold: null,
              deadline: "December 31",
              positions: {
                YES: {
                  canonicalLabel: "Bilibili Gaming",
                  shortLabel: "Bilibili Gaming",
                  aliases: ["BGL", "BLG"],
                },
                NO: {
                  canonicalLabel: "NO on Bilibili Gaming",
                  shortLabel: "NO",
                  aliases: [],
                },
              },
              provenance: {
                reviewedBy: "00000000-0000-4000-8000-000000000001",
                reviewedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        },
      });
      assert.equal(resolved.presentation.source, "approved_override");
      assert.equal(
        normalizeTelegramPresentationAliases(
          "BLG added while BGL remains quoted.",
          resolved.presentation,
        ),
        "Bilibili Gaming added while Bilibili Gaming remains quoted.",
      );
    },
  },
  {
    name: "total aliases are idempotent and public titles drop service suffixes",
    run: () => {
      const resolved = resolveTelegramMarketPresentation({
        eventTitle: "Spain vs. Argentina - More Markets",
        marketTitle: "O/U 2.5 total goals",
        outcomes: ["Over", "Under"],
      });
      const once = normalizeTelegramPresentationAliases(
        "Under 2.5 total goals trades near 59c.",
        resolved.presentation,
      );
      const twice = normalizeTelegramPresentationAliases(
        once,
        resolved.presentation,
      );
      assert.equal(once, "Under 2.5 total goals trades near 59c.");
      assert.equal(twice, once);
      assert.equal(resolved.presentation.subject, "Spain vs. Argentina");
    },
  },
  {
    name: "conflicting approved aliases fail closed to raw proposition",
    run: () => {
      const resolved = resolveTelegramMarketPresentation({
        eventTitle: "World Cup winner",
        marketTitle: "Spain",
        metadata: {
          hunch: {
            telegramPresentationV1: {
              version: 1,
              reviewStatus: "approved",
              subject: "World Cup winner",
              predicate: "Spain wins",
              threshold: null,
              deadline: null,
              positions: {
                YES: {
                  canonicalLabel: "Spain",
                  shortLabel: "Spain",
                  aliases: ["ESP"],
                },
                NO: {
                  canonicalLabel: "Field",
                  shortLabel: "Field",
                  aliases: ["ESP"],
                },
              },
              provenance: {
                reviewedBy: "00000000-0000-4000-8000-000000000001",
                reviewedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        },
      });
      assert.equal(resolved.presentation.source, "safe_fallback");
      assert.deepEqual(resolved.diagnostics, [
        "alias_conflict",
        "safe_fallback",
      ]);
      assert.equal(
        resolved.presentation.positions.NO.canonicalLabel,
        "NO on Spain",
      );
    },
  },
  {
    name: "generic NO subjects do not invent a complementary proposition",
    run: () => {
      const result = subject({
        eventTitle: "World Cup Winner",
        marketTitle: "France",
        side: "NO",
      });
      assert.equal(result.text, "NO on France winning the World Cup");
      assert.equal(result.source, "natural_market_proposition");
      assert.doesNotMatch(result.text, /Field|not France/i);
      assert.doesNotMatch(result.text, / · /);
    },
  },
  {
    name: "team YES subjects describe the actual outcome instead of internal YES",
    run: () => {
      const result = subject({
        eventTitle: "World Cup Winner",
        marketTitle: "Spain",
        side: "YES",
      });
      assert.equal(result.text, "Spain to win the World Cup");
      assert.doesNotMatch(result.text, /\bYES\b/);
    },
  },
  {
    name: "award markets read as human propositions and incomplete NO subjects fail",
    run: () => {
      const result = subject({
        eventTitle: "World Cup: Golden Boot Winner",
        marketTitle: "Will Lionel Messi win?",
        side: "NO",
      });
      assert.equal(
        result.text,
        "NO on Lionel Messi winning the Golden Boot at the World Cup",
      );
      assert.equal(
        isSignalNotificationSubjectComplete(result.text, "NO"),
        true,
      );
      assert.equal(
        isSignalNotificationSubjectComplete("NO on Argentina", "NO"),
        false,
      );
    },
  },
  {
    name: "explicit total outcomes preserve the threshold",
    run: () => {
      const result = subject({
        eventTitle: "Portugal vs Spain",
        marketTitle: "O/U 2.5 total goals",
        outcomes: ["Over", "Under"],
        side: "NO",
      });
      assert.equal(result.text, "Under 2.5 total goals in Portugal vs Spain");
      assert.equal(result.preservedFields.includes("threshold"), true);
    },
  },
  {
    name: "resolution outranks every other story",
    run: () => {
      const result = buildSignalNotificationHeadline({
        cooling: true,
        currentPrice: 1,
        joinedWallets: 5,
        kind: "resolved_win",
        netCopyFlowUsd: -4_000,
        priceMoveCents: 20,
        subject: subject({ marketTitle: "Will it happen?" }),
      });
      assert.equal(result.storyKind, "resolved_win");
      assert.equal(result.emoji, "🏁");
      assert.match(result.hook, / won\.$/);
      assert.equal(result.continuation, null);
    },
  },
  {
    name: "cooling outranks price and flow",
    run: () => {
      const result = buildSignalNotificationHeadline({
        cooling: true,
        currentPrice: 0.7,
        kind: "stats",
        netCopyFlowUsd: -3_000,
        priceMoveCents: 15,
        subject: subject({ marketTitle: "Will it happen?" }),
      });
      assert.equal(result.storyKind, "cooling");
      assert.match(result.text, /^⚠️ \$3K sold\./);
      assert.equal(result.primaryMetric, "-$3K");
    },
  },
  {
    name: "opposed price and inflow produce divergence",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.45,
        kind: "stats",
        netCopyFlowUsd: 2_500,
        priceMoveCents: -3,
        subject: subject({ marketTitle: "Will it happen?" }),
      });
      assert.equal(result.storyKind, "divergence");
      assert.equal(result.emoji, "📈");
      assert.equal(result.hook, "+$2.5K bought. −3¢ anyway.");
      assert.match(
        result.continuation ?? "",
        /moved against large-wallet buying/,
      );
    },
  },
  {
    name: "rate-move divergence reads naturally in a notification",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.83,
        kind: "stats",
        netCopyFlowUsd: 352_000,
        priceMoveCents: -10,
        subject: subject({ marketTitle: "25 bps increase", side: "NO" }),
      });
      assert.equal(
        result.text,
        "📈 +$352K bought. −10¢ anyway. NO on a 25 bps increase moved against large-wallet buying.",
      );
    },
  },
  {
    name: "price moves put signed whole cents before the market explanation",
    run: () => {
      const cases = [10, 5, 2, -10, -5, -2];
      for (const testCase of cases) {
        const result = buildSignalNotificationHeadline({
          currentPrice: 0.51,
          kind: "stats",
          priceMoveCents: testCase,
          subject: subject({ marketTitle: "Will it happen?" }),
        });
        assert.equal(result.storyKind, "price_move");
        assert.equal(
          result.hook,
          `${testCase > 0 ? "+" : "−"}${Math.abs(testCase)}¢ to 51¢.`,
        );
        assert.equal(result.emoji, testCase > 0 ? "📈" : "📉");
      }
    },
  },
  {
    name: "sub-two-cent moves yield to flow and participation",
    run: () => {
      const flow = buildSignalNotificationHeadline({
        currentPrice: 0.51,
        joinedWallets: 4,
        kind: "stats",
        netCopyFlowUsd: 1_200,
        priceMoveCents: 1.9,
        subject: subject({ marketTitle: "Will it happen?" }),
      });
      assert.equal(flow.storyKind, "flow");
      assert.doesNotMatch(flow.text, /edges/);

      const participation = buildSignalNotificationHeadline({
        currentPrice: 0.51,
        joinedWallets: 4,
        kind: "stats",
        priceMoveCents: 1,
        subject: subject({ marketTitle: "Will it happen?" }),
      });
      assert.equal(participation.storyKind, "participation");
    },
  },
  {
    name: "initial and research update copy remain deterministic",
    run: () => {
      const marketSubject = subject({ marketTitle: "Will it happen?" });
      const initial = buildSignalNotificationHeadline({
        currentPrice: 0.32,
        kind: "initial",
        subject: marketSubject,
      });
      const update = buildSignalNotificationHeadline({
        currentPrice: 0.32,
        kind: "research_update",
        researchDelta: {
          currentPrice: 0.4,
          kind: "price_move",
          priceMoveCents: 8,
        },
        subject: marketSubject,
      });
      assert.match(initial.text, /^👀 /);
      assert.equal(
        update.text,
        "📈 +8¢ to 40¢. Will it happen? · YES moved with the call.",
      );
      assert.equal(update.primaryMetric, "+8¢");
      assert.equal(update.supportingMetric, "40¢");
      assert.equal(update.templateKey, "research_price_move_v7");

      const updateWithoutPosition = buildSignalNotificationHeadline({
        currentPrice: 0.32,
        kind: "research_update",
        subject: marketSubject,
      });
      assert.equal(
        updateWithoutPosition.text,
        "🔎 New research. Will it happen? · YES",
      );
      assert.equal(
        updateWithoutPosition.templateKey,
        "research_update_suppressed_v7",
      );
    },
  },
  {
    name: "editorial initial headlines choose the strongest human tension",
    run: () => {
      const cases = [
        {
          expected:
            "🪙 Ethereum has just a 16% chance of hitting $1K. A trader up $67K is still betting on it.",
          input: {
            actorMode: "single_holder" as const,
            actorOpenPnlUsd: -8_100,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 67_100,
            actorVolumeUsd: 539_500,
            currentPrice: 0.16,
            editorialProbability: 0.16,
            editorialSubject: "ETH hitting $1K before 2027",
            holderPositionUsd: 53_200,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 0,
            subject: subject({ marketTitle: "Will Ethereum hit $1,000?" }),
          },
        },
        {
          expected:
            "🏆 Most tracked money is against England. Three profitable wallets are holding $277K on the other side.",
          input: {
            actorMode: "sharp_cluster" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 644_100,
            currentPrice: 0.22,
            editorialProbability: 0.22,
            editorialSubject: "England to win the World Cup",
            holderPositionUsd: 277_000,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 3,
            subject: subject({
              eventTitle: "World Cup Winner",
              marketTitle: "England",
            }),
            trackedMoneyOpposes: true,
          },
        },
        {
          expected:
            "🏆 Argentina has just a 17% chance of winning the World Cup. Four wallets up nearly $1M are still backing Argentina.",
          input: {
            actorMode: "sharp_cluster" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 967_800,
            currentPrice: 0.17,
            editorialProbability: 0.17,
            editorialSubject: "Argentina to win the World Cup",
            holderPositionUsd: 66_000,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 4,
            subject: subject({
              eventTitle: "World Cup Winner",
              marketTitle: "Argentina",
            }),
            trackedMoneyOpposes: true,
          },
        },
        {
          expected:
            "⚽ France is the favorite. Two wallets up $251K are taking Spain instead.",
          input: {
            actorMode: "sharp_cluster" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 250_800,
            currentPrice: 0.41,
            editorialProbability: 0.41,
            editorialSubject: "Spain over France",
            holderPositionUsd: 20_200,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 2,
            subject: subject({
              eventTitle: "Spain vs France",
              marketTitle: "Spain",
            }),
            trackedMoneyOpposes: true,
          },
        },
        {
          expected:
            "🐋 A trader up $168K has built a $305K position. It is betting on France to win the World Cup.",
          input: {
            actorMode: "single_holder" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 168_300,
            actorVolumeUsd: 1_200_000,
            currentPrice: 0.39,
            editorialProbability: 0.39,
            editorialSubject: "France to win the World Cup",
            holderPositionUsd: 305_000,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 0,
            subject: subject({
              eventTitle: "World Cup Winner",
              marketTitle: "France",
            }),
            trackedMoneyOpposes: true,
          },
        },
        {
          expected:
            "🌐 A U.S. invasion of Iran is priced at 20%. A trader up $44K is still betting on it.",
          input: {
            actorMode: "single_holder" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 43_700,
            currentPrice: 0.2,
            editorialProbability: 0.2,
            editorialSubject: "U.S. to invade Iran before 2027",
            holderPositionUsd: 32_500,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 0,
            subject: subject({
              marketTitle: "Will the U.S. invade Iran before 2027?",
            }),
            trackedMoneyOpposes: true,
          },
        },
        {
          expected:
            "⚽ Two wallets up $1.4M are down on France. Neither has backed away.",
          input: {
            actorMode: "sharp_cluster" as const,
            actorOpenPnlUsd: -3_900,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 1_400_000,
            currentPrice: 0.38,
            editorialProbability: 0.38,
            editorialSubject: "France over Spain",
            holderPositionUsd: 56_400,
            kind: "initial" as const,
            positionDirection: "backing" as const,
            strongWallets: 2,
            subject: subject({
              eventTitle: "France vs Spain",
              marketTitle: "France",
            }),
          },
        },
        {
          expected:
            "🔥 Messi has only an 8% chance of winning the Golden Boot. Two profitable wallets are betting against Messi.",
          input: {
            actorMode: "sharp_cluster" as const,
            actorPnlHorizonDays: 30,
            actorPnlUsd: 122_000,
            currentPrice: 0.92,
            editorialProbability: 0.08,
            editorialSubject: "Lionel Messi to win the Golden Boot",
            holderPositionUsd: 38_000,
            kind: "initial" as const,
            positionDirection: "against" as const,
            strongWallets: 2,
            subject: subject({
              eventTitle: "World Cup: Golden Boot Winner",
              marketTitle: "Will Lionel Messi win?",
              side: "NO",
            }),
          },
        },
      ];

      for (const testCase of cases) {
        assert.equal(
          buildSignalNotificationHeadline(testCase.input).text,
          testCase.expected,
        );
      }
    },
  },
  {
    name: "late-stage exits and adverse targets get editorial follow-up hooks",
    run: () => {
      const cashout = buildSignalNotificationHeadline({
        currentPrice: 0.99,
        earlyWalletsCut: 22,
        editorialSubject:
          "Kylian Mbappe to win the Golden Boot at the World Cup",
        kind: "stats",
        positionDirection: "backing",
        priceMoveCents: 50,
        subject: subject({
          eventTitle: "World Cup: Golden Boot Winner",
          marketTitle: "Will Kylian Mbappe win?",
        }),
      });
      assert.equal(
        cashout.text,
        "⚠️ 22 early wallets are cashing out. Mbappe reached 99¢ to win the Golden Boot.",
      );
      assert.equal(cashout.templateKey, "late_stage_early_wallet_cashout_v10");

      const resistance = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        currentPrice: 0.61,
        editorialSubject: "BTC hitting $67.5K in July",
        holderPositionUsd: 5_800,
        kind: "research_update",
        positionDirection: "against",
        researchDelta: {
          currentPrice: 0.61,
          kind: "price_move",
          priceMoveCents: -11,
        },
        subject: subject({
          eventTitle: "What price will Bitcoin hit in July?",
          marketTitle: "↑ 67,500",
          side: "NO",
        }),
      });
      assert.equal(
        resistance.text,
        "📉 Bitcoin is moving closer to $67.5K. This trader still refuses to flip.",
      );
    },
  },
  {
    name: "verified cluster performance outranks position size and consumes repeated proof",
    run: () => {
      const result = buildSignalNotificationHeadline({
        actorPnlEvidenceId: "cluster-pnl",
        actorPnlHorizonDays: 30,
        actorPnlUsd: 122_000,
        actorMode: "sharp_cluster",
        currentPrice: 0.92,
        holderPositionUsd: 38_000,
        kind: "initial",
        positionLabel:
          "NO on Lionel Messi winning the Golden Boot at the World Cup",
        strongWallets: 2,
        subject: subject({
          eventTitle: "World Cup: Golden Boot Winner",
          marketTitle: "Will Lionel Messi win?",
          side: "NO",
        }),
      });
      assert.equal(
        result.text,
        "👀 +$122K combined PnL in 30 days. 2 strong wallets have $38K against Lionel Messi winning the Golden Boot at the World Cup, with NO at 92¢.",
      );
      assert.deepEqual(result.evidenceKindsUsed, [
        "track_record",
        "conviction",
        "capital",
      ]);
      assert.equal(result.primaryEvidenceId, "cluster-pnl");
    },
  },
  {
    name: "large capital stays explicit without hiding mixed breadth",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.89,
        joinedWallets: 5,
        kind: "stats",
        netCopyFlowUsd: 67_700,
        priceMoveCents: 2,
        subject: subject({
          eventTitle: "What price will Bitcoin hit in July?",
          marketTitle: "↓ 57,500",
          side: "NO",
        }),
        trimmedWallets: 8,
      });
      assert.equal(result.storyKind, "divergence");
      assert.equal(
        result.text,
        "⚠️ +$67.7K bought. 8 wallets cut. Tracked wallets remain split on NO on BTC hitting $57.5K in July.",
      );
    },
  },
  {
    name: "research deltas preserve actor scope and current wallet count",
    run: () => {
      const marketSubject = subject({
        eventTitle: "World Cup Winner",
        marketTitle: "Spain",
        side: "YES",
      });
      const walletChange = buildSignalNotificationHeadline({
        currentPrice: 0.59,
        kind: "research_update",
        researchDelta: {
          afterWallets: 5,
          beforeWallets: 7,
          kind: "wallet_count_change",
          walletChange: -2,
        },
        subject: marketSubject,
      });
      assert.equal(
        walletChange.text,
        "⚠️ 2 fewer strong wallets. 5 remain. Strong-wallet support for Spain to win the World Cup has thinned.",
      );

      const positionChange = buildSignalNotificationHeadline({
        currentPrice: 0.59,
        kind: "research_update",
        positionLabel: "Under 2.5 total goals in Spain vs. Argentina",
        researchDelta: {
          afterUsd: 78_400,
          beforeUsd: 29_000,
          kind: "position_change",
          positionChangeUsd: 49_400,
          scope: "representative_wallet",
          walletId: "wallet-1",
        },
        subject: subject({
          eventTitle: "Spain vs. Argentina - More Markets",
          marketTitle: "O/U 2.5 total goals",
          outcomes: ["Over", "Under"],
          side: "NO",
        }),
      });
      assert.equal(
        positionChange.text,
        "💰 +$49.4K added. One trader increased their Under 2.5 total goals in Spain vs. Argentina position.",
      );
    },
  },
  {
    name: "profitable wallet add leads with credibility and states the action",
    run: () => {
      const result = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorPnlUsd: 107_700,
        currentPrice: 0.78,
        editorialProbability: 0.23,
        editorialSubject: "Bitcoin hitting $70K in July",
        kind: "research_update",
        positionDirection: "against",
        researchDelta: {
          afterUsd: 14_900,
          beforeUsd: 7_000,
          kind: "position_change",
          positionChangeUsd: 7_900,
          scope: "representative_wallet",
          walletId: "gmtrader",
        },
        subject: subject({
          eventTitle: "What price will Bitcoin hit in July?",
          marketTitle: "↑ 70,000",
          side: "NO",
        }),
      });
      assert.equal(result.templateKey, "research_profitable_wallet_added_v11");
      assert.equal(
        result.text,
        "💰 A trader up $108K just added to their bet that Bitcoin won't hit $70K in July.",
      );
    },
  },
  {
    name: "profitable wallet hold leads with live probability after the move",
    run: () => {
      const result = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorOpenPnlUsd: 2_100,
        actorPnlUsd: 111_800,
        currentPrice: 0.84,
        editorialProbability: 0.17,
        editorialSubject: "Bitcoin hitting $70K in July",
        holderPositionUsd: 16_100,
        kind: "research_update",
        positionDirection: "against",
        researchDelta: {
          currentPrice: 0.84,
          holderPositionState: "unchanged",
          kind: "price_move",
          priceMoveCents: 6,
        },
        subject: subject({
          eventTitle: "What price will Bitcoin hit in July?",
          marketTitle: "↑ 70,000",
          side: "NO",
        }),
      });
      assert.equal(
        result.templateKey,
        "research_profitable_price_target_hold_v12",
      );
      assert.equal(
        result.text,
        "📈 Bitcoin is now just 17% to hit $70K in July. A trader up $112K still hasn't taken profit.",
      );
    },
  },
  {
    name: "profitable trader hold turns a grouped ceasefire deadline into a FOMO headline",
    run: () => {
      const ceasefire = subject({
        eventTitle: "Israel x Iran ceasefire continues through...?",
        marketTitle: "July 31",
        side: "YES",
      });
      assert.equal(
        ceasefire.text,
        "Israel–Iran ceasefire lasting through July 31",
      );
      const result = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorOpenPnlUsd: 3_200,
        actorPnlUsd: 247_700,
        currentPrice: 0.94,
        editorialProbability: 0.94,
        editorialSubject: ceasefire.text,
        holderPositionUsd: 8_600,
        kind: "research_update",
        positionDirection: "backing",
        researchDelta: {
          currentPrice: 0.94,
          holderPositionState: "unchanged",
          kind: "price_move",
          priceMoveCents: 7,
        },
        subject: ceasefire,
      });
      assert.equal(result.templateKey, "research_profitable_trader_hold_v13");
      assert.equal(
        result.text,
        "📈 The Israel–Iran ceasefire is now 94% to last through July 31. A trader up $248K still hasn't taken profit.",
      );
    },
  },
  {
    name: "profitable price moves do not promote incomplete child labels into live hooks",
    run: () => {
      for (const market of [
        {
          eventTitle: "Will NATO and Russia clash?",
          marketTitle: "December 31",
        },
        {
          eventTitle: "Spain vs. Argentina - More Markets",
          marketTitle: "O/U 2.5 total goals",
          outcomes: ["Over", "Under"],
        },
      ]) {
        const marketSubject = subject({ ...market, side: "YES" });
        const result = buildSignalNotificationHeadline({
          actorMode: "single_holder",
          actorOpenPnlUsd: 3_200,
          actorPnlUsd: 247_700,
          currentPrice: 0.64,
          editorialProbability: 0.64,
          editorialSubject: marketSubject.text,
          holderPositionUsd: 8_600,
          kind: "research_update",
          positionDirection: "backing",
          researchDelta: {
            currentPrice: 0.64,
            holderPositionState: "unchanged",
            kind: "price_move",
            priceMoveCents: 7,
          },
          subject: marketSubject,
        });
        assert.equal(result.templateKey, "research_price_move_v7");
        assert.doesNotMatch(
          result.text,
          /December 31 is now priced|total goals is now priced/,
        );
        assert.match(result.text, /NATO and Russia|Spain vs\. Argentina/);
      }
    },
  },
  {
    name: "profitable hold wording follows proved position behavior",
    run: () => {
      const ceasefire = subject({
        eventTitle: "Israel x Iran ceasefire continues through...?",
        marketTitle: "July 31",
        side: "YES",
      });
      const headline = (
        holderPositionState: "increased" | "reduced" | "unchanged" | "unknown",
      ) =>
        buildSignalNotificationHeadline({
          actorMode: "single_holder",
          actorOpenPnlUsd: 3_200,
          actorPnlUsd: 247_700,
          currentPrice: 0.94,
          editorialProbability: 0.94,
          editorialSubject: ceasefire.text,
          holderPositionUsd: 8_600,
          kind: "research_update",
          positionDirection: "backing",
          researchDelta: {
            currentPrice: 0.94,
            holderPositionState,
            kind: "price_move",
            priceMoveCents: 7,
          },
          subject: ceasefire,
        }).text;
      assert.match(headline("unchanged"), /still hasn't taken profit/);
      assert.match(headline("reduced"), /has trimmed but is still holding YES/);
      assert.match(headline("increased"), /has added and is still holding YES/);
      assert.match(headline("unknown"), /is still holding YES/);

      const withoutPosition = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorOpenPnlUsd: 3_200,
        actorPnlUsd: 247_700,
        currentPrice: 0.94,
        editorialProbability: 0.94,
        editorialSubject: ceasefire.text,
        holderPositionUsd: 0,
        kind: "research_update",
        positionDirection: "backing",
        researchDelta: {
          currentPrice: 0.94,
          holderPositionState: "unknown",
          kind: "price_move",
          priceMoveCents: 7,
        },
        subject: ceasefire,
      });
      assert.equal(withoutPosition.templateKey, "research_price_move_v7");
      assert.doesNotMatch(
        withoutPosition.text,
        /hasn't taken profit|still holding/,
      );
    },
  },
  {
    name: "profitable trader holding through a loss leads with persistence",
    run: () => {
      const result = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorOpenPnlUsd: -1_100,
        actorPnlUsd: 247_100,
        currentPrice: 0.73,
        editorialProbability: 0.27,
        editorialSubject: "25 bps increase",
        holderPositionUsd: 10_500,
        kind: "research_update",
        positionDirection: "against",
        researchDelta: {
          currentPrice: 0.73,
          kind: "price_move",
          priceMoveCents: -7,
        },
        subject: subject({ marketTitle: "25 bps increase", side: "NO" }),
      });
      assert.equal(
        result.templateKey,
        "research_profitable_trader_underwater_v12",
      );
      assert.equal(
        result.text,
        "📉 The market turned against this trade. A trader up $247K still hasn't backed away.",
      );
    },
  },
  {
    name: "expensive favorite leads with wallet quality and capital at risk",
    run: () => {
      const result = buildSignalNotificationHeadline({
        actorMode: "single_holder",
        actorPnlUsd: 208_100,
        currentPrice: 0.94,
        editorialProbability: 0.94,
        editorialSubject: "Spirit over OG",
        holderPositionUsd: 27_100,
        kind: "initial",
        positionDirection: "backing",
        subject: subject({
          eventTitle: "Spirit vs OG",
          marketTitle: "Spirit",
          side: "YES",
        }),
      });
      assert.equal(result.templateKey, "initial_expensive_favorite_v11");
      assert.equal(
        result.text,
        "⚽ A trader up $208K is risking $27.1K on Spirit despite 94¢ odds.",
      );
    },
  },
  {
    name: "price and fresh buying lead with the market event, not raw deltas",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.3,
        editorialProbability: 0.3,
        editorialSubject: "a NATO–Russia clash",
        joinedWallets: 1,
        kind: "stats",
        netCopyFlowUsd: 9_000,
        positionDirection: "backing",
        priceMoveCents: 12,
        subject: subject({
          eventTitle: "Will NATO and Russia clash?",
          marketTitle: "December 31",
          side: "YES",
        }),
      });
      assert.equal(result.templateKey, "price_wallets_still_adding_v11");
      assert.equal(
        result.text,
        "📈 A NATO–Russia clash is now priced at 30%. Large wallets are still adding.",
      );
    },
  },
  {
    name: "manager scenarios render human prose without inventing evidence",
    run: () => {
      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.23,
          evidenceRows: trackRecordEvidence(107_700),
          headlineTemplateKey: "research_profitable_wallet_added_v11",
          marketLabel: "Bitcoin hitting $70K in July",
          messageKind: "research_update",
          note: {
            holderDisplayName: "gmtrader",
            holderIdentityDisplayName: "gmtrader",
            holderOpenPnlUsd: 1_200,
            holderPositionUsd: 14_900,
          },
          price: 0.78,
          researchDelta: {
            afterUsd: 14_900,
            kind: "position_change",
            positionChangeUsd: 7_900,
            scope: "representative_wallet",
          },
          side: "NO",
          sideLabel: "NO on BTC hitting $70K in July",
        }),
        [
          "Bitcoin hitting $70K in July is priced at 23%, but gmtrader has increased its NO position instead of taking profit.",
          "The trader is now holding $14.9K on NO, is sitting on +$1.2K open PnL, and has made $107.7K over the last 30 days.",
        ],
      );

      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.94,
          evidenceRows: trackRecordEvidence(247_700),
          headlineTemplateKey: "research_profitable_trader_hold_v13",
          marketLabel: "Israel–Iran ceasefire lasting through July 31",
          messageKind: "research_update",
          note: {
            holderDisplayName: null,
            holderIdentityDisplayName: null,
            holderOpenPnlUsd: 3_200,
            holderPositionUsd: 8_600,
          },
          price: 0.94,
          researchDelta: {
            holderPositionState: "unchanged",
            kind: "price_move",
            priceMoveCents: 7,
          },
          side: "YES",
          sideLabel: "YES",
        }),
        [
          "Since the original call, YES has climbed 7¢ to 94¢.",
          "Rather than locking in gains, the trader continues to hold $8.6K on YES, with +$3.2K in open profit after making $247.7K over the last 30 days.",
        ],
      );

      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.06,
          evidenceRows: trackRecordEvidence(247_700),
          headlineTemplateKey: "research_profitable_trader_hold_v13",
          marketLabel: "Israel–Iran ceasefire lasting through July 31",
          messageKind: "research_update",
          note: {
            holderDisplayName: null,
            holderIdentityDisplayName: null,
            holderOpenPnlUsd: 3_200,
            holderPositionUsd: 8_600,
          },
          price: 0.94,
          researchDelta: {
            holderPositionState: "unchanged",
            kind: "price_move",
            priceMoveCents: 7,
          },
          side: "NO",
          sideLabel: "NO",
        }),
        [
          "Since the original call, NO has climbed 7¢ to 94¢.",
          "Rather than locking in gains, the trader continues to hold $8.6K on NO, with +$3.2K in open profit after making $247.7K over the last 30 days.",
        ],
      );

      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.1,
          evidenceRows: trackRecordEvidence(88_800),
          headlineTemplateKey: "research_profitable_price_target_hold_v12",
          marketLabel: "Bitcoin hitting $67.5K in July",
          messageKind: "research_update",
          note: {
            holderDisplayName: "gmtrader",
            holderIdentityDisplayName: "gmtrader",
            holderOpenPnlUsd: 8_400,
            holderPositionUsd: 14_500,
          },
          price: 0.91,
          researchDelta: { kind: "price_move", priceMoveCents: 26 },
          side: "NO",
          sideLabel: "NO on BTC hitting $67.5K in July",
        }),
        [
          "The market has moved sharply in the trader's favor, with NO rising from 65¢ to 91¢ since the original call.",
          "Despite sitting on +$8.4K in open profit, gmtrader is still holding $14.5K on NO after making $88.8K over the last 30 days.",
        ],
      );

      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.27,
          evidenceRows: trackRecordEvidence(247_100),
          headlineTemplateKey: "research_profitable_trader_underwater_v12",
          marketLabel: "25 bps increase",
          messageKind: "research_update",
          note: {
            holderDisplayName: "charlatta",
            holderIdentityDisplayName: "charlatta",
            holderOpenPnlUsd: -1_100,
            holderPositionUsd: 10_500,
          },
          price: 0.73,
          researchDelta: { kind: "price_move", priceMoveCents: -7 },
          side: "NO",
          sideLabel: "NO",
        }),
        [
          "The probability of no 25 bps increase has dropped from 80¢ to 73¢, but charlatta continues to hold a $10.5K position despite being down $1.1K.",
          "After making $247.1K over the last 30 days, charlatta's continued conviction is what makes this position worth watching.",
        ],
      );

      assert.deepEqual(
        buildSignalBotStructuredNarrative({
          editorialProbability: 0.94,
          evidenceRows: trackRecordEvidence(208_100),
          headlineTemplateKey: "initial_expensive_favorite_v11",
          marketLabel: "Spirit over OG",
          messageKind: "initial",
          note: {
            holderDisplayName: "a trader",
            holderIdentityDisplayName: null,
            holderOpenPnlUsd: -773,
            holderPositionUsd: 27_100,
          },
          price: 0.94,
          researchDelta: null,
          side: "YES",
          sideLabel: "Spirit",
        }),
        [
          "Spirit is already a heavy favorite, but this trader has still built a $27.1K position while making $208.1K over the last 30 days.",
          "At 94¢, there is little room left for error, so risking $27.1K is a strong statement of conviction.",
        ],
      );
    },
  },
  {
    name: "even a small adverse move blocks positive-flow language",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.09,
        exitedWallets: 1,
        joinedWallets: 2,
        kind: "stats",
        netCopyFlowUsd: 345,
        priceMoveCents: -1,
        subject: subject({
          marketTitle: "Will the Iranian regime fall before 2027?",
        }),
        trimmedWallets: 2,
      });
      assert.equal(result.storyKind, "divergence");
      assert.equal(
        result.text,
        "📈 +$345 bought. −1¢ anyway. Will the Iranian regime fall before 2027? · YES moved against large-wallet buying.",
      );
      assert.doesNotMatch(result.text, /builds behind|backs/);
    },
  },
  {
    name: "strong price momentum outranks small copy flow",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.81,
        joinedWallets: 4,
        kind: "stats",
        netCopyFlowUsd: 1_300,
        priceMoveCents: 6,
        subject: subject({
          eventTitle: "What price will Bitcoin hit in July?",
          marketTitle: "↑ 70,000",
          side: "NO",
        }),
        trimmedWallets: 5,
      });
      assert.equal(result.storyKind, "price_move");
      assert.equal(
        result.text,
        "📈 +6¢ to 81¢. NO on BTC hitting $70K in July moved with the call.",
      );
    },
  },
  {
    name: "fire is reserved for capital and price confluence",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.62,
        joinedWallets: 6,
        kind: "stats",
        netCopyFlowUsd: 45_000,
        priceMoveCents: 7,
        subject: subject({ marketTitle: "Will it happen?" }),
        trimmedWallets: 2,
      });
      assert.equal(result.storyKind, "confluence");
      assert.equal(result.hook, "+$45K bought. +7¢.");
      assert.match(result.continuation ?? "", /moving with tracked wallets/);
    },
  },
  {
    name: "decisive price and capital confirmation outranks mixed participation",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.99,
        exitedWallets: 5,
        joinedWallets: 17,
        kind: "stats",
        netCopyFlowUsd: 1_000_000,
        priceMoveCents: 50,
        subject: subject({
          eventTitle: "World Cup: Golden Boot Winner",
          marketTitle: "Will Kylian Mbappe win?",
          side: "YES",
        }),
        trimmedWallets: 22,
      });
      assert.equal(result.storyKind, "confluence");
      assert.equal(result.emoji, "📈");
      assert.equal(
        result.text,
        "📈 +50¢ to 99¢. $1M flowed into Kylian Mbappe to win the Golden Boot at the World Cup after the call.",
      );
      assert.equal(result.templateKey, "dominant_price_capital_confluence_v9");
    },
  },
  {
    name: "long contract subjects are linted but never truncated",
    run: () => {
      const longTitle =
        "Will the international coalition complete every listed treaty obligation before December 31, 2028?";
      const marketSubject = subject({ marketTitle: longTitle, side: "NO" });
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.41,
        kind: "initial",
        subject: marketSubject,
      });
      assert.equal(result.lintExceeded, true);
      assert.match(result.text, /December 31, 2028/);
      assert.doesNotMatch(result.text, /…/);
    },
  },
  {
    name: "long divergence copy preserves both verified metrics and subject",
    run: () => {
      const longTitle =
        "Will the international coalition complete every listed treaty obligation before December 31, 2028?";
      const marketSubject = subject({ marketTitle: longTitle, side: "NO" });
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.41,
        kind: "stats",
        netCopyFlowUsd: 12_000,
        priceMoveCents: -3,
        subject: marketSubject,
      });
      assert.equal(result.storyKind, "divergence");
      assert.match(result.text, /December 31, 2028/);
      assert.match(result.hook, /\+\$12K bought\. −3¢ anyway\./);
      assert.equal(result.lintExceeded, true);
    },
  },
  {
    name: "visible length counts Unicode grapheme clusters",
    run: () => {
      const result = buildSignalNotificationHeadline({
        currentPrice: 0.5,
        kind: "initial",
        subject: subject({
          eventTitle: "🇵🇹 Portugal election",
          marketTitle: "Candidate João wins?",
        }),
      });
      const expected = Array.from(
        new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
          result.text,
        ),
      ).length;
      assert.equal(result.visibleLength, expected);
      assert.match(result.text, /🇵🇹/);
      assert.match(result.text, /João/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[signal-notification-headline-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(
  `[signal-notification-headline-tests] passed ${passed}/${tests.length}`,
);
