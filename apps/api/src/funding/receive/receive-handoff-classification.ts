import type { PoolClient } from "@hunch/infra";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type { NormalizedAction } from "../domain/types.js";
import { polymarketDepositWalletHandoffExpectation } from "../execution/polymarket-deposit-wallet-handoff.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  FundingPolymarketHandoffLookupOverflowError,
  listPotentialPolymarketHandoffsForCanonicalEvents,
  type FundingPolymarketHandoffCandidate,
} from "../persistence/funding-evidence-repository.js";
import type { FundingReceiveCanonicalEvent } from "./canonical-receive-event-scanner.js";

/** Physical transfer envelope only: reusable by receive and refund writers,
 * without inventing a receive session/variant for a funding receipt. */
export type HandoffCanonicalEvent = Pick<
  FundingReceiveCanonicalEvent,
  | "transactionHash"
  | "eventIndex"
  | "sourceAddress"
  | "destinationAddress"
  | "rawAmount"
> & {
  variant: Pick<FundingReceiveCanonicalEvent["variant"], "networkId" | "asset">;
};

const EVM_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type FingerprintedFundingReceiveCanonicalEvent = Readonly<{
  event: HandoffCanonicalEvent;
  receiptRefLookupHmac: string | null;
}>;

export type PolymarketHandoffEventClassification =
  | Readonly<{
      kind: "internal";
      reason: null;
      reference: "exact";
      operationId: string;
      attemptId: string;
    }>
  | Readonly<{ kind: "external"; reason: null }>
  | Readonly<{ kind: "recovery_required"; reason: string }>;

function canonicalEventIdentity(event: HandoffCanonicalEvent): string {
  return [
    event.variant.networkId,
    event.transactionHash,
    event.eventIndex,
  ].join(":");
}

function handoffSnapshotMatchesCanonicalEvent(
  candidate: FundingPolymarketHandoffCandidate,
  event: HandoffCanonicalEvent,
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
  event: HandoffCanonicalEvent,
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
  if (candidate.resolvedTransactionHash) {
    return candidate.resolvedTransactionHash.toLowerCase() ===
      event.event.transactionHash.toLowerCase()
      ? "match"
      : "mismatch";
  }
  // A relayer request ID is not a transaction hash, even if an HMAC happens to
  // match. Only its resolved canonical transaction can establish this relation.
  if (candidate.referenceKind === "external_handoff") return "unavailable";
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
  const exactMatches = new Map<string, Set<string>>();
  const matchedCandidates = new Map<
    string,
    FundingPolymarketHandoffCandidate
  >();
  const markRecovery = (eventIdentity: string, reason: string) => {
    classifications.set(eventIdentity, {
      kind: "recovery_required",
      reason,
    });
  };
  const markMatch = (
    candidate: FundingPolymarketHandoffCandidate,
    eventIdentity: string,
    exact: boolean,
  ) => {
    const candidateId = candidate.attemptId;
    matchedCandidates.set(candidateId, candidate);
    const candidateEventIds = candidateMatches.get(candidateId) ?? new Set();
    candidateEventIds.add(eventIdentity);
    candidateMatches.set(candidateId, candidateEventIds);
    const eventCandidateIds = eventMatches.get(eventIdentity) ?? new Set();
    eventCandidateIds.add(candidateId);
    eventMatches.set(eventIdentity, eventCandidateIds);
    if (exact) {
      const exactEventIds = exactMatches.get(candidateId) ?? new Set();
      exactEventIds.add(eventIdentity);
      exactMatches.set(candidateId, exactEventIds);
    }
  };

  for (const candidate of candidates) {
    const referencedEvents: (typeof events)[number][] = [];
    const exactReferencedEvents: (typeof events)[number][] = [];
    for (const event of events) {
      const eventIdentity = canonicalEventIdentity(event.event);
      const relation = handoffCanonicalEventRelation(candidate, event.event);
      const referenceMatch = candidateReferenceMatch(candidate, event, codec);
      if (referenceMatch === "match") {
        if (
          candidate.resolvedEventIndex != null &&
          candidate.resolvedEventIndex !== event.event.eventIndex
        )
          continue;
        referencedEvents.push(event);
        if (relation === "match") {
          if (candidate.resolvedEventIndex != null)
            exactReferencedEvents.push(event);
          else markMatch(candidate, eventIdentity, false);
        }
        if (relation === "invalid") {
          markRecovery(eventIdentity, "handoff_envelope_invalid");
        }
        continue;
      }
      if (relation === "match" && referenceMatch === "unavailable") {
        if (
          candidate.attemptOutcome === "started" ||
          candidate.attemptOutcome === "failed" ||
          candidate.attemptOutcome === "cancelled" ||
          candidate.attemptOutcome === "succeeded" ||
          candidate.referenceKind === "external_handoff"
        ) {
          markMatch(candidate, eventIdentity, false);
        } else {
          markRecovery(eventIdentity, "handoff_reference_unavailable");
        }
      } else if (relation === "invalid" && referenceMatch === "unavailable") {
        markRecovery(eventIdentity, "handoff_envelope_invalid");
      }
    }
    if (exactReferencedEvents.length > 0) {
      for (const event of exactReferencedEvents) {
        markMatch(candidate, canonicalEventIdentity(event.event), true);
      }
      continue;
    }
    // Hash-only candidates have no exact log proof yet. They must stay pending
    // rather than be relabelled an envelope mismatch below.
    if (
      referencedEvents.some(
        (event) =>
          handoffCanonicalEventRelation(candidate, event.event) === "match",
      )
    )
      continue;
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
      markRecovery(
        eventIdentity,
        [...matchingCandidates].every((id) =>
          exactMatches.get(id)?.has(eventIdentity),
        )
          ? "handoff_candidate_ambiguity"
          : "handoff_correlation_pending",
      );
      continue;
    }
    const candidateId = [...matchingCandidates][0];
    if (!candidateId) continue;
    const matchingEvents = candidateMatches.get(candidateId) ?? new Set();
    if (matchingEvents.size !== 1) {
      for (const matchingEventIdentity of matchingEvents) {
        if (
          classifications.get(matchingEventIdentity)?.kind !==
          "recovery_required"
        ) {
          markRecovery(matchingEventIdentity, "handoff_correlation_pending");
        }
      }
      continue;
    }
    const candidate = matchedCandidates.get(candidateId);
    if (!candidate || !exactMatches.get(candidateId)?.has(eventIdentity)) {
      // Envelope equality closes the broadcast-to-report gap but cannot prove
      // internal ownership. Keep the physical event in recoverable quarantine.
      markRecovery(eventIdentity, "handoff_correlation_pending");
      continue;
    }
    classifications.set(eventIdentity, {
      kind: "internal",
      reason: null,
      reference: "exact",
      operationId: candidate.operationId,
      attemptId: candidate.attemptId,
    });
  }
  return classifications;
}

/** Read-only shared lookup. Missing codec never implies a negative match:
 * the existing immutable-envelope query still exposes unresolved handoffs. */
export async function loadCanonicalPolymarketHandoffClassifications(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    events: readonly HandoffCanonicalEvent[];
    now: Date;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
    listPotentialPolymarketHandoffs?: typeof listPotentialPolymarketHandoffsForCanonicalEvents;
  },
): Promise<ReadonlyMap<string, PolymarketHandoffEventClassification>> {
  const codec = input.transactionReferenceCodec ?? null;
  const fingerprinted: FingerprintedFundingReceiveCanonicalEvent[] = [];
  for (const event of input.events) {
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
      input.listPotentialPolymarketHandoffs ??
      listPotentialPolymarketHandoffsForCanonicalEvents
    )(db, {
      userId: input.userId,
      currentLookupKeyVersion: codec?.keyVersion ?? null,
      now: input.now,
      events: fingerprinted.map((entry) => ({
        networkId: entry.event.variant.networkId,
        assetId: entry.event.variant.asset.assetId,
        sourceAddress: entry.event.sourceAddress,
        destinationAddress: entry.event.destinationAddress,
        rawAmount: entry.event.rawAmount,
        transactionHash: entry.event.transactionHash,
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
          reason: "handoff_correlation_pending",
        },
      ]),
    );
  }
  return classifyPolymarketHandoffEvents(fingerprinted, candidates, codec);
}
