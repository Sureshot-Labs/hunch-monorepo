import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { hip4Identity } from "@hunch/shared";
import {
  createVerifiedBuyObserver,
  HIP4_VERIFIED_BUY_FILLS_SQL,
  HIP4_VERIFIED_BUY_SOURCE_SQL,
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./services/verified-buy-observer.js";
import {
  EvidenceBudgetExhausted,
  repairVerifiedBuys,
} from "./services/verified-buy.js";
import { buildHip4SocialInstrument } from "./services/hip4-social-instrument.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { Hip4ReadError } from "./services/hip4-client.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/social-evidence-v1-20261016.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const publicFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
function harness() {
  const identity = hip4Identity("mainnet", 13343);
  const native = mapHip4Market({
    ...publicFixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: publicFixture.collectedAt,
    generation: "replaceable-public-read",
  }).market;
  Object.assign(native, {
    outcome: 13343,
    marketId: identity.marketId,
    expiry: fixture.syntheticInstrument.expiry,
    quoteToken: "USDC",
    quoteTokenId: HYPERCORE_MAINNET_USDC.assetId,
    quoteWeiDecimals: 8,
  });
  native.sides = native.sides.map((side, i) => ({
    ...side,
    ...identity.sides[i],
  }));
  const instrument = buildHip4SocialInstrument({
    marketId: native.marketId,
    tokenId: identity.sides[0].tokenId,
    outcome: "YES",
    expiry: native.expiry,
    snapshot: native,
  });
  assert.ok(instrument);
  const row: VerifiedBuySourceRow = {
    id: randomUUID(),
    user_id: randomUUID(),
    venue: "hyperliquid",
    wallet_address: fixture.canonicalContract.owner,
    order_hash: null,
    venue_order_id: "1",
    token_id: identity.sides[0].tokenId,
    side: "BUY",
    order_payload: {
      grossNotionalUsd: "999999999999",
      unsigned_envelope: "untrusted",
    },
    client_order_id: null,
    tx_signature: null,
    market_id: identity.marketId,
    outcome: "YES",
    expiration_time: native.expiry ? new Date(native.expiry) : null,
    market_metadata: {
      hip4: { description: "Today's changed terms must not be used" },
    },
    input_mint: null,
    output_mint: null,
  };
  const journal = {
    environment: "mainnet",
    signer_address: row.wallet_address,
    submission_signer_address: row.wallet_address,
    account_history: {} as Record<string, unknown>,
    canonical_market_id: identity.marketId,
    token_id: row.token_id,
    cloid: fixture.canonicalContract.cloid,
    action_fingerprint: canonicalJsonHash(fixture.syntheticEnvelope),
    unsigned_envelope: structuredClone(fixture.syntheticEnvelope),
    preparation_snapshot: {
      socialInstrument: instrument,
      socialInstrumentSnapshot: native,
    },
  };
  let saved: typeof journal | null = journal;
  let body: unknown = structuredClone(fixture.originalPartialBuy.orderStatus);
  let fills: unknown[] = structuredClone(fixture.originalPartialBuy.fills);
  type Entry = {
    execution: unknown;
    provider_fill: unknown;
    provider_evidence_status?: unknown;
  };
  let entries: Entry[] | null = null;
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const providerCalls: unknown[] = [];
  const unavailable = async () => {
    throw new Error("unexpected_non_native_provider_read");
  };
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 100,
    limitlessPositionContract: "unused",
    limitlessExchangeAddress: "unused",
    solanaCollateralMint: "unused",
    readEvmReceipt: unavailable,
    readFinalizedSolanaTransaction: unavailable,
    readLimitlessOrder: unavailable,
    readDflowOrder: unavailable,
    readPolymarketFills: unavailable,
    readHip4OrderStatus: async (request) => {
      providerCalls.push(request);
      return body;
    },
  };
  const db = {
    query: async (sql: string, parameters: unknown[] = []) => {
      calls.push({ sql, parameters });
      if (sql === HIP4_VERIFIED_BUY_SOURCE_SQL) {
        assert.deepEqual(parameters, [row.id, row.user_id]);
        return { rows: saved ? [saved] : [] };
      }
      if (sql === HIP4_VERIFIED_BUY_FILLS_SQL) {
        assert.deepEqual(parameters, [
          "mainnet",
          row.wallet_address?.toLowerCase(),
          "#133430",
          "1",
          deps.maxEvidenceItems + 1,
        ]);
        return {
          rows: (
            entries ??
            fills.map((provider_fill) => ({
              provider_fill,
              execution: projectHip4Execution(
                "mainnet",
                fixture.canonicalContract.owner,
                provider_fill,
              ),
            }))
          ).map((entry: Entry) => ({
            ...entry,
            time_ms: String(
              (entry.provider_fill as { time?: number } | null)?.time ?? 0,
            ),
            tid: String(
              (entry.provider_fill as { tid?: number } | null)?.tid ?? 0,
            ),
          })),
        };
      }
      if (sql.includes("from orders purchase_row")) return { rows: [row] };
      throw new Error("unexpected_sql");
    },
  } as unknown as Pick<Pool, "query">;
  return {
    row,
    journal,
    deps,
    db,
    calls,
    providerCalls,
    observe: () => observeVerifiedBuySource(db, deps, row),
    setSaved: (value: typeof journal | null) => {
      saved = value;
    },
    setBody: (value: unknown) => {
      body = value;
    },
    setFills: (value: unknown[]) => {
      fills = value;
    },
    setEntries: (value: Entry[]) => {
      entries = value;
    },
  };
}

test("native observer proves partial BUY from admitted journal/P2, ignoring recorder and today's metadata", async () => {
  const h = harness();
  const result = await h.observe();
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("fixture");
  assert.equal(result.facts.grossNotionalUsd, "7.02");
  assert.equal(result.facts.grossShares, "27");
  assert.equal(result.facts.feesUsd, "0");
  assert.deepEqual(
    result.facts.instrument,
    h.journal.preparation_snapshot.socialInstrument,
  );
  assert.deepEqual(h.providerCalls, [
    {
      environment: "mainnet",
      accountAddress: fixture.canonicalContract.owner,
      cloid: fixture.canonicalContract.cloid,
    },
  ]);
  assert.equal(h.calls.length, 2);
});

test("purchase claim follows the same owned native journal seam", async () => {
  const h = harness();
  const result = await createVerifiedBuyObserver(
    h.db,
    h.deps,
  )({
    purchaseRef: { kind: "order", id: h.row.id },
    userId: h.row.user_id,
    leaseToken: randomUUID(),
    attempts: 1,
  });
  assert.equal(result.state, "verified");
  assert.equal(h.calls.length, 3);
});

test("unadmitted and historical native rows cannot fabricate proof from recorder payload", async () => {
  const h = harness();
  h.setSaved(null);
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_admitted_original_order_missing",
  });
  assert.equal(h.providerCalls.length, 0);
});

test("missing frozen instrument provenance remains pending before provider reads", async () => {
  const h = harness();
  delete (h.journal.preparation_snapshot as Record<string, unknown>)
    .socialInstrumentSnapshot;
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason:
      "observation_unavailable:hip4_frozen_instrument_provenance_unavailable",
  });
  assert.equal(h.providerCalls.length, 0);
});

test("a changed frozen condition cannot reuse another instrument generation", async () => {
  const h = harness();
  h.journal.preparation_snapshot.socialInstrumentSnapshot.description +=
    " changed resolution source";
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason:
      "observation_unavailable:hip4_frozen_instrument_provenance_unavailable",
  });
});

test("owner, token and immutable action-fingerprint mismatches have no guessed fallback", async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => {
      h.journal.submission_signer_address = `0x${"2".repeat(40)}`;
    },
    (h: ReturnType<typeof harness>) => {
      h.journal.token_id = "foreign-token";
    },
    (h: ReturnType<typeof harness>) => {
      h.journal.action_fingerprint = "0".repeat(64);
    },
  ]) {
    const h = harness();
    change(h);
    const result = await h.observe();
    assert.equal(result.state, "pending");
    if (result.state !== "pending") throw new Error("fixture");
    assert.match(result.reason, /^observation_unavailable:hip4_/u);
    assert.equal(h.providerCalls.length, 0);
  }
});

test("native status absence and transport failures preserve confirmed money through unavailable classification", async () => {
  const h = harness();
  h.setBody({ status: "unknownOid" });
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_order_not_observed",
  });
  assert.equal(
    h.calls.some((call) => call.sql === HIP4_VERIFIED_BUY_FILLS_SQL),
    true,
  );
  h.deps.readHip4OrderStatus = async () => {
    throw new Error("private provider detail must not escape");
  };
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_status_read_unavailable",
  });
});

test("missing provider adapter remains recoverable pending rather than an implicit CLOB fallback", async () => {
  const h = harness();
  delete h.deps.readHip4OrderStatus;
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_status_reader_unavailable",
  });
});

test("an exact authoritative OID contradiction revokes rather than admitting another order", async () => {
  const h = harness();
  const body = structuredClone(fixture.originalPartialBuy.orderStatus);
  body.order.order.oid = 2;
  h.setBody(body);
  const result = await h.observe();
  assert.equal(result.state, "revoked");
  if (result.state !== "revoked") throw new Error("fixture");
  assert.equal(result.reason, "order_identity_conflict");
  assert.equal(result.nativeEvidenceGuard?.orderId, "1");
});

test("precise original-fill conflicts revoke, exact matching rechecks recover, malformed status stays unavailable", async () => {
  const h = harness();
  const provider_fill = fixture.originalPartialBuy.fills[0];
  const execution = projectHip4Execution(
    "mainnet",
    fixture.canonicalContract.owner,
    provider_fill,
  );
  const marker = {
    version: 1,
    revision: "1",
    state: "conflicted",
    reason: "execution_identity_conflict",
    retainedFingerprint: canonicalJsonHash(execution),
    retainedBasisFingerprint: "1".repeat(64),
    observedFingerprint: "2".repeat(64),
    observedBasisFingerprint: "2".repeat(64),
  };
  h.setEntries([
    { execution, provider_fill, provider_evidence_status: marker },
  ]);
  const conflicted = await h.observe();
  assert.equal(conflicted.state, "revoked");
  if (conflicted.state !== "revoked") throw new Error("fixture");
  assert.equal(conflicted.reason, "hip4_execution_evidence_conflict");
  assert.equal(conflicted.nativeEvidenceGuard?.rows[0].revision, "1");
  h.setEntries([
    {
      execution,
      provider_fill,
      provider_evidence_status: {
        ...marker,
        revision: "2",
        state: "matched",
        reason: null,
      },
    },
  ]);
  const restored = await h.observe();
  assert.equal(restored.state, "verified");
  assert.equal(restored.nativeEvidenceGuard?.rows[0].revision, "2");
  h.setEntries([
    { execution, provider_fill, provider_evidence_status: { version: 2 } },
  ]);
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason:
      "observation_unavailable:hip4_execution_evidence_status_unavailable",
  });
});

test("native guarded proof cannot finalize without a finalizer, or when its revision has changed", async () => {
  for (const changed of [false, true]) {
    const h = harness();
    const observation = await h.observe();
    assert.equal(observation.state, "verified");
    let stored: unknown[] = [];
    let claimed = false;
    const db = {
      query: async (sql: string, parameters: unknown[]) => {
        if (sql.includes("with due_purchase")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                id: h.row.id,
                user_id: h.row.user_id,
                verified_buy_lease_token: randomUUID(),
                verified_buy_attempts: 1,
              },
            ],
          };
        }
        stored = parameters;
        return { rows: [{ id: h.row.id }] };
      },
    } as unknown as Pick<Pool, "query">;
    const result = await repairVerifiedBuys(db, {
      batchSize: 1,
      leaseSeconds: 60,
      retrySeconds: 1,
      verifiedRecheckSeconds: 60,
      observe: async () => observation,
      ...(changed
        ? { finalizeNativeEvidence: async () => ({ stored: false as const }) }
        : {}),
    });
    assert.equal(result.pending, 1);
    assert.equal(stored[1], "pending");
    assert.equal(stored[2], null);
    assert.equal(
      stored[3],
      "observation_unavailable:hip4_execution_evidence_changed",
    );
  }
});

test("legacy unscoped conflict is pending, and one exact official matching recheck immediately restores proof", async () => {
  const h = harness();
  const provider_fill = fixture.originalPartialBuy.fills[0];
  const execution = projectHip4Execution(
    "mainnet",
    fixture.canonicalContract.owner,
    provider_fill,
  );
  h.journal.account_history = {
    accountingConflicts: { [provider_fill.coin]: provider_fill.time },
  };
  const assertQuarantined = (result: Awaited<ReturnType<typeof h.observe>>) => {
    assert.equal(result.state, "pending");
    if (result.state !== "pending") throw new Error("fixture");
    assert.equal(result.reason, "hip4_legacy_execution_conflict_unscoped");
    assert.ok(result.nativeEvidenceGuard);
  };
  assertQuarantined(await h.observe());
  let rechecks = 0;
  h.deps.recheckHip4OrderFills = async (scope) => {
    rechecks++;
    assert.deepEqual(scope, {
      environment: "mainnet",
      accountAddress: fixture.canonicalContract.owner,
      coin: provider_fill.coin,
      orderId: "1",
      timeMs: provider_fill.time,
    });
    // Empty/absent proof cannot acquit an exact legacy row.
  };
  assertQuarantined(await h.observe());
  assert.equal(rechecks, 1);
  h.deps.recheckHip4OrderFills = async () => {
    rechecks++;
    h.setEntries([
      {
        execution,
        provider_fill,
        provider_evidence_status: {
          version: 1,
          revision: "1",
          state: "matched",
          reason: null,
          retainedFingerprint: canonicalJsonHash(execution),
          observedFingerprint: canonicalJsonHash(execution),
          retainedBasisFingerprint: "1".repeat(64),
          observedBasisFingerprint: "1".repeat(64),
        },
      },
    ]);
  };
  const restored = await h.observe();
  assert.equal(restored.state, "verified");
  assert.equal(rechecks, 2, "at most one source slice per purchase attempt");
  assert.equal(
    restored.nativeEvidenceGuard?.legacyConflictTime,
    provider_fill.time,
  );
});

test("known legacy ambiguity cannot fall through to ordinary status transport unavailability", async () => {
  const h = harness();
  const fill = fixture.originalPartialBuy.fills[0];
  h.journal.account_history = {
    accountingConflicts: { [fill.coin]: fill.time },
  };
  h.deps.readHip4OrderStatus = async () => {
    throw new Error("offline");
  };
  const result = await h.observe();
  assert.equal(result.state, "pending");
  if (result.state !== "pending") throw new Error("fixture");
  assert.equal(result.reason, "hip4_legacy_execution_conflict_unscoped");
  assert.ok(result.nativeEvidenceGuard);
  assert.equal(h.providerCalls.length, 0);
});

test("proven original quantity or adverse-price contradictions revoke exact purchase proof", async () => {
  for (const change of [{ sz: "57.0" }, { px: "0.27" }]) {
    const h = harness();
    h.setFills([{ ...fixture.originalPartialBuy.fills[0], ...change }]);
    assert.equal((await h.observe()).state, "revoked");
  }
});

test("unproved dual status remains unavailable, not revocation", async () => {
  const h = harness();
  const body = structuredClone(fixture.originalPartialBuy.orderStatus);
  Object.assign(body.order.order, {
    coin: "#133431",
    side: "A",
    limitPx: "0.74",
  });
  h.setBody(body);
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_social_dual_alias_unverified",
  });
});

test("legacy or inconsistent P2 receipt provenance cannot become verified money", async () => {
  const h = harness();
  h.setEntries([
    { execution: {}, provider_fill: fixture.originalPartialBuy.fills[0] },
  ]);
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_execution_provenance_conflict",
  });
  h.setEntries([{ execution: {}, provider_fill: null }]);
  assert.deepEqual(await h.observe(), {
    state: "pending",
    reason: "observation_unavailable:hip4_social_original_fills_not_observed",
  });
});

test("known precise original BUY contradiction revokes before missing, unknown or offline status", async () => {
  for (const status of ["missing", "unknown", "offline"]) {
    const h = harness();
    const provider_fill = fixture.originalPartialBuy.fills[0];
    const execution = projectHip4Execution(
      "mainnet",
      fixture.canonicalContract.owner,
      provider_fill,
    );
    h.setEntries([
      {
        execution,
        provider_fill,
        provider_evidence_status: {
          version: 1,
          revision: "1",
          state: "conflicted",
          reason: "execution_identity_conflict",
          retainedFingerprint: canonicalJsonHash(execution),
          observedFingerprint: "2".repeat(64),
          retainedBasisFingerprint: "1".repeat(64),
          observedBasisFingerprint: "2".repeat(64),
        },
      },
    ]);
    if (status === "missing") delete h.deps.readHip4OrderStatus;
    else if (status === "unknown") h.setBody({ status: "unknownOid" });
    else
      h.deps.readHip4OrderStatus = async () => {
        throw new Error("offline");
      };
    const result = await h.observe();
    assert.equal(result.state, "revoked");
    if (result.state !== "revoked") throw new Error("fixture");
    assert.equal(result.reason, "hip4_execution_evidence_conflict");
    assert.equal(result.nativeEvidenceGuard?.rows[0].revision, "1");
    assert.equal(h.providerCalls.length, 0);
  }
});

test("unsupported or another-cloid conflicted rows cannot revoke/quarantine/count original BUY, but stay in full guard", async () => {
  for (const representation of [
    { side: "A", dir: "Sell" },
    { cloid: `0x${"3".repeat(32)}` },
  ]) {
    const h = harness();
    const provider_fill = fixture.originalPartialBuy.fills[0];
    const execution = projectHip4Execution(
      "mainnet",
      fixture.canonicalContract.owner,
      provider_fill,
    );
    const matched = {
      version: 1,
      revision: "1",
      state: "matched",
      reason: null,
      retainedFingerprint: canonicalJsonHash(execution),
      observedFingerprint: canonicalJsonHash(execution),
      retainedBasisFingerprint: "1".repeat(64),
      observedBasisFingerprint: "1".repeat(64),
    };
    const uncounted = {
      ...provider_fill,
      ...representation,
      tid: provider_fill.tid + 1,
      time: provider_fill.time + 1,
    };
    h.journal.account_history = {
      accountingConflicts: { [provider_fill.coin]: uncounted.time },
    };
    h.setEntries([
      { execution, provider_fill, provider_evidence_status: matched },
      {
        execution: {},
        provider_fill: uncounted,
        provider_evidence_status: {
          ...matched,
          state: "conflicted",
          reason: "execution_identity_conflict",
        },
      },
    ]);
    const result = await h.observe();
    assert.equal(result.state, "verified");
    if (result.state !== "verified") throw new Error("fixture");
    assert.equal(result.facts.grossShares, "27");
    assert.equal(result.facts.grossNotionalUsd, "7.02");
    assert.equal(result.nativeEvidenceGuard?.rows.length, 2);
  }
});

test("bounded original-fill overflow uses existing evidence-budget recovery", async () => {
  const h = harness();
  h.deps.maxEvidenceItems = 1;
  h.setFills([
    fixture.originalPartialBuy.fills[0],
    fixture.originalPartialBuy.fills[0],
  ]);
  await assert.rejects(h.observe(), EvidenceBudgetExhausted);
});

test("exhausted shared native request budget stops the existing repair batch", async () => {
  const h = harness();
  h.deps.readHip4OrderStatus = async () => {
    throw new Hip4ReadError("budget_exhausted");
  };
  await assert.rejects(h.observe(), EvidenceBudgetExhausted);
});

test("signed native rebates and unknown denominations retain their actual evidence semantics", async () => {
  for (const [change, expected] of [
    [{ fee: "-0.00000001" }, "-0.00000001"],
    [{ fee: "0.12", feeToken: "OTHER" }, null],
  ] as const) {
    const h = harness();
    h.setFills([{ ...fixture.originalPartialBuy.fills[0], ...change }]);
    const result = await h.observe();
    assert.equal(result.state, "verified");
    if (result.state !== "verified") throw new Error("fixture");
    assert.equal(result.facts.feesUsd, expected);
  }
});
