import assert from "node:assert/strict";
import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchSystemPromptV2,
  buildHolderResearchUserPrompt,
  buildHolderResearchUserPromptV2,
} from "./schemas/holder-research.js";
import {
  buildIntelActivityHeadline,
  intelHoldingObservation,
  intelPublicActorName,
  type IntelActivityHeadlineInput,
} from "./services/intel-activity-copy.js";
import { buildSignalNotificationHeadline } from "./services/signal-notification-headline.js";
import { buildSignalBotStructuredNarrative } from "./services/signal-bot-editorial-copy.js";

const base: IntelActivityHeadlineInput = {
  actorName: "lava-lava",
  actorMode: "single_holder",
  actorCount: 1,
  positionValueUsd: 9500,
  positionLabel: "backing Likud to win 25–29 seats",
};
assert.equal(
  buildIntelActivityHeadline(base),
  "lava-lava holds $9.5K backing Likud to win 25–29 seats.",
);
assert.equal(
  buildIntelActivityHeadline({
    ...base,
    actorName: "@flawfence",
    positionValueUsd: 50600,
    positionLabel: "betting against Likud winning 30–34 seats",
  }),
  "@flawfence holds $50.6K betting against Likud winning 30–34 seats.",
);
for (const name of [
  null,
  "0x" + "a".repeat(40),
  "00000000-0000-4000-8000-000000000001",
  "tracked wallet",
  "https://example.org",
]) {
  assert.equal(intelPublicActorName(name), null);
  assert.match(
    buildIntelActivityHeadline({ ...base, actorName: name }),
    /^A trader holds/,
  );
}
for (const value of [null, NaN, -1, Infinity])
  assert.doesNotMatch(
    buildIntelActivityHeadline({ ...base, positionValueUsd: value }),
    /\$|NaN|Infinity/,
  );
assert.match(
  buildIntelActivityHeadline({
    ...base,
    actorMode: "sharp_cluster",
    actorCount: 2,
  }),
  /^2 tracked wallets hold \$9.5K/,
);
const observation = intelHoldingObservation({
  displayName: "Greedo",
  positionUsd: 13600,
  positionShares: 20000,
  observedAt: "2026-10-27T20:00:00Z",
});
assert.equal(observation.positionValueUsd, 13600);
assert.equal(observation.positionShares, 20000);
assert.equal(observation.confirmedPurchase, false);
assert.equal(
  observation.amountBasis,
  "marked_position_value_not_trade_notional",
);
const change = {
  scope: "representative_wallet" as const,
  beforeUsd: 5000,
  afterUsd: 9500,
  positionChangeUsd: 4500,
};
assert.match(
  buildIntelActivityHeadline({ ...base, change }),
  /observed position value.*rose to \$9.5K/,
);
assert.doesNotMatch(
  buildIntelActivityHeadline({ ...base, change }),
  /bought|added|profit|conviction|built/,
);
assert.match(
  buildIntelActivityHeadline({
    ...base,
    change: { ...change, scope: "selected_side_cluster" },
  }),
  /^lava-lava holds/,
);
assert.match(
  buildIntelActivityHeadline({ ...base, actorMode: "sharp_cluster", change }),
  /^Tracked wallets hold/,
);
assert.match(
  buildIntelActivityHeadline({
    ...base,
    actorMode: "sharp_cluster",
    actorCount: 2,
    change: { ...change, scope: "selected_side_cluster", afterUsd: 100000 },
  }),
  /^Tracked holders’ observed position value.*\$100K/,
);
for (const label of [
  "backing Under 2.5 total goals in Spain vs. Argentina",
  "betting against No Hormuz Agreement",
  "backing Beta Team over Alpha Team in Game 1",
])
  assert.ok(
    buildIntelActivityHeadline({ ...base, positionLabel: label }).includes(
      label,
    ),
  );
for (const prompt of [
  buildHolderResearchSystemPrompt(),
  buildHolderResearchSystemPromptV2(),
]) {
  assert.match(prompt, /WHO is doing WHAT/);
  assert.match(prompt, /Use bought only for confirmed trade evidence/);
  assert.match(prompt, /approximate 30-day PnL may include open positions/);
  assert.match(prompt, /Do not include CTA/);
  assert.doesNotMatch(prompt, /naming the market object and thesis\/tension/);
}
for (const build of [
  buildHolderResearchUserPrompt,
  buildHolderResearchUserPromptV2,
])
  assert.match(
    build({ candidateJson: {}, allowedEvidenceIds: [] }),
    /observed activity/,
  );
const subject = {
  text: "Likud winning 25–29 seats",
  source: "safe_full_title" as const,
  preservedFields: ["outcome" as const],
  version: "signal_notification_subject_v3" as const,
};
const headline = buildSignalNotificationHeadline({
  intelActivity: base,
  actorMode: "single_holder",
  holderPositionUsd: 9500,
  kind: "initial",
  currentPrice: 0.5,
  subject,
});
assert.equal(headline.templateKey, "intel_activity_v1");
assert.match(headline.text, /lava-lava holds/);
assert.equal(headline.continuation, null);
// A copy change must NOT bypass the existing weak-public-initial gate.
assert.equal(
  buildSignalNotificationHeadline({
    intelActivity: base,
    actorMode: "none",
    kind: "initial",
    currentPrice: 0.5,
    subject,
  }).templateKey,
  "initial_watch_v7",
);
assert.equal(
  buildSignalBotStructuredNarrative({
    headlineTemplateKey: "intel_activity_v1",
    editorialProbability: 0.5,
    evidenceRows: [],
    marketLabel: "Likud",
    messageKind: "initial",
    note: { holderOpenPnlUsd: 0, holderPositionUsd: 9500 },
    price: 0.5,
    researchDelta: null,
    side: "YES",
    sideLabel: "Yes",
  }),
  null,
);
console.log(
  "[intel-activity-copy-tests] passed identity, units, scope, prompts, outcomes and admission regressions",
);
