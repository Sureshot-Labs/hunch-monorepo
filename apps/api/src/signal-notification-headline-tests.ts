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
      assert.match(result.text, /^🏁 .* wins$/);
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
      assert.match(result.text, /^⚠️ .* is losing wallet support$/);
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
      assert.match(result.text, /slips 3¢ despite \$2\.5K inflow$/);
    },
  },
  {
    name: "price bands use jumps rises and edges with whole-cent display",
    run: () => {
      const cases = [
        { move: 10, verb: "jumps" },
        { move: 5, verb: "rises" },
        { move: 2, verb: "edges up" },
        { move: -10, verb: "drops" },
        { move: -5, verb: "falls" },
        { move: -2, verb: "edges down" },
      ];
      for (const testCase of cases) {
        const result = buildSignalNotificationHeadline({
          currentPrice: 0.51,
          kind: "stats",
          priceMoveCents: testCase.move,
          subject: subject({ marketTitle: "Will it happen?" }),
        });
        assert.equal(result.storyKind, "price_move");
        assert.match(result.text, new RegExp(`${testCase.verb} .* to 51¢$`));
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
      assert.equal(update.text, "📈 Will it happen? · YES rises 8¢ to 40¢");
      assert.equal(update.primaryMetric, "8¢");
      assert.equal(update.supportingMetric, "40¢");
      assert.equal(update.templateKey, "research_price_move_v5");

      const updateWithoutPosition = buildSignalNotificationHeadline({
        currentPrice: 0.32,
        kind: "research_update",
        subject: marketSubject,
      });
      assert.equal(
        updateWithoutPosition.text,
        "🔎 Update: Will it happen? · YES",
      );
      assert.equal(
        updateWithoutPosition.templateKey,
        "research_update_suppressed_v5",
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
        "⚠️ $67.7K enters NO on BTC hitting $57.5K in July, but wallet support is mixed",
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
        "⚠️ Will the Iranian regime fall before 2027? · YES slips 1¢ despite $345 inflow",
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
        "📈 NO on BTC hitting $70K in July rises 6¢ to 81¢",
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
      assert.match(result.text, /^🔥 \$45K backs .* after a 7¢ move$/);
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
    name: "long divergence copy drops only its supporting clause",
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
      assert.match(result.text, /slips 3¢$/);
      assert.doesNotMatch(result.text, /despite/);
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
