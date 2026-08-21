import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingCommitRequest,
  FundingQuoteRequest,
  FundingQuoteSummary,
  FundingReceiveMethod,
  FundingReceiveReceipt,
  FundingReceiveSession,
  FundingReceiveSessionChannel,
  JsonValue,
} from "../domain/types.js";
import { resolveFundingDestinationChoice } from "../domain/selections.js";
import { canonicalAccountAddress } from "../domain/asset-identity.js";
import { FundingPlannerError, sameAsset } from "../planner/money.js";
import {
  FundingPlanningRuntime,
  type PreparedFundingRuntimeCommit,
} from "../planner/runtime-service.js";
import { buildFundingReceiveTargets } from "../planner/receive-targets.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { PostgresFundingPlanningStore } from "../persistence/funding-planning-repository.js";
import {
  cancelFundingReceiveSessionForUser,
  createOrReuseFundingReceiveSession,
  type FundingReceiveSessionPersistenceResult,
  FundingReceiveSessionChannelConflictError,
  FundingReceiveSessionExactScopeConflictError,
  FundingReceiveSessionOpenIdempotencyConflictError,
  replayFundingReceiveSessionOpenIdempotency,
  fetchFundingReceiveReceiptForReview,
  type FundingReceiveReceiptReviewTarget,
  fetchFundingReceiveSessionForUser,
  linkFundingReceiveReceiptReviewOperationInTransaction,
  listFundingReceiveReceiptsForUser,
  setFundingReceiveReceiptReviewQuote,
} from "../persistence/funding-receive-session-repository.js";
import {
  fetchFundingOperationForUser,
  type FundingOperationRow,
  type FundingQuoteCommitScope,
} from "../persistence/funding-operation-repository.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../policies/funding-policy-service.js";
import {
  observeDirectIngressDestination,
  parseDirectIngressObservationVariant,
  type DirectIngressObservationTarget,
  type DirectIngressObservationVariant,
  type DirectIngressVariantObservation,
} from "../reconciliation/direct-ingress-observer.js";
import { initializeCanonicalFundingReceiveEventCursors } from "./canonical-receive-event-scanner.js";
import { quoteFundingReceiveReceipt } from "./receive-receipt-router.js";
import {
  FUNDING_RECEIVE_OBSERVATION_GRACE_MS,
  FUNDING_RECEIVE_SESSION_TTL_MS,
} from "./receive-session-constants.js";
import {
  findFundingReceiveOption,
  fundingReceiveOptionExpiry,
  ingressSupportsFundingReceiveSelection,
  fundingReceiveOptionsResponse,
  listFundingReceiveOptions,
  type FundingReceiveOptionsResponse,
} from "./receive-option-catalog.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

function reviewCommitScope(input: {
  ownerChannel: FundingReceiveSessionChannel;
  receiveSessionId: string;
  receiptId: string;
}): FundingQuoteCommitScope {
  return { kind: "receive_receipt_review_v1", ...input };
}

function jsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FundingPlannerError(
      "invalid_policy",
      "receive session plan snapshot is invalid",
    );
  }
  return value as JsonRecord;
}

function receiveTargets(
  ingress: ExternalIngressInstruction | undefined,
): NonNullable<ExternalIngressInstruction["receiveTargets"]> {
  if (!ingress?.receiveTargets?.length) {
    throw new FundingPlannerError(
      "destination_unavailable",
      "selected destination has no verified receive capability",
    );
  }
  return ingress.receiveTargets;
}

function matchesReceiveTarget(
  candidate: Readonly<{ networkId: string; destinationAddress: string }>,
  target: Readonly<{ networkId: string; destinationAddress: string }>,
): boolean {
  return (
    candidate.networkId === target.networkId &&
    canonicalAccountAddress(
      candidate.networkId,
      candidate.destinationAddress,
    ) === canonicalAccountAddress(target.networkId, target.destinationAddress)
  );
}

function receiveOpenRequestFingerprint(receiveOptionId: string): string {
  return canonicalJsonHash({
    kind: "funding_receive_option_open_v1",
    receiveOptionId,
  });
}

type ReceiveVariantVerificationDependencies = Readonly<{
  initializeCursors: (
    variants: readonly DirectIngressObservationVariant[],
  ) => Promise<readonly DirectIngressObservationVariant[]>;
  observe: (
    pool: Pool,
    target: DirectIngressObservationTarget,
  ) => Promise<Readonly<{
    variants: readonly DirectIngressVariantObservation[];
  }> | null>;
}>;

export type VerifiedFundingReceiveVariants = Readonly<{
  variants: readonly DirectIngressObservationVariant[];
  failures: readonly Readonly<{
    variantId: string;
    stage: "cursor" | "baseline";
    reason: string;
  }>[];
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupedReceiveVariants(
  variants: readonly DirectIngressObservationVariant[],
  key: (variant: DirectIngressObservationVariant) => string,
): readonly (readonly DirectIngressObservationVariant[])[] {
  const groups = new Map<string, DirectIngressObservationVariant[]>();
  for (const variant of variants) {
    const group = groups.get(key(variant)) ?? [];
    group.push(variant);
    groups.set(key(variant), group);
  }
  return [...groups.values()];
}

export async function verifyFundingReceiveVariants(
  pool: Pool,
  target: DirectIngressObservationTarget,
  variants: readonly DirectIngressObservationVariant[],
  dependencies: ReceiveVariantVerificationDependencies = {
    initializeCursors: initializeCanonicalFundingReceiveEventCursors,
    observe: observeDirectIngressDestination,
  },
): Promise<VerifiedFundingReceiveVariants> {
  const failures: Array<VerifiedFundingReceiveVariants["failures"][number]> =
    [];
  const initialized: DirectIngressObservationVariant[] = [];
  const networkGroups = groupedReceiveVariants(
    variants,
    (variant) => variant.networkId,
  );
  await Promise.all(
    networkGroups.map(async (group) => {
      try {
        initialized.push(...(await dependencies.initializeCursors(group)));
      } catch (error) {
        for (const variant of group) {
          failures.push({
            variantId: variant.variantId,
            stage: "cursor",
            reason: errorMessage(error),
          });
        }
      }
    }),
  );

  const observations = new Map<string, DirectIngressVariantObservation>();
  const observationGroups = groupedReceiveVariants(initialized, (variant) =>
    [
      variant.observation.adapterId,
      variant.networkId,
      variant.destinationLocationId,
      variant.destinationAddress,
    ].join(":"),
  );
  await Promise.all(
    observationGroups.map(async (group) => {
      let groupObservation: Readonly<{
        variants: readonly DirectIngressVariantObservation[];
      }> | null = null;
      try {
        groupObservation = await dependencies.observe(pool, {
          ...target,
          variants: group,
        });
      } catch {
        // Fall back to exact per-asset verification below. One unavailable
        // RPC/token must not suppress every independently verifiable target.
      }
      if (groupObservation?.variants.length === group.length) {
        for (const observation of groupObservation.variants) {
          observations.set(observation.variantId, observation);
        }
        return;
      }
      await Promise.all(
        group.map(async (variant) => {
          try {
            const observation = await dependencies.observe(pool, {
              ...target,
              variants: [variant],
            });
            const exact = observation?.variants.find(
              (candidate) => candidate.variantId === variant.variantId,
            );
            if (!exact || observation?.variants.length !== 1) {
              throw new Error("receive baseline omitted the accepted asset");
            }
            observations.set(variant.variantId, exact);
          } catch (error) {
            failures.push({
              variantId: variant.variantId,
              stage: "baseline",
              reason: errorMessage(error),
            });
          }
        }),
      );
    }),
  );

  return {
    variants: initialized.flatMap((variant) => {
      const observation = observations.get(variant.variantId);
      return observation
        ? [
            {
              ...variant,
              baselineRaw: observation.observedRaw,
              baselineRevision: observation.revision,
            },
          ]
        : [];
    }),
    failures,
  };
}

export type OpenFundingReceiveSessionRequest =
  | Readonly<{
      destinationOptionId: string;
      venueBindingOptionId: string;
      selectedReceiveTargetId?: string | null;
    }>
  | Readonly<{
      receiveOptionId: string;
      // Request retries use this caller key. Persistence keeps one active
      // session per user/destination/binding and additionally compares this
      // opaque choice's exact receiver+asset scope before replaying it.
      idempotencyKey: string;
    }>;

export type FundingReceiveSessionResponse = Readonly<{
  session: FundingReceiveSession;
  receipts: readonly FundingReceiveReceipt[];
  replayed: boolean;
}>;

export function resolveFundingReceiveSelectedTargetId(
  requested: string | null | undefined,
  recommended: string | null,
  ownerChannel: FundingReceiveSessionChannel = "web",
): string | null {
  return ownerChannel === "telegram" && requested === null
    ? null
    : (requested ?? recommended);
}

export type FundingReceiveReceiptReviewQuoteResponse = Readonly<{
  receipt: FundingReceiveReceipt;
  quote: FundingQuoteSummary;
}>;

export type PreparedFundingReceiveReceiptReviewQuote = Readonly<{
  ownerChannel: FundingReceiveSessionChannel;
  previousQuoteId: string | null;
  quote: FundingQuoteSummary;
  receiptId: string;
  receiveSessionId: string;
  targetFingerprint: string;
  userId: string;
}>;

function reviewTargetFingerprint(
  target: FundingReceiveReceiptReviewTarget,
): string {
  return canonicalJsonHash({
    automationPolicy: target.automationPolicy,
    destinationAsset: target.destinationAsset,
    destinationOptionId: target.destinationOptionId,
    destinationTargetSnapshot: target.destinationTargetSnapshot,
    ownerChannel: target.ownerChannel,
    ownershipRevision: target.ownershipRevision,
    policyRevision: target.policyRevision,
    policyVersion: target.policyVersion,
    receipt: target.receipt,
    receiptDestinationLocationId: target.receiptDestinationLocationId,
    receiptVariantSnapshot: target.receiptVariantSnapshot,
    userId: target.userId,
    venueBindingOptionId: target.venueBindingOptionId,
    venueBindingSnapshot: target.venueBindingSnapshot,
    venueId: target.venueId,
  });
}

export class FundingReceiveSessionService {
  private readonly runtime: FundingPlanningRuntime;
  private readonly planningStore: PostgresFundingPlanningStore;

  constructor(
    private readonly db: Pool,
    private readonly optionsConfig: Readonly<{
      /** Injected by the API route; Telegram only uses legacy opens. */
      receiveOptionTokenKey?: string;
    }> = {},
  ) {
    this.runtime = new FundingPlanningRuntime(db);
    this.planningStore = new PostgresFundingPlanningStore(db);
  }

  private receiveOptionTokenKey(): string {
    const key = this.optionsConfig.receiveOptionTokenKey?.trim() ?? "";
    if (key.length < 32) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "generic receive options are temporarily unavailable",
      );
    }
    return key;
  }

  async options(userId: string): Promise<FundingReceiveOptionsResponse> {
    return fundingReceiveOptionsResponse(
      await listFundingReceiveOptions({
        runtime: this.runtime,
        userId,
        tokenKey: this.receiveOptionTokenKey(),
      }),
    );
  }

  private async resolveOpenRequest(
    userId: string,
    request: OpenFundingReceiveSessionRequest,
    now: Date,
  ): Promise<
    Readonly<{
      destinationOptionId: string;
      venueBindingOptionId: string;
      selectedReceiveTargetId?: string | null;
      selectedReceiveAsset?: AssetRef | null;
      selectedReceiveTarget?: Readonly<{
        networkId: string;
        destinationAddress: string;
      }>;
    }>
  > {
    if ("destinationOptionId" in request) return request;
    const expiresAt = fundingReceiveOptionExpiry(request.receiveOptionId);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      throw new FundingPlannerError(
        "receive_option_expired",
        "selected receive option expired; refresh the available assets",
      );
    }
    const catalog = await listFundingReceiveOptions({
      runtime: this.runtime,
      userId,
      tokenKey: this.receiveOptionTokenKey(),
      now,
      expiresAt,
    });
    const resolved = findFundingReceiveOption(catalog, request.receiveOptionId);
    if (!resolved) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "selected receive option is no longer available",
      );
    }
    return {
      destinationOptionId: resolved.destinationOptionId,
      venueBindingOptionId: resolved.venueBindingOptionId,
      selectedReceiveAsset: resolved.option.asset,
      selectedReceiveTarget: resolved.receiveTarget,
    };
  }

  async open(
    userId: string,
    request: OpenFundingReceiveSessionRequest,
    now = new Date(),
    ownerChannel: FundingReceiveSessionChannel = "web",
    finalize?: (
      client: PoolClient,
      result: FundingReceiveSessionPersistenceResult,
    ) => Promise<void>,
    preparePersistence?: (client: PoolClient) => Promise<void>,
  ): Promise<FundingReceiveSessionResponse> {
    if ("receiveOptionId" in request) this.receiveOptionTokenKey();
    const openIdempotency =
      "receiveOptionId" in request
        ? {
            key: request.idempotencyKey,
            requestFingerprint: receiveOpenRequestFingerprint(
              request.receiveOptionId,
            ),
          }
        : null;
    if (openIdempotency) {
      try {
        const existing = await replayFundingReceiveSessionOpenIdempotency(
          this.db,
          {
            userId,
            ownerChannel,
            idempotencyKey: openIdempotency.key,
            requestFingerprint: openIdempotency.requestFingerprint,
            now,
          },
        );
        if (existing) {
          const receipts = await listFundingReceiveReceiptsForUser(this.db, {
            userId,
            receiveSessionId: existing.snapshot.session.receiveSessionId,
          });
          return {
            session: existing.snapshot.session,
            receipts,
            replayed: true,
          };
        }
      } catch (error) {
        if (error instanceof FundingReceiveSessionChannelConflictError) {
          throw new FundingPlannerError("receive_channel_conflict", error.message);
        }
        if (error instanceof FundingReceiveSessionExactScopeConflictError) {
          throw new FundingPlannerError(
            "receive_session_selection_conflict",
            error.message,
          );
        }
        if (
          error instanceof FundingReceiveSessionOpenIdempotencyConflictError
        ) {
          throw new FundingPlannerError(
            "receive_session_idempotency_conflict",
            error.message,
          );
        }
        throw error;
      }
    }
    const resolvedRequest = await this.resolveOpenRequest(userId, request, now);
    const destinationAccess = await this.runtime.destinationAccess(userId, {
      purpose: "fund",
    });
    const destination = resolveFundingDestinationChoice({
      options: destinationAccess.options,
      destinationOptionId: resolvedRequest.destinationOptionId,
      venueBindingOptionId: resolvedRequest.venueBindingOptionId,
    });
    if (!destination) {
      const policyDisabled = resolveFundingDestinationChoice({
        options: destinationAccess.policyDisabledOptions,
        destinationOptionId: resolvedRequest.destinationOptionId,
        venueBindingOptionId: resolvedRequest.venueBindingOptionId,
      });
      if (policyDisabled) {
        throw new FundingPlannerError(
          "funding_policy_disabled",
          "receive session destination is disabled by funding policy",
        );
      }
      throw new FundingPlannerError(
        "destination_unavailable",
        "receive session requires one selectable destination for the stable binding",
      );
    }
    const oneRaw = "1";
    const liquidity = await this.runtime.liquidity(userId, {
      purpose: "add_funds",
      marketContextId: null,
      confirmedSourceAmount: null,
      requestedDestinationAmount: {
        asset: destination.requiredAsset,
        raw: oneRaw,
      },
      destinationOptionId: destination.destinationOptionId,
      venueBindingOptionId: destination.venueBindingOptionId,
      withdrawalRecipientId: null,
      maxFeeUsd: null,
      maxSlippageBps: null,
      deadline: null,
    });
    const receiveOptions = liquidity.sourceOptions.filter(
      (option) =>
        option.selectable &&
        option.source.kind === "external_ingress" &&
        option.ingress?.receiveTargets?.length,
    );
    const manualOptions = receiveOptions.filter(
      (option) => option.kind === "manual_receive",
    );
    if (manualOptions.length !== 1) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "receive session requires one verified manual receive capability",
      );
    }
    const sourceOption = manualOptions[0];
    if (!sourceOption) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "receive session capability is unavailable",
      );
    }
    receiveTargets(sourceOption.ingress);
    const planning = await this.planningStore.fetchOwnedCurrent({
      userId,
      projectionId: liquidity.liquidityProjectionId,
      now,
    });
    const resolvedPolicy = await resolveFundingPolicy(this.db);
    if (resolvedPolicy.revision !== planning?.policyRevision) {
      throw new FundingPlannerError(
        "stale_projection",
        "funding policy changed before the receive session could be opened",
      );
    }
    const planned = planning?.plannerSnapshot.sources.filter(
      (source) => source.option.sourceOptionId === sourceOption.sourceOptionId,
    );
    if (
      !planning ||
      planned?.length !== 1 ||
      !planning.plannerSnapshot.destination
    ) {
      throw new FundingPlannerError(
        "stale_projection",
        "receive capability changed before the session could be opened",
      );
    }
    const selectedPlan = planned[0];
    if (!selectedPlan) {
      throw new FundingPlannerError(
        "source_not_selected",
        "receive capability plan is unavailable",
      );
    }
    const supportMetadata =
      selectedPlan.commitPlan.operation.supportMetadata ?? {};
    const rawVariants =
      supportMetadata.receiveSessionVariants ?? supportMetadata.ingressVariants;
    if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
      throw new FundingPlannerError(
        "invalid_policy",
        "receive capability lacks observable variants",
      );
    }
    const variants = rawVariants.map(parseDirectIngressObservationVariant);
    const selectedReceiveAsset = resolvedRequest.selectedReceiveAsset;
    const selectedReceiveTarget = resolvedRequest.selectedReceiveTarget;
    const selectedVariants = selectedReceiveAsset
      ? variants.filter(
          (variant) =>
            sameAsset(variant.asset, selectedReceiveAsset) &&
            (!selectedReceiveTarget ||
              matchesReceiveTarget(variant, selectedReceiveTarget)),
        )
      : variants;
    if (selectedVariants.length === 0) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "selected receive asset is no longer available",
      );
    }
    const baselineTarget: DirectIngressObservationTarget = {
      operationId: stableOpaqueId(
        "receive_baseline",
        `${userId}:${destination.destinationOptionId}:${now.toISOString()}`,
      ),
      userId,
      purpose: "add_funds",
      marketId: null,
      venueBindingOptionId: destination.venueBindingOptionId,
      requestedAsset: destination.requiredAsset,
      requestedRaw: "1",
      operationVersion: 1,
      operationState: {
        status: "awaiting_external_funds",
        stage: "source_action",
      },
      variants: selectedVariants,
    };
    // Freeze each network's canonical event boundary before its balance
    // snapshot. Independently verified networks remain usable when another
    // provider is unavailable; unverified assets are never shown.
    const verified = await verifyFundingReceiveVariants(
      this.db,
      baselineTarget,
      selectedVariants,
    );
    const frozenVariants = verified.variants;
    if (verified.failures.length > 0) {
      console.warn("[funding-receive] variants failed exact verification", {
        userId,
        venueId: destination.venueId,
        destinationOptionId: destination.destinationOptionId,
        failures: verified.failures,
      });
    }
    if (frozenVariants.length === 0) {
      const failureSummary = verified.failures
        .map(
          (failure) =>
            `${failure.variantId}:${failure.stage}:${failure.reason}`,
        )
        .join("; ");
      throw new FundingPlannerError(
        "destination_unavailable",
        `receive balances could not be verified before showing an address (${failureSummary || "no verified variants"})`,
      );
    }
    const receiveCapabilityRevision = canonicalJsonHash({
      ownershipRevision: planning.ownershipRevision,
      variants: frozenVariants
        .map((variant) => ({
          variantId: variant.variantId,
          networkId: variant.networkId,
          asset: variant.asset,
          destinationAddress: canonicalAccountAddress(
            variant.networkId,
            variant.destinationAddress,
          ),
          destinationLocationId: variant.destinationLocationId,
          observation: variant.observation,
          completion: variant.completion,
        }))
        .sort((left, right) => left.variantId.localeCompare(right.variantId)),
    });
    const targets = buildFundingReceiveTargets(frozenVariants);
    const opaqueSelectedTarget = selectedReceiveTarget
      ? targets.find((target) =>
          matchesReceiveTarget(target, selectedReceiveTarget),
        )
      : null;
    if (
      (selectedReceiveTarget && !opaqueSelectedTarget) ||
      (resolvedRequest.selectedReceiveTargetId != null &&
        !targets.some(
          (target) =>
            target.receiveTargetId === resolvedRequest.selectedReceiveTargetId,
        ))
    ) {
      throw new FundingPlannerError(
        "source_not_selected",
        "selected receive target is not part of the verified capability",
      );
    }
    const plannedRecommendation =
      sourceOption.ingress?.recommendedReceiveTargetId;
    const recommendedReceiveTargetId =
      (targets.some(
        (target) => target.receiveTargetId === plannedRecommendation,
      )
        ? plannedRecommendation
        : null) ??
      targets[0]?.receiveTargetId ??
      null;
    // `undefined` preserves the existing public/web convenience selection.
    // An explicit `null` is used by Telegram so a verified address is not
    // revealed before an exact target+asset consent callback.
    const selectedReceiveTargetId = resolveFundingReceiveSelectedTargetId(
      opaqueSelectedTarget?.receiveTargetId ??
        resolvedRequest.selectedReceiveTargetId,
      recommendedReceiveTargetId,
      ownerChannel,
    );
    const methodRecommendedReceiveTargetId =
      selectedReceiveTargetId ?? recommendedReceiveTargetId;
    const expiresAt = new Date(now.getTime() + FUNDING_RECEIVE_SESSION_TTL_MS);
    const observeUntil = new Date(
      expiresAt.getTime() + FUNDING_RECEIVE_OBSERVATION_GRACE_MS,
    );
    const methods: FundingReceiveMethod[] = receiveOptions.flatMap((option) => {
      const kind =
        option.kind === "manual_receive"
          ? ("manual" as const)
          : option.kind === "privy_funding_method"
            ? ("privy" as const)
            : null;
      const optionIngress = option.ingress;
      if (!kind || !optionIngress) return [];
      // Manual ingress is narrowed to the opaque asset selection. A Privy
      // method is only retained when that method itself supports the same
      // asset at the same receiver; otherwise it would advertise Card for an
      // asset that only the crypto method can accept.
      if (
        kind === "privy" &&
        resolvedRequest.selectedReceiveAsset != null &&
        selectedReceiveTarget != null &&
        !ingressSupportsFundingReceiveSelection({
          ingress: optionIngress,
          asset: resolvedRequest.selectedReceiveAsset,
          receiveTarget: selectedReceiveTarget,
        })
      ) {
        return [];
      }
      const ingress: ExternalIngressInstruction =
        kind === "manual" || resolvedRequest.selectedReceiveAsset != null
          ? {
              ...optionIngress,
              receiveTargets: targets,
              recommendedReceiveTargetId: methodRecommendedReceiveTargetId,
              destinationAddress:
                targets.find(
                  (target) =>
                    target.receiveTargetId === selectedReceiveTargetId,
                )?.destinationAddress ??
                targets.find(
                  (target) =>
                    target.receiveTargetId === recommendedReceiveTargetId,
                )?.destinationAddress ??
                targets[0]?.destinationAddress ??
                optionIngress.destinationAddress,
              requestedAmount: null,
              amountSemantics: "minimum",
              expiresAt: expiresAt.toISOString(),
            }
          : {
              ...optionIngress,
              receiveTargets: optionIngress.receiveTargets?.map((target) => ({
                ...target,
                acceptedAssets: target.acceptedAssets.map((accepted) => ({
                  ...accepted,
                })),
                safeInstructions: [...target.safeInstructions],
              })),
              requestedAmount: null,
              amountSemantics: "minimum",
              expiresAt: expiresAt.toISOString(),
              safeInstructions: [...optionIngress.safeInstructions],
            };
      return [
        {
          methodId: stableOpaqueId(
            "receive_method",
            `${destination.destinationOptionId}:${option.sourceOptionId}:${kind}`,
          ),
          kind,
          safeLabel: kind === "manual" ? "Send crypto" : "Fund with Privy",
          ingress,
        },
      ];
    });
    if (
      methods.length === 0 ||
      methods.filter((method) => method.kind === "manual").length !== 1
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "receive session requires one durable manual funding method",
      );
    }
    let created: Awaited<ReturnType<typeof createOrReuseFundingReceiveSession>>;
    try {
      created = await createOrReuseFundingReceiveSession(
        this.db,
        {
          userId,
          ownerChannel,
          venueId: destination.venueId,
          destinationOptionId: destination.destinationOptionId,
          venueBindingOptionId: destination.venueBindingOptionId,
          destinationAsset: destination.requiredAsset as AssetRef,
          destinationTargetSnapshot: jsonRecord(
            selectedPlan.commitPlan.operation.destinationTargetSnapshot,
          ),
          venueBindingSnapshot: jsonRecord(
            selectedPlan.commitPlan.operation.venueBindingSnapshot,
          ),
          methods,
          receiveTargets: targets,
          observationVariants: frozenVariants.map(jsonRecord),
          selectedReceiveTargetId,
          requireExactReceiveScope:
            resolvedRequest.selectedReceiveAsset != null,
          openIdempotency: openIdempotency ?? undefined,
          automationPolicy: {
            stableConversion: "automatic_within_caps",
            volatileConversion: "review_required",
            maximumFeeUsd: resolvedPolicy.runtime.placement.maximumFeeUsd,
            maximumFeeBps: resolvedPolicy.runtime.placement.maximumFeeBps,
            maximumSlippageBps:
              resolvedPolicy.runtime.placement.maximumSlippageBps,
          },
          policyVersion: planning.policyVersion,
          policyRevision: planning.policyRevision,
          ownershipRevision: receiveCapabilityRevision,
          expiresAt,
          observeUntil,
          now,
        },
        finalize,
        preparePersistence,
      );
    } catch (error) {
      if (error instanceof FundingReceiveSessionChannelConflictError) {
        throw new FundingPlannerError(
          "receive_channel_conflict",
          error.message,
        );
      }
      if (error instanceof FundingReceiveSessionExactScopeConflictError) {
        throw new FundingPlannerError(
          "receive_session_selection_conflict",
          error.message,
        );
      }
      if (error instanceof FundingReceiveSessionOpenIdempotencyConflictError) {
        throw new FundingPlannerError(
          "receive_session_idempotency_conflict",
          error.message,
        );
      }
      throw error;
    }
    const receipts = await listFundingReceiveReceiptsForUser(this.db, {
      userId,
      receiveSessionId: created.snapshot.session.receiveSessionId,
    });
    return {
      session: created.snapshot.session,
      receipts,
      replayed: created.replayed,
    };
  }

  async get(
    userId: string,
    receiveSessionId: string,
    ownerChannel: FundingReceiveSessionChannel = "web",
  ): Promise<FundingReceiveSessionResponse | null> {
    const found = await fetchFundingReceiveSessionForUser(this.db, {
      userId,
      receiveSessionId,
    });
    if (!found || found.ownerChannel !== ownerChannel) return null;
    const receipts = await listFundingReceiveReceiptsForUser(this.db, {
      userId,
      receiveSessionId,
    });
    return { session: found.session, receipts, replayed: true };
  }

  async reviewQuote(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    ownerChannel: FundingReceiveSessionChannel,
    now = new Date(),
  ): Promise<FundingReceiveReceiptReviewQuoteResponse> {
    const prepared = await this.prepareReviewQuote(
      userId,
      receiveSessionId,
      receiptId,
      ownerChannel,
      now,
    );
    const attachNow = new Date(Math.max(now.getTime(), Date.now()));
    return tx(this.db, (client) =>
      this.attachPreparedReviewQuoteInTransaction(client, prepared, attachNow),
    );
  }

  async prepareReviewQuote(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    ownerChannel: FundingReceiveSessionChannel,
    now = new Date(),
  ): Promise<PreparedFundingReceiveReceiptReviewQuote> {
    const target = await fetchFundingReceiveReceiptForReview(this.db, {
      userId,
      ownerChannel,
      receiveSessionId,
      receiptId,
    });
    if (!target || target.receipt.status !== "review_required") {
      throw new FundingPlannerError(
        "source_not_selected",
        "receive receipt does not require an economic review",
      );
    }
    if (!target.receipt.reviewQuotePlan) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "receive receipt lacks its adapter-owned review quote plan",
      );
    }
    const quote = await quoteFundingReceiveReceipt(
      {
        liquidity: this.runtime.liquidity.bind(this.runtime),
        quote: (quoteUserId: string, request: FundingQuoteRequest) =>
          this.runtime.quoteForCommitScope(
            quoteUserId,
            request,
            reviewCommitScope({
              ownerChannel,
              receiveSessionId,
              receiptId,
            }),
          ),
      },
      target,
      { quotePlan: target.receipt.reviewQuotePlan },
    );
    if (
      !quote ||
      quote.consentMode !== "explicit_economic_review" ||
      new Date(quote.expiresAt).getTime() <= Math.max(now.getTime(), Date.now())
    ) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "received asset cannot be quoted for safe conversion",
      );
    }
    return {
      ownerChannel,
      previousQuoteId: target.reviewQuoteId,
      quote,
      receiptId,
      receiveSessionId,
      targetFingerprint: reviewTargetFingerprint(target),
      userId,
    };
  }

  async attachPreparedReviewQuoteInTransaction(
    client: PoolClient,
    prepared: PreparedFundingReceiveReceiptReviewQuote,
    now = new Date(),
    expectedPreviousQuoteId = prepared.previousQuoteId,
  ): Promise<FundingReceiveReceiptReviewQuoteResponse> {
    const target = await fetchFundingReceiveReceiptForReview(client, {
      userId: prepared.userId,
      ownerChannel: prepared.ownerChannel,
      receiveSessionId: prepared.receiveSessionId,
      receiptId: prepared.receiptId,
      lock: true,
    });
    if (
      !target ||
      target.receipt.status !== "review_required" ||
      target.reviewQuoteId !== expectedPreviousQuoteId ||
      reviewTargetFingerprint(target) !== prepared.targetFingerprint ||
      new Date(prepared.quote.expiresAt).getTime() <= now.getTime()
    ) {
      throw new FundingPlannerError(
        "stale_projection",
        "receive receipt changed while its review quote was prepared",
      );
    }
    const stored = await setFundingReceiveReceiptReviewQuote(client, {
      receiptId: prepared.receiptId,
      userId: prepared.userId,
      quoteId: prepared.quote.quoteId,
      previousQuoteId: expectedPreviousQuoteId,
      now,
    });
    if (!stored) {
      throw new FundingPlannerError(
        "stale_projection",
        "receive receipt changed before review was created",
      );
    }
    return { receipt: target.receipt, quote: prepared.quote };
  }

  async commitReview(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    request: FundingCommitRequest,
    ownerChannel: FundingReceiveSessionChannel,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
    const prepared = await this.prepareReviewCommit(
      userId,
      receiveSessionId,
      receiptId,
      request,
      ownerChannel,
    );
    return tx(this.db, (client) =>
      this.commitReviewInTransaction(
        client,
        userId,
        receiveSessionId,
        receiptId,
        request,
        prepared,
        ownerChannel,
      ),
    );
  }

  prepareReviewCommit(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    request: FundingCommitRequest,
    ownerChannel: FundingReceiveSessionChannel,
  ): Promise<PreparedFundingRuntimeCommit> {
    return this.runtime.prepareCommit(userId, request, {
      commitScope: reviewCommitScope({
        ownerChannel,
        receiveSessionId,
        receiptId,
      }),
    });
  }

  async commitReviewInTransaction(
    client: PoolClient,
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    request: FundingCommitRequest,
    prepared: PreparedFundingRuntimeCommit,
    ownerChannel: FundingReceiveSessionChannel,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
    // The receipt lock makes quote consumption, operation creation, and
    // attribution one boundary. Channel-specific callers may take their own
    // lifecycle/context locks before entering this generic financial boundary.
    await lockFundingPolicyForTransaction(client);
    const target = await fetchFundingReceiveReceiptForReview(client, {
      userId,
      ownerChannel,
      receiveSessionId,
      receiptId,
      lock: true,
    });
    if (!target || target.reviewQuoteId !== request.quoteId) {
      throw new FundingPlannerError(
        "stale_projection",
        "receive receipt review quote is absent or stale",
      );
    }
    if (
      target.receipt.status === "routing" &&
      target.receipt.childFundingOperationId
    ) {
      const existing = await fetchFundingOperationForUser(client, {
        userId,
        operationId: target.receipt.childFundingOperationId,
      });
      if (existing?.quoteId === request.quoteId) {
        return { operation: existing, replayed: true };
      }
      throw new FundingPlannerError(
        "stale_projection",
        "receive receipt is linked to another operation",
      );
    }
    const committed = await this.runtime.commitPreparedInTransaction(
      client,
      prepared,
    );
    const linked = await linkFundingReceiveReceiptReviewOperationInTransaction(
      client,
      {
        receiptId,
        receiveSessionId,
        userId,
        quoteId: request.quoteId,
        childFundingOperationId: committed.operation.id,
        now: committed.operation.createdAt,
      },
    );
    if (!linked) {
      throw new FundingPlannerError(
        "stale_projection",
        "receive receipt changed before the reviewed operation was linked",
      );
    }
    return committed;
  }

  async cancel(
    userId: string,
    receiveSessionId: string,
    now = new Date(),
    ownerChannel: FundingReceiveSessionChannel = "web",
  ): Promise<FundingReceiveSessionResponse | null> {
    const cancelled = await cancelFundingReceiveSessionForUser(this.db, {
      userId,
      ownerChannel,
      receiveSessionId,
      now,
    });
    if (!cancelled) return null;
    return { session: cancelled.session, receipts: [], replayed: false };
  }
}
