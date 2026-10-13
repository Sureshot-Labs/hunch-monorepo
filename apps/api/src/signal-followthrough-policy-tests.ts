import assert from "node:assert/strict";
import {
  defaultSignalBotFollowthroughPolicy,
  mergeSignalBotFollowthroughPolicy,
} from "./services/signal-bot-followthrough-policy.js";
import {
  followthroughCursorKey,
  parseFollowthroughCursor,
} from "./services/signal-bot-followthrough-scan.js";
import {
  readFrozenPublicationEntry,
  buildSignalPublicationSnapshot,
} from "./services/signal-publication-snapshot.js";
import { holderResearchReportCategory } from "./services/holder-research-report-category.js";
import { buildEventPublicationHistory } from "./services/holder-research-event-publications.js";

const defaults = defaultSignalBotFollowthroughPolicy({});
assert.equal(defaults.enabled, true);
assert.equal(defaults.maxPerTick, 3);
assert.deepEqual(defaults.types, ["stats", "resolved_win"]);
assert.equal(defaults.terminalInitialCutoff, null);
for (const types of [
  [],
  ["stats"],
  ["resolved_win"],
  ["resolved_loss"],
  ["resolved_win", "resolved_loss"],
]) {
  assert.deepEqual(
    mergeSignalBotFollowthroughPolicy(defaults, {
      signalBotFollowthroughTypes: types,
    }).types,
    types,
  );
}
assert.equal(
  mergeSignalBotFollowthroughPolicy(defaults, {
    signalBotFollowthroughEnabled: false,
  }).enabled,
  false,
);
const dated = mergeSignalBotFollowthroughPolicy(defaults, {
  signalBotTerminalInitialCutoff: "2026-09-13T14:00:00Z",
});
assert.equal(dated.terminalInitialCutoff, "2026-09-13T14:00:00.000Z");
assert.equal(
  mergeSignalBotFollowthroughPolicy(dated, {
    signalBotTerminalInitialCutoff: null,
  }).terminalInitialCutoff,
  null,
);
const cursor = {
  sentAt: "2026-10-01 00:00:00.000123+00",
  id: "00000000-0000-4000-8000-000000000001",
};
assert.deepEqual(parseFollowthroughCursor(JSON.stringify(cursor)), cursor);
assert.equal(parseFollowthroughCursor("{}"), null);
assert.equal(
  followthroughCursorKey({
    lane: "terminal",
    chatIds: ["b", "a"],
    policy: defaults,
  }),
  followthroughCursorKey({
    lane: "terminal",
    chatIds: ["a", "b"],
    policy: defaults,
  }),
);
assert.notEqual(
  followthroughCursorKey({
    lane: "terminal",
    chatIds: ["a"],
    policy: defaults,
  }),
  followthroughCursorKey({ lane: "stats", chatIds: ["a"], policy: defaults }),
);

const sentAt = new Date("2026-09-20T12:00:00Z");
const snapshot = buildSignalPublicationSnapshot({
  marketId: "m",
  venue: "polymarket",
  side: "YES",
  now: sentAt,
  priceSnapshot: {
    version: 1,
    marketId: "m",
    venue: "polymarket",
    displaySide: "YES",
    asOf: sentAt.toISOString(),
    displayPrice: 0.55,
    displayPriceSource: "midpoint",
    YES: { bid: 0.54, ask: 0.56, mark: 0.55 },
    NO: { bid: 0.44, ask: 0.46, mark: 0.45 },
  },
});
const entry = {
  snapshot,
  legacyPrice: 0.52,
  marketId: "m",
  venue: "polymarket",
  side: "YES" as const,
  sentAt,
};
assert.equal(readFrozenPublicationEntry(entry).price, 0.56); // delivery ask, not the earlier Phillies research price
for (const patch of [
  { marketId: "other" },
  { side: "NO" },
  { venue: "limitless" },
  { ask: null },
  { ask: 0 },
]) {
  assert.equal(
    readFrozenPublicationEntry({
      ...entry,
      snapshot: { ...snapshot, ...patch },
    }).price,
    null,
  );
}
assert.equal(
  readFrozenPublicationEntry({
    ...entry,
    sentAt: new Date(sentAt.getTime() + 11 * 60_000),
  }).price,
  null,
);
assert.equal(
  readFrozenPublicationEntry({ ...entry, snapshot: undefined }).price,
  0.52,
);
for (const legacyPrice of [null, "", 0, 1, -1, NaN]) {
  assert.equal(
    readFrozenPublicationEntry({ ...entry, snapshot: undefined, legacyPrice })
      .price,
    null,
  );
}
for (const [league, expected] of [
  ["NFL", "sports_american_football"],
  ["MLB", "sports_baseball_game"],
  ["atp", "sports_tennis_game"],
  ["cs2", "sports_esports_game"],
]) {
  assert.equal(
    holderResearchReportCategory({
      marketType: "single_game_sports",
      marketSegment: "sports_soccer_game",
      marketMetadata: { league },
    }),
    expected,
  );
}
assert.equal(
  holderResearchReportCategory({
    marketType: "single_game_sports",
    marketSegment: "sports_soccer_game",
  }),
  "sports_unknown",
);
assert.equal(
  holderResearchReportCategory({
    marketType: "politics",
    marketSegment: "politics_election",
  }),
  "politics_election",
);
// Recorded delivery inputs from the read-only 2026-10-07 production audit.
// No current prices, later resolution or future news are used in these cases.
const historical = [
  {
    title: "Benjamin Netanyahu",
    marketId: "polymarket:682705",
    eventId: "polymarket:81557",
    side: "NO" as const,
    ask: 0.71,
    quoteAt: "2026-09-25T18:30:30.300Z",
    sentAt: "2026-09-25T18:31:26.842Z",
  },
  {
    title: "James Talarico (D)",
    marketId: "polymarket:630963",
    eventId: "polymarket:57672",
    side: "YES" as const,
    ask: 0.64,
    quoteAt: "2026-10-05T09:30:22.785Z",
    sentAt: "2026-10-05T09:32:14.783Z",
  },
  {
    title: "Ken Paxton (R)",
    marketId: "polymarket:630964",
    eventId: "polymarket:57672",
    side: "NO" as const,
    ask: 0.65,
    quoteAt: "2026-10-05T18:30:44.144Z",
    sentAt: "2026-10-05T18:32:30.721Z",
  },
  {
    title: "Team Falcons vs Natus Vincere",
    marketId: "polymarket:5342769",
    eventId: "polymarket:1139329",
    side: "YES" as const,
    ask: 0.93,
    quoteAt: "2026-10-06T20:30:44.513Z",
    sentAt: "2026-10-06T20:31:31.360Z",
  },
  {
    title: "Team Falcons vs Natus Vincere",
    marketId: "polymarket:5342769",
    eventId: "polymarket:1139329",
    side: "NO" as const,
    ask: 0.291,
    quoteAt: "2026-10-06T22:30:17.911Z",
    sentAt: "2026-10-06T22:32:18.218Z",
  },
];
for (const item of historical) {
  const frozen = buildSignalPublicationSnapshot({
    marketId: item.marketId,
    venue: "polymarket",
    side: item.side,
    priceSnapshot: null,
    nativeQuote: { ask: item.ask, asOf: item.quoteAt },
    now: new Date(item.sentAt),
    displayPrice: item.ask,
  });
  assert.equal(
    readFrozenPublicationEntry({
      snapshot: frozen,
      marketId: item.marketId,
      venue: "polymarket",
      side: item.side,
      sentAt: item.sentAt,
      legacyPrice: null,
    }).price,
    item.ask,
  );
}
for (const eventId of ["polymarket:57672", "polymarket:1139329"]) {
  const items = historical.filter((item) => item.eventId === eventId);
  const history = buildEventPublicationHistory({
    enabled: true,
    available: true,
    eventId,
    committed: [],
    selectedHolderIds: [],
    loaded: items.map((item, index) => ({
      event_id: eventId,
      market_id: item.marketId,
      side: item.side,
      note_id: String(index),
      published_at: item.sentAt,
      title: item.title,
      // Original prose is not in the anonymized audit. Do not fabricate a thesis.
      summary: "",
      win_condition: null,
      holder_ids: [],
    })),
  });
  assert.equal(history.items.length, 2);
  assert.equal(history.status, "partial");
  assert.deepEqual(
    new Set(history.items.map((item) => item.side)),
    new Set(["YES", "NO"]),
  );
  assert.equal(history.items[0]?.publishedAt, items[1].sentAt);
}
console.log(
  "[signal-followthrough-policy-tests] defaults, literal policy, cursors, frozen entries and report categories passed",
);
