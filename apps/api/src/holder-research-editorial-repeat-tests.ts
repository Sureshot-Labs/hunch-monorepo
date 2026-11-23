import assert from "node:assert/strict";
import {
  parseHolderResearchTriageOutputV1,
  parseHolderResearchTriageOutputV2,
} from "./schemas/holder-research.js";
import { classifyHolderEditorialRepeat } from "./services/holder-research-editorial-repeat.js";
import { buildEventPublicationHistory } from "./services/holder-research-event-publications.js";
import type { HolderPublicNote } from "./services/holder-research-publication-history.js";

const same: HolderPublicNote = {
  noteId: "delivered",
  marketId: "polymarket:1",
  side: "YES",
  publishedAt: "2026-11-18T12:00Z",
  title: "Test thesis",
  summary: "Previous argument",
  sideLabel: "YES",
  priceSnapshot: null,
  decisionSnapshot: null,
  externalResearch: null,
};
const history = { status: "ok" as const, items: [same] };
const repeat = {
  key: "key",
  action: "skip" as const,
  reason_codes: ["editorial_repeat" as const],
  repeat_of_note_id: same.noteId,
  research_need: "none" as const,
  research_question: null,
  reason: "The public thesis is unchanged.",
};
assert.equal(
  parseHolderResearchTriageOutputV2({ decisions: [repeat] }).decisions[0]
    ?.repeat_of_note_id,
  same.noteId,
);
const { research_need: _research, ...legacy } = repeat;
assert.equal(
  parseHolderResearchTriageOutputV1({
    decisions: [{ ...legacy, priority: 0.1, needs_external_search: false }],
  }).decisions[0]?.repeat_of_note_id,
  same.noteId,
);
const base = {
  decision: repeat,
  history,
  side: "YES" as const,
  marketId: same.marketId,
  verifiedPositionChange: false,
  materialAskChange: false,
  currentAskKnown: true,
  hasMaterialUpdateSince: () => false,
};
assert.equal(classifyHolderEditorialRepeat(base), "defer");
for (const input of [
  { ...base, side: "NO" as const },
  { ...base, history: { ...history, status: "unavailable" as const } },
  { ...base, decision: { ...repeat, repeat_of_note_id: "unrelated" } },
  { ...base, decision: { ...repeat, research_need: "news_timing" as const } },
  { ...base, verifiedPositionChange: true },
  { ...base, materialAskChange: true },
  { ...base, currentAskKnown: false },
  { ...base, hasMaterialUpdateSince: () => true },
])
  assert.equal(classifyHolderEditorialRepeat(input), "investigate");
assert.equal(
  classifyHolderEditorialRepeat({
    ...base,
    decision: { ...repeat, reason_codes: ["weak_credentials"] },
  }),
  "not_repeat",
);
const eventRow = {
  event_id: "event",
  market_id: "polymarket:2",
  side: "YES",
  note_id: "delivered-sibling",
  published_at: "2026-11-18T12:00Z",
  title: "Sibling",
  summary: "Same argument, different strike",
  win_condition: "Official rule",
  holder_ids: [],
  price_snapshot: {
    version: 1,
    marketId: "polymarket:2",
    venue: "polymarket",
    side: "YES",
    preparedAt: "2026-11-18T12:00Z",
    quoteAsOf: "2026-11-18T11:59Z",
    ask: 0.6,
    bid: 0.59,
    displayPrice: 0.6,
  },
};
const sibling = buildEventPublicationHistory({
  enabled: true,
  available: true,
  eventId: "event",
  loaded: [eventRow],
  committed: [{ ...eventRow, market_id: "polymarket:3", note_id: null }],
  selectedHolderIds: [],
});
assert.equal(
  classifyHolderEditorialRepeat({
    ...base,
    history: { status: "ok", items: [] },
    eventHistory: sibling,
    decision: { ...repeat, repeat_of_note_id: "delivered-sibling" },
  }),
  "defer",
);
assert.equal(
  classifyHolderEditorialRepeat({
    ...base,
    history: { status: "ok", items: [] },
    eventHistory: {
      ...sibling,
      items: sibling.items.map((item) => ({ ...item, quotedAsk: null })),
    },
    decision: { ...repeat, repeat_of_note_id: "delivered-sibling" },
  }),
  "investigate",
);
const committed = sibling.items.find(
  (item) => item.delivery === "committed_in_run",
);
assert.ok(committed);
assert.equal(
  classifyHolderEditorialRepeat({
    ...base,
    history: { status: "ok", items: [] },
    eventHistory: {
      ...sibling,
      items: [{ ...committed, noteId: "unconfirmed" }],
    },
    decision: { ...repeat, repeat_of_note_id: "unconfirmed" },
  }),
  "investigate",
);
console.log(
  "[holder-research-editorial-repeat-tests] anchors, repeat, recovery and wire compatibility passed",
);
