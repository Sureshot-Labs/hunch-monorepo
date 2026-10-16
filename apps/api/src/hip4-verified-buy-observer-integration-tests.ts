// @requires-db — explicit disposable PG16 target; no provider/signing/exchange IO.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hip4Identity } from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction } from "./repos/hip4-order-preparation.js";
import {
  createVerifiedBuyObserver,
  createHip4NativeEvidenceFinalizer,
  HIP4_VERIFIED_BUY_FILLS_SQL,
  HIP4_VERIFIED_BUY_SOURCE_SQL,
  type VerifiedBuyObserverDependencies,
} from "./services/verified-buy-observer.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  repairVerifiedBuys,
  type PurchaseObservation,
} from "./services/verified-buy.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
} from "./services/hip4-account-repository.js";

const publicFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000 -c lock_timeout=2000",
});
const db = await pool.connect();
let depth = 0;
const nestedQuery = async (sql: string, args?: unknown[]) => {
  // The outer fixture already uses READ COMMITTED; PG forbids changing its
  // isolation after setup statements, unlike the helper's fresh runtime TX.
  if (sql === "set transaction isolation level read committed")
    return { rows: [] };
  if (sql === "begin") return db.query(`savepoint native_evidence_${++depth}`);
  if (sql === "commit")
    return db.query(`release savepoint native_evidence_${depth--}`);
  if (sql === "rollback") {
    const result = await db.query(
      `rollback to savepoint native_evidence_${depth}`,
    );
    await db.query(`release savepoint native_evidence_${depth--}`);
    return result;
  }
  return db.query(sql, args);
};
const transactionPool = {
  connect: async () => ({ query: nestedQuery, release: () => {} }),
} as unknown as Pool;
try {
  await db.query("begin");
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  const fixture = await hip4OrderTestFixture(db);
  const outcome = Number(fixture.request.marketId.split(":").at(-1));
  const identity = hip4Identity("mainnet", outcome);
  const selected = identity.sides[1];
  const native = mapHip4Market({
    ...publicFixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: publicFixture.collectedAt,
    generation: "replaceable-fixture-refresh",
  }).market;
  Object.assign(native, {
    marketId: identity.marketId,
    outcome,
    expiry: "2099-01-01T00:00:00.000Z",
    quoteToken: "USDC",
    quoteTokenId: HYPERCORE_MAINNET_USDC.assetId,
    quoteWeiDecimals: 8,
  });
  native.sides = native.sides.map((side, i) => ({
    ...side,
    ...identity.sides[i],
  }));
  await db.query(
    "update unified_markets set metadata=$2::jsonb,expiration_time=$3 where id=$1",
    [identity.marketId, JSON.stringify({ hip4: native }), native.expiry],
  );
  fixture.request.limitPrice = "0.4";
  fixture.request.quantity = "50";
  fixture.request.consentedDebitCapRaw = "2100000000";
  fixture.nonce -= 10000;
  fixture.feeCapRaw = "0";
  const prepared = await persistHip4OrderPreparationInTransaction(db, fixture);
  const oid = randomInt(1000000, 1000000000);
  // A synthetic admitted journal fixture, not a native admission/exchange call.
  await db.query(
    `insert into hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,debit_asset_id,debit_decimals,debit_raw)
    values($1,$2,'{}'::jsonb,$3,$4,8,'2000000000')`,
    [
      prepared.actionId,
      "1".repeat(64),
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ],
  );
  await db.query(
    "update orders set venue_order_id=$2,status='submitted' where id=$1",
    [prepared.orderId, String(oid)],
  );
  await db.query(
    "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1)",
    [fixture.profile.address],
  );
  const fill = {
    coin: selected.coin,
    px: "0.4",
    sz: "27.0",
    side: "B",
    time: fixture.nonce + 200,
    startPosition: "0.0",
    dir: "Buy",
    closedPnl: "0.0",
    hash: `0x${"2".repeat(64)}`,
    oid,
    crossed: false,
    fee: "-0.00000001",
    tid: 1,
    cloid: prepared.cloid,
    feeToken: "USDC",
    twapId: null,
  };
  const execution = projectHip4Execution(
    "mainnet",
    fixture.profile.address,
    fill,
  );
  await db.query(
    `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill,provider_fingerprint)
    values('mainnet',$1,$2,$3,1,$4,$5,$5,$6::jsonb,$7,$8::jsonb,$9)`,
    [
      fixture.profile.address,
      fill.time,
      fill.coin,
      oid,
      identity.marketId,
      JSON.stringify(execution),
      canonicalJsonHash(execution),
      JSON.stringify(fill),
      canonicalJsonHash(fill),
    ],
  );
  const response = {
    status: "order",
    order: {
      status: "canceled",
      statusTimestamp: fixture.nonce + 300,
      order: {
        coin: selected.coin,
        side: "B",
        oid,
        cloid: prepared.cloid,
        limitPx: "0.4",
        origSz: "50.0",
        sz: "23.0",
        timestamp: fixture.nonce + 100,
        orderType: "Limit",
        reduceOnly: false,
        tif: "Ioc",
      },
    },
  };
  let statusBody: unknown = response;
  let reads = 0;
  const unexpected = async () => {
    throw new Error("unexpected_provider_read");
  };
  const dependencies: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: "unused",
    limitlessExchangeAddress: "unused",
    solanaCollateralMint: "unused",
    readEvmReceipt: unexpected,
    readFinalizedSolanaTransaction: unexpected,
    readLimitlessOrder: unexpected,
    readDflowOrder: unexpected,
    readPolymarketFills: unexpected,
    readHip4OrderStatus: async (request) => {
      assert.deepEqual(request, {
        environment: "mainnet",
        accountAddress: fixture.profile.address,
        cloid: prepared.cloid,
      });
      reads++;
      return statusBody;
    },
  };
  const observer = createVerifiedBuyObserver(db, dependencies);
  const claim = {
    purchaseRef: { kind: "order" as const, id: prepared.orderId },
    userId: fixture.userId,
    leaseToken: randomUUID(),
    attempts: 1,
  };
  const result = await observer(claim);
  assert.equal(result.state, "verified");
  if (result.state !== "verified") throw new Error("fixture");
  assert.equal(result.facts.grossNotionalUsd, "10.8");
  assert.equal(result.facts.netShares, "27");
  assert.equal(result.facts.feesUsd, "-0.00000001");
  assert.equal(result.facts.instrument.outcome, "NO");
  // Today's replacement metadata is not the purchase's frozen contract terms.
  await db.query(
    "update unified_markets set metadata='{}'::jsonb where id=$1",
    [identity.marketId],
  );
  const unchanged = await observer(claim);
  assert.equal(unchanged.state, "verified");
  if (unchanged.state !== "verified") throw new Error("fixture");
  assert.equal(unchanged.facts.evidenceRevision, result.facts.evidenceRevision);
  const unauthorized = await db.query(HIP4_VERIFIED_BUY_SOURCE_SQL, [
    prepared.orderId,
    randomUUID(),
  ]);
  assert.equal(unauthorized.rowCount, 0);
  const plans = [];
  for (const [sql, parameters] of [
    [HIP4_VERIFIED_BUY_SOURCE_SQL, [prepared.orderId, fixture.userId]],
    [
      HIP4_VERIFIED_BUY_FILLS_SQL,
      ["mainnet", fixture.profile.address, selected.coin, String(oid), 11],
    ],
  ] as const) {
    const plan = (
      await db.query(`explain (analyze,buffers,format json) ${sql}`, [
        ...parameters,
      ])
    ).rows[0]["QUERY PLAN"][0];
    plans.push({
      executionMs: plan["Execution Time"],
      rows: plan.Plan["Actual Rows"],
      sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
    });
  }
  statusBody = { status: "unknownOid" };
  assert.deepEqual(await observer(claim), {
    state: "pending",
    reason: "observation_unavailable:hip4_order_not_observed",
  });
  statusBody = structuredClone(response);
  (statusBody as typeof response).order.order.oid++;
  const contradicted = await observer(claim);
  assert.equal(contradicted.state, "revoked");
  if (contradicted.state !== "revoked") throw new Error("fixture");
  assert.equal(contradicted.reason, "order_identity_conflict");
  assert.ok(contradicted.nativeEvidenceGuard);
  assert.equal(reads, 4);
  statusBody = response;
  const finalizer = createHip4NativeEvidenceFinalizer(transactionPool);
  async function repairOnce(observation?: PurchaseObservation) {
    let claimed = false;
    const exactClaimDb = {
      query: async (sql: string, args: unknown[]) => {
        if (!sql.includes("with due_purchase")) return db.query(sql, args);
        if (claimed || sql.includes("from executions")) return { rows: [] };
        claimed = true;
        // Test only queue isolation; finalization executes the real production
        // stored-purchase/thesis/Copy CTE under its real account lock.
        return db.query(
          `update orders set verified_buy_lease_token=gen_random_uuid(),verified_buy_lease_until=now()+interval '60 seconds',verified_buy_attempts=verified_buy_attempts+1
        where id=$1 and user_id=$2 returning id,user_id,verified_buy_lease_token,verified_buy_attempts`,
          [prepared.orderId, fixture.userId],
        );
      },
    } as unknown as Pick<Pool, "query">;
    return repairVerifiedBuys(exactClaimDb, {
      batchSize: 1,
      leaseSeconds: 60,
      retrySeconds: 1,
      verifiedRecheckSeconds: 60,
      observe: async (purchase) => observation ?? observer(purchase),
      finalizeNativeEvidence: finalizer,
    });
  }
  async function save(sources: Array<typeof fill>, withSources = true) {
    const lease = await claimHip4AccountRefresh(
      db,
      "mainnet",
      fixture.profile.address,
      60000,
      new Date(),
    );
    assert.ok(lease);
    assert.equal(
      await persistHip4AccountRefresh(transactionPool, {
        environment: "mainnet",
        address: fixture.profile.address,
        lease,
        observation: null,
        executions: sources.map((source) =>
          projectHip4Execution("mainnet", fixture.profile.address, source),
        ),
        ...(withSources ? { executionSources: sources } : {}),
        ledger: [],
        history: {},
        error: null,
      }),
      true,
    );
  }
  await db.query(
    "update hip4_account_snapshots set history=jsonb_build_object('accountingConflicts',jsonb_build_object($2::text,$3::bigint)) where environment='mainnet' and account_address=$1",
    [fixture.profile.address, fill.coin, fill.time],
  );
  const legacyAmbiguous = await observer(claim);
  assert.equal(legacyAmbiguous.state, "pending");
  if (legacyAmbiguous.state !== "pending") throw new Error("fixture");
  assert.equal(
    legacyAmbiguous.reason,
    "hip4_legacy_execution_conflict_unscoped",
  );
  assert.ok(legacyAmbiguous.nativeEvidenceGuard);
  let sourceRechecks = 0;
  dependencies.recheckHip4OrderFills = async (scope) => {
    sourceRechecks++;
    assert.deepEqual(scope, {
      environment: "mainnet",
      accountAddress: fixture.profile.address,
      coin: fill.coin,
      orderId: String(oid),
      timeMs: fill.time,
    });
    await save([fill], false);
  };
  assert.equal((await observer(claim)).state, "pending");
  assert.equal(sourceRechecks, 1);
  dependencies.recheckHip4OrderFills = async () => {
    sourceRechecks++;
    await save([fill]);
  };
  const legacyRestored = await observer(claim);
  assert.equal(
    legacyRestored.state,
    "verified",
    "one exact official matching recheck immediately clears only the legacy row",
  );
  assert.equal(sourceRechecks, 2);
  assert.equal(legacyRestored.nativeEvidenceGuard?.rows[0].revision, "1");
  assert.equal((await repairOnce()).verified, 1);
  const thesisId = randomUUID(),
    copyId = randomUUID();
  await db.query(
    `insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,expiry,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash)
    values($1,$2,$3,$4,$5,$5,$6,'NO',$7,$8,'Synthetic proof-projection fixture',$9::jsonb,'fixture',10.8,$10,$11)`,
    [
      thesisId,
      fixture.userId,
      result.facts.canonicalPurchaseKey,
      prepared.orderId,
      identity.marketId,
      selected.tokenId,
      result.facts.instrument.generation,
      result.facts.instrument.expiry,
      JSON.stringify(result.facts),
      randomUUID(),
      "1".repeat(64),
    ],
  );
  // Direct projection fixture, not a source-authorization/admission request.
  await db.query(
    `insert into copy_attributions(id,copier_user_id,source_thesis_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,order_id,created_at)
    values($1,$2,$3,'{}',$4::jsonb,$5,$6,$6,$7,$8,$9)`,
    [
      copyId,
      fixture.userId,
      thesisId,
      JSON.stringify(result.facts.instrument),
      randomUUID(),
      "1".repeat(64),
      `fixture:${copyId}`,
      prepared.orderId,
      new Date(fill.time - 1000),
    ],
  );
  assert.equal((await repairOnce()).verified, 1);
  const beforeQuarantine = (
    await db.query("select verified_buy_facts from orders where id=$1", [
      prepared.orderId,
    ])
  ).rows[0].verified_buy_facts;
  const beforeCopy = (
    await db.query("select * from copy_attributions where id=$1", [copyId])
  ).rows[0];
  assert.equal(beforeCopy.state, "confirmed");
  // Recreate an exact pre-0347 legacy row with retained source and only its
  // historical coarse diagnostic. This fixture-only reset is rolled back.
  await db.query(
    "update hip4_account_executions set provider_evidence_status=null where environment='mainnet' and account_address=$1 and coin=$2 and oid=$3 and tid=1",
    [fixture.profile.address, fill.coin, oid],
  );
  delete dependencies.recheckHip4OrderFills;
  const lateLegacyPending = await observer(claim);
  assert.equal((await repairOnce(lateLegacyPending)).pending, 1);
  const quarantined = (
    await db.query(
      "select verified_buy_state,verified_buy_facts from orders where id=$1",
      [prepared.orderId],
    )
  ).rows[0];
  assert.equal(quarantined.verified_buy_state, "pending");
  assert.deepEqual(
    quarantined.verified_buy_facts,
    beforeQuarantine,
    "quarantine retains raw financial facts and exact purchase identity",
  );
  assert.ok(
    (
      await db.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesisId],
      )
    ).rows[0].proof_invalidated_at,
  );
  const pendingCopy = (
    await db.query("select * from copy_attributions where id=$1", [copyId])
  ).rows[0];
  assert.equal(pendingCopy.state, "pending");
  assert.equal(
    pendingCopy.canonical_purchase_key,
    beforeCopy.canonical_purchase_key,
  );
  assert.deepEqual(pendingCopy.execution_facts, beforeCopy.execution_facts);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from copy_attributions where id=$1 and state='confirmed'",
        [copyId],
      )
    ).rows[0].n,
    0,
  );
  dependencies.recheckHip4OrderFills = async () => {
    await save([fill]);
  };
  assert.equal((await repairOnce()).verified, 1);
  assert.equal(
    (
      await db.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesisId],
      )
    ).rows[0].proof_invalidated_at,
    null,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from copy_attributions where id=$1 and state='confirmed'",
        [copyId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await repairOnce(lateLegacyPending)).pending,
    1,
    "late guarded ambiguity must not overwrite restored proof",
  );
  assert.equal(
    (
      await db.query("select verified_buy_state from orders where id=$1", [
        prepared.orderId,
      ])
    ).rows[0].verified_buy_state,
    "verified",
  );
  assert.equal(
    (
      await db.query("select state from copy_attributions where id=$1", [
        copyId,
      ])
    ).rows[0].state,
    "confirmed",
  );
  const staleVerified = await observer(claim);
  await save([{ ...fill, sz: "28.0" }]);
  assert.equal(
    (await repairOnce(staleVerified)).pending,
    1,
    "concurrent marker change must not store stale verified observation",
  );
  assert.equal(
    (
      await db.query("select verified_buy_state from orders where id=$1", [
        prepared.orderId,
      ])
    ).rows[0].verified_buy_state,
    "verified",
  );
  assert.equal((await repairOnce()).revoked, 1);
  assert.ok(
    (
      await db.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesisId],
      )
    ).rows[0].proof_invalidated_at,
  );
  assert.equal(
    (
      await db.query("select state from copy_attributions where id=$1", [
        copyId,
      ])
    ).rows[0].state,
    "revoked",
  );
  await save([fill], false);
  assert.equal(
    (await observer(claim)).state,
    "revoked",
    "source-absent projected replay cannot clear positive conflict",
  );
  statusBody = { status: "unknownOid" };
  assert.equal(
    (await repairOnce()).revoked,
    1,
    "known exact original conflict takes precedence over unavailable status",
  );
  assert.equal(
    (
      await db.query("select verified_buy_state from orders where id=$1", [
        prepared.orderId,
      ])
    ).rows[0].verified_buy_state,
    "revoked",
    "transient observation must preserve known revoked state",
  );
  statusBody = response;
  const staleRevoked = await observer(claim);
  await save([fill]);
  assert.equal(
    (await repairOnce(staleRevoked)).pending,
    1,
    "old conflict observation must not overwrite restored provider proof",
  );
  assert.equal((await repairOnce()).verified, 1);
  assert.equal(
    (
      await db.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesisId],
      )
    ).rows[0].proof_invalidated_at,
    null,
  );
  assert.equal(
    (
      await db.query("select state from copy_attributions where id=$1", [
        copyId,
      ])
    ).rows[0].state,
    "confirmed",
  );
  // A conflict on another original OID, even on this exact coin, is irrelevant.
  const other = { ...fill, oid: oid + 1, tid: 2 };
  await save([other]);
  await save([{ ...other, sz: "28.0" }]);
  assert.equal((await observer(claim)).state, "verified");
  assert.equal(depth, 0);
  console.log(
    JSON.stringify({
      test: "hip4-verified-buy-observer-pg16",
      checks:
        "exact owned admitted journal, frozen generation, P2 provenance, signed rebate, precise conflict revocation and matching recovery through real guarded purchase/thesis/Copy CTE, stale-revision retry, unrelated OID independence",
      plans,
      representativeScale: false,
    }),
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
