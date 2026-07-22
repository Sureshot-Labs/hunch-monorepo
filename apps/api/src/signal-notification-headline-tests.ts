import assert from "node:assert/strict";

import { buildMarketSideCopy } from "./services/market-side-copy.js";
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
            "🪙 Ethereum has just a 16% chance of hitting $1K. A wallet up $67K is still betting on it.",
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
            "🐋 A wallet up $168K has built a $305K position. It is betting on France to win the World Cup.",
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
            "🌐 A U.S. invasion of Iran is priced at 20%. A wallet up $44K is still betting on it.",
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
        "📉 Bitcoin is moving closer to $67.5K. This wallet still refuses to flip.",
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
        "💰 +$49.4K added. One tracked wallet increased its Under 2.5 total goals in Spain vs. Argentina position.",
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
