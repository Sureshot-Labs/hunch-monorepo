import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { sameAccountAddress } from "../domain/asset-identity.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type {
  FundingReceiveReceipt,
  FundingReceiveSessionStatus,
  JsonValue,
  NormalizedAction,
} from "../domain/types.js";
import { polymarketDepositWalletHandoffExpectation } from "../execution/polymarket-deposit-wallet-handoff.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  FundingPolymarketHandoffLookupOverflowError,
  listPotentialPolymarketHandoffsForCanonicalEvents,
  type FundingPolymarketHandoffCandidate,
} from "../persistence/funding-evidence-repository.js";
import {
  observeDirectIngressDestination,
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
  type DirectIngressObservationTarget,
  type DirectIngressVariantObservation,
} from "../reconciliation/direct-ingress-observer.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  claimObservableFundingReceiveSessions,
  derivePersistedFundingReceiveSessionStatus,
  finalizeFundingReceiveCanonicalEventAllocation,
  insertFundingReceiveReceipt,
  expireFundingReceiveSessions,
  updateClosedFundingReceiveSessionObservation,
  updateFundingReceiveSessionObservation,
  type FundingReceiveSessionSnapshot,
} from "../persistence/funding-receive-session-repository.js";
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

type JsonRecord = Readonly<Record<string, JsonValue>>;

const EVM_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type FingerprintedFundingReceiveCanonicalEvent = Readonly<{
  event: FundingReceiveCanonicalEvent;
  receiptRefLookupHmac: string | null;
}>;

export type PolymarketHandoffEventClassification = Readonly<{
  kind: "internal" | "external" | "recovery_required";
  reason: string | null;
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

function handoffSnapshotMatchesCanonicalEvent(
  candidate: FundingPolymarketHandoffCandidate,
  event: FundingReceiveCanonicalEvent,
): boolean {
  const networkId = candidate.normalizedAction.networkId;
  const tokenAddress = candidate.actionValidationResult.tokenAddress;
  const funderAddress = candidate.actionValidationResult.funderAddress;
  const recipientAddress = candidate.actionValidationResult.recipientAddress;
  const amountRaw = candidate.actionValidationResult.amountRaw;
  if (
    typeof networkId !== "string" ||
    typeof tokenAddress !== "string" ||
    typeof funderAddress !== "string" ||
    typeof recipientAddress !== "string" ||
    typeof amountRaw !== "string" ||
    networkId !== event.variant.networkId ||
    amountRaw !== event.rawAmount
  ) {
    return false;
  }
  return (
    sameAccountAddress(networkId, funderAddress, event.sourceAddress) &&
    sameAccountAddress(networkId, recipientAddress, event.destinationAddress) &&
    sameAccountAddress(networkId, tokenAddress, event.variant.asset.assetId)
  );
}

function handoffCanonicalEventRelation(
  candidate: FundingPolymarketHandoffCandidate,
  event: FundingReceiveCanonicalEvent,
): "match" | "mismatch" | "invalid" {
  const snapshotMatch = handoffSnapshotMatchesCanonicalEvent(candidate, event);
  const action = normalizedActionSchema.safeParse(candidate.normalizedAction);
  if (!action.success) return snapshotMatch ? "invalid" : "mismatch";
  const expectation = polymarketDepositWalletHandoffExpectation(
    action.data as unknown as NormalizedAction,
    candidate.actionValidationResult,
  );
  if (!expectation || action.data.networkId !== event.variant.networkId) {
    return snapshotMatch ? "invalid" : "mismatch";
  }
  let eventAmount: bigint;
  try {
    eventAmount = BigInt(event.rawAmount);
  } catch {
    return "invalid";
  }
  return expectation.amountRaw === eventAmount &&
    sameAccountAddress(
      event.variant.networkId,
      expectation.funderAddress,
      event.sourceAddress,
    ) &&
    sameAccountAddress(
      event.variant.networkId,
      expectation.recipientAddress,
      event.destinationAddress,
    ) &&
    sameAccountAddress(
      event.variant.networkId,
      expectation.tokenAddress,
      event.variant.asset.assetId,
    )
    ? "match"
    : snapshotMatch
      ? "invalid"
      : "mismatch";
}

function candidateReferenceMatch(
  candidate: FundingPolymarketHandoffCandidate,
  event: FingerprintedFundingReceiveCanonicalEvent,
  codec: Pick<FundingTransactionReferenceCodec, "decrypt"> | null,
): "match" | "mismatch" | "unavailable" {
  if (
    candidate.receiptRefLookupHmac &&
    event.receiptRefLookupHmac &&
    candidate.receiptRefLookupHmac === event.receiptRefLookupHmac
  ) {
    return "match";
  }
  if (!candidate.receiptRefCiphertext || !codec) return "unavailable";
  try {
    return codec.decrypt(candidate.receiptRefCiphertext).toLowerCase() ===
      event.event.transactionHash.toLowerCase()
      ? "match"
      : "mismatch";
  } catch {
    return "unavailable";
  }
}

export function classifyPolymarketHandoffEvents(
  events: readonly FingerprintedFundingReceiveCanonicalEvent[],
  candidates: readonly FundingPolymarketHandoffCandidate[],
  codec: Pick<FundingTransactionReferenceCodec, "decrypt"> | null = null,
): ReadonlyMap<string, PolymarketHandoffEventClassification> {
  const classifications = new Map<string, PolymarketHandoffEventClassification>(
    events.map((entry) => [
      canonicalEventIdentity(entry.event),
      { kind: "external", reason: null },
    ]),
  );
  const candidateMatches = new Map<string, Set<string>>();
  const eventMatches = new Map<string, Set<string>>();
  const markRecovery = (eventIdentity: string, reason: string) => {
    classifications.set(eventIdentity, {
      kind: "recovery_required",
      reason,
    });
  };
  const markMatch = (candidateId: string, eventIdentity: string) => {
    const candidateEventIds = candidateMatches.get(candidateId) ?? new Set();
    candidateEventIds.add(eventIdentity);
    candidateMatches.set(candidateId, candidateEventIds);
    const eventCandidateIds = eventMatches.get(eventIdentity) ?? new Set();
    eventCandidateIds.add(candidateId);
    eventMatches.set(eventIdentity, eventCandidateIds);
  };

  for (const candidate of candidates) {
    if (candidate.attemptOutcome === "started") {
      for (const event of events) {
        const eventIdentity = canonicalEventIdentity(event.event);
        const relation = handoffCanonicalEventRelation(candidate, event.event);
        if (relation === "match") {
          markMatch(candidate.attemptId, eventIdentity);
        } else if (relation === "invalid") {
          markRecovery(eventIdentity, "handoff_envelope_invalid");
        }
      }
      continue;
    }

    const referencedEvents: (typeof events)[number][] = [];
    const exactReferencedEvents: (typeof events)[number][] = [];
    for (const event of events) {
      const eventIdentity = canonicalEventIdentity(event.event);
      const relation = handoffCanonicalEventRelation(candidate, event.event);
      const referenceMatch = candidateReferenceMatch(candidate, event, codec);
      if (referenceMatch === "match") {
        referencedEvents.push(event);
        if (relation === "match") exactReferencedEvents.push(event);
        if (relation === "invalid") {
          markRecovery(eventIdentity, "handoff_envelope_invalid");
        }
        continue;
      }
      if (relation === "match" && referenceMatch === "unavailable") {
        markRecovery(eventIdentity, "handoff_reference_unavailable");
      } else if (relation === "invalid" && referenceMatch === "unavailable") {
        markRecovery(eventIdentity, "handoff_envelope_invalid");
      }
    }
    if (exactReferencedEvents.length > 0) {
      for (const event of exactReferencedEvents) {
        markMatch(candidate.attemptId, canonicalEventIdentity(event.event));
      }
      continue;
    }
    for (const event of referencedEvents) {
      markRecovery(
        canonicalEventIdentity(event.event),
        "handoff_reference_envelope_mismatch",
      );
    }
  }

  for (const event of events) {
    const eventIdentity = canonicalEventIdentity(event.event);
    if (classifications.get(eventIdentity)?.kind === "recovery_required") {
      continue;
    }
    const matchingCandidates = eventMatches.get(eventIdentity) ?? new Set();
    if (matchingCandidates.size === 0) continue;
    if (matchingCandidates.size !== 1) {
      markRecovery(eventIdentity, "handoff_candidate_ambiguity");
      continue;
    }
    const candidateId = [...matchingCandidates][0];
    if (!candidateId) continue;
    const matchingEvents = candidateMatches.get(candidateId) ?? new Set();
    if (matchingEvents.size !== 1) {
      for (const matchingEventIdentity of matchingEvents) {
        markRecovery(matchingEventIdentity, "handoff_event_ambiguity");
      }
      continue;
    }
    classifications.set(eventIdentity, { kind: "internal", reason: null });
  }
  return classifications;
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

export async function isFundingReceiveSessionSchemaReady(
  db: Pick<Pool, "query">,
): Promise<boolean> {
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
        as ready
    `,
  );
  return rows[0]?.ready === true;
}

export type FundingReceiveSessionObservationResult = Readonly<{
  sessionsPolled: number;
  receiptsRecorded: number;
  recoveriesRequired: number;
  retryableErrors: number;
}>;

type FundingReceivePollingCandidate = Readonly<{
  userId: string;
  session: Readonly<{
    receiveSessionId: string;
    status: FundingReceiveSessionStatus;
    openedAt: string;
  }>;
  observationVariants: readonly JsonRecord[];
}>;

function sessionPollingPriority(
  snapshot: FundingReceivePollingCandidate,
): number {
  return snapshot.session.status === "open" ||
    snapshot.session.status === "processing" ||
    snapshot.session.status === "review_required"
    ? 0
    : 1;
}

function canonicalCursor(
  variants: readonly DirectIngressObservationVariant[],
): bigint | null {
  const cursors = variants.flatMap((variant) => {
    const raw =
      variant.observation.payload.eventCursorBlock ??
      variant.observation.payload.eventCursorSlot;
    return typeof raw === "string" && /^[0-9]+$/.test(raw) ? [BigInt(raw)] : [];
  });
  if (cursors.length === 0) return null;
  return cursors.reduce((minimum, cursor) =>
    cursor < minimum ? cursor : minimum,
  );
}

export function selectFundingReceiveSessionsForPolling<
  T extends FundingReceivePollingCandidate,
>(snapshots: readonly T[]): readonly T[] {
  const valid = snapshots.flatMap((snapshot) => {
    try {
      const variants = snapshot.observationVariants.map(
        parseDirectIngressObservationVariant,
      );
      return [{ snapshot, cursor: canonicalCursor(variants) }];
    } catch {
      return [];
    }
  });
  valid.sort((left, right) => {
    if (left.cursor != null && right.cursor != null) {
      if (left.cursor < right.cursor) return -1;
      if (left.cursor > right.cursor) return 1;
    } else if (left.cursor != null) {
      return -1;
    } else if (right.cursor != null) {
      return 1;
    }
    const priority =
      sessionPollingPriority(left.snapshot) -
      sessionPollingPriority(right.snapshot);
    if (priority !== 0) return priority;
    const openedAt =
      Date.parse(right.snapshot.session.openedAt) -
      Date.parse(left.snapshot.session.openedAt);
    if (openedAt !== 0) return openedAt;
    return left.snapshot.session.receiveSessionId.localeCompare(
      right.snapshot.session.receiveSessionId,
    );
  });
  return valid.map((entry) => entry.snapshot);
}

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

async function quarantineInvalidObservationVariants(
  pool: Pool,
  snapshot: FundingReceiveSessionSnapshot,
  now: Date,
): Promise<boolean> {
  const closed =
    snapshot.session.status === "expired" ||
    snapshot.session.status === "cancelled";
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
    input.sessionStatus === "expired" || input.sessionStatus === "cancelled";
  const direct = isDirectReceiveCompletionKind(input.completion.kind);
  const reviewRequired = input.handling === "review_required";
  if (late && !direct) {
    return {
      receiptStatus: "recovery_required",
      sessionStatus: "recovery_required",
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
      scanCanonicalEvents?: typeof scanCanonicalFundingReceiveEvents;
      scanCanonicalEventsBatch?: typeof scanCanonicalFundingReceiveEventsBatch;
      listPotentialPolymarketHandoffs?: typeof listPotentialPolymarketHandoffsForCanonicalEvents;
    }> = {},
  ) {}

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
        limit: Math.min(1_000, batchLimit * 8),
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
    const sessions = selectFundingReceiveSessionsForPolling(
      validSessions,
    ).slice(0, batchLimit);
    let batchScans: Awaited<
      ReturnType<typeof scanCanonicalFundingReceiveEventsBatch>
    > | null = null;
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
        return {
          sessionsPolled: sessions.length,
          receiptsRecorded: 0,
          recoveriesRequired,
          retryableErrors,
        };
      }
    }
    let receiptsRecorded = 0;
    for (const session of sessions) {
      const sessionKey = session.session.receiveSessionId;
      if (batchScans?.failedKeys.has(sessionKey)) {
        retryableErrors += 1;
        continue;
      }
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
    return {
      sessionsPolled: sessions.length,
      receiptsRecorded,
      recoveriesRequired,
      retryableErrors,
    };
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
        const closed =
          snapshot.session.status === "expired" ||
          snapshot.session.status === "cancelled";
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
        const late =
          snapshot.session.status === "expired" ||
          snapshot.session.status === "cancelled";
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
  ): Promise<
    Readonly<{ receiptsRecorded: number; recoveryRequired: boolean }>
  > {
    if (!cursorAdvanced && events.length === 0) {
      return { receiptsRecorded: 0, recoveryRequired: false };
    }
    return tx(pool, async (client) => {
      let receiptsRecorded = 0;
      let recoveryRequired = false;
      const uniqueEvents = deduplicateCanonicalEvents(events);
      const handoffClassifications = await this.handoffClassifications(
        client,
        snapshot,
        uniqueEvents,
      );
      for (const event of uniqueEvents) {
        const handoffClassification = handoffClassifications.get(
          canonicalEventIdentity(event),
        );
        if (handoffClassification?.kind === "internal") {
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
          },
        );
        if (allocation.status === "recovery_required") {
          recoveryRequired = true;
          continue;
        }
        if (
          allocation.status === "allocated" ||
          allocation.targetReceiveSessionId !==
            snapshot.session.receiveSessionId
        ) {
          continue;
        }
        const handling = fundingReceiveVariantHandling(event.variant);
        const disposition = fundingReceiveObservationDisposition({
          sessionStatus: snapshot.session.status,
          completion: event.variant.completion,
          handling,
        });
        const handoffRecoveryRequired =
          handoffClassification?.kind === "recovery_required";
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
          status: handoffRecoveryRequired
            ? "recovery_required"
            : disposition.receiptStatus,
          evidence: {
            observerId,
            transactionHash: event.transactionHash,
            eventIndex: event.eventIndex,
            ledgerHeight: event.blockNumber,
            blockHash: event.blockHash,
            sourceAddress: event.sourceAddress,
            canonicalEventId: allocation.eventId,
            lateReceipt: disposition.late,
            ...(handoffRecoveryRequired
              ? {
                  handoffClassification: "recovery_required",
                  handoffReason: handoffClassification.reason,
                }
              : {}),
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
        recoveryRequired ||=
          handoffRecoveryRequired ||
          disposition.sessionStatus === "recovery_required";
      }
      const closed =
        snapshot.session.status === "expired" ||
        snapshot.session.status === "cancelled";
      const nextVariants = variants.map(jsonRecord);
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
              : await derivePersistedFundingReceiveSessionStatus(client, {
                  receiveSessionId: snapshot.session.receiveSessionId,
                  userId: snapshot.userId,
                }),
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

  private async handoffClassifications(
    client: PoolClient,
    snapshot: FundingReceiveSessionSnapshot,
    events: readonly FundingReceiveCanonicalEvent[],
  ): Promise<ReadonlyMap<string, PolymarketHandoffEventClassification>> {
    const codec = this.dependencies.transactionReferenceCodec ?? null;
    const fingerprinted: FingerprintedFundingReceiveCanonicalEvent[] = [];
    for (const event of events) {
      if (
        !event.variant.networkId.startsWith("evm:") ||
        !EVM_TRANSACTION_HASH_PATTERN.test(event.transactionHash)
      ) {
        continue;
      }
      let receiptRefLookupHmac: string | null = null;
      if (codec) {
        try {
          receiptRefLookupHmac = codec.fingerprint(
            event.transactionHash.toLowerCase(),
          );
        } catch {
          receiptRefLookupHmac = null;
        }
      }
      fingerprinted.push({ event, receiptRefLookupHmac });
    }
    if (fingerprinted.length === 0) return new Map();
    let candidates: readonly FundingPolymarketHandoffCandidate[];
    try {
      candidates = await (
        this.dependencies.listPotentialPolymarketHandoffs ??
        listPotentialPolymarketHandoffsForCanonicalEvents
      )(client, {
        userId: snapshot.userId,
        currentLookupKeyVersion: codec?.keyVersion ?? null,
        events: fingerprinted.map((entry) => ({
          networkId: entry.event.variant.networkId,
          assetId: entry.event.variant.asset.assetId,
          sourceAddress: entry.event.sourceAddress,
          destinationAddress: entry.event.destinationAddress,
          rawAmount: entry.event.rawAmount,
          receiptRefLookupHmac: entry.receiptRefLookupHmac,
        })),
      });
    } catch (error) {
      if (!(error instanceof FundingPolymarketHandoffLookupOverflowError)) {
        throw error;
      }
      return new Map(
        fingerprinted.map(({ event }) => [
          canonicalEventIdentity(event),
          {
            kind: "recovery_required" as const,
            reason: "handoff_candidate_lookup_overflow",
          },
        ]),
      );
    }
    return classifyPolymarketHandoffEvents(fingerprinted, candidates, codec);
  }
}
