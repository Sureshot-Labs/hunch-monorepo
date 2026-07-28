import { tx, type Pool } from "@hunch/infra";

import type {
  FundingReceiveReceipt,
  FundingReceiveSessionStatus,
  JsonValue,
} from "../domain/types.js";
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
  type FundingReceiveCanonicalEvent,
} from "./canonical-receive-event-scanner.js";
import { fundingReceiveVariantHandling } from "../planner/receive-targets.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

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
  const direct = input.completion.kind === "direct_destination_credit";
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
    let receiptsRecorded = 0;
    for (const session of sessions) {
      try {
        const result = await this.pollSession(pool, session, now);
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
  ): Promise<
    Readonly<{ receiptsRecorded: number; recoveryRequired: boolean }>
  > {
    const target = observationTarget(snapshot);
    const canonicalEvents = await scanCanonicalFundingReceiveEvents(
      target.variants,
      now,
    );
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
          snapshot.session.status === "review_required"
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
            status: disposition.sessionStatus,
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
      for (const event of events) {
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
        recoveryRequired ||= disposition.sessionStatus === "recovery_required";
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
}
