import assert from "node:assert/strict";

import { buildMarketSideCopy } from "./services/market-side-copy.js";
import {
  buildSignalNotificationHeadline,
  buildSignalNotificationSubject,
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
      assert.equal(result.text, "NO on France winning World Cup");
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
      assert.equal(result.emoji, "📉");
      assert.equal(result.hook, "+$2.5K bought. −3¢ anyway.");
      assert.match(result.continuation ?? "", /moved against tracked flow/);
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
        "📉 +$345 bought. −1¢ anyway. Will the Iranian regime fall before 2027? · YES moved against tracked flow.",
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
