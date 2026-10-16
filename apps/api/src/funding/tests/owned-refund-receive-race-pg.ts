import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import {
  createOrReuseFundingReceiveSession,
  claimFundingReceiveCanonicalEventAllocation,
  finalizeFundingReceiveCanonicalEventAllocation,
  insertFundingReceiveReceipt,
  type FundingReceiveCanonicalEventInput,
} from "../persistence/funding-receive-session-repository.js";
import { OWNED_REFUND_OTHER_EVM_CREDIT_SQL } from "../reconciliation/relay-owned-refund-ownership.js";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";

/** Shared synthetic receive session for exact/owned refund ownership tests. */
export async function createRefundReceiveSessionFixture(
  pool: Pool,
  input: { userId: string; event: FundingReceiveCanonicalEventInput },
) {
  const scopeId = randomUUID();
  const { event } = input;
  const receiveTarget = {
    receiveTargetId: scopeId,
    networkId: event.networkId,
    destinationAddress: event.destinationAddress,
    acceptedAssets: [{ asset: event.asset, handling: "direct" as const }],
    safeInstructions: [],
  };
  const session = await createOrReuseFundingReceiveSession(pool, {
    userId: input.userId,
    venueId: "limitless",
    destinationOptionId: scopeId,
    venueBindingOptionId: scopeId,
    destinationAsset: event.asset,
    destinationTargetSnapshot: {},
    venueBindingSnapshot: {},
    methods: [
      {
        methodId: scopeId,
        kind: "manual",
        safeLabel: "Offline race fixture",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: scopeId,
          destinationOptionId: scopeId,
          destinationAddress: event.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(event.now.getTime() + 60000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    selectedReceiveTargetId: scopeId,
    observationVariants: [
      {
        variantId: scopeId,
        networkId: event.networkId,
        asset: event.asset,
        destinationAddress: event.destinationAddress,
        destinationLocationId: scopeId,
        baselineRaw: "0",
        baselineRevision: scopeId,
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: {
            eventCursorBlock: "100",
            eventConfirmations: 2,
            eventIdentity: "evm_erc20_transfer_v1",
          },
        },
        completion: { kind: "direct_destination_credit" },
      },
    ],
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "owned-refund-race",
    ownershipRevision: scopeId,
    now: event.now,
    expiresAt: new Date(event.now.getTime() + 60000),
    observeUntil: new Date(event.now.getTime() + 120000),
  });
  const sessionId = session.snapshot.session.receiveSessionId;
  return { scopeId, sessionId };
}

/** Real independent PG transactions. First-key insertion contention must fail
 * with the exact try-gate signal, roll back, and recover through the unchanged
 * receive/refund APIs after the other owner commits. No guessed wait sleeps. */
export async function verifyOwnedRefundReceiveRacePg(
  pool: Pool,
  input: {
    first: "receive" | "refund";
    legacyReceiveAlias?: boolean;
    userId: string;
    event: FundingReceiveCanonicalEventInput;
    poll: (db: Pool) => Promise<{ refundSatisfied: boolean }>;
  },
) {
  const { event } = input;
  const { scopeId, sessionId } = await createRefundReceiveSessionFixture(
    pool,
    input,
  );
  const receiver = await pool.connect();
  let onObserverReady: () => void = () => {};
  const observerReady = new Promise<void>((resolve) => {
    onObserverReady = resolve;
  });
  let resumeObserver: () => void = () => {};
  const observerGate = new Promise<void>((resolve) => {
    resumeObserver = resolve;
  });
  const traced = Object.create(pool) as Pool;
  traced.query = pool.query.bind(pool);
  traced.connect = (async () => {
    const client = await pool.connect();
    if (input.first === "receive") onObserverReady();
    return new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (sql: string, values?: unknown[]) => {
            if (
              input.first === "refund" &&
              sql === OWNED_REFUND_OTHER_EVM_CREDIT_SQL
            ) {
              onObserverReady();
              await observerGate;
            }
            return target.query(sql, values);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  let observerResult: ReturnType<typeof input.poll> | undefined;
  let receiveResult:
    | ReturnType<typeof claimFundingReceiveCanonicalEventAllocation>
    | undefined;
  const waitForObserver = (result: ReturnType<typeof input.poll>) =>
    Promise.race([
      observerReady,
      result.then(() => {
        throw new Error("Refund observer completed before the race boundary");
      }),
    ]);
  try {
    await receiver.query("begin");
    await receiver.query("set local lock_timeout='10s'");
    if (input.first === "receive") {
      const claim = await claimFundingReceiveCanonicalEventAllocation(
        receiver,
        { ...event, expectedReceiveSessionId: sessionId },
      );
      assert.equal(claim.status, "pending");
      assert.equal(claim.targetReceiveSessionId, sessionId);
      const receipt = await insertFundingReceiveReceipt(receiver, {
        receiveSessionId: sessionId,
        userId: input.userId,
        variantId: scopeId,
        asset: event.asset,
        destinationAddress: event.destinationAddress,
        rawAmount: event.rawAmount,
        observationRevision: scopeId,
        canonicalEvent: event,
        observedAt: event.observedAt,
        handling: "direct",
        status: "ready",
        evidence: {},
        now: event.now,
      });
      assert.equal(
        await finalizeFundingReceiveCanonicalEventAllocation(receiver, {
          eventId: claim.eventId,
          receiveSessionId: sessionId,
          receiptId: receipt.receipt.receiptId,
          now: event.now,
        }),
        true,
      );
      if (input.legacyReceiveAlias) {
        // Exact offline legacy fixture only: normal API writers canonicalize
        // hashes. Retain BOTH the allocated E and receipt under old casing.
        await receiver.query("set local session_replication_role=replica");
        const alias = `0X${event.transactionHash.slice(2).toUpperCase()}`;
        await receiver.query(
          "update funding_receive_receipts set tx_hash=$2 where id=$1",
          [receipt.receipt.receiptId, alias],
        );
        await receiver.query(
          "update funding_receive_canonical_events set tx_hash=$2 where id=$1",
          [claim.eventId, alias],
        );
        await receiver.query("set local session_replication_role=origin");
      }
      observerResult = input.poll(traced);
      await waitForObserver(observerResult);
      assert.equal(
        (await observerResult).refundSatisfied,
        false,
        "physical contention retries without money",
      );
      await receiver.query("commit");
      observerResult = input.poll(pool);
      assert.equal((await observerResult).refundSatisfied, false);
    } else {
      observerResult = input.poll(traced);
      await waitForObserver(observerResult);
      receiveResult = claimFundingReceiveCanonicalEventAllocation(receiver, {
        ...event,
        expectedReceiveSessionId: sessionId,
      });
      void receiveResult.catch(() => {}); // Assert below; no unhandled timeout.
      await assert.rejects(receiveResult, fundingPhysicalEventIsBusy);
      await receiver.query("rollback");
      resumeObserver();
      assert.equal((await observerResult).refundSatisfied, true);
      await receiver.query("begin");
      receiveResult = claimFundingReceiveCanonicalEventAllocation(receiver, {
        ...event,
        expectedReceiveSessionId: sessionId,
      });
      assert.equal((await receiveResult).status, "recovery_required");
      assert.equal(
        (await receiveResult).errorCode,
        "internal_exact_refund_suppressed",
      );
      await receiver.query("commit");
    }
    assert.equal(
      (
        await pool.query(
          `select count(*)::int as n from funding_receive_receipts where receive_session_id=$1`,
          [sessionId],
        )
      ).rows[0].n,
      input.first === "receive" ? 1 : 0,
    );
  } finally {
    resumeObserver();
    await receiver.query("rollback");
    await Promise.allSettled([observerResult, receiveResult].filter(Boolean));
    // Exact synthetic scope, never a production cleanup path.
    await receiver.query("begin");
    await receiver.query("set local session_replication_role=replica");
    await receiver.query(
      `delete from funding_receive_canonical_events where network_id=$1 and lower(tx_hash)=lower($2) and event_index=$3`,
      [event.networkId, event.transactionHash, event.eventIndex],
    );
    await receiver.query(
      "delete from funding_receive_receipts where receive_session_id=$1",
      [sessionId],
    );
    await receiver.query("delete from funding_receive_sessions where id=$1", [
      sessionId,
    ]);
    await receiver.query("commit");
    receiver.release();
  }
}
