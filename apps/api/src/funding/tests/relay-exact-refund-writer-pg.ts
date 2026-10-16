import assert from "node:assert/strict";
import { verifyRefundCanonicalWatchPg } from "./refund-canonical-watch-pg.js";
import { verifyReceiveRecordedRefundPg } from "./receive-recorded-refund-pg.js";
import { verifyExactRefundRemineGuardPg } from "./exact-refund-remine-guard-pg.js";
import { verifyRefundCompetingRolesPg } from "./refund-competing-roles-pg.js";
import type { Pool, PoolClient } from "pg";
import type { AssetLocation } from "../domain/types.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { relayRequestEvidenceSchema } from "../../funding-providers/relay/request-evidence.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import {
  advanceFundingObservationFinalityInTransaction,
  listFundingObservationsForOperation,
} from "../persistence/funding-operation-repository.js";
import {
  recordRelayExactRefundReceiptsInTransaction,
  RelayExactRefundSnapshotChanged,
  loadRelayExactRefundContext,
  RELAY_EXACT_REFUND_CONTEXT_SQL,
} from "../reconciliation/relay-exact-refund-receipts.js";
import {
  readRefundCompletionPage,
  type RefundCompletionProgress,
} from "../reconciliation/relay-refund-completion-scan.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import { readRelayExactRefundEvidence } from "../../funding-providers/relay/exact-refund-observer.js";
import { Hip4ReadError } from "../../services/hip4-client.js";
import { RelayClient } from "../../funding-providers/relay/client.js";
import { RelayReconciliationDriver } from "../../funding-providers/relay/reconciliation.js";
import { reconcileRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-runtime.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { ingestFundingObservationInTransaction } from "../reconciliation/funding-observation-ingestion.js";
import {
  loadFundingAccountValueFacts,
  loadFundingSnapshotDebits,
  fundingRefundSnapshotLagOperations,
  fundingInvalidatedRefundComponentIds,
} from "../../account-value/funding-movement-feed.js";
import type { ValuedAssetComponent } from "../domain/types.js";
import {
  classifyRecordedRelayExactRefundEvents,
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";
import {
  loadRefundSourceCandidatePage,
  matchRefundSourceEnvelope,
  type RefundSourceCursor,
} from "../reconciliation/relay-refund-source-candidates.js";

type RefundFixtureInput = {
  operationId: string;
  segmentId: string;
  requestId: string;
  referenceCodec: RelayReferenceCodec;
  protocolOrderId: string;
  source: AssetLocation;
  target: AssetLocation;
  now: Date;
};

/** Synthetic exact evidence, shared by single-transaction and concurrent PG
 * tests. No network, wallet keys, signatures, or production identifiers. */
export function relayExactRefundTestFixture(input: RefundFixtureInput) {
  const native = input.target.asset.networkId === "hyperliquid:mainnet";
  const chainId = native ? 1337 : Number(input.target.asset.networkId.slice(4));
  const originChain =
    input.source.asset.networkId === "hyperliquid:mainnet"
      ? 1337
      : Number(input.source.asset.networkId.slice(4));
  const owner = String(input.target.details.address);
  const provider = `0x${"ab".repeat(20)}`;
  const baseTime = input.now.getTime();
  const unit = 10n ** BigInt(input.target.asset.decimals);
  const hashes = [0, 1].map(
    (index) => `0x${canonicalJsonHash([input.requestId, index])}`,
  );
  const amounts = [4n * unit, (58n * unit) / 10n].map(String);
  const transactions = hashes.map((hash, index) => ({
    txHash: hash,
    chainId,
    status: "success",
    block: 123 + index,
    timestamp: Math.floor(baseTime / 1000) + index * 10,
    data: native
      ? {
          hash,
          error: null,
          user: provider,
          action: {
            type: "sendAsset",
            hyperliquidChain: "Mainnet",
            destination: owner,
            sourceDex: "",
            destinationDex: "",
            token: `USDC:${input.target.asset.assetId}`,
            amount: index === 0 ? "4" : "5.8",
            fromSubAccount: "",
            nonce: baseTime + index * 10000,
          },
        }
      : null,
  }));
  const ledger = hashes.map((hash, index) => ({
    hash,
    time: baseTime + index * 10000,
    privateField: "must-not-be-retained",
    delta: {
      type: "send",
      user: provider,
      destination: owner,
      sourceDex: "",
      destinationDex: "",
      token: "USDC",
      amount: index === 0 ? "4" : "5.8",
      usdcValue: index === 0 ? "4" : "5.8",
      fee: "0",
      nativeTokenFee: "0",
      feeToken: "USDC",
      nonce: baseTime + index * 10000,
    },
  }));
  const evm = hashes.map(
    (hash, index) =>
      ({
        networkId: input.target.asset.networkId,
        asset: input.target.asset,
        sourceAddress: provider,
        destinationAddress: owner,
        rawAmount: amounts[index],
        transactionHash: hash,
        eventIndex: String(7 + index),
        ledgerHeight: String(123 + index),
        blockHash: `0x${"ed".repeat(32)}`,
        observedAt: input.now,
      }) satisfies OwnedRouteCanonicalDestinationEvent,
  );
  const sourceCurrency = {
    chainId: originChain,
    address: input.source.asset.assetId,
    decimals: input.source.asset.decimals,
  };
  const targetCurrency = {
    chainId,
    address: native ? `0x${"0".repeat(32)}` : input.target.asset.assetId,
    decimals: input.target.asset.decimals,
  };
  const request = relayRequestEvidenceSchema.parse({
    id: input.requestId,
    status: "refund",
    sender: input.source.details.address,
    protocol: {
      orderId: input.protocolOrderId,
      settlement: {
        destination: {
          refunds: hashes.map((transactionId) => ({
            chainId,
            transactionId,
          })),
        },
      },
    },
    data: {
      outTxs: transactions,
      refundCurrencyData: {
        amount: amounts
          .map(BigInt)
          .reduce((a, b) => a + b)
          .toString(),
        currency: targetCurrency,
      },
      route: {
        actual: {
          origin: {
            inputCurrency: {
              amount: (
                10n *
                10n ** BigInt(input.source.asset.decimals)
              ).toString(),
              currency: sourceCurrency,
            },
          },
          destination: {
            outputCurrency: { amount: "0", currency: targetCurrency },
          },
        },
      },
    },
  });
  const status = {
    requestId: input.requestId,
    status: "refund",
    txHashes: hashes,
  };
  const base = { ...input, request, status };
  const events = (index: number) =>
    native ? { nativeLedger: [ledger[index]] } : { evmEvents: [evm[index]] };
  const expected = {
    requestId: input.requestId,
    protocolOrderId: input.protocolOrderId,
    source: input.source,
    sourceAmount: {
      asset: input.source.asset,
      raw: (10n * 10n ** BigInt(input.source.asset.decimals)).toString(),
    },
    refundLocations: [input.target],
  };
  return {
    native,
    owner,
    baseTime,
    hashes,
    transactions,
    ledger,
    evm,
    request,
    status,
    base,
    events,
    expected,
  };
}

/** Called by the rollback-only HIP funding PG16 integration suite against real
 * committed native/inbound plans. No transport, signing, or worker execution. */
export async function verifyRelayExactRefundWriterPg(
  db: Pick<PoolClient, "query">,
  input: RefundFixtureInput,
) {
  await db.query("savepoint exact_refund_writer");
  try {
    // An actual canonical debit is distinct from the refund claim and remains
    // suppressed after the partial and complete refund; all fixtures roll back.
    await ingestFundingObservationInTransaction(db, {
      discoverySource: "chain_rpc",
      observation: {
        operationId: input.operationId,
        segmentId: input.segmentId,
        kind: "source_debit",
        networkId: input.source.asset.networkId,
        assetId: input.source.asset.assetId,
        assetDecimals: input.source.asset.decimals,
        txHash: `0x${canonicalJsonHash([input.requestId, "source-debit"])}`,
        eventIndex: "test-source-debit",
        fromAddress: String(input.source.details.address),
        toAddress: `0x${"ab".repeat(20)}`,
        rawAmount: (
          10n *
          10n ** BigInt(input.source.asset.decimals)
        ).toString(),
        observedAt: input.now,
        finalizedAt: input.now,
        finalityStatus: "finalized",
        ledgerHeight: "122",
        blockHash: `0x${"ed".repeat(32)}`,
      },
    });
    const reservation = (
      await db.query(
        "select user_id,component_id,location_id from balance_reservations where operation_id=$1 and segment_id=$2 and mode='subtract_available' order by created_at limit 1",
        [input.operationId, input.segmentId],
      )
    ).rows[0];
    assert.ok(reservation);
    const staleSource = {
      componentId: reservation.component_id,
      location: {
        ...input.source,
        accountId: reservation.user_id,
        locationId: reservation.location_id,
      },
      amount: {
        asset: input.source.asset,
        raw: (100n * 10n ** BigInt(input.source.asset.decimals)).toString(),
      },
      observedAt: new Date(input.now.getTime() - 1000).toISOString(),
      observationFreshness: "fresh",
      observationError: null,
    } as ValuedAssetComponent;
    let movementSql = "";
    const movementDb = {
      query: async (sql: string, values: unknown[]) => {
        if (sql.includes("with owned_operations as materialized"))
          movementSql = sql;
        return db.query(sql, values);
      },
    };
    const checkMovement = async (expectedRaw: string | null) => {
      const facts = await loadFundingAccountValueFacts(
        movementDb as never,
        reservation.user_id,
      );
      const movement = facts.inTransit.find(
        (row) =>
          row.operationId === input.operationId &&
          row.segmentId === input.segmentId,
      );
      assert.equal(movement?.amount.raw ?? null, expectedRaw);
      if (movement) assert.equal(movement.observationError ?? null, null);
      const debits = await loadFundingSnapshotDebits(
        db as never,
        reservation.user_id,
        [staleSource],
      );
      assert.equal(
        debits
          .filter((row) => row.operationId === input.operationId)
          .reduce((sum, row) => sum + BigInt(row.amount.raw), 0n),
        10n * 10n ** BigInt(input.source.asset.decimals),
      );
    };
    await checkMovement(
      (10n * 10n ** BigInt(input.source.asset.decimals)).toString(),
    );
    const {
      native,
      owner,
      baseTime,
      hashes,
      transactions,
      ledger,
      evm,
      request,
      status,
      base,
      events,
      expected,
    } = relayExactRefundTestFixture(input);
    const verifySourceEnumeration = async () => {
      if (native) return;
      const cutoff = (
        await db.query("select clock_timestamp()::text as cutoff")
      ).rows[0].cutoff;
      let cursor: RefundSourceCursor | null = null;
      let found = false;
      do {
        const page = await loadRefundSourceCandidatePage(db, {
          userId: reservation.user_id,
          scanBefore: cutoff,
          cursor,
          limit: 2,
        });
        const target = page.rows.find(
          (row) => row.segment_id === input.segmentId,
        );
        if (target) {
          found = true;
          assert.equal(
            matchRefundSourceEnvelope(reservation.user_id, evm[0], target).kind,
            "candidate",
          );
        }
        cursor = page.nextCursor;
      } while (cursor);
      assert.ok(
        found,
        "immutable matching source survives mutable lifecycle state",
      );
    };
    await verifySourceEnumeration();
    let nativeCalls = 0;
    let evmCalls = 0;
    const readSlice = (receiptIndex: number, ledgerAfterSecond?: number) =>
      readRelayExactRefundEvidence(
        { expected, status, now: input.now, ledgerAfterSecond },
        {
          requestEvidence: async (requestId) => {
            assert.equal(requestId, input.requestId);
            return request;
          },
          readNativeLedger: async (address, start, end) => {
            assert.equal(address, owner);
            assert.equal(end - start, 999);
            if (++nativeCalls > 1) throw new Hip4ReadError("budget_exhausted");
            const index = transactions.findIndex(
              (transaction) => transaction.timestamp * 1000 === start,
            );
            assert.ok(index >= 0);
            return [ledger[index]];
          },
          readEvm: async (read) => {
            evmCalls += 1;
            assert.equal(read.transactionHashes.length, 1);
            assert.ok(hashes.includes(read.transactionHashes[0]));
            assert.deepEqual(read.asset, input.target.asset);
            assert.equal(read.destinationAddress, owner);
            if (read.transactionHashes[0] !== hashes[receiptIndex])
              throw new Error("private-sibling-rpc-url-must-not-leak");
            return [evm[receiptIndex]];
          },
        },
      );
    const wrongRead = await readRelayExactRefundEvidence(
      { expected, status, now: input.now },
      {
        requestEvidence: async () => ({
          ...request,
          protocol: { ...request.protocol, orderId: `0x${"0".repeat(64)}` },
        }),
        readNativeLedger: async () => {
          assert.fail("wrong-order RPC read");
        },
        readEvm: async () => {
          assert.fail("wrong-order RPC read");
        },
      },
    );
    assert.deepEqual(wrongRead, {
      kind: "pending",
      reason: "refund_request_identity_mismatch",
    });
    assert.deepEqual(
      await readRelayExactRefundEvidence(
        { expected, status, now: input.now },
        {
          requestEvidence: async () => {
            throw new Error("secret-private-transport-url");
          },
          readNativeLedger: async () => [],
          readEvm: async () => [],
        },
      ),
      {
        kind: "pending",
        reason: "refund_receipt_configuration_or_transport_error",
      },
    );
    const firstRead = await readSlice(0);
    assert.equal(firstRead.kind, "observed");
    const readReason = native
      ? "native_ledger_budget_exhausted"
      : "refund_evm_receipt_transport_error";
    assert.equal(firstRead.reason, readReason);
    nativeCalls = 0;
    const secondRead = await readSlice(
      1,
      "ledgerAfterSecond" in firstRead
        ? firstRead.ledgerAfterSecond
        : undefined,
    );
    assert.equal(secondRead.kind, "observed");
    assert.equal(secondRead.reason, readReason);
    if (native) {
      assert.deepEqual(firstRead.nativeLedger, [ledger[0]]);
      assert.deepEqual(secondRead.nativeLedger, [ledger[1]]);
      assert.equal(evmCalls, 0);
    } else {
      assert.equal(nativeCalls, 0);
      assert.equal(evmCalls, 4);
      assert.deepEqual(firstRead.evmEvents, [evm[0]]);
      assert.deepEqual(secondRead.evmEvents, [evm[1]]);
    }

    // Exercise the real provider driver and status persistence. Nested tx()
    // becomes a savepoint so every synthetic row stays in the outer rollback.
    const transactionClient = {
      query: (sql: string, values?: unknown[]) =>
        db.query(
          sql === "begin"
            ? "savepoint provider_poll"
            : sql === "commit"
              ? "release savepoint provider_poll"
              : sql === "rollback"
                ? "rollback to savepoint provider_poll"
                : sql,
          values,
        ),
      release: () => undefined,
    };
    const driverQueries: string[] = [];
    const driverPool = {
      query: (sql: string, values?: unknown[]) => {
        driverQueries.push(sql);
        return db.query(sql, values);
      },
      connect: async () => transactionClient,
    } as unknown as Pool;
    let pollStatus = "refund_in_progress";
    let pollNumber = 0;
    const callbacks: string[] = [];
    const afterPersist = async (
      _pool: Pool,
      target: { status: { status: string }; segmentId: string },
    ) => {
      assert.equal(target.segmentId, input.segmentId);
      assert.equal(
        (
          await db.query(
            "select raw_status from funding_operation_segments where id=$1",
            [input.segmentId],
          )
        ).rows[0].raw_status,
        pollStatus,
      );
      callbacks.push(target.status.status);
    };
    const relayClient = new RelayClient({
      apiKey: "offline-refund-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            requestId: input.requestId,
            status: pollStatus,
            txHashes: hashes,
            updatedAt: baseTime + ++pollNumber,
          }),
          { status: 200 },
        ),
    });
    const driver = new RelayReconciliationDriver(
      relayClient,
      input.referenceCodec,
      input.referenceCodec,
      async (...args) => {
        assert.equal(pollStatus, "success");
        await afterPersist(...args);
      },
      async (...args) => {
        assert.ok(["refund", "refund_in_progress"].includes(pollStatus));
        await afterPersist(...args);
      },
    );
    for (const state of [
      "refund_in_progress",
      "refund",
      "success",
      "pending",
    ]) {
      pollStatus = state;
      await driver.pollOperation(driverPool, input.operationId, input.now);
    }
    assert.deepEqual(callbacks, ["refund_in_progress", "refund", "success"]);
    const requestBindings = async () =>
      (
        await db.query(
          `select request_ref_lookup_hmac, lookup_key_version, request_ref_ciphertext
       from funding_provider_requests where segment_id=$1 order by id`,
          [input.segmentId],
        )
      ).rows;
    const frozenBindings = await requestBindings();
    assert.equal(frozenBindings.length, 1);
    const rotatedDriver = new RelayReconciliationDriver(
      relayClient,
      {
        ...input.referenceCodec,
        keyVersion: input.referenceCodec.keyVersion + 1,
        fingerprint: () => "f".repeat(64),
      },
      input.referenceCodec,
    );
    for (let replay = 0; replay < 2; replay += 1) {
      await rotatedDriver.pollOperation(
        driverPool,
        input.operationId,
        input.now,
      );
      assert.deepEqual(
        await requestBindings(),
        frozenBindings,
        "polling after HMAC-key rotation retains the one committed request",
      );
    }
    const lifecycle = async () => {
      const facts = await loadFundingLifecycleFactsForOperationInTransaction(
        db,
        input,
      );
      assert.ok(facts);
      return deriveFundingLifecycle(facts);
    };
    const calls: string[] = [];
    const traced = {
      query: async (sql: string, values: unknown[]) => {
        calls.push(sql);
        return db.query(sql, values);
      },
    } as Pick<PoolClient, "query">;
    await db.query("savepoint exact_refund_runtime");
    const runtimePool = {
      ...driverPool,
      query: traced.query,
    } as unknown as Pool;
    let observationsRead = 0;
    const observe: Parameters<
      typeof reconcileRelayExactRefundReceipts
    >[3] = async (_pool, _relay, read) => {
      assert.equal(read.expected.requestId, input.requestId);
      assert.equal(
        read.ledgerAfterSecond,
        observationsRead === 0 || !native
          ? undefined
          : transactions[0].timestamp,
      );
      return observationsRead++ === 0 ? firstRead : secondRead;
    };
    const partialRuntime = await reconcileRelayExactRefundReceipts(
      runtimePool,
      relayClient,
      base,
      observe,
    );
    // Native compatibility remains in this rollback-only effect fixture.
    // EVM runtime without a real job context must not use the old tx writer;
    // committed runtime/worker fixtures exercise its pool-level publisher.
    assert.equal(partialRuntime.kind, native ? "partial" : "pending");
    const completeRuntime = await reconcileRelayExactRefundReceipts(
      runtimePool,
      relayClient,
      base,
      observe,
    );
    assert.equal(completeRuntime.kind, native ? "complete" : "pending");
    if (!native)
      assert.deepEqual(completeRuntime, {
        kind: "pending",
        reason: "role_work_context_pending",
      });
    const diagnostic = (
      await db.query(
        "select support_metadata from funding_operation_segments where id=$1",
        [input.segmentId],
      )
    ).rows[0].support_metadata;
    assert.equal(
      diagnostic.exactRefundReceipts.result,
      native ? "complete" : "pending",
    );
    assert.equal(
      diagnostic.exactRefundReceipts.reason,
      native ? null : "role_work_context_pending",
    );
    assert.equal(diagnostic.exactRefundReceipts.observationReason, readReason);
    assert.ok(
      diagnostic.relayStatusCategory,
      "refund diagnostics preserve the existing driver metadata",
    );
    const diagnosticSql = calls.find(
      (sql) =>
        sql.includes("set support_metadata=jsonb_set") &&
        sql.includes("exactRefundReceipts"),
    );
    assert.ok(diagnosticSql);
    await db.query("rollback to savepoint exact_refund_runtime");
    await db.query("release savepoint exact_refund_runtime");
    calls.length = 0;
    const wrong = await recordRelayExactRefundReceiptsInTransaction(traced, {
      ...base,
      request: {
        ...request,
        protocol: { ...request.protocol, orderId: `0x${"0".repeat(64)}` },
      },
      ...events(0),
    });
    assert.deepEqual(wrong, {
      kind: "pending",
      reason: "refund_request_identity_mismatch",
    });
    assert.equal(
      (await listFundingObservationsForOperation(db, input.operationId)).filter(
        (row) => row.kind === "refund_credit",
      ).length,
      0,
    );
    if (!native) {
      const unseen = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: evm,
      });
      assert.ok(
        [...unseen.values()].every((decision) => decision.kind === "unmatched"),
      );
    }
    if (!native)
      await verifyRefundCompetingRolesPg(
        db,
        { ...base, ...events(0) },
        input.target,
      );
    const first = await recordRelayExactRefundReceiptsInTransaction(traced, {
      ...base,
      nativeLedger: firstRead.nativeLedger,
      evmEvents: firstRead.evmEvents,
    });
    assert.equal(first.kind, "partial");
    const refundContext = await loadRelayExactRefundContext(db, base);
    assert.equal(refundContext.kind, "ready");
    if (refundContext.kind !== "ready")
      assert.fail("expected committed refund contract");
    const readCurrentRefundSet = async () => {
      let progress: RefundCompletionProgress = { kind: "unchecked" };
      for (let page = 0; page < 3; page++) {
        progress = await readRefundCompletionPage(db, {
          operationId: input.operationId,
          segmentId: input.segmentId,
          contract: refundContext.contract,
          progress,
          limit: 1,
        });
        if (progress.kind !== "reading") return progress;
      }
      assert.fail("two writer receipts must finish in two pages");
    };
    assert.deepEqual(await readCurrentRefundSet(), {
      kind: "pending",
      reason: "proof_missing",
    });
    await checkMovement(
      (6n * 10n ** BigInt(input.source.asset.decimals)).toString(),
    );
    assert.equal("inserted" in first && first.inserted, 1);
    assert.equal((await lifecycle()).safety.reservationsMayRelease, false);
    if (!native) {
      await verifyExactRefundRemineGuardPg(db, {
        operationId: input.operationId,
        transactionHash: hashes[0],
        now: input.now,
      });
      const recorded = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: evm,
      });
      assert.deepEqual(recorded.get(refundCanonicalEventKey(evm[0])), {
        kind: "internal",
        operationId: input.operationId,
        segmentId: input.segmentId,
      });
      const evidence = (
        await readRecordedRelayRefundRoleEvidence(db, {
          userId: reservation.user_id,
          events: evm,
        })
      ).get(refundCanonicalEventKey(evm[0]));
      assert.deepEqual(
        evidence?.classification,
        recorded.get(refundCanonicalEventKey(evm[0])),
      );
      assert.deepEqual(evidence?.dependencies, [
        {
          userId: reservation.user_id,
          operationId: input.operationId,
          revision: (
            await db.query(
              "select coalesce((select revision from funding_classification_revisions where operation_id=$1),0)::text as revision",
              [input.operationId],
            )
          ).rows[0].revision,
        },
      ]);
      assert.equal(
        recorded.get(refundCanonicalEventKey(evm[1]))?.kind,
        "unmatched",
      );
      const wrongValue = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: [{ ...evm[0], rawAmount: "1" }],
      });
      assert.equal(
        wrongValue.get(refundCanonicalEventKey(evm[0]))?.kind,
        "recovery_required",
      );
      await verifyReceiveRecordedRefundPg(db, driverPool, {
        userId: reservation.user_id,
        operationId: input.operationId,
        segmentId: input.segmentId,
        event: evm[0],
        now: input.now,
        referenceCodec: input.referenceCodec,
      });
      const quarantine = calls.findIndex((sql) =>
        sql.includes("insert into funding_receive_canonical_events"),
      );
      const operationLock = calls.findIndex(
        (sql) =>
          sql.includes("select id from funding_operations") &&
          sql.includes("for update"),
      );
      assert.ok(
        quarantine >= 0 && operationLock > quarantine,
        "canonical-event locks precede operation lock",
      );
      assert.deepEqual(
        (
          await db.query(
            "select allocation_status,allocation_error_code from funding_receive_canonical_events where network_id=$1 and tx_hash=$2",
            [input.target.asset.networkId, hashes[0]],
          )
        ).rows,
        [
          {
            allocation_status: "recovery_required",
            allocation_error_code: "internal_exact_refund_suppressed",
          },
        ],
      );
    }
    // Fault-inject the post-lock read projection, not chain facts or persisted
    // money. Real two-session races live in the concurrency suite; these check
    // the same-key anchor/economic and no-longer-verifiable CAS branches too.
    for (const changed of native
      ? ["finality", "identity", "native-proof"]
      : ["anchor", "amount", "finality", "identity", "unverifiable"]) {
      await db.query("savepoint refund_snapshot_retry");
      let afterOperationLock = false;
      let injected = false;
      const effects: string[] = [];
      const faulted = {
        query: async (sql: string, values: unknown[]) => {
          if (
            sql.includes("select id from funding_operations") &&
            sql.includes("for update")
          )
            afterOperationLock = true;
          if (
            afterOperationLock &&
            /(?:insert into|update) funding_(?:receive_canonical_events|observations|reconciliation_jobs)/u.test(
              sql,
            )
          )
            effects.push(sql);
          const result = await db.query(sql, values);
          if (!afterOperationLock || !sql.includes("from funding_observations"))
            return result;
          return {
            ...result,
            rows: result.rows.map((row) => {
              if (row.tx_hash !== hashes[0] || row.kind !== "refund_credit")
                return row;
              injected = true;
              if (changed === "anchor")
                return { ...row, block_hash: `0x${"cd".repeat(32)}` };
              if (changed === "amount") return { ...row, raw_amount: "1" };
              if (changed === "unverifiable")
                return { ...row, raw_amount: "99999999999999999999" };
              if (changed === "finality")
                return { ...row, canonical: false, finality_status: "reorged" };
              if (changed === "identity")
                return {
                  ...row,
                  metadata: { ...row.metadata, relayRefundReceipt: null },
                };
              return {
                ...row,
                metadata: { ...row.metadata, relayRefundNativeLedger: null },
              };
            }),
          };
        },
      } as Pick<PoolClient, "query">;
      await assert.rejects(
        recordRelayExactRefundReceiptsInTransaction(faulted, {
          ...base,
          nativeLedger: secondRead.nativeLedger,
          evmEvents: secondRead.evmEvents,
        }),
        RelayExactRefundSnapshotChanged,
      );
      assert.equal(injected, true, changed);
      assert.deepEqual(
        effects,
        [],
        `${changed}: stale snapshot cannot commit effects`,
      );
      await db.query("rollback to savepoint refund_snapshot_retry");
      const recovered = await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        nativeLedger: secondRead.nativeLedger,
        evmEvents: secondRead.evmEvents,
      });
      assert.deepEqual(
        recovered,
        { kind: "complete", inserted: 1, reason: null },
        `${changed}: fresh snapshot recovers`,
      );
      await db.query("rollback to savepoint refund_snapshot_retry");
      await db.query("release savepoint refund_snapshot_retry");
    }
    // One ledger-second / RPC receipt per poll, not all receipts in one budget.
    const second = await recordRelayExactRefundReceiptsInTransaction(db, {
      ...base,
      nativeLedger: secondRead.nativeLedger,
      evmEvents: secondRead.evmEvents,
    });
    assert.deepEqual(second, { kind: "complete", inserted: 1, reason: null });
    for (const collision of [false, true]) {
      await db.query("savepoint refund_manifest_extra");
      await db.query(
        `insert into funding_observations (
        operation_id,segment_id,kind,network_id,asset_id,asset_decimals,tx_hash,event_index,
        from_address,to_address,raw_amount,observed_at,ledger_height,block_hash,
        finality_status,canonical,finalized_at,metadata)
        select operation_id,segment_id,kind,network_id,asset_id,asset_decimals,$3,'0',
          from_address,to_address,'1',observed_at,ledger_height,block_hash,
          finality_status,canonical,finalized_at,'{}'::jsonb
        from funding_observations where operation_id=$1 and tx_hash=$2 and kind='refund_credit'`,
        [
          input.operationId,
          hashes[0],
          collision
            ? hashes[0]
            : `0x${canonicalJsonHash([input.requestId, "outside-manifest"])}`,
        ],
      );
      const incomplete = await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        nativeLedger: secondRead.nativeLedger,
        evmEvents: secondRead.evmEvents,
      });
      assert.deepEqual(
        incomplete,
        collision
          ? {
              kind: "pending",
              reason: "refund_shared_transaction_requires_attribution",
            }
          : {
              kind: "partial",
              inserted: 0,
              reason: "refund_canonical_set_pending",
            },
        "neither invalid metadata nor a missing manifest member can be ignored to complete refund",
      );
      await db.query("rollback to savepoint refund_manifest_extra");
      await db.query("release savepoint refund_manifest_extra");
      assert.deepEqual(
        await recordRelayExactRefundReceiptsInTransaction(db, {
          ...base,
          nativeLedger: secondRead.nativeLedger,
          evmEvents: secondRead.evmEvents,
        }),
        { kind: "complete", inserted: 0, reason: null },
      );
    }
    await checkMovement(null);
    assert.equal((await lifecycle()).status, "refunded");
    await verifySourceEnumeration();
    await verifyRefundCanonicalWatchPg(db, driverPool, { ...input, native });
    if (!native) {
      const completed = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: evm,
      });
      assert.ok(
        [...completed.values()].every(
          (decision) => decision.kind === "internal",
        ),
        "terminal lifecycle does not hide an exact refund",
      );
      const foreign = await classifyRecordedRelayExactRefundEvents(db, {
        userId: "foreign-user",
        events: evm,
      });
      assert.ok(
        [...foreign.values()].every(
          (decision) => decision.kind === "recovery_required",
        ),
      );
      // Migration 0195 prevents a second claim of the same physical log, even
      // for a different asset. Do not weaken that invariant for a test fixture.
      await db.query("savepoint recorded_refund_collision");
      await assert.rejects(
        db.query(
          `insert into funding_observations(
           operation_id, segment_id, kind, network_id, asset_id, asset_decimals,
           tx_hash, event_index, from_address, to_address, raw_amount,
           observed_at, ledger_height, block_hash, finality_status,
           canonical, finalized_at, metadata)
         select operation_id, segment_id, kind, network_id, $3, asset_decimals,
           tx_hash, event_index, from_address, to_address, raw_amount,
           observed_at, ledger_height, block_hash, finality_status,
           canonical, finalized_at, metadata
         from funding_observations
         where operation_id=$1 and tx_hash=$2 and kind='refund_credit'`,
          [input.operationId, hashes[0], `0x${"ff".repeat(20)}`],
        ),
        { code: "23505", constraint: "funding_observations_transfer_unique" },
      );
      await db.query("rollback to savepoint recorded_refund_collision");
      await db.query("release savepoint recorded_refund_collision");
      // The existing physical receipt must still conflict with an incoming
      // different token instead of disappearing through an asset SQL filter.
      const collision = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: [
          {
            ...evm[0],
            asset: { ...evm[0].asset, assetId: `0x${"ff".repeat(20)}` },
          },
          evm[1],
        ],
      });
      assert.deepEqual(collision.get(refundCanonicalEventKey(evm[0])), {
        kind: "recovery_required",
        reason: "exact_refund_receipt_conflict",
      });
      assert.equal(
        collision.get(refundCanonicalEventKey(evm[1]))?.kind,
        "internal",
      );
    }
    const receipts = (
      await listFundingObservationsForOperation(db, input.operationId)
    ).filter((row) => row.kind === "refund_credit");
    assert.equal(receipts.length, 2);
    assert.equal(
      (await readCurrentRefundSet()).kind,
      "complete_refund_set",
      "paged reader consumes the real writer's frozen proof for EVM/native receipts",
    );
    if (native) {
      assert.ok(
        receipts.every(
          (row) =>
            !JSON.stringify(row.metadata).includes("must-not-be-retained"),
        ),
      );
      assert.ok(
        receipts.every(
          (row) => row.eventIndex === "hypercore:send:destination_credit",
        ),
      );
    }
    calls.length = 0;
    assert.deepEqual(
      await recordRelayExactRefundReceiptsInTransaction(traced, base),
      { kind: "complete", inserted: 0, reason: null },
      "exact immutable receipts survive later empty provider reads",
    );
    assert.ok(
      !calls.some((sql) => sql.includes("funding_reconciliation_jobs")),
      "a replay cannot schedule a busy polling loop",
    );
    assert.deepEqual(
      await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        referenceCodec: {
          ...input.referenceCodec,
          keyVersion: input.referenceCodec.keyVersion + 1,
          fingerprint: () => "f".repeat(64),
        },
      }),
      { kind: "complete", inserted: 0, reason: null },
      "lookup-key rotation retains the frozen proof identity",
    );
    assert.deepEqual(
      await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        referenceCodec: {
          ...input.referenceCodec,
          decrypt: () => "another-exact-request",
        },
      }),
      { kind: "pending", reason: "refund_committed_request_mismatch" },
    );
    const caseEvent = native
      ? {
          nativeLedger: [
            { ...ledger[0], hash: `0x${hashes[0].slice(2).toUpperCase()}` },
          ],
        }
      : {
          evmEvents: [
            {
              ...evm[0],
              transactionHash: `0x${hashes[0].slice(2).toUpperCase()}`,
            },
          ],
        };
    assert.deepEqual(
      await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        ...caseEvent,
      }),
      { kind: "complete", inserted: 0, reason: null },
    );
    if (native) {
      const conflicting = {
        ...ledger[0],
        delta: { ...ledger[0].delta, nonce: baseTime + 1 },
      };
      const conflict = await recordRelayExactRefundReceiptsInTransaction(db, {
        ...base,
        nativeLedger: [conflicting],
      });
      assert.notEqual(
        conflict.kind,
        "complete",
        "new contradictory ledger cannot be hidden by stored proof",
      );
    }
    const cachedTarget = {
      ...staleSource,
      location: input.target,
      amount: { asset: input.target.asset, raw: "0" },
      observedAt: new Date(input.now.getTime() + 30000).toISOString(),
    };
    const beforeReorg = await loadFundingAccountValueFacts(
      db as never,
      reservation.user_id,
    );
    assert.equal(
      fundingRefundSnapshotLagOperations(
        beforeReorg.refundBalanceChanges.filter(
          (change) => change.operationId === input.operationId,
        ),
        [cachedTarget],
      ).size,
      0,
    );
    const reorgedAt = new Date(input.now.getTime() + 60000);
    // Both EVM receipts have the same observed_at; UUID ordering is not their
    // transaction ordering. Reorg the explicit physical event, not row zero.
    const reorgedReceipt = receipts.find(
      (receipt) => receipt.txHash === hashes[0],
    );
    assert.ok(reorgedReceipt);
    await advanceFundingObservationFinalityInTransaction(db, {
      observationId: reorgedReceipt.id,
      expectedFinality: "finalized",
      nextFinality: "reorged",
      reorgedAt,
    });
    assert.notEqual(
      (await readCurrentRefundSet()).kind,
      "complete_refund_set",
      "a subset of the former complete manifest is not complete after reorg",
    );
    if (!native) {
      const reorged = await classifyRecordedRelayExactRefundEvents(db, {
        userId: reservation.user_id,
        events: evm,
      });
      assert.deepEqual(reorged.get(refundCanonicalEventKey(evm[0])), {
        kind: "recovery_required",
        reason: "exact_refund_receipt_not_final",
      });
      assert.equal(
        reorged.get(refundCanonicalEventKey(evm[1]))?.kind,
        "internal",
      );
    }
    assert.notEqual(
      (await recordRelayExactRefundReceiptsInTransaction(db, base)).kind,
      "complete",
    );
    assert.equal((await lifecycle()).status, "recovery_required");
    await verifySourceEnumeration();
    const remainingReturned = receipts
      .filter((receipt) => receipt.id !== reorgedReceipt.id)
      .reduce(
        (sum, receipt) =>
          sum +
          (BigInt(receipt.rawAmount) *
            10n ** BigInt(input.source.asset.decimals)) /
            10n ** BigInt(receipt.assetDecimals),
        0n,
      );
    await checkMovement(
      (
        10n * 10n ** BigInt(input.source.asset.decimals) -
        remainingReturned
      ).toString(),
    );
    const afterReorg = await loadFundingAccountValueFacts(
      db as never,
      reservation.user_id,
    );
    const targetChanges = afterReorg.refundBalanceChanges.filter(
      (change) => change.operationId === input.operationId,
    );
    assert.equal(
      fundingRefundSnapshotLagOperations(targetChanges, [cachedTarget]).has(
        input.operationId,
      ),
      true,
    );
    assert.equal(
      fundingInvalidatedRefundComponentIds(targetChanges, [cachedTarget]).has(
        cachedTarget.componentId,
      ),
      true,
    );
    const refreshedTarget = {
      ...cachedTarget,
      observedAt: reorgedAt.toISOString(),
    };
    assert.equal(
      fundingRefundSnapshotLagOperations(targetChanges, [refreshedTarget]).size,
      0,
    );
    assert.equal(
      fundingInvalidatedRefundComponentIds(targetChanges, [refreshedTarget])
        .size,
      0,
    );
    const contextSql = calls.find(
      (sql) => sql === RELAY_EXACT_REFUND_CONTEXT_SQL,
    );
    assert.ok(contextSql);
    const providerRequestSql = driverQueries.find(
      (sql) =>
        sql.includes("request.request_ref_lookup_hmac") &&
        sql.includes("from funding_provider_requests request"),
    );
    assert.ok(providerRequestSql);
    assert.ok(movementSql);
    return { contextSql, diagnosticSql, providerRequestSql, movementSql };
  } finally {
    await db.query("rollback to savepoint exact_refund_writer");
    await db.query("release savepoint exact_refund_writer");
  }
}
