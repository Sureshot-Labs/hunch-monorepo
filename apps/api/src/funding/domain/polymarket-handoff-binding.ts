import { z } from "zod";
import { isRecord } from "../../lib/type-guards.js";
import {
  assetLocationSchema,
  moneySchema,
  normalizedActionSchema,
} from "./schemas.js";
import { sameAccountAddress, sameAsset } from "./asset-identity.js";
import { readCommittedFundingIdentity } from "./committed-economic-identity.js";
import { polymarketHandoffSourceIntent } from "./polymarket-handoff-source.js";
import { polymarketDepositWalletHandoffExpectation } from "../execution/polymarket-deposit-wallet-handoff.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";
import type {
  FundingCommitPlan,
  FundingCommitReservation,
} from "../persistence/funding-operation-repository.js";
import type { AssetLocation, NormalizedAction } from "./types.js";
import type { FundingStepReceiptObservation } from "../persistence/funding-step-receipt-repository.js";
import type { CanonicalEventOwnershipRow } from "../persistence/canonical-event-lock-sql.js";

const profileIdentitySchema = z.object({
  walletId: z.string().min(1),
  networkId: z.literal("evm:137"),
  address: z.string().regex(/^0x[\da-fA-F]{40}$/),
  source: z.enum(["embedded", "external"]),
  controllerWalletRef: z.string().min(1),
});

function profiles(value: unknown, depth = 0): unknown[] {
  if (
    depth < 16 &&
    isRecord(value) &&
    !("walletId" in value) &&
    Array.isArray(value.profiles)
  )
    return value.profiles.flatMap((entry) => profiles(entry, depth + 1));
  return [value];
}

function ownedLocation(snapshot: unknown): AssetLocation | null {
  const wrapped =
    isRecord(snapshot) && isRecord(snapshot.source)
      ? snapshot.source
      : snapshot;
  const result = assetLocationSchema.safeParse(
    isRecord(wrapped) && wrapped.kind === "owned_location"
      ? wrapped.location
      : null,
  );
  return result.success ? (result.data as AssetLocation) : null;
}

export type FrozenPolymarketHandoffBinding = Readonly<{
  economicSource: AssetLocation;
  executionSource: AssetLocation;
  sourceReservation: FundingCommitReservation;
  controllerFence: FundingCommitReservation;
  handoffOrdinal: number;
  handoffFingerprint: string;
  handoffExecutorId: string;
  rawAmount: string;
}>;

/** Exact immutable topology, NOT evidence of execution. In particular, a
 * linked address, operation metadata, ACK or an expired reservation cannot
 * establish that the controller received funds. Shared by planner and readers
 * so a source-input reservation is never mistaken for the controller balance. */
export function readFrozenPolymarketHandoffBinding(input: {
  currentUserId: string;
  plan: FundingCommitPlan;
  segmentOrdinal: number;
}): FrozenPolymarketHandoffBinding | null {
  const { plan, segmentOrdinal } = input;
  const segment = plan.segments[segmentOrdinal];
  if (!segment || segment.providerId !== "relay") return null;
  const source = ownedLocation(segment.sourceSnapshot);
  const amount = moneySchema.safeParse(segment.quotedInput);
  const sourceReservations = plan.reservations.filter(
    (reservation) =>
      reservation.segmentOrdinal === segmentOrdinal &&
      reservation.mode === "subtract_available" &&
      (reservation.economicRole ?? "source_input") === "source_input",
  );
  const sourceReservation = sourceReservations[0];
  if (
    !source ||
    !amount.success ||
    !/^[1-9]\d*$/.test(amount.data.raw) ||
    sourceReservations.length !== 1 ||
    !sourceReservation
  )
    return null;
  const operationSource = plan.operation.sourceSnapshot;
  const legs =
    isRecord(operationSource) && Array.isArray(operationSource.sourceLegs)
      ? operationSource.sourceLegs
      : null;
  const economicLocations = (legs ?? [operationSource])
    .map(ownedLocation)
    .filter(
      (location): location is AssetLocation =>
        location !== null &&
        location.locationId === sourceReservation.locationId &&
        sameAsset(location.asset, amount.data.asset),
    );
  const economicSource = economicLocations[0];
  if (
    economicLocations.length !== 1 ||
    !economicSource ||
    !readCommittedFundingIdentity({
      currentOwnerUserId: input.currentUserId,
      operationSourceSnapshot: operationSource,
      accountIds: [economicSource.accountId, source.accountId],
    })
  )
    return null;
  const candidates = profiles(plan.operation.walletExecutionSnapshot)
    .map((profile) => profileIdentitySchema.safeParse(profile))
    .flatMap((profile) =>
      profile.success && profile.data.walletId === source.details.walletId
        ? [profile.data]
        : [],
    );
  const controller = candidates[0];
  if (
    !controller ||
    candidates.some((profile) => !canonicalJsonEqual(profile, controller))
  )
    return null;
  const intent = polymarketHandoffSourceIntent({
    economicLocation: economicSource,
    controllerProfile: controller,
  });
  if (
    !intent ||
    !canonicalJsonEqual(intent.executionSource.location, source) ||
    !sameAsset(source.asset, amount.data.asset) ||
    sourceReservation.sourceInputRawAmount !== undefined ||
    sourceReservation.rawAmount !== amount.data.raw ||
    !sameAsset(
      {
        networkId: sourceReservation.networkId,
        assetId: sourceReservation.assetId,
        decimals: sourceReservation.assetDecimals,
      },
      amount.data.asset,
    )
  )
    return null;
  const fences = plan.reservations.filter(
    (reservation) =>
      reservation.mode === "subtract_available" &&
      reservation.economicRole === "future_credit_fence" &&
      reservation.locationId === source.locationId,
  );
  const controllerFence = fences[0];
  if (
    fences.length !== 1 ||
    !controllerFence ||
    controllerFence.segmentOrdinal !== null ||
    controllerFence.componentId !== intent.controllerComponentId ||
    controllerFence.rawAmount !== amount.data.raw ||
    controllerFence.sourceInputRawAmount !== undefined ||
    !sameAsset(
      {
        networkId: controllerFence.networkId,
        assetId: controllerFence.assetId,
        decimals: controllerFence.assetDecimals,
      },
      amount.data.asset,
    )
  )
    return null;

  const byOrdinal = new Map(plan.steps.map((step) => [step.ordinal, step]));
  const routeSteps = plan.steps.filter(
    (step) => step.segmentOrdinal === segmentOrdinal,
  );
  if (byOrdinal.size !== plan.steps.length || routeSteps.length === 0)
    return null;
  const linkedHandoffs = plan.steps.filter((step) => {
    if (
      step.segmentOrdinal !== null ||
      step.stepKind !== "external_handoff" ||
      step.dependsOnOrdinal !== null
    )
      return false;
    const action = normalizedActionSchema.safeParse(step.normalizedAction);
    if (
      !action.success ||
      action.data.kind !== "external_handoff" ||
      canonicalJsonHash(action.data) !== step.actionFingerprint ||
      ![
        "polymarket_deposit_wallet_relayer_v1",
        "polymarket_safe_relayer_v1",
      ].includes(step.executorId)
    )
      return false;
    if (
      step.executorId !==
      (action.data.handoffKind === "polymarket_safe_transfer"
        ? "polymarket_safe_relayer_v1"
        : "polymarket_deposit_wallet_relayer_v1")
    )
      return false;
    const expectation = polymarketDepositWalletHandoffExpectation(
      action.data as NormalizedAction,
      step.actionValidationResult,
    );
    const toOwnedWallet =
      step.actionValidationResult.executionEnvelope ===
      "polymarket_safe_to_owned_wallet_v1";
    const actorWalletId = action.data.actorWalletId;
    const actors = profiles(plan.operation.walletExecutionSnapshot)
      .map((profile) => profileIdentitySchema.safeParse(profile))
      .flatMap((profile) =>
        profile.success && profile.data.walletId === actorWalletId
          ? [profile.data]
          : [],
      );
    const actor = actors[0];
    if (
      !actor ||
      actors.some((entry) => !canonicalJsonEqual(entry, actor)) ||
      (!toOwnedWallet && actor.walletId !== controller.walletId) ||
      (toOwnedWallet &&
        step.actionValidationResult.recipientWalletId !== controller.walletId)
    )
      return false;
    if (
      !expectation ||
      !sameAccountAddress(
        "evm:137",
        expectation.tokenAddress,
        source.asset.assetId,
      ) ||
      !sameAccountAddress(
        "evm:137",
        expectation.funderAddress,
        String(economicSource.details.address),
      ) ||
      !sameAccountAddress(
        "evm:137",
        expectation.recipientAddress,
        controller.address,
      ) ||
      expectation.amountRaw.toString() !== amount.data.raw ||
      !sameAccountAddress(
        "evm:137",
        String(step.actionValidationResult.signerAddress),
        actor.address,
      )
    )
      return false;
    // One topological pass, not a fresh ancestry walk per step. Persisted
    // history may be dense even though newly issued Relay plans are small.
    const gated = new Set<number>([step.ordinal]);
    return [...routeSteps]
      .sort((a, b) => a.ordinal - b.ordinal)
      .every((child) => {
        if (
          child.dependsOnOrdinal === null ||
          child.dependsOnOrdinal >= child.ordinal ||
          !gated.has(child.dependsOnOrdinal)
        )
          return false;
        const parent = byOrdinal.get(child.dependsOnOrdinal);
        if (
          !parent ||
          (parent.ordinal !== step.ordinal &&
            parent.segmentOrdinal !== segmentOrdinal)
        )
          return false;
        gated.add(child.ordinal);
        return true;
      });
  });
  const handoff = linkedHandoffs[0];
  if (linkedHandoffs.length !== 1 || !handoff) return null;
  // Composite tags are an additional consistency check, never the authority.
  if (legs) {
    const matchingLegs = legs.filter(
      (leg) =>
        isRecord(leg) &&
        ownedLocation(leg)?.locationId === economicSource.locationId &&
        leg.sourceLegId === handoff.actionValidationResult.compositeSourceLegId,
    );
    if (
      matchingLegs.length !== 1 ||
      handoff.actionValidationResult.compositeSegmentOrdinal !==
        segmentOrdinal ||
      routeSteps.some(
        (step) =>
          step.actionValidationResult.compositeSourceLegId !==
            handoff.actionValidationResult.compositeSourceLegId ||
          step.actionValidationResult.compositeSegmentOrdinal !==
            segmentOrdinal,
      )
    )
      return null;
  }
  return {
    economicSource,
    executionSource: source,
    sourceReservation,
    controllerFence,
    handoffOrdinal: handoff.ordinal,
    handoffFingerprint: handoff.actionFingerprint,
    handoffExecutorId: handoff.executorId,
    rawAmount: amount.data.raw,
  };
}

/** Current finalized receipt AND its owned physical event. A positive ACK,
 * current step state or cached pre-reorg receipt is not a transfer. This
 * projection never creates a source_debit or a second economic in-transit
 * claim. Finality observation time is NOT the Transfer's chain time or proof
 * that a latest-RPC balance snapshot predates that transfer. */
export function readFinalizedPolymarketHandoffReceipt(input: {
  operationId: string;
  binding: FrozenPolymarketHandoffBinding;
  attempt: Readonly<{
    operationId: string;
    id: string;
    stepId: string;
    stepOrdinal: number;
    actionFingerprint: string;
    executorId: string;
    broadcastMayHaveOccurred: boolean;
  }>;
  receipt: FundingStepReceiptObservation;
  event: CanonicalEventOwnershipRow &
    Readonly<{ network_id: string; tx_hash: string; event_index: string }>;
}): Readonly<{
  transactionHash: string;
  eventIndex: string;
  rawAmount: string;
  finalityObservedAt: string;
}> | null {
  const { binding, attempt, receipt, event } = input;
  const hash = receipt.evidence.transactionHash,
    index = receipt.evidence.handoffEventIndex;
  const owned = receipt.evidence.handoffOwnedPhysicalEventV1;
  if (
    input.operationId.length === 0 ||
    receipt.operationId !== input.operationId ||
    attempt.operationId !== input.operationId ||
    receipt.status !== "finalized" ||
    !receipt.canonical ||
    receipt.actionMatch !== true ||
    receipt.failureCode !== null ||
    receipt.reorgedAt !== null ||
    receipt.networkId !== binding.economicSource.asset.networkId ||
    receipt.stepId !== attempt.stepId ||
    receipt.attemptId !== attempt.id ||
    attempt.stepOrdinal !== binding.handoffOrdinal ||
    attempt.actionFingerprint !== binding.handoffFingerprint ||
    attempt.executorId !== binding.handoffExecutorId ||
    !attempt.broadcastMayHaveOccurred ||
    typeof hash !== "string" ||
    !/^0x[\da-f]{64}$/i.test(hash) ||
    typeof index !== "string" ||
    !/^(0|[1-9]\d*)$/.test(index) ||
    !isRecord(owned) ||
    owned.transactionHash !== hash.toLowerCase() ||
    owned.handoffEventIndex !== index ||
    typeof receipt.ledgerHeight !== "string" ||
    !/^\d+$/.test(receipt.ledgerHeight) ||
    typeof receipt.blockHash !== "string" ||
    !/^0x[\da-f]{64}$/i.test(receipt.blockHash) ||
    owned.ledgerHeight !== receipt.ledgerHeight ||
    owned.blockHash !== receipt.blockHash.toLowerCase() ||
    event.network_id !== receipt.networkId ||
    event.tx_hash !== hash.toLowerCase() ||
    event.event_index !== index ||
    event.ledger_height !== receipt.ledgerHeight ||
    event.block_hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    !sameAsset(
      {
        networkId: event.network_id,
        assetId: event.asset_id,
        decimals: event.asset_decimals,
      },
      binding.economicSource.asset,
    ) ||
    !sameAccountAddress(
      event.network_id,
      String(event.source_address),
      String(binding.economicSource.details.address),
    ) ||
    !sameAccountAddress(
      event.network_id,
      event.destination_address,
      String(binding.executionSource.details.address),
    ) ||
    event.raw_amount !== binding.rawAmount ||
    event.allocation_status !== "recovery_required" ||
    event.allocation_error_code !== "internal_handoff_suppressed" ||
    event.allocated_receipt_id !== null ||
    event.allocated_receive_session_id !== null ||
    !receipt.finalizedAt ||
    !Number.isFinite(receipt.finalizedAt.getTime())
  )
    return null;
  return {
    transactionHash: hash.toLowerCase(),
    eventIndex: index,
    rawAmount: binding.rawAmount,
    finalityObservedAt: receipt.finalizedAt.toISOString(),
  };
}
