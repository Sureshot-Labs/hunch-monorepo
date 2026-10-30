import assert from "node:assert/strict";
import { classifyIntelTags } from "./services/intel-tags.js";
import { intelTagsSchema } from "./schemas/intel-tags.js";
import {
  intelTagFixture,
  intelFixtureWallet,
} from "./intel-tags-test-fixtures.js";
import {
  loadIntelTags,
  INTEL_TAG_NOTES_SQL,
  INTEL_TAG_BASELINES_SQL,
} from "./services/intel-tags-loader.js";
import type { DbQuery } from "./db.js";
import { resolvePolymarketMarketAssets } from "@hunch/shared";
import { buildSocialInstrument } from "./services/social-instrument.js";
import { resolveLimitlessPositionContract } from "./services/limitless-protocol-config.js";
type Fixture = ReturnType<typeof intelTagFixture>;
// Test-only mutations of deliberately malformed persisted JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
function check(change: (f: Fixture) => void = () => {}) {
  const f = intelTagFixture();
  change(f);
  const result = classifyIntelTags(f);
  intelTagsSchema.parse(result);
  const encoded = JSON.stringify(result);
  for (const privateValue of [
    intelFixtureWallet,
    "must not leak",
    "socialInstrumentV1",
    "primary_holder_credentials",
  ])
    assert.ok(!encoded.includes(privateValue));
  return result;
}
const codes = (change: (f: Fixture) => void) =>
  check(change).tags.map((t) => t.code);
const has = (code: string, change: (f: Fixture) => void, expected = false) =>
  assert.equal(codes(change).includes(code as never), expected, code);
assert.deepEqual(
  check().tags.map((t) => t.code),
  [
    "winning_bet",
    "wallet_activity",
    "new_evidence",
    "price_update",
    "top_trader",
  ],
);
assert.equal(check().primaryTag, "winning_bet");
assert.equal(
  check((f) => {
    f.market.resolved_outcome = null;
  }).primaryTag,
  "wallet_activity",
);
assert.equal(
  check((f) => {
    f.market.resolved_outcome = null;
    const update = (f.note.metrics as Obj).holderResearchUpdateV1;
    update.primaryReason = update.reasons[1];
  }).primaryTag,
  "price_update",
);
for (const status of ["retracted", "deleted"])
  assert.equal(
    check((f) => {
      f.note.status = status;
    }).tags.length,
    0,
  );
assert.equal(
  check((f) => {
    f.note.note_type = "context";
  }).tags.length,
  0,
);
assert.equal(
  check((f) => {
    f.note.metrics = {};
  }).tags.length,
  0,
);
has("top_trader", (f) => {
  (
    f.note.lineage as Obj
  ).decision_snapshot.publicComparisonPositions[0].strong = false;
});
has("top_trader", (f) => {
  (f.note.model_meta as Obj).primary_holder_credentials.primaryHolder.walletId =
    "other";
});
has("top_trader", (f) => {
  (f.note.model_meta as Obj).primary_holder_credentials.side = "YES";
});
has("top_trader", (f) => {
  (
    f.note.lineage as Obj
  ).decision_snapshot.publicComparisonPositions[0].positionShares = 0;
});
has(
  "top_trader",
  (f) => {
    (f.note.model_meta as Obj).current_pnl = -999999;
  },
  true,
);
has(
  "top_trader",
  (f) => {
    const actor = (f.note.model_meta as Obj).primary_holder_credentials;
    actor.mode = "sharp_cluster";
    actor.cluster = { sharpHolders: 2 };
    const rows = (f.note.lineage as Obj).decision_snapshot
      .publicComparisonPositions;
    rows.push({ ...rows[0], walletId: "another" });
  },
  true,
);
has("top_trader", (f) => {
  const rows = (f.note.lineage as Obj).decision_snapshot
    .publicComparisonPositions;
  rows.push({ ...rows[0] });
});
has("wallet_activity", (f) => {
  (
    f.note.lineage as Obj
  ).decision_snapshot.publicComparisonPositions[0].positionShares = 20000;
});
has("wallet_activity", (f) => {
  (f.note.lineage as Obj).decision_snapshot.publicComparisonPositions = [];
});
has("wallet_activity", (f) => {
  (f.baseline.lineage as Obj).decision_snapshot = {};
});
has("wallet_activity", (f) => {
  (f.baseline.metrics as Obj).socialInstrumentV1 = {
    ...(f.baseline.metrics as Obj).socialInstrumentV1,
    generation: "old",
  };
});
has("wallet_activity", (f) => {
  f.baseline.status = "retracted";
});
has("wallet_activity", (f) => {
  f.baseline.source_id = "other";
});
has("wallet_activity", (f) => {
  (f.note.metrics as Obj).holderResearchUpdateV1.materialityPolicy.thresholds =
    {};
});
has("wallet_activity", (f) => {
  (
    f.note.lineage as Obj
  ).decision_snapshot.publicComparisonPositions[0].observedAt =
    "2026-10-28T11:00:00Z";
});
has(
  "wallet_activity",
  (f) => {
    f.note.created_at = "2026-10-29T11:59:59.990Z";
  },
  true,
);
const exit = check((f) => {
  const p = (f.note.lineage as Obj).decision_snapshot
    .publicComparisonPositions[0];
  p.positionShares = 0;
  p.strong = false;
}).tags.find((t) => t.code === "wallet_activity");
assert.ok(exit?.code === "wallet_activity");
assert.deepEqual(exit.basis.sides, [
  { side: "NO", increasedWallets: 0, reducedWallets: 0, exitedWallets: 1 },
]);
const mixed = check((f) => {
  const before = (f.baseline.lineage as Obj).decision_snapshot
    .publicComparisonPositions;
  const after = (f.note.lineage as Obj).decision_snapshot
    .publicComparisonPositions;
  before.push({ ...before[0], walletId: "wallet-2", side: "YES" });
  after.push({
    ...after[0],
    walletId: "wallet-2",
    side: "YES",
    positionShares: 5000,
    strong: false,
  });
}).tags.find((t) => t.code === "wallet_activity");
assert.ok(mixed?.code === "wallet_activity");
assert.equal(mixed.basis.sides.length, 2);
for (const outcome of [null, "YES", "VOID", "INVALID"])
  has("winning_bet", (f) => {
    f.market.resolved_outcome = outcome;
  });
has("winning_bet", (f) => {
  f.market.resolved_outcome_pct = "5000";
});
has("winning_bet", (f) => {
  f.market.token_id = "new";
});
has("winning_bet", (f) => {
  f.market.expiration_time = "2027-01-01T00:00:00Z";
});
has("winning_bet", (f) => {
  f.market.venue = "polymarket";
  f.market.metadata = {
    umaResolutionStatus: "proposed",
    outcomePrices: [0, 1],
  };
  f.market.resolved_outcome = null;
});
has("price_update", (f) => {
  const u = (f.note.metrics as Obj).holderResearchUpdateV1;
  u.reasons = [u.primaryReason];
});
has("new_evidence", (f) => {
  (f.note.model_meta as Obj).external_research.citations = [];
});
has("new_evidence", (f) => {
  (f.note.metrics as Obj).holderResearchUpdateV1.reasons[2].eventAt =
    "2026-10-27T00:00:00.000Z";
});
has("new_evidence", (f) => {
  (f.note.metrics as Obj).holderResearchUpdateV1.reasons[2].sourceUrl =
    "javascript:alert(1)";
});
for (const selectedSide of ["YES", "NO"] as const) {
  const poly = intelTagFixture();
  const conditionId = `0x01${"00".repeat(31)}`;
  const assets = [
    BigInt(conditionId).toString(),
    (BigInt(conditionId) + 1n).toString(),
  ];
  const protocol = resolvePolymarketMarketAssets({
    version: "v2",
    conditionId,
    positionIds: assets,
    outcomes: ["Team A", "Team B"],
    negRisk: false,
  });
  poly.note.source_id = "polymarket:named-outcome";
  poly.note.lineage = { side: selectedSide };
  poly.market = {
    ...poly.market,
    venue: "polymarket",
    token_id: assets[selectedSide === "YES" ? 0 : 1],
    metadata: { polymarketProtocol: protocol },
    resolved_outcome: selectedSide,
  };
  (poly.note.metrics as Obj).socialInstrumentV1 = buildSocialInstrument({
    marketId: poly.note.source_id,
    venue: "polymarket",
    outcome: selectedSide,
    tokenId: poly.market.token_id,
    metadata: poly.market.metadata,
    expiry: null,
  });
  assert.ok(
    classifyIntelTags(poly).tags.some((tag) => tag.code === "winning_bet"),
  );
  poly.market.metadata = {
    polymarketProtocol: {
      ...protocol,
      positionContract: "0x9999999999999999999999999999999999999999",
    },
  };
  assert.ok(
    !classifyIntelTags(poly).tags.some((tag) => tag.code === "winning_bet"),
  );
}
has(
  "winning_bet",
  (f) => {
    f.limitlessPositionContract = resolveLimitlessPositionContract({});
    (f.note.metrics as Obj).socialInstrumentV1 = {
      ...(f.note.metrics as Obj).socialInstrumentV1,
      generation: `8453:${f.limitlessPositionContract}:intel-tag-no`,
    };
  },
  true,
);
const fixture = intelTagFixture();
let failBaseline = true;
const queries: string[] = [];
const db = {
  query: async (sql: string) => {
    queries.push(sql);
    if (sql === INTEL_TAG_NOTES_SQL)
      return { rows: [{ ...fixture.note, ...fixture.market }] };
    if (sql === INTEL_TAG_BASELINES_SQL) {
      if (failBaseline) throw Error("temporary");
      return { rows: [fixture.baseline] };
    }
    throw Error("unexpected SQL");
  },
} as unknown as DbQuery;
assert.equal((await loadIntelTags(db, [])).byId.size, 0);
assert.equal(queries.length, 0);
assert.equal(
  (await loadIntelTags(db, [fixture.note.id], fixture)).complete,
  false,
);
failBaseline = false;
const recovered = await loadIntelTags(
  db,
  [fixture.note.id, fixture.note.id],
  fixture,
);
assert.equal(recovered.complete, true);
assert.deepEqual(
  recovered.byId.get(fixture.note.id),
  classifyIntelTags(fixture),
);
assert.equal(queries.length, 4);
assert.ok(queries.every((sql) => !/\b(insert|update|delete)\b/i.test(sql)));
console.log(
  "Intel tags: classification, historical evidence, privacy, priority and transient recovery passed",
);
