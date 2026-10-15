import { loadCanonicalPolymarketHandoffClassifications } from "./receive-handoff-classification.js";
export { classifyPolymarketHandoffEvents } from "./receive-handoff-classification.js";
export type { PolymarketHandoffEventClassification } from "./receive-handoff-classification.js";
import { tx, type Pool } from "@hunch/infra";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import {
  observeFinalizedOwnedReceiveSourceBalance,
  observeFinalizedSolanaOwnedAssetBalanceAfterSlot,
  verifyFinalizedSolanaReceiveSourceDebit,
} from "../reconciliation/owned-wallet-asset-balance.js";
import type { FundingReceiveReceipt, JsonValue } from "../domain/types.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { listPotentialPolymarketHandoffsForCanonicalEvents } from "../persistence/funding-evidence-repository.js";
import {
  observeDirectIngressDestination,
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
  type DirectIngressObservationTarget,
  type DirectIngressVariantObservation,
} from "../reconciliation/direct-ingress-observer.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  bindFundingReceiveCanonicalEventSession,
  claimFundingReceiveClassificationRetries,
  fundingReceiveClassificationRetryTarget,
  validateFundingReceiveClassificationRetry,
  finishFundingReceiveClassificationRetry,
  isFundingReceiveClassificationRetryReason,
  claimExpiredFundingReceiveInventoryReviews,
  claimExpiredFundingReceiveSpentReviews,
  claimObservableFundingReceiveSessions,
  deriveEffectiveFundingReceiveSessionStatus,
  finalizeFundingReceiveCanonicalEventAllocation,
  insertFundingReceiveReceipt,
  listFundingReceiveSpentReviewCandidates,
  markFundingReceiveSpentReviewCandidatesChecked,
  lockFundingReceiveCanonicalEvents,
  lockFundingReceiveSessionScope,
  quarantineFundingReceiveCanonicalInternalEvent,
  resolveFundingReceiveSpentReview,
  resolveFundingReceiveInventoryReview,
  expireFundingReceiveSessions,
  updateClosedFundingReceiveSessionObservation,
  updateFundingReceiveSessionObservation,
  type RecoverableFundingReceiveCanonicalEvent,
  type FundingReceiveSessionSnapshot,
  type FundingReceiveClassificationRetry,
} from "../persistence/funding-receive-session-repository.js";
import {
  classifyOwnedRouteCanonicalDestinationEvents,
  recordOwnedRouteCanonicalDestinationCredit,
} from "../reconciliation/owned-route-destination-observer.js";
import {
  scanCanonicalFundingReceiveEvents,
  scanCanonicalFundingReceiveEventsBatch,
  type FundingReceiveCanonicalEvent,
  type FundingReceiveEventScan,
} from "./canonical-receive-event-scanner.js";
import {
  fundingReceiveVariantHandling,
  isDirectReceiveCompletionKind,
} from "../planner/receive-targets.js";
import { recordCanonicalReceiveDepositNotification } from "./receive-deposit-notification.js";
import { receiveInternalRolesConflict } from "./receive-event-classification.js";
import {
  classifyRecordedRelayExactRefundEvents,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

function canonicalEventIdentity(event: FundingReceiveCanonicalEvent): string {
  return [
    event.variant.networkId,
    event.transactionHash,
    event.eventIndex,
  ].join(":");
}

function deduplicateCanonicalEvents(
  events: readonly FundingReceiveCanonicalEvent[],
): readonly FundingReceiveCanonicalEvent[] {
  const unique = new Map<string, FundingReceiveCanonicalEvent>();
  for (const event of events) {
    const identity = canonicalEventIdentity(event);
    if (!unique.has(identity)) unique.set(identity, event);
  }
  return [...unique.values()];
}

function recoveredCanonicalEvent(
  variants: readonly DirectIngressObservationVariant[],
  recovered: RecoverableFundingReceiveCanonicalEvent,
): FundingReceiveCanonicalEvent | null {
  const variant = variants.find(
    (candidate) => candidate.variantId === recovered.variantId,
  );
  if (
    !variant ||
    recovered.sourceAddress == null ||
    variant.networkId !== recovered.networkId ||
    variant.asset.decimals !== recovered.asset.decimals ||
    !sameAccountAddress(
      variant.networkId,
      variant.asset.assetId,
      recovered.asset.assetId,
    ) ||
    !sameAccountAddress(
      variant.networkId,
      variant.destinationAddress,
      recovered.destinationAddress,
    )
  ) {
    return null;
  }
  return {
    variant,
    transactionHash: recovered.transactionHash,
    eventIndex: recovered.eventIndex,
    blockNumber: recovered.ledgerHeight,
    blockHash: recovered.blockHash,
    sourceAddress: recovered.sourceAddress,
    destinationAddress: recovered.destinationAddress,
    rawAmount: recovered.rawAmount,
    observedAt: recovered.observedAt.toISOString(),
  };
}

function jsonRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function observationTarget(
  snapshot: FundingReceiveSessionSnapshot,
): DirectIngressObservationTarget {
  return {
    operationId: snapshot.session.receiveSessionId,
    userId: snapshot.userId,
    purpose: "add_funds",
    marketId: null,
    venueBindingOptionId: snapshot.session.venueBindingOptionId,
    requestedAsset: snapshot.session.destinationAsset,
    requestedRaw: "1",
    operationVersion: snapshot.session.version,
    operationState: {
      status: "awaiting_external_funds",
      stage: "source_action",
    },
    variants: snapshot.observationVariants.map(
      parseDirectIngressObservationVariant,
    ),
  };
}

const fundingReceiveSessionReadyPools = new WeakSet<object>();

export async function isFundingReceiveSessionSchemaReady(
  db: Pick<Pool, "query">,
): Promise<boolean> {
  if (fundingReceiveSessionReadyPools.has(db)) return true;
  const { rows } = await db.query<{ ready: boolean }>(
    `
      select
        to_regclass('public.funding_receive_sessions') is not null
        and to_regclass('public.funding_receive_receipts') is not null
        and to_regclass('public.funding_receive_canonical_events') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'funding_receive_sessions'
            and column_name = 'observation_start_variants'
        )
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'funding_receive_sessions'
            and column_name = 'observation_requested_at'
        )
        and exists (
          select 1 from pg_attribute
          where attrelid=to_regclass('public.funding_receive_canonical_events')
            and attname='classification_lease_token' and not attisdropped
        )
        as ready
    `,
  );
  const ready = rows[0]?.ready === true;
  if (ready) fundingReceiveSessionReadyPools.add(db);
  return ready;
}

export type FundingReceiveSessionObservationResult = Readonly<{
  sessionsPolled: number;
  receiptsRecorded: number;
  recoveriesRequired: number;
  retryableErrors: number;
}>;

function hasValidObservationVariants(
  snapshot: FundingReceiveSessionSnapshot,
): boolean {
  if (snapshot.observationVariants.length === 0) return false;
  try {
    snapshot.observationVariants.forEach(parseDirectIngressObservationVariant);
    return true;
  } catch {
    return false;
  }
}

function isLateObservableReceiveSession(
  snapshot: FundingReceiveSessionSnapshot,
): boolean {
  return (
    snapshot.session.status === "completed" ||
    snapshot.session.status === "expired" ||
    snapshot.session.status === "cancelled"
  );
}

async function quarantineInvalidObservationVariants(
  pool: Pool,
  snapshot: FundingReceiveSessionSnapshot,
  now: Date,
): Promise<boolean> {
  const closed = isLateObservableReceiveSession(snapshot);
  if (closed) {
    return updateClosedFundingReceiveSessionObservation(pool, {
      receiveSessionId: snapshot.session.receiveSessionId,
      expectedVersion: snapshot.session.version,
      observationVariants: snapshot.observationVariants,
      lastObservedAt: now,
      recoveryRequired: true,
      now,
    });
  }
  if (
    snapshot.session.status !== "open" &&
    snapshot.session.status !== "processing" &&
    snapshot.session.status !== "review_required"
  ) {
    return false;
  }
  return updateFundingReceiveSessionObservation(pool, {
    receiveSessionId: snapshot.session.receiveSessionId,
    expectedVersion: snapshot.session.version,
    observationVariants: snapshot.observationVariants,
    status: "recovery_required",
    lastObservedAt: now,
    now,
  });
}

export function fundingReceiveObservationDisposition(
  input: Readonly<{
    sessionStatus: FundingReceiveSessionSnapshot["session"]["status"];
    completion: DirectIngressObservationVariant["completion"];
    handling?: FundingReceiveReceipt["handling"];
  }>,
): Readonly<{
  receiptStatus: "ready" | "observed" | "review_required" | "recovery_required";
  sessionStatus:
    | "open"
    | "processing"
    | "review_required"
    | "recovery_required";
  late: boolean;
}> {
  const late =
    input.sessionStatus === "completed" ||
    input.sessionStatus === "expired" ||
    input.sessionStatus === "cancelled";
  const direct = isDirectReceiveCompletionKind(input.completion.kind);
  const reviewRequired = input.handling === "review_required";
  if (late && !direct) {
    return {
      // Keep the unconverted receipt out of automatic routing and do not
      // falsely mark the destination ready. This is historical evidence,
      // not new work for the expired/cancelled/completed receive scenario.
      receiptStatus: "recovery_required",
      // As for late direct credits below, the closed-session writer retains
      // the actual terminal state; this neutral proposal must not reopen it.
      sessionStatus: "open",
      late,
    };
  }
  return {
    receiptStatus: direct
      ? "ready"
      : reviewRequired
        ? "review_required"
        : "observed",
    sessionStatus: direct
      ? "open"
      : reviewRequired
        ? "review_required"
        : "processing",
    late,
  };
}

export function selectFundingReceiveSessionObservation(
  variants: readonly DirectIngressObservationVariant[],
  observations: readonly DirectIngressVariantObservation[],
):
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "ambiguous"; variantIds: readonly string[] }>
  | Readonly<{
      kind: "received";
      variant: DirectIngressObservationVariant;
      observation: DirectIngressVariantObservation;
      delta: bigint;
    }> {
  const observedByVariant = new Map(
    observations.map((entry) => [entry.variantId, entry]),
  );
  const positive = variants.flatMap((variant) => {
    const observation = observedByVariant.get(variant.variantId);
    if (!observation) return [];
    const delta = BigInt(observation.observedRaw) - BigInt(variant.baselineRaw);
    return delta > 0n ? [{ variant, observation, delta }] : [];
  });
  if (positive.length === 0) return { kind: "waiting" };
  if (positive.length > 1) {
    return {
      kind: "ambiguous",
      variantIds: positive.map((entry) => entry.variant.variantId),
    };
  }
  const selected = positive[0];
  if (!selected) return { kind: "waiting" };
  return { kind: "received", ...selected };
}

export function advanceFundingReceiveObservationBaselines(
  variants: readonly DirectIngressObservationVariant[],
  observations: readonly DirectIngressVariantObservation[],
  mode: "negative_only" | "all_changed",
): readonly DirectIngressObservationVariant[] | null {
  const observedByVariant = new Map(
    observations.map((entry) => [entry.variantId, entry]),
  );
  let changed = false;
  const next = variants.map((variant) => {
    const observation = observedByVariant.get(variant.variantId);
    if (!observation) return variant;
    const delta = BigInt(observation.observedRaw) - BigInt(variant.baselineRaw);
    if (delta === 0n || (mode === "negative_only" && delta > 0n)) {
      return variant;
    }
    changed = true;
    return {
      ...variant,
      baselineRaw: observation.observedRaw,
      baselineRevision: observation.revision,
    };
  });
  return changed ? next : null;
}

export class FundingReceiveSessionObserver {
  constructor(
    private readonly dependencies: Readonly<{
      transactionReferenceCodec?: Pick<
        FundingTransactionReferenceCodec,
        "decrypt" | "fingerprint" | "keyVersion"
      >;
      relayReferenceCodec?: Pick<RelayReferenceCodec, "fingerprint">;
      scanCanonicalEvents?: typeof scanCanonicalFundingReceiveEvents;
      scanCanonicalEventsBatch?: typeof scanCanonicalFundingReceiveEventsBatch;
      listPotentialPolymarketHandoffs?: typeof listPotentialPolymarketHandoffsForCanonicalEvents;
      classifyOwnedRouteDestinations?: typeof classifyOwnedRouteCanonicalDestinationEvents;
      classifyRecordedRefunds?: typeof classifyRecordedRelayExactRefundEvents;
      readFinalizedSourceBalance?: typeof observeFinalizedSolanaOwnedAssetBalanceAfterSlot;
      readFinalizedInventoryBalance?: typeof observeFinalizedOwnedReceiveSourceBalance;
      verifyFinalizedSourceDebit?: typeof verifyFinalizedSolanaReceiveSourceDebit;
    }> = {},
  ) {}

  /** Known immutable transfers only: no provider IO, scanner, quote or old Buy.
   * The claim commits before scope locking; failures therefore rotate instead
   * of making the oldest batch monopolize every subsequent tick. */
  async pollKnownCanonicalRetryBatch(
    pool: Pool,
    input: Readonly<{ limit: number; retryDelayMs: number; now?: Date }>,
  ): Promise<
    Readonly<{
      eventsChecked: number;
      unboundEvents: number;
      receiptsRecorded: number;
      recoveriesRequired: number;
      retryableErrors: number;
    }>
  > {
    const now = input.now ?? new Date();
    const retries = await claimFundingReceiveClassificationRetries(pool, {
      ...input,
      now,
    });
    let receiptsRecorded = 0,
      recoveriesRequired = 0,
      retryableErrors = 0,
      unboundEvents = 0;
    for (const retry of retries) {
      try {
        const target = await fundingReceiveClassificationRetryTarget(
          pool,
          retry,
        );
        if (!target) {
          unboundEvents += 1;
          continue;
        }
        const variants = target.observationStartVariants.map(
          parseDirectIngressObservationVariant,
        );
        const event = recoveredCanonicalEvent(variants, target.event);
        if (!event) {
          retryableErrors += 1;
          continue;
        }
        const result = await this.persistCanonicalEvents(
          pool,
          target.snapshot,
          [event],
          variants,
          false,
          now,
          retry,
        );
        receiptsRecorded += result.receiptsRecorded;
        recoveriesRequired += Number(result.recoveryRequired);
      } catch {
        retryableErrors += 1;
      }
    }
    return {
      eventsChecked: retries.length,
      unboundEvents,
      receiptsRecorded,
      recoveriesRequired,
      retryableErrors,
    };
  }

  async pollBatch(
    pool: Pool,
    input: Readonly<{
      limit?: number;
      minimumPollIntervalMs?: number;
      now?: Date;
    }> = {},
  ): Promise<FundingReceiveSessionObservationResult> {
    if (!(await isFundingReceiveSessionSchemaReady(pool))) {
      return {
        sessionsPolled: 0,
        receiptsRecorded: 0,
        recoveriesRequired: 0,
        retryableErrors: 0,
      };
    }
    const now = input.now ?? new Date();
    await expireFundingReceiveSessions(pool, { now });
    const batchLimit = input.limit ?? 25;
    const observableSessions = await claimObservableFundingReceiveSessions(
      pool,
      {
        // Claim only work this poll will actually execute. Claiming an
        // oversized set advances last_observed_at for rows that are later
        // sliced away and can indefinitely postpone their real scan.
        limit: batchLimit,
        minimumPollIntervalMs: input.minimumPollIntervalMs ?? 10_000,
        inactivePollIntervalMs: 60_000,
        closedPollIntervalMs: 300_000,
        activeWindowMs: 15 * 60_000,
        now,
      },
    );
    const validSessions: FundingReceiveSessionSnapshot[] = [];
    let recoveriesRequired = 0;
    let retryableErrors = 0;
    for (const session of observableSessions) {
      if (hasValidObservationVariants(session)) {
        validSessions.push(session);
        continue;
      }
      try {
        if (await quarantineInvalidObservationVariants(pool, session, now)) {
          recoveriesRequired += 1;
        } else {
          retryableErrors += 1;
        }
      } catch {
        retryableErrors += 1;
      }
    }
    const sessions = validSessions;
    let batchScans: Awaited<
      ReturnType<typeof scanCanonicalFundingReceiveEventsBatch>
    > | null = null;
    let batchScanFailed = false;
    if (
      !this.dependencies.scanCanonicalEvents ||
      this.dependencies.scanCanonicalEventsBatch
    ) {
      const scanBatch =
        this.dependencies.scanCanonicalEventsBatch ??
        scanCanonicalFundingReceiveEventsBatch;
      try {
        batchScans = await scanBatch(
          sessions.map((session) => ({
            key: session.session.receiveSessionId,
            variants: observationTarget(session).variants,
          })),
          now,
        );
      } catch {
        // An unexpected batch-level failure is retryable for every selected
        // session. Normal route failures are isolated in failedKeys below.
        retryableErrors += sessions.length;
        batchScanFailed = true;
      }
    }
    let receiptsRecorded = 0;
    for (const session of sessions) {
      const sessionKey = session.session.receiveSessionId;
      if (batchScanFailed) {
        // The batch failure was already counted for every selected session.
      } else if (batchScans?.failedKeys.has(sessionKey)) {
        retryableErrors += 1;
      } else {
        try {
          const result = await this.pollSession(
            pool,
            session,
            now,
            batchScans
              ? { canonicalEvents: batchScans.scans.get(sessionKey) ?? null }
              : undefined,
          );
          receiptsRecorded += result.receiptsRecorded;
          recoveriesRequired += result.recoveryRequired ? 1 : 0;
        } catch {
          // One RPC or venue observation failure must not stall unrelated
          // receive sessions or the canonical funding reconciliation batch.
          retryableErrors += 1;
        }
      }
    }
    return {
      sessionsPolled: sessions.length,
      receiptsRecorded,
      recoveriesRequired,
      retryableErrors,
    };
  }

  /** Optional historical repair runs in its own worker job, never ahead of live reconciliation. */
  async pollSpentReviewBatch(
    pool: Pool,
    input: Readonly<{ now?: Date }> = {},
  ): Promise<
    Readonly<{
      sessionsPolled: number;
      resolved: number;
      retryableErrors: number;
    }>
  > {
    if (!(await isFundingReceiveSessionSchemaReady(pool))) {
      return { sessionsPolled: 0, resolved: 0, retryableErrors: 0 };
    }
    const now = input.now ?? new Date();
    const sessions = await claimExpiredFundingReceiveSpentReviews(pool, {
      limit: 1,
      minimumPollIntervalMs: 60_000,
      now,
    });
    let resolved = 0;
    let retryableErrors = 0;
    for (const session of sessions) {
      try {
        resolved += await this.resolveSpentReviews(pool, session, now, 1);
      } catch {
        console.warn("[funding-receive] spent review retry required", {
          receiveSessionId: session.session.receiveSessionId,
        });
        retryableErrors += 1;
      }
    }
    return { sessionsPolled: sessions.length, resolved, retryableErrors };
  }

  /** Closed, unconverted receipts can be repaired from finalized inventory. */
  async pollInventoryReviewBatch(
    pool: Pool,
    input: Readonly<{ now?: Date }> = {},
  ): Promise<
    Readonly<{
      sessionsPolled: number;
      resolved: number;
      retryableErrors: number;
    }>
  > {
    if (!(await isFundingReceiveSessionSchemaReady(pool))) {
      return { sessionsPolled: 0, resolved: 0, retryableErrors: 0 };
    }
    const now = input.now ?? new Date();
    const candidates = await claimExpiredFundingReceiveInventoryReviews(pool, {
      limit: 1,
      // Present inventory can legitimately require user consent; recheck it
      // periodically without letting it crowd out older unexamined reviews.
      minimumPollIntervalMs: 60 * 60_000,
      now,
    });
    let resolved = 0;
    let retryableErrors = 0;
    for (const candidate of candidates) {
      try {
        const observed = await (
          this.dependencies.readFinalizedInventoryBalance ??
          observeFinalizedOwnedReceiveSourceBalance
        )({
          asset: {
            networkId: candidate.networkId,
            assetId: candidate.assetId,
            decimals: candidate.assetDecimals,
          },
          destinationAddress: candidate.destinationAddress,
          minimumHeight: candidate.requiredFinalizedHeight,
          sourceEvent: {
            sourceLedgerHeight: candidate.sourceLedgerHeight,
            txHash: candidate.txHash,
            eventIndex: candidate.eventIndex,
            blockHash: candidate.blockHash,
            sourceAddress: candidate.sourceAddress,
            sourceRaw: candidate.sourceRaw,
          },
        });
        if (BigInt(observed.raw) >= BigInt(candidate.sourceRaw)) {
          console.info("[funding-receive] review source still available", {
            receiptId: candidate.receiptId,
            receiveSessionId: candidate.receiveSessionId,
          });
          continue;
        }
        if (
          await resolveFundingReceiveInventoryReview(pool, {
            ...candidate,
            observedBalanceRaw: observed.raw,
            observedHeight: observed.height,
            now,
          })
        ) {
          resolved += 1;
          console.info(
            "[funding-receive] review source inventory insufficient",
            {
              receiptId: candidate.receiptId,
              receiveSessionId: candidate.receiveSessionId,
            },
          );
        } else {
          console.info("[funding-receive] inventory review state changed", {
            receiptId: candidate.receiptId,
            receiveSessionId: candidate.receiveSessionId,
          });
        }
      } catch {
        console.warn("[funding-receive] inventory review retry required", {
          receiptId: candidate.receiptId,
          receiveSessionId: candidate.receiveSessionId,
        });
        retryableErrors += 1;
      }
    }
    return {
      sessionsPolled: candidates.length,
      resolved,
      retryableErrors,
    };
  }

  private async resolveSpentReviews(
    pool: Pool,
    session: FundingReceiveSessionSnapshot,
    now: Date,
    candidateLimit: number,
  ): Promise<number> {
    const candidates = await listFundingReceiveSpentReviewCandidates(pool, {
      userId: session.userId,
      receiveSessionId: session.session.receiveSessionId,
      limit: candidateLimit,
    });
    if (candidates.length === 0) return 0;
    await markFundingReceiveSpentReviewCandidatesChecked(pool, {
      userId: session.userId,
      receiveSessionId: session.session.receiveSessionId,
      receiptIds: candidates.map(({ receiptId }) => receiptId),
      now,
    });
    const readBalance =
      this.dependencies.readFinalizedSourceBalance ??
      observeFinalizedSolanaOwnedAssetBalanceAfterSlot;
    let retryRequired = false;
    let resolved = 0;
    for (const candidate of candidates) {
      try {
        const verifiedDebit = await (
          this.dependencies.verifyFinalizedSourceDebit ??
          verifyFinalizedSolanaReceiveSourceDebit
        )({
          signature: candidate.spentSignature,
          destinationAddress: candidate.destinationAddress,
          asset: {
            networkId: candidate.networkId,
            assetId: candidate.assetId,
            decimals: candidate.assetDecimals,
          },
          expectedRaw: candidate.spentRaw,
          expectedSlot: candidate.spentSlot,
        });
        if (!verifiedDebit) continue;
        const observed = await readBalance({
          asset: {
            networkId: candidate.networkId,
            assetId: candidate.assetId,
            decimals: candidate.assetDecimals,
          },
          destinationAddress: candidate.destinationAddress,
          minimumSlot: candidate.requiredFinalizedSlot,
        });
        if (
          await resolveFundingReceiveSpentReview(pool, {
            ...candidate,
            observedBalanceRaw: observed.raw,
            observedSlot: observed.slot,
            verifiedDebitRaw: candidate.spentRaw,
            verifiedDebitSlot: candidate.spentSlot,
            now,
          })
        ) {
          resolved += 1;
          console.info("[funding-receive] exact review source unavailable", {
            receiptId: candidate.receiptId,
            receiveSessionId: candidate.receiveSessionId,
          });
        }
      } catch {
        retryRequired = true;
      }
    }
    if (retryRequired) throw new Error("receive_spent_review_retry_required");
    return resolved;
  }

  private async pollSession(
    pool: Pool,
    snapshot: FundingReceiveSessionSnapshot,
    now: Date,
    precomputed?: Readonly<{
      canonicalEvents: FundingReceiveEventScan | null;
    }>,
  ): Promise<
    Readonly<{ receiptsRecorded: number; recoveryRequired: boolean }>
  > {
    const target = observationTarget(snapshot);
    const canonicalEvents = precomputed
      ? precomputed.canonicalEvents
      : await (
          this.dependencies.scanCanonicalEvents ??
          scanCanonicalFundingReceiveEvents
        )(target.variants, now);
    if (canonicalEvents) {
      return this.persistCanonicalEvents(
        pool,
        snapshot,
        canonicalEvents.events,
        canonicalEvents.variants,
        canonicalEvents.cursorAdvanced,
        now,
      );
    }
    const observed = await observeDirectIngressDestination(pool, target);
    if (!observed) {
      return { receiptsRecorded: 0, recoveryRequired: false };
    }
    const selection = selectFundingReceiveSessionObservation(
      target.variants,
      observed.variants,
    );
    if (selection.kind === "waiting") {
      const rebased = advanceFundingReceiveObservationBaselines(
        target.variants,
        observed.variants,
        "negative_only",
      );
      if (!rebased) {
        return { receiptsRecorded: 0, recoveryRequired: false };
      }
      await tx(pool, async (client) => {
        const closed = isLateObservableReceiveSession(snapshot);
        const activeStatus =
          snapshot.session.status === "open" ||
          snapshot.session.status === "processing" ||
          snapshot.session.status === "review_required" ||
          snapshot.session.status === "recovery_required"
            ? snapshot.session.status
            : null;
        if (!closed && !activeStatus) {
          throw new Error("receive session is not observable");
        }
        const updated = closed
          ? await updateClosedFundingReceiveSessionObservation(client, {
              receiveSessionId: snapshot.session.receiveSessionId,
              expectedVersion: snapshot.session.version,
              observationVariants: rebased.map(jsonRecord),
              lastObservedAt: now,
              recoveryRequired: false,
              now,
            })
          : await updateFundingReceiveSessionObservation(client, {
              receiveSessionId: snapshot.session.receiveSessionId,
              expectedVersion: snapshot.session.version,
              observationVariants: rebased.map(jsonRecord),
              status: activeStatus ?? "open",
              lastObservedAt: now,
              now,
            });
        if (!updated) {
          throw new Error("receive session changed during baseline rebase");
        }
      });
      return { receiptsRecorded: 0, recoveryRequired: false };
    }
    if (selection.kind === "ambiguous") {
      await tx(pool, async (client) => {
        const late = isLateObservableReceiveSession(snapshot);
        const updated = late
          ? await updateClosedFundingReceiveSessionObservation(client, {
              receiveSessionId: snapshot.session.receiveSessionId,
              expectedVersion: snapshot.session.version,
              observationVariants: snapshot.observationVariants,
              lastObservedAt: now,
              recoveryRequired: true,
              now,
            })
          : await updateFundingReceiveSessionObservation(client, {
              receiveSessionId: snapshot.session.receiveSessionId,
              expectedVersion: snapshot.session.version,
              observationVariants: snapshot.observationVariants,
              status: "recovery_required",
              lastObservedAt: now,
              now,
            });
        if (!updated) {
          throw new Error("receive session changed during ambiguity handling");
        }
      });
      return { receiptsRecorded: 0, recoveryRequired: true };
    }
    const selected = selection;
    const handling = fundingReceiveVariantHandling(selected.variant);
    const disposition = fundingReceiveObservationDisposition({
      sessionStatus: snapshot.session.status,
      completion: selected.variant.completion,
      handling,
    });
    const advancedVariants =
      advanceFundingReceiveObservationBaselines(
        target.variants,
        observed.variants,
        "all_changed",
      ) ?? target.variants;
    const nextVariants = advancedVariants.map(jsonRecord);
    const result = await tx(pool, async (client) => {
      const receipt = await insertFundingReceiveReceipt(client, {
        receiveSessionId: snapshot.session.receiveSessionId,
        userId: snapshot.userId,
        variantId: selected.variant.variantId,
        asset: selected.variant.asset,
        destinationAddress: selected.variant.destinationAddress,
        rawAmount: selected.delta.toString(),
        observationRevision: selected.observation.revision,
        observedAt: new Date(selected.observation.observedAt),
        handling,
        status: disposition.receiptStatus,
        evidence: {
          baselineRaw: selected.variant.baselineRaw,
          baselineRevision: selected.variant.baselineRevision,
          observedRaw: selected.observation.observedRaw,
          observedRevision: selected.observation.revision,
          lateReceipt: disposition.late,
        },
        now,
      });
      const updated = disposition.late
        ? await updateClosedFundingReceiveSessionObservation(client, {
            receiveSessionId: snapshot.session.receiveSessionId,
            expectedVersion: snapshot.session.version,
            observationVariants: nextVariants,
            lastObservedAt: new Date(selected.observation.observedAt),
            recoveryRequired: disposition.sessionStatus === "recovery_required",
            now,
          })
        : await updateFundingReceiveSessionObservation(client, {
            receiveSessionId: snapshot.session.receiveSessionId,
            expectedVersion: snapshot.session.version,
            observationVariants: nextVariants,
            // A later ordinary observation cannot silently clear an earlier
            // ambiguous/recovery receipt. It remains visible and observable
            // until the receipt router resolves it.
            status:
              snapshot.session.status === "recovery_required"
                ? "recovery_required"
                : disposition.sessionStatus,
            lastObservedAt: new Date(selected.observation.observedAt),
            now,
          });
      if (!updated) {
        throw new Error("receive session changed while recording a receipt");
      }
      return receipt;
    });
    return {
      receiptsRecorded: result.replayed ? 0 : 1,
      recoveryRequired: false,
    };
  }

  private async persistCanonicalEvents(
    pool: Pool,
    snapshot: FundingReceiveSessionSnapshot,
    events: readonly FundingReceiveCanonicalEvent[],
    variants: readonly DirectIngressObservationVariant[],
    cursorAdvanced: boolean,
    now: Date,
    retry?: FundingReceiveClassificationRetry,
  ): Promise<
    Readonly<{ receiptsRecorded: number; recoveryRequired: boolean }>
  > {
    return tx(pool, async (client) => {
      // Session opens take this scope lock before touching receive rows. Keep
      // the same global order here before canonical allocation locks candidate
      // sessions, otherwise observer-vs-open can deadlock.
      await lockFundingReceiveSessionScope(client, {
        userId: snapshot.userId,
        destinationOptionId: snapshot.session.destinationOptionId,
        venueBindingOptionId: snapshot.session.venueBindingOptionId,
      });
      let receiptsRecorded = 0;
      let recoveryRequired = false;
      let eventBelongsToSession = false;
      const uniqueEvents = deduplicateCanonicalEvents(events);
      if (!cursorAdvanced && uniqueEvents.length === 0) {
        return { receiptsRecorded: 0, recoveryRequired: false };
      }
      // Canonical-event -> operation is the common writer order. Acquire ALL
      // physical keys before the first classification can lead to an operation
      // lock; merely sorting the allocation loop would still allow A -> O -> B
      // versus B -> O deadlocks with a refund/destination writer.
      await lockFundingReceiveCanonicalEvents(
        client,
        events.map((event) => ({
          networkId: event.variant.networkId,
          asset: event.variant.asset,
          destinationAddress: event.destinationAddress,
          sourceAddress: event.sourceAddress,
          rawAmount: event.rawAmount,
          transactionHash: event.transactionHash,
          eventIndex: event.eventIndex,
          ledgerHeight: event.blockNumber,
          blockHash: event.blockHash,
          observedAt: new Date(event.observedAt),
          now,
        })),
      );
      if (retry) {
        if (
          !(await validateFundingReceiveClassificationRetry(
            client,
            retry,
            snapshot.session.receiveSessionId,
          ))
        ) {
          return { receiptsRecorded: 0, recoveryRequired: false };
        }
      }
      const handoffClassifications =
        await loadCanonicalPolymarketHandoffClassifications(client, {
          userId: snapshot.userId,
          events: uniqueEvents,
          now,
          transactionReferenceCodec:
            this.dependencies.transactionReferenceCodec,
          listPotentialPolymarketHandoffs:
            this.dependencies.listPotentialPolymarketHandoffs,
        });
      const canonicalEvents = uniqueEvents.map((event) => ({
        networkId: event.variant.networkId,
        asset: event.variant.asset,
        destinationAddress: event.destinationAddress,
        sourceAddress: event.sourceAddress,
        rawAmount: event.rawAmount,
        transactionHash: event.transactionHash,
        eventIndex: event.eventIndex,
        ledgerHeight: event.blockNumber,
        blockHash: event.blockHash,
        observedAt: new Date(event.observedAt),
      }));
      const recordedRefunds = await (
        this.dependencies.classifyRecordedRefunds ??
        classifyRecordedRelayExactRefundEvents
      )(client, { userId: snapshot.userId, events: canonicalEvents });
      const ownedRouteClassifications = this.dependencies.relayReferenceCodec
        ? await (
            this.dependencies.classifyOwnedRouteDestinations ??
            classifyOwnedRouteCanonicalDestinationEvents
          )(client, {
            userId: snapshot.userId,
            events: canonicalEvents,
            referenceCodec: this.dependencies.relayReferenceCodec,
          })
        : new Map();
      for (const event of uniqueEvents) {
        const eventIdentity = canonicalEventIdentity(event);
        const ownedRouteClassification =
          ownedRouteClassifications.get(eventIdentity);
        const handoff = handoffClassifications.get(eventIdentity);
        const refund = recordedRefunds.get(
          refundCanonicalEventKey({
            ...event,
            networkId: event.variant.networkId,
            asset: event.variant.asset,
            ledgerHeight: event.blockNumber,
            observedAt: new Date(event.observedAt),
          }),
        );
        // All recorded-role readers run before any effect. An exact handoff
        // cannot hide a conflicting/pending destination or refund. Re-evaluate
        // through the existing frozen-target retry queue when facts change.
        const handoffClassification = receiveInternalRolesConflict([
          handoff ?? { kind: "external" },
          ownedRouteClassification ?? { kind: "external" },
          refund ?? { kind: "unmatched" },
        ])
          ? {
              kind: "recovery_required" as const,
              reason: "internal_event_classification_conflict",
            }
          : refund?.kind === "recovery_required"
            ? refund
            : handoff;
        if (handoffClassification?.kind === "internal") {
          const quarantined =
            await quarantineFundingReceiveCanonicalInternalEvent(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              reason: "internal_handoff_suppressed",
              now,
            });
          if (!quarantined) {
            throw new Error(
              "internal handoff was already allocated as an external deposit",
            );
          }
          continue;
        }
        if (handoffClassification?.kind === "recovery_required") {
          const quarantined =
            await quarantineFundingReceiveCanonicalInternalEvent(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              reason:
                handoffClassification.reason ??
                "internal_handoff_classification_ambiguous",
              now,
            });
          if (!quarantined) {
            throw new Error(
              "ambiguous internal handoff was already allocated as an external deposit",
            );
          }
          if (
            !retry &&
            isFundingReceiveClassificationRetryReason(
              handoffClassification.reason,
            )
          ) {
            await bindFundingReceiveCanonicalEventSession(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              now,
            });
          }
          continue;
        }
        if (refund?.kind === "internal") {
          const quarantined =
            await quarantineFundingReceiveCanonicalInternalEvent(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              reason: "internal_exact_refund_suppressed",
              now,
            });
          if (!quarantined)
            throw new Error(
              "recorded refund was already allocated as an external deposit",
            );
          continue;
        }
        // A recorded lookup miss is only an absence of recorded evidence. Keep
        // the legacy receive path unchanged; this is not the pending-source
        // authority needed to activate new exact-refund discovery in the worker.
        if (ownedRouteClassification?.kind === "recovery_required") {
          const quarantined =
            await quarantineFundingReceiveCanonicalInternalEvent(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              reason: ownedRouteClassification.reason,
              now,
            });
          if (!quarantined) {
            throw new Error(
              "ambiguous owned-route transfer was already allocated as an external deposit",
            );
          }
          if (
            !retry &&
            ownedRouteClassification.reason ===
              "owned_route_destination_correlation_pending"
          ) {
            await bindFundingReceiveCanonicalEventSession(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              now,
            });
          }
          continue;
        }
        if (ownedRouteClassification?.kind === "internal") {
          const quarantined =
            await quarantineFundingReceiveCanonicalInternalEvent(client, {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
              reason: "internal_owned_route_destination_suppressed",
              now,
            });
          if (!quarantined) {
            throw new Error(
              "owned-route transfer was already allocated as an external deposit",
            );
          }
          await recordOwnedRouteCanonicalDestinationCredit(client, {
            event: {
              networkId: event.variant.networkId,
              asset: event.variant.asset,
              destinationAddress: event.destinationAddress,
              sourceAddress: event.sourceAddress,
              rawAmount: event.rawAmount,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              ledgerHeight: event.blockNumber,
              blockHash: event.blockHash,
              observedAt: new Date(event.observedAt),
            },
            match: ownedRouteClassification,
            now,
          });
          continue;
        }
        const allocation = await claimFundingReceiveCanonicalEventAllocation(
          client,
          {
            networkId: event.variant.networkId,
            asset: event.variant.asset,
            destinationAddress: event.destinationAddress,
            sourceAddress: event.sourceAddress,
            rawAmount: event.rawAmount,
            transactionHash: event.transactionHash,
            eventIndex: event.eventIndex,
            ledgerHeight: event.blockNumber,
            blockHash: event.blockHash,
            observedAt: new Date(event.observedAt),
            now,
            expectedReceiveSessionId: snapshot.session.receiveSessionId,
          },
        );
        if (
          allocation.targetReceiveSessionId != null &&
          allocation.targetReceiveSessionId !==
            snapshot.session.receiveSessionId
        ) {
          continue;
        }
        if (allocation.status === "recovery_required") {
          eventBelongsToSession = true;
          recoveryRequired = true;
          continue;
        }
        if (allocation.status === "allocated") {
          continue;
        }
        eventBelongsToSession = true;
        const handling = fundingReceiveVariantHandling(event.variant);
        const disposition = fundingReceiveObservationDisposition({
          sessionStatus: retry ? "expired" : snapshot.session.status,
          completion: event.variant.completion,
          handling,
        });
        const observerId =
          event.variant.observation.payload.eventIdentity ===
          "solana_transfer_v1"
            ? "solana_transfer_v1"
            : "evm_erc20_transfer_v1";
        const result = await insertFundingReceiveReceipt(client, {
          receiveSessionId: snapshot.session.receiveSessionId,
          userId: snapshot.userId,
          variantId: event.variant.variantId,
          asset: event.variant.asset,
          destinationAddress: event.destinationAddress,
          rawAmount: event.rawAmount,
          observationRevision: [
            observerId,
            event.variant.networkId,
            event.transactionHash,
            event.eventIndex,
          ].join(":"),
          canonicalEvent: {
            transactionHash: event.transactionHash,
            eventIndex: event.eventIndex,
            ledgerHeight: event.blockNumber,
            blockHash: event.blockHash,
            sourceAddress: event.sourceAddress,
          },
          observedAt: new Date(event.observedAt),
          handling,
          status: disposition.receiptStatus,
          evidence: {
            observerId,
            transactionHash: event.transactionHash,
            eventIndex: event.eventIndex,
            ledgerHeight: event.blockNumber,
            blockHash: event.blockHash,
            sourceAddress: event.sourceAddress,
            canonicalEventId: allocation.eventId,
            lateReceipt: disposition.late,
          },
          now,
        });
        if (
          result.receipt.receiveSessionId !== snapshot.session.receiveSessionId
        ) {
          continue;
        }
        if (!result.replayed) receiptsRecorded += 1;
        const allocated = await finalizeFundingReceiveCanonicalEventAllocation(
          client,
          {
            eventId: allocation.eventId,
            receiveSessionId: snapshot.session.receiveSessionId,
            receiptId: result.receipt.receiptId,
            now,
          },
        );
        if (!allocated) {
          throw new Error(
            "canonical receive event allocation changed during receipt commit",
          );
        }
        await recordCanonicalReceiveDepositNotification(client, {
          receiveSessionId: snapshot.session.receiveSessionId,
          userId: snapshot.userId,
          ownerChannel: snapshot.ownerChannel,
          variant: event.variant,
          event,
          canonicalEventId: allocation.eventId,
          now,
        });
        recoveryRequired ||= disposition.sessionStatus === "recovery_required";
      }
      if (retry) {
        await finishFundingReceiveClassificationRetry(client, {
          retry,
          receiveSessionId: snapshot.session.receiveSessionId,
          receiptsRecorded,
        });
        return { receiptsRecorded, recoveryRequired };
      }
      if (!cursorAdvanced && !eventBelongsToSession) {
        return { receiptsRecorded: 0, recoveryRequired: false };
      }
      const closed = isLateObservableReceiveSession(snapshot);
      const nextVariants = variants.map(jsonRecord);
      const effectiveActiveStatus =
        closed || recoveryRequired
          ? null
          : await deriveEffectiveFundingReceiveSessionStatus(client, {
              receiveSessionId: snapshot.session.receiveSessionId,
              userId: snapshot.userId,
            });
      if (!closed && !recoveryRequired && effectiveActiveStatus === null) {
        throw new Error("receive session disappeared while deriving status");
      }
      const updated = closed
        ? await updateClosedFundingReceiveSessionObservation(client, {
            receiveSessionId: snapshot.session.receiveSessionId,
            expectedVersion: snapshot.session.version,
            observationVariants: nextVariants,
            lastObservedAt: now,
            recoveryRequired,
            now,
          })
        : await updateFundingReceiveSessionObservation(client, {
            receiveSessionId: snapshot.session.receiveSessionId,
            expectedVersion: snapshot.session.version,
            observationVariants: nextVariants,
            status: recoveryRequired
              ? "recovery_required"
              : (effectiveActiveStatus ?? "recovery_required"),
            lastObservedAt: now,
            now,
          });
      if (!updated) {
        throw new Error(
          "receive session changed while recording canonical events",
        );
      }
      return { receiptsRecorded, recoveryRequired };
    });
  }
}
