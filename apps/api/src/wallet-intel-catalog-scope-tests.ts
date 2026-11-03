import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { resolvePolymarketMarketAssets } from "@hunch/shared";
import {
  buildPolymarketAssetBindings,
  type PolymarketAssetBinding,
} from "@hunch/db";
import {
  scopeWalletIntelPolymarketTokens as scope,
  WALLET_INTEL_MARKET_SCOPE_SQL,
  WALLET_INTEL_SCOPE_BINDINGS_SQL,
  WALLET_INTEL_SCOPE_REPAIR_SQL,
  WALLET_INTEL_CATALOG_SQL_BATCH,
} from "./services/wallet-intel-market-scope.js";
import {
  parseWalletIntelRepairArgs as parse,
  loadWalletIntelRepairPlan,
  WALLET_INTEL_REPAIR_TARGETS_SQL,
} from "./services/wallet-intel-repair.js";

const condition = `0x${"11".repeat(32)}`;
const unknownCondition = `0x${"22".repeat(32)}`;
const market = {
  id: "polymarket:1",
  venue: "polymarket",
  condition_id: condition,
  clob_token_ids: '["11","12"]',
  outcomes: '["Away","Home"]',
  metadata: { version: "v1", negRisk: false },
};
type Source = typeof market & { requested_token_id: string };
function fixture(
  sources: Source[] = [],
  initial: PolymarketAssetBinding[] = [],
) {
  const frozen = [...initial];
  let writes = 0;
  let race: PolymarketAssetBinding | null = null;
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql === WALLET_INTEL_MARKET_SCOPE_SQL) return { rows: sources };
      if (sql === WALLET_INTEL_SCOPE_BINDINGS_SQL) return { rows: [...frozen] };
      if (sql === WALLET_INTEL_SCOPE_REPAIR_SQL) {
        writes++;
        if (race) frozen.push(race);
        const rows: PolymarketAssetBinding[] = JSON.parse(params[0] as string);
        const inserted = rows.filter(
          (row) =>
            !frozen.some(
              (old) =>
                old.asset_id === row.asset_id &&
                old.position_contract === row.position_contract,
            ),
        );
        frozen.push(...inserted);
        return { rows: inserted.map((row) => ({ asset_id: row.asset_id })) };
      }
      throw Error("Unexpected SQL in catalog-scope fixture");
    },
  } as unknown as Pick<Pool, "query">;
  return {
    db,
    frozen,
    get writes() {
      return writes;
    },
    raceWith(row: PolymarketAssetBinding) {
      race = row;
    },
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("Catalog scoping must never call a provider");
};
try {
  const outside = fixture();
  const skipped = await scope(
    outside.db,
    [{ tokenId: "90", conditionIds: [unknownCondition] }],
    [],
  );
  assert.equal(skipped.complete, true);
  assert.deepEqual(skipped.tokenIds, []);
  assert.equal(skipped.summary.skippedOutsideCatalog, 1);
  assert.equal(outside.writes, 0);
  const absentHint = await scope(outside.db, [{ tokenId: "90" }], []);
  assert.equal(absentHint.complete, false);
  assert.equal(absentHint.summary.pendingTokens, 1);
  const oldHolding = await scope(outside.db, [], ["90"]);
  assert.equal(oldHolding.complete, false);
  assert.deepEqual(oldHolding.tokenIds, ["90"]);
  assert.equal(
    oldHolding.summary.skippedOutsideCatalog,
    0,
    "never discard previously tracked holdings by absence",
  );

  for (const id of ["11", "12"]) {
    const local = fixture([{ ...market, requested_token_id: id }]);
    const repaired = await scope(
      local.db,
      [{ tokenId: id, conditionIds: [condition] }],
      [],
    );
    assert.equal(repaired.complete, true);
    assert.equal(repaired.summary.repairedBindings, 1);
    assert.equal(
      local.frozen[0]?.outcome_index,
      id === "11" ? 0 : 1,
      "named outcomes keep their exact index",
    );
    assert.equal(local.writes, 1);
    assert.equal(
      local.frozen.length,
      1,
      "only requested bindings, no catalog import",
    );
  }
  const knownWithoutHint = fixture([{ ...market, requested_token_id: "11" }]);
  assert.equal(
    (await scope(knownWithoutHint.db, [{ tokenId: "11" }], [])).complete,
    true,
    "exact local provenance can repair a known token without an optional API hint",
  );
  const changed = fixture([
    { ...market, clob_token_ids: '["98","99"]', requested_token_id: "11" },
  ]);
  const incompatible = await scope(
    changed.db,
    [{ tokenId: "11", conditionIds: [condition] }],
    [],
  );
  assert.equal(incompatible.complete, false);
  assert.equal(incompatible.summary.skippedOutsideCatalog, 0);
  assert.equal(
    changed.writes,
    0,
    "a known condition cannot reassign an old token to a current generation",
  );

  const historical = buildPolymarketAssetBindings(market).slice(0, 1);
  const frozen = fixture(
    [{ ...market, clob_token_ids: '["98","99"]', requested_token_id: "11" }],
    historical,
  );
  assert.equal(
    (await scope(frozen.db, [{ tokenId: "11", conditionIds: [condition] }], []))
      .complete,
    true,
  );
  assert.deepEqual(
    frozen.frozen,
    historical,
    "retain frozen historical identity after generation replacement",
  );
  const unsupported = fixture(
    [
      {
        ...market,
        requested_token_id: "11",
        metadata: { version: "v2", negRisk: false, positionIds: ["11", "12"] },
      } as Source,
    ],
    historical,
  );
  const unsupportedResult = await scope(
    unsupported.db,
    [{ tokenId: "11", conditionIds: [condition] }],
    [],
  );
  assert.equal(
    unsupportedResult.complete,
    false,
    "a valid historical binding cannot hide unresolved current ledger provenance",
  );
  assert.equal(unsupportedResult.summary.pendingTokens, 1);
  assert.equal(unsupported.writes, 0);
  const wrongMarket = fixture(
    [
      { ...market, requested_token_id: "11" },
      {
        ...market,
        id: "polymarket:2",
        condition_id: unknownCondition,
        clob_token_ids: '["98","99"]',
        requested_token_id: "11",
      },
    ],
    historical,
  );
  assert.equal(
    (
      await scope(
        wrongMarket.db,
        [{ tokenId: "11", conditionIds: [unknownCondition] }],
        [],
      )
    ).complete,
    false,
    "a historical binding to another market cannot cover an unresolved API condition",
  );
  const wrongCondition = fixture(
    [
      {
        ...market,
        condition_id: unknownCondition,
        requested_token_id: "11",
        metadata: {
          ...market.metadata,
          polymarketProtocol: resolvePolymarketMarketAssets({
            version: "v1",
            conditionId: condition,
            clobTokenIds: ["11", "12"],
            outcomes: ["Away", "Home"],
            negRisk: false,
          }),
        },
      } as Source,
    ],
    historical,
  );
  assert.equal(
    (
      await scope(
        wrongCondition.db,
        [{ tokenId: "11", conditionIds: [unknownCondition] }],
        [],
      )
    ).complete,
    false,
    "stored protocol condition cannot contradict the local market condition",
  );

  const conflict = fixture([
    { ...market, requested_token_id: "11" },
    {
      ...market,
      id: "polymarket:2",
      condition_id: unknownCondition,
      requested_token_id: "11",
    },
  ]);
  assert.equal(
    (
      await scope(
        conflict.db,
        [{ tokenId: "11", conditionIds: [condition, unknownCondition] }],
        [],
      )
    ).complete,
    false,
  );
  assert.equal(
    conflict.writes,
    0,
    "ambiguous local identities are not picked by order",
  );
  const raced = fixture([{ ...market, requested_token_id: "11" }]);
  const historicalBinding = historical[0];
  assert.ok(historicalBinding);
  raced.raceWith({ ...historicalBinding, market_id: "polymarket:other" });
  assert.equal(
    (await scope(raced.db, [{ tokenId: "11", conditionIds: [condition] }], []))
      .complete,
    false,
  );
  assert.equal(
    raced.frozen[0]?.market_id,
    "polymarket:other",
    "concurrent frozen bindings are never overwritten",
  );
  const empty = fixture();
  assert.equal((await scope(empty.db, [], [])).complete, true);
  await assert.rejects(
    scope(empty.db, [{ tokenId: "bad", conditionIds: [condition] }], []),
    /token identity/,
  );
  await assert.rejects(
    scope(empty.db, [{ tokenId: "11", conditionIds: ["bad"] }], []),
    /condition hint/,
  );
  for (const count of [1001, 2001]) {
    const visited: string[] = [];
    const bounded = {
      query: async (sql: string, params: unknown[]) => {
        assert.ok(
          sql === WALLET_INTEL_MARKET_SCOPE_SQL ||
            sql === WALLET_INTEL_SCOPE_BINDINGS_SQL,
        );
        const chunk = params[0] as string[];
        assert.ok(chunk.length <= WALLET_INTEL_CATALOG_SQL_BATCH);
        if (sql === WALLET_INTEL_MARKET_SCOPE_SQL) {
          visited.push(...chunk);
          assert.deepEqual(
            params[1],
            chunk,
            "hints stay with their token across chunks",
          );
          assert.equal((params[2] as string[]).length, chunk.length);
        }
        return { rows: [] };
      },
    } as unknown as Pick<Pool, "query">;
    const discovered = Array.from({ length: count }, (_, i) => ({
      tokenId: String(i + 10000),
      conditionIds: [unknownCondition],
    }));
    const large = await scope(bounded, discovered, []);
    assert.equal(large.complete, true);
    assert.equal(large.summary.skippedOutsideCatalog, count);
    assert.deepEqual(
      visited,
      discovered.map((row) => row.tokenId),
      "process all batches, never first-N truncation",
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}

const id = "00000000-0000-0000-0000-000000000001";
const other = "00000000-0000-0000-0000-000000000002";
const noRead = () => {
  throw Error("must not read manifest");
};
assert.equal(parse([], noRead), null);
assert.deepEqual(
  parse([`--repair-wallet-ids=${other},${id},${id.toUpperCase()}`], noRead),
  { walletIds: [id, other], execute: false },
);
assert.deepEqual(
  parse(
    ["--repair", "--repair-wallet-ids-file=targets.json", "--repair-execute"],
    (path) => {
      assert.equal(path, "targets.json");
      return JSON.stringify([other, id]);
    },
  ),
  { walletIds: [id, other], execute: true },
);
for (const args of [
  ["--repair"],
  ["--repair-execute"],
  ["--repair-wallet-ids"],
  ["--repair-walet-ids=x"],
  ["--repair-wallet-ids="],
  ["--repair-wallet-ids=not-a-uuid"],
  [`--repair-wallet-ids=${id}`, "--ignore-runtime-policy"],
  [`--repair-wallet-ids=${id}`, "--backfill=1"],
  [`--repair-wallet-ids=${id}`, "--cleanup-only"],
  [`--repair-wallet-ids=${id}`, "--auto-tracked-wallet-limit=1000"],
  [
    `--repair-wallet-ids=${id}`,
    "--auto-tracked-fresh-price-check=false",
    "--repair-execute",
  ],
  [`--repair-wallet-ids=${id}`, "--repair-wallet-ids-file=targets.json"],
])
  assert.throws(() => parse(args, noRead));
assert.throws(
  () =>
    parse(["--repair-wallet-ids-file=x"], () =>
      JSON.stringify({ walletIds: [id] }),
    ),
  /UUID array/,
);
assert.throws(
  () => parse(["--repair-wallet-ids-file=x"], () => " ".repeat(65537)),
  /64KiB/,
);
let calls = 0;
const db = {
  query: async (sql: string, params: unknown[]) => {
    calls++;
    assert.equal(sql, WALLET_INTEL_REPAIR_TARGETS_SQL);
    assert.deepEqual(params[0], [id, other]);
    return {
      rows: [
        {
          wallet_id: id,
          address: "0x" + "11".repeat(20),
          chain: "polygon",
          venue: "polymarket",
          sources: ["whale"],
          priority: 1,
          excluded_reason: null,
        },
        {
          wallet_id: other,
          address: null,
          chain: null,
          venue: "polymarket",
          sources: null,
          priority: null,
          excluded_reason: "unknown_wallet",
        },
      ],
    };
  },
} as unknown as Pick<Pool, "query">;
const plan = await loadWalletIntelRepairPlan(db, [id, other], {
  protocolAddresses: [],
  enabledVenues: ["polymarket"],
  maxWallets: 50,
});
assert.equal(calls, 1);
assert.equal(plan.targets.length, 1);
assert.equal(plan.report.excluded.length, 1);
assert.ok(!JSON.stringify(plan.report).includes("0x"));
await assert.rejects(
  loadWalletIntelRepairPlan(db, [id, other], {
    protocolAddresses: [],
    enabledVenues: ["polymarket"],
    maxWallets: 1,
  }),
  /batches/,
);
await assert.rejects(
  loadWalletIntelRepairPlan(db, [id, other], {
    protocolAddresses: [],
    enabledVenues: [],
    maxWallets: 50,
  }),
  /disabled/,
);
console.log(
  "[wallet Intel catalog/repair] outside scope, frozen identity, local repair, conflicts, explicit dry-run and bounded selection passed",
);
