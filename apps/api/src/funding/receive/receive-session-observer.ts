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
  validateFundingReceiveClassificationRetryBudget,
  stageFundingReceiveClassificationBatch,
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
import {
  resolveLegacyRecordedReceiveRoles,
  type ReceiveEventClassification,
} from "./receive-event-classification.js";
import {
  commitFundingClassificationTransaction,
  lockFundingClassificationOperations,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  classifyRecordedRelayExactRefundEvents,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";
import {
  advanceReceiveRefundScan,
  checkpointReceiveRoleArbitrationInTransaction,
  clearReceiveRefundScanBatch,
} from "./receive-refund-scan.js";
import { supportsRefundSourceEnvelope } from "../reconciliation/relay-refund-source-candidates.js";
import { inspectEvmFundingReceiveAnchor } from "./evm-receive-anchor-proof.js";
import { prepareReceiveAnchors } from "./prepare-receive-anchors.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";
import {
  readPendingReceiveAnchorCandidate,
  repairPendingReceiveAnchor,
} from "../persistence/funding-pending-receive-anchor.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

function canonicalEventInput(event: FundingReceiveCanonicalEvent, now: Date) {
  return {
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
  };
}

type ReceivePublicationAuthority = Readonly<{
  limit: number;
  claims: readonly Readonly<{
    retry: FundingReceiveClassificationRetry;
    event: FundingReceiveCanonicalEvent;
  }>[];
}>;

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
      inspectCanonicalAnchor?: typeof inspectEvmFundingReceiveAnchor;
      listPotentialPolymarketHandoffs?: typeof listPotentialPolymarketHandoffsForCanonicalEvents;
      classifyOwnedRouteDestinations?: typeof classifyOwnedRouteCanonicalDestinationEvents;
      classifyRecordedRefunds?: typeof classifyRecordedRelayExactRefundEvents;
      readRoleArbitration?: typeof checkpointReceiveRoleArbitrationInTransaction;
      readFinalizedSourceBalance?: typeof observeFinalizedSolanaOwnedAssetBalanceAfterSlot;
      readFinalizedInventoryBalance?: typeof observeFinalizedOwnedReceiveSourceBalance;
      verifyFinalizedSourceDebit?: typeof verifyFinalizedSolanaReceiveSourceDebit;
    }> = {},
  ) {}

  /** Known transfers only: bounded exact-transaction chain inspection, no
   * history scan, quote or old Buy. Rolling claims commit before provider IO;
   * a slow event must not postpone every untouched event in a bulk lease. */
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
      refundScanPages: number;
      refundScanErrors: number;
      refundScanCleanupEvents: number;
      refundScanCleanupRows: number;
      refundScanCleanupErrors: number;
      anchorsRepaired: number;
      anchorsDeferred: number;
    }>
  > {
    validateFundingReceiveClassificationRetryBudget({
      ...input,
      now: input.now ?? new Date(),
    });
    // Cleanup remains reachable after allocation removes E from the retry
    // queue. Failure is diagnostic; it must not block financial evidence repair.
    const cleanup = await clearReceiveRefundScanBatch(pool, {
      limit: input.limit,
    }).catch(() => ({ eventsChecked: 0, rowsDeleted: 0, errors: 1 }));
    // The existing retry interval bounds this invocation, independent of the
    // optional deterministic scheduling clock. Cleanup is outside that budget.
    const deadlineMs = Date.now() + input.retryDelayMs;
    let receiptsRecorded = 0,
      recoveriesRequired = 0,
      retryableErrors = 0,
      unboundEvents = 0,
      refundScanPages = 0,
      refundScanErrors = 0,
      eventsChecked = 0,
      anchorsRepaired = 0,
      anchorsDeferred = 0;
    while (eventsChecked < input.limit && Date.now() < deadlineMs) {
      const now = input.now ?? new Date();
      const [claimedRetry] = await claimFundingReceiveClassificationRetries(
        pool,
        {
          ...input,
          limit: 1,
          now,
        },
      );
      if (!claimedRetry) break;
      eventsChecked += 1;
      let retry = claimedRetry;
      try {
        if (Date.now() >= deadlineMs) {
          anchorsDeferred += 1;
          continue;
        }
        if (["evm:137", "evm:8453"].includes(retry.networkId)) {
          const candidate = await readPendingReceiveAnchorCandidate(
            pool,
            retry.eventId,
          );
          if (
            !candidate ||
            JSON.parse(candidate.snapshot).classification_lease_token !==
              retry.leaseToken ||
            receiveRoleEventFingerprint(candidate.event) !==
              receiveRoleEventFingerprint(retry)
          ) {
            anchorsDeferred += 1;
            continue;
          }
          if (Date.now() >= deadlineMs) {
            anchorsDeferred += 1;
            continue;
          }
          const proof = await (
            this.dependencies.inspectCanonicalAnchor ??
            inspectEvmFundingReceiveAnchor
          )({
            expected: candidate.event,
            deadlineMs,
          });
          if (proof.kind === "replacement_verified") {
            const repaired = await repairPendingReceiveAnchor(pool, {
              candidate,
              proof,
              deadlineMs,
            });
            if (repaired === "reanchored") anchorsRepaired += 1;
            else anchorsDeferred += 1;
            // A reanchor revokes this token. Only a NEW ordinary claim may
            // classify B; no branch may fall through and publish old A.
            continue;
          }
          if (
            proof.kind !== "canonical" ||
            proof.eventFingerprint !== receiveRoleEventFingerprint(retry)
          ) {
            anchorsDeferred += 1;
            continue;
          }
          if (Date.now() >= deadlineMs) {
            anchorsDeferred += 1;
            continue;
          }
        }
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
        // Advance derived evidence under the SAME claimed event lease, before
        // publication consumes that lease. One page per event, using the
        // existing worker batch budget; no chain scan, quote or execution.
        const jointAuthority = supportsRefundSourceEnvelope(retry);
        if (jointAuthority) {
          if (!retry.boundSessionId || !retry.boundVariantId) {
            // Historical rows can predate any receiving session. Freeze the
            // selected binding before scan headers capture it; the existing
            // lease must still match. No fabricated session or new lease.
            const bound = await tx(pool, async (db) => {
              await lockFundingReceiveSessionScope(db, {
                userId: target.snapshot.userId,
                destinationOptionId:
                  target.snapshot.session.destinationOptionId,
                venueBindingOptionId:
                  target.snapshot.session.venueBindingOptionId,
              });
              await lockFundingReceiveCanonicalEvents(db, [
                canonicalEventInput(event, now),
              ]);
              return validateFundingReceiveClassificationRetry(
                db,
                retry,
                target.snapshot.session.receiveSessionId,
              );
            });
            if (!bound) continue;
            retry = {
              ...retry,
              boundSessionId: target.snapshot.session.receiveSessionId,
              boundVariantId: target.event.variantId,
            };
          }
          try {
            const progress = await advanceReceiveRefundScan(pool, {
              retry,
              userId: target.snapshot.userId,
              limit: input.limit,
              transactionReferenceCodec:
                this.dependencies.transactionReferenceCodec,
              referenceCodec: this.dependencies.relayReferenceCodec,
            });
            if (progress.kind === "context_mismatch") refundScanErrors += 1;
            else if (
              progress.kind === "source_page" ||
              progress.kind === "action_page"
            )
              refundScanPages += 1;
          } catch {
            refundScanErrors += 1;
          }
        }
        const result = await this.persistCanonicalEvents(
          pool,
          target.snapshot,
          [event],
          variants,
          false,
          now,
          retry,
          jointAuthority
            ? { limit: input.limit, claims: [{ retry, event }] }
            : undefined,
        );
        receiptsRecorded += result.receiptsRecorded;
        recoveriesRequired += Number(result.recoveryRequired);
      } catch {
        retryableErrors += 1;
      }
    }
    return {
      eventsChecked,
      anchorsRepaired,
      anchorsDeferred,
      unboundEvents,
      receiptsRecorded,
      recoveriesRequired,
      retryableErrors,
      refundScanPages,
      refundScanErrors,
      refundScanCleanupEvents: cleanup.eventsChecked,
      refundScanCleanupRows: cleanup.rowsDeleted,
      refundScanCleanupErrors: cleanup.errors,
    };
  }

  async pollBatch(
    pool: Pool,
    input: Readonly<{
      limit?: number;
      minimumPollIntervalMs?: number;
      /** Lease/retry clock is independent of an explicit zero-delay scan. */
      classificationRetryDelayMs?: number;
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
            {
              limit: batchLimit,
              retryDelayMs: input.classificationRetryDelayMs ?? 10_000,
            },
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
    classificationPolicy: Readonly<{ limit: number; retryDelayMs: number }>,
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
      const supported = canonicalEvents.events.filter((event) =>
        supportsRefundSourceEnvelope(canonicalEventInput(event, now)),
      );
      const claims: ReceivePublicationAuthority["claims"][number][] = [];
      if (supported.length) {
        if (
          (await prepareReceiveAnchors(pool, {
            events: supported.map((event) => canonicalEventInput(event, now)),
            deadlineMs: Date.now() + classificationPolicy.retryDelayMs,
            inspect: this.dependencies.inspectCanonicalAnchor,
          })) !== "ready"
        )
          return { receiptsRecorded: 0, recoveryRequired: true };
        // Persist immutable events and selected bindings BEFORE source reads.
        // A crash or a cursor advance cannot lose the ordinary retry work.
        const staged = await stageFundingReceiveClassificationBatch(pool, {
          scope: {
            userId: snapshot.userId,
            destinationOptionId: snapshot.session.destinationOptionId,
            venueBindingOptionId: snapshot.session.venueBindingOptionId,
          },
          events: supported.map((event) => canonicalEventInput(event, now)),
          retryDelayMs: classificationPolicy.retryDelayMs,
          classifyRecordedRefunds: this.dependencies.classifyRecordedRefunds,
          now,
        });
        for (const stage of staged) {
          // Other selected sessions, deferred leases and final allocations are
          // never sent through legacy allocation as an apparent fresh deposit.
          if (
            stage.kind !== "claimed" ||
            stage.retry.boundSessionId !== snapshot.session.receiveSessionId
          )
            continue;
          const target = await fundingReceiveClassificationRetryTarget(
            pool,
            stage.retry,
          );
          if (!target || target.snapshot.userId !== snapshot.userId) continue;
          const event = recoveredCanonicalEvent(
            target.observationStartVariants.map(
              parseDirectIngressObservationVariant,
            ),
            target.event,
          );
          if (!event) continue;
          await advanceReceiveRefundScan(pool, {
            retry: stage.retry,
            userId: snapshot.userId,
            limit: classificationPolicy.limit,
            transactionReferenceCodec:
              this.dependencies.transactionReferenceCodec,
            referenceCodec: this.dependencies.relayReferenceCodec,
          });
          claims.push({ retry: stage.retry, event });
        }
      }
      return this.persistCanonicalEvents(
        pool,
        snapshot,
        canonicalEvents.events,
        canonicalEvents.variants,
        canonicalEvents.cursorAdvanced,
        now,
        undefined,
        supported.length
          ? { limit: classificationPolicy.limit, claims }
          : undefined,
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
    authority?: ReceivePublicationAuthority,
  ): Promise<
    Readonly<{ receiptsRecorded: number; recoveryRequired: boolean }>
  > {
    const client = await pool.connect();
    const dependencies: FundingClassificationRevision[] = [];
    try {
      await client.query("begin");
      const result = await (async () => {
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
          events.map((event) => canonicalEventInput(event, now)),
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
        const legacyEvents = authority
          ? uniqueEvents.filter(
              (event) =>
                !supportsRefundSourceEnvelope(canonicalEventInput(event, now)),
            )
          : uniqueEvents;
        const handoffClassifications =
          await loadCanonicalPolymarketHandoffClassifications(client, {
            userId: snapshot.userId,
            events: legacyEvents,
            now,
            transactionReferenceCodec:
              this.dependencies.transactionReferenceCodec,
            listPotentialPolymarketHandoffs:
              this.dependencies.listPotentialPolymarketHandoffs,
          });
        const canonicalEvents = legacyEvents.map((event) =>
          canonicalEventInput(event, now),
        );
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
        const classifiedEvents: {
          event: FundingReceiveCanonicalEvent;
          classification: ReceiveEventClassification;
        }[] = legacyEvents.map((event) => {
          const eventIdentity = canonicalEventIdentity(event);
          return {
            event,
            classification: resolveLegacyRecordedReceiveRoles({
              handoff: handoffClassifications.get(eventIdentity),
              destination: ownedRouteClassifications.get(eventIdentity),
              refund: recordedRefunds.get(
                refundCanonicalEventKey({
                  ...event,
                  networkId: event.variant.networkId,
                  asset: event.variant.asset,
                  ledgerHeight: event.blockNumber,
                  observedAt: new Date(event.observedAt),
                }),
              ),
            }),
          };
        });
        const validClaims: FundingReceiveClassificationRetry[] = [];
        if (authority)
          for (const claim of authority.claims) {
            if (
              !(await validateFundingReceiveClassificationRetry(
                client,
                claim.retry,
                snapshot.session.receiveSessionId,
              ))
            )
              continue;
            validClaims.push(claim.retry);
            const decision = await (
              this.dependencies.readRoleArbitration ??
              checkpointReceiveRoleArbitrationInTransaction
            )(client, {
              retry: claim.retry,
              userId: snapshot.userId,
              limit: authority.limit,
              transactionReferenceCodec:
                this.dependencies.transactionReferenceCodec,
              referenceCodec: this.dependencies.relayReferenceCodec,
            });
            if (decision.kind === "incomplete") continue;
            classifiedEvents.push({
              event: claim.event,
              classification: decision.classification,
            });
            dependencies.push(...decision.dependencies);
          }
        // Full batch union, including negative witnesses, before ANY effect.
        // A mismatch at F rolls back receipts, notifications and acknowledgments.
        if (authority)
          await lockFundingClassificationOperations(
            client,
            dependencies,
            classifiedEvents.flatMap(({ classification }) =>
              classification.kind === "internal_destination"
                ? [
                    {
                      operationId: classification.match.operationId,
                      userId: snapshot.userId,
                    },
                  ]
                : [],
            ),
          );
        for (const { event, classification } of classifiedEvents) {
          const canonicalEvent = canonicalEventInput(event, now);
          if (classification.kind !== "external") {
            const reason =
              classification.kind === "recovery_required"
                ? classification.reason
                : classification.kind === "internal_handoff"
                  ? "internal_handoff_suppressed"
                  : classification.kind === "internal_refund"
                    ? "internal_exact_refund_suppressed"
                    : "internal_owned_route_destination_suppressed";
            const quarantined =
              await quarantineFundingReceiveCanonicalInternalEvent(client, {
                ...canonicalEvent,
                reason,
              });
            if (!quarantined) {
              throw new Error(
                "internal transfer was already allocated as an external deposit",
              );
            }
            if (
              classification.kind === "recovery_required" &&
              !retry &&
              isFundingReceiveClassificationRetryReason(reason)
            )
              await bindFundingReceiveCanonicalEventSession(
                client,
                canonicalEvent,
              );
            if (classification.kind === "internal_destination")
              await recordOwnedRouteCanonicalDestinationCredit(client, {
                event: canonicalEvent,
                match: classification.match,
                now,
              });
            continue;
          }
          const allocation = await claimFundingReceiveCanonicalEventAllocation(
            client,
            {
              ...canonicalEvent,
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
            result.receipt.receiveSessionId !==
            snapshot.session.receiveSessionId
          ) {
            continue;
          }
          if (!result.replayed) receiptsRecorded += 1;
          const allocated =
            await finalizeFundingReceiveCanonicalEventAllocation(client, {
              eventId: allocation.eventId,
              receiveSessionId: snapshot.session.receiveSessionId,
              receiptId: result.receipt.receiptId,
              now,
            });
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
          recoveryRequired ||=
            disposition.sessionStatus === "recovery_required";
        }
        for (const claim of validClaims) {
          await finishFundingReceiveClassificationRetry(client, {
            retry: claim,
            receiveSessionId: snapshot.session.receiveSessionId,
            // Initial observation updates its own version/cursor below. A retry
            // never reopens its old session or authorizes another automatic buy.
            receiptsRecorded: retry ? receiptsRecorded : 0,
          });
        }
        if (retry && !authority) {
          await finishFundingReceiveClassificationRetry(client, {
            retry,
            receiveSessionId: snapshot.session.receiveSessionId,
            receiptsRecorded,
          });
          return { receiptsRecorded, recoveryRequired };
        }
        if (retry) return { receiptsRecorded, recoveryRequired };
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
      })();
      if (authority)
        await commitFundingClassificationTransaction(client, dependencies);
      else await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
