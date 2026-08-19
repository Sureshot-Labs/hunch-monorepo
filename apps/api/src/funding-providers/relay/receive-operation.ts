import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "@hunch/infra";

import { stableOpaqueId } from "../../account-value/canonical.js";
import type {
  AssetLocation,
  AssetRef,
  FundingReceiveReviewContinuation,
  FundingTarget,
  JsonValue,
  VenueBindingOption,
  WalletExecutionProfile,
} from "../../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import type { DelegatedFundingPreBroadcastDecision } from "../../funding/execution/delegated-funding-capability.js";
import { fundingSubjectLookupHmac } from "../../funding/persistence/canonical.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
} from "../../funding/persistence/funding-operation-repository.js";
import {
  fundingReceiveReceiptOperationIdempotencyKey,
  type FundingReceiveReceiptRoutingTarget,
} from "../../funding/persistence/funding-receive-session-repository.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
  type FundingControlPlaneSnapshot,
} from "../../funding/policies/funding-policy-sidecar.js";
import type { FundingRuntimePolicy } from "../../funding/policies/funding-policy.js";
import type { ResolvedRouteDestination } from "../../funding/planner/destination-adapters.js";
import type { RelayEligibleSourceFact } from "../../funding/planner/source-options.js";
import {
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
} from "../../funding/reconciliation/direct-ingress-observer.js";
import {
  receiveAutomationEconomicsWithinPolicy,
  type FundingReceiveReceiptAutomaticExecution,
  type FundingReceiveReceiptDisposition,
} from "../../funding/receive/receive-receipt-router.js";
import { isRecord } from "../../lib/type-guards.js";
import { RelayClient, type RelayClientConfig } from "./client.js";
import {
  relayStableAssetSymbol,
  resolveRelayRouteSpec,
  type RelayRouteSpec,
} from "./mappings.js";
import { buildRelayPlanningQuote } from "./operation-plan.js";
import { type RelayReferenceCodec } from "./reference-codec.js";
import {
  RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
  relayReceiveQuotePlan,
} from "./receive-routing.js";
import { RelayWalletQuoteAdapter } from "./wallet-adapter.js";
import {
  loadRelayEvmExecutionConfiguration,
  relayEvmSequentialQuoteTtlMs,
} from "../../funding/execution/delegated-funding-config.js";
import {
  captureRelayEvmAllowanceBaseline,
  relayEvmAllowanceBaselineSupportMetadata,
} from "../../funding/execution/relay-evm-allowance-baseline.js";
import { relayEvmFundingProfileSpec } from "../../funding/execution/relay-evm-profile-specs.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type RuntimeRoute = FundingRuntimePolicy["routes"][number];

export { RELAY_RECEIVE_OPERATION_ADAPTER_KEY } from "./receive-routing.js";

export function relayReceiveQuoteCorrelationId(
  receiptId: string,
  operationIdempotencyKey: string,
): string {
  const baseIdempotencyKey = `receive-receipt:${receiptId}`;
  return stableOpaqueId(
    "funding_quote",
    operationIdempotencyKey === baseIdempotencyKey
      ? receiptId
      : operationIdempotencyKey,
  );
}

function relayReviewContinuation(
  destinationAsset: AssetRef,
): FundingReceiveReviewContinuation | null {
  const symbol = relayStableAssetSymbol(destinationAsset);
  return symbol
    ? {
        version: 1,
        kind: "convert",
        label: `Convert to ${symbol}`,
        confirmation: "fresh_quote",
      }
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => !string(entry)))
    return null;
  return value.map((entry) => string(entry) as string);
}

function asset(value: unknown): AssetRef | null {
  if (!isRecord(value)) return null;
  const networkId = string(value.networkId);
  const assetId = string(value.assetId);
  return networkId &&
    assetId &&
    Number.isInteger(value.decimals) &&
    Number(value.decimals) >= 0 &&
    Number(value.decimals) <= 36
    ? { networkId, assetId, decimals: Number(value.decimals) }
    : null;
}

function walletProfile(value: unknown): WalletExecutionProfile | null {
  if (!isRecord(value)) return null;
  const walletId = string(value.walletId);
  const networkId = string(value.networkId);
  const address = string(value.address);
  const controllerWalletRef =
    value.controllerWalletRef == null
      ? null
      : string(value.controllerWalletRef);
  const source = value.source;
  const signingModes = stringArray(value.signingModes);
  const serverWalletRef =
    value.serverWalletRef == null ? null : string(value.serverWalletRef);
  const sponsorshipPolicyIds = stringArray(value.sponsorshipPolicyIds);
  const evmAtomicBatchMode = value.evmAtomicBatchMode ?? null;
  if (
    !walletId ||
    !networkId ||
    !address ||
    !controllerWalletRef ||
    (source !== "embedded" && source !== "smart") ||
    !signingModes?.length ||
    signingModes.some(
      (mode) =>
        mode !== "web_client" &&
        mode !== "privy_authorization" &&
        mode !== "privy_delegated",
    ) ||
    !sponsorshipPolicyIds ||
    (evmAtomicBatchMode !== null &&
      evmAtomicBatchMode !== "privy_wallet_send_calls")
  ) {
    return null;
  }
  return {
    walletId,
    controllerWalletRef,
    networkId,
    address,
    source,
    signingModes: signingModes as WalletExecutionProfile["signingModes"],
    serverWalletRef,
    sponsorshipPolicyIds,
    evmAtomicBatchMode,
  };
}

function ownedTarget(
  value: unknown,
  userId: string,
  expectedAsset: AssetRef,
): Extract<FundingTarget, { kind: "owned_location" }> | null {
  if (!isRecord(value) || value.kind !== "owned_location") return null;
  const location = value.location;
  if (!isRecord(location) || !isRecord(location.details)) return null;
  const locationAsset = asset(location.asset);
  const kind = string(location.kind);
  const locationId = string(location.locationId);
  const accountId = string(location.accountId);
  const address = string(location.details.address);
  if (
    !locationAsset ||
    !kind ||
    !locationId ||
    accountId !== userId ||
    !address ||
    !sameAsset(locationAsset, expectedAsset)
  ) {
    return null;
  }
  return {
    kind: "owned_location",
    location: {
      kind,
      locationId,
      accountId,
      asset: locationAsset,
      details: location.details as JsonRecord,
    },
  };
}

function venueBindingOption(
  value: unknown,
  expectedId: string,
): VenueBindingOption | null {
  if (!isRecord(value)) return null;
  const venueBindingOptionId = string(value.venueBindingOptionId);
  const safeLabel = string(value.safeLabel);
  const readinessClass = value.readinessClass;
  const preparationPurpose = value.preparationPurpose;
  const marketClass =
    value.marketClass == null ? null : string(value.marketClass);
  const topology = string(value.topology);
  const inspectionRevision = string(value.inspectionRevision);
  const reasonCodes = stringArray(value.reasonCodes);
  if (
    venueBindingOptionId !== expectedId ||
    !safeLabel ||
    ![
      "internal_managed",
      "external_ready",
      "external_setup_available",
      "external_source_only",
      "external_view_only",
    ].includes(String(readinessClass)) ||
    !["fund", "buy", "sell", "redeem", "withdraw"].includes(
      String(preparationPurpose),
    ) ||
    !topology ||
    !inspectionRevision ||
    typeof value.selectable !== "boolean" ||
    !reasonCodes
  ) {
    return null;
  }
  return {
    venueBindingOptionId,
    safeLabel,
    readinessClass: readinessClass as VenueBindingOption["readinessClass"],
    preparationPurpose:
      preparationPurpose as VenueBindingOption["preparationPurpose"],
    marketClass,
    topology,
    inspectionRevision,
    selectable: value.selectable,
    reasonCodes: reasonCodes as VenueBindingOption["reasonCodes"],
  };
}

type FrozenRelayReceipt = Readonly<{
  destination: ResolvedRouteDestination;
  profile: WalletExecutionProfile;
  routeId: string;
  source: RelayEligibleSourceFact;
  variant: DirectIngressObservationVariant;
}>;

function frozenRelayReceipt(
  target: FundingReceiveReceiptRoutingTarget,
): FrozenRelayReceipt | null {
  if (
    !["web", "telegram"].includes(target.ownerChannel) ||
    !target.receiptVariantSnapshot ||
    !target.receiptDestinationLocationId
  ) {
    return null;
  }
  let variant: DirectIngressObservationVariant;
  try {
    variant = parseDirectIngressObservationVariant(
      target.receiptVariantSnapshot,
    );
  } catch {
    return null;
  }
  const routeId = string(variant.observation.payload.routeId);
  const sourceComponentId = string(
    variant.observation.payload.sourceComponentId,
  );
  const profile = walletProfile(
    variant.observation.payload.walletExecutionProfile,
  );
  const destinationTarget = ownedTarget(
    target.destinationTargetSnapshot,
    target.userId,
    target.destinationAsset,
  );
  const bindingOption = venueBindingOption(
    target.venueBindingSnapshot,
    target.venueBindingOptionId,
  );
  if (
    variant.variantId !== target.receipt.variantId ||
    variant.completion.kind !== "child_funding_operation" ||
    variant.observation.adapterId !== "owned_wallet_liquid_balances_v1" ||
    variant.destinationLocationId !== target.receiptDestinationLocationId ||
    !sameAsset(variant.asset, target.receipt.asset) ||
    !sameAccountAddress(
      variant.networkId,
      variant.destinationAddress,
      target.receipt.destinationAddress,
    ) ||
    !routeId ||
    !sourceComponentId ||
    !profile ||
    profile.networkId !== variant.networkId ||
    !sameAccountAddress(
      variant.networkId,
      profile.address,
      variant.destinationAddress,
    ) ||
    !destinationTarget ||
    !bindingOption
  ) {
    return null;
  }
  const sourceLocation: AssetLocation = {
    kind: "wallet",
    locationId: variant.destinationLocationId,
    accountId: target.userId,
    asset: variant.asset,
    details: { walletId: profile.walletId, address: profile.address },
  };
  return {
    profile,
    routeId,
    variant,
    source: {
      componentId: sourceComponentId,
      reservationLocationId: sourceLocation.locationId,
      sourceLocationPatternId: "",
      safeLabel: "Received funds",
      source: { kind: "owned_location", location: sourceLocation },
      quoteInputAmount: {
        asset: target.receipt.asset,
        raw: target.receipt.rawAmount,
      },
      quoteModeOverride: "exact_input",
      maximumSourceRaw: target.receipt.rawAmount,
      maximumSlippageBps: target.automationPolicy.maximumSlippageBps,
      estimatedUsd: null,
      transferable: true,
      riskEligible: true,
      walletExecutionReady: true,
      nativeGasReady: true,
      freshness: "fresh",
    },
    destination: {
      destinationId: target.destinationOptionId,
      destinationLocationPatternId: "",
      target: destinationTarget,
      requiredAsset: target.destinationAsset,
      spendability: null,
      venueId: target.venueId,
      venueBindingOption: bindingOption,
      externalRecipientId: null,
      recipientAddress: null,
    },
  };
}

function exactCurrentRoute(
  policy: FundingControlPlaneSnapshot,
  target: FundingReceiveReceiptRoutingTarget,
  frozen: FrozenRelayReceipt,
): RuntimeRoute | null {
  if (policy.revision !== target.policyRevision) return null;
  const matches = policy.runtime.routes.filter(
    (route) =>
      route.enabled &&
      route.providerId === "relay" &&
      route.routeId === frozen.routeId &&
      sameAsset(route.sourceAsset, target.receipt.asset) &&
      sameAsset(route.destinationAsset, target.destinationAsset),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function controlPlaneDecision(
  policy: FundingControlPlaneSnapshot,
  target: FundingReceiveReceiptRoutingTarget,
  frozen: FrozenRelayReceipt,
): DelegatedFundingPreBroadcastDecision {
  if (
    policy.invalidStoredPolicy ||
    policy.policy.paused ||
    policy.runtime.creationMode !== "on" ||
    !policy.runtime.gates.startUnsubmittedAction ||
    policy.runtime.gates.emergencyBroadcastPause
  ) {
    return { kind: "soft_paused", reasonCode: "funding_policy_paused" };
  }
  if (policy.revision !== target.policyRevision) {
    return { kind: "hard_invalid", reasonCode: "funding_policy_changed" };
  }
  return exactCurrentRoute(policy, target, frozen)
    ? { kind: "allowed" }
    : { kind: "hard_invalid", reasonCode: "delegated_route_changed" };
}

async function exactCurrentWallet(
  db: Pick<Pool, "query">,
  target: FundingReceiveReceiptRoutingTarget,
  profile: WalletExecutionProfile,
  lock = false,
): Promise<boolean> {
  const walletType =
    profile.networkId === "solana:mainnet" ? "solana" : "ethereum";
  const { rows } = await db.query<{ id: string }>(
    `
      select wallet.id
      from users app_user
      join user_wallets wallet on wallet.user_id = app_user.id
      where app_user.id = $1::uuid
        and coalesce(app_user.is_active, true) = true
        and wallet.id = $2::uuid
        and wallet.wallet_type = $3
        and wallet.is_verified = true
        and wallet.is_internal_wallet = true
        and wallet.wallet_source = $4
        and wallet.privy_wallet_id is not distinct from $5
        and funding_account_identifier_equal(
              $6,
              wallet.wallet_address,
              $7
            )
      ${lock ? "for update of app_user, wallet" : ""}
      limit 2
    `,
    [
      target.userId,
      profile.controllerWalletRef,
      walletType,
      profile.source,
      profile.serverWalletRef,
      profile.networkId,
      profile.address,
    ],
  );
  return rows.length === 1;
}

function destinationAddress(destination: ResolvedRouteDestination): string {
  const value =
    destination.target.kind === "owned_location"
      ? destination.target.location.details.address
      : destination.recipientAddress;
  const address = string(value);
  if (!address) throw new Error("Relay receipt destination address is missing");
  return address;
}

function exactInputRoute(route: RuntimeRoute): RelayRouteSpec {
  return { ...resolveRelayRouteSpec(route), quoteMode: "exact_input" };
}

async function validateOperationLink(
  client: PoolClient,
  input: Readonly<{
    operationId: string;
    target: FundingReceiveReceiptRoutingTarget;
    expectedSource: AssetRef;
    expectedSourceRaw: string;
    routeId: string;
    delegatedProfileId?: string;
  }>,
): Promise<boolean> {
  const { rows } = await client.query<{ valid: boolean }>(
    `
      select exists (
        select 1
        from funding_operations operation
        join funding_operation_segments segment
          on segment.operation_id = operation.id
         and segment.ordinal = 0
        join funding_receive_receipts receipt
          on receipt.id = $3::uuid
         and receipt.receive_session_id = $4::uuid
         and receipt.user_id = operation.user_id
        where operation.id = $1::uuid
          and operation.user_id = $2::uuid
          and operation.purpose = 'add_funds'
          and operation.plan_kind = 'wallet_route'
          and operation.policy_revision = $5
          and operation.support_metadata ->> 'routeId' = $6
          and operation.support_metadata ->> 'fundingReceiveReceiptId' =
                receipt.id::text
          and operation.requested_source_amount ->> 'raw' = $7
          and operation.requested_source_amount #>> '{asset,networkId}' = $8
          and operation.requested_source_amount #>> '{asset,decimals}' = $9
          and funding_account_identifier_equal(
                $8,
                operation.requested_source_amount #>> '{asset,assetId}',
                $10
              )
          and segment.provider_id = 'relay'
          and segment.quoted_input ->> 'raw' = $7
          and not exists (
            select 1
            from funding_operation_segments other_segment
            where other_segment.operation_id = operation.id
              and other_segment.id <> segment.id
          )
          and (
            ($11::text is null and exists (
            select 1
            from funding_operation_steps step
            where step.operation_id = operation.id
              and step.state = 'action_required'
            ))
            or ($11::text is not null and (
              select count(*)
              from funding_operation_steps step
              where step.operation_id = operation.id
                and step.executor_id = $11
                and step.state = 'planned'
            ) = 2)
          )
      ) as valid
    `,
    [
      input.operationId,
      input.target.userId,
      input.target.receipt.receiptId,
      input.target.receipt.receiveSessionId,
      input.target.policyRevision,
      input.routeId,
      input.expectedSourceRaw,
      input.expectedSource.networkId,
      input.expectedSource.decimals,
      input.expectedSource.assetId,
      input.delegatedProfileId ?? null,
    ],
  );
  return rows[0]?.valid === true;
}

export function createRelayReceiveReceiptDispositionResolver(
  input: Readonly<{
    client: RelayClientConfig;
    referenceCodec: RelayReferenceCodec;
    subjectLookupHmacKey: string;
    subjectLookupKeyVersion: number;
  }>,
): (
  target: FundingReceiveReceiptRoutingTarget,
) => FundingReceiveReceiptDisposition {
  const adapter = new RelayWalletQuoteAdapter(new RelayClient(input.client));
  return (target) => {
    const quotePlan = relayReceiveQuotePlan({
      receiptAsset: target.receipt.asset,
      destinationAsset: target.destinationAsset,
      rawAmount: target.receipt.rawAmount,
    });
    const frozen = frozenRelayReceipt(target);
    if (!quotePlan || !frozen || !quotePlan.confirmedSourceAmount) {
      return {
        kind: "hard_invalid",
        reasonCode: "receipt_quote_plan_invalid",
      };
    }
    if (target.receipt.handling === "review_required") {
      const continuation = relayReviewContinuation(target.destinationAsset);
      return continuation
        ? {
            kind: "review_required",
            continuation,
            quotePlan,
          }
        : {
            kind: "hard_invalid",
            reasonCode: "receipt_quote_plan_invalid",
          };
    }
    if (target.receipt.handling !== "automatic_conversion") {
      return {
        kind: "hard_invalid",
        reasonCode: "receipt_quote_plan_invalid",
      };
    }
    const confirmedSourceAmount = quotePlan.confirmedSourceAmount;
    const outsidePolicyReview = relayReviewContinuation(
      target.destinationAsset,
    );
    const execution: FundingReceiveReceiptAutomaticExecution = {
      adapterKey: RELAY_RECEIVE_OPERATION_ADAPTER_KEY,
      ...(outsidePolicyReview ? { outsidePolicyReview } : {}),
      quotePlan: () => quotePlan,
      decision: async (db, receiptTarget) => {
        const policy = await resolveFundingControlPlaneSnapshot(db);
        const policyDecision = controlPlaneDecision(
          policy,
          receiptTarget,
          frozen,
        );
        if (policyDecision.kind !== "allowed") return policyDecision;
        return (await exactCurrentWallet(db, receiptTarget, frozen.profile))
          ? { kind: "allowed" }
          : {
              kind: "hard_invalid",
              reasonCode: "delegated_authority_invalid",
            };
      },
      prepareOperation: async (db, receiptTarget, now) => {
        const policy = await resolveFundingControlPlaneSnapshot(db);
        const route = exactCurrentRoute(policy, receiptTarget, frozen);
        if (
          !route ||
          !(await exactCurrentWallet(db, receiptTarget, frozen.profile))
        ) {
          return null;
        }
        const sourceAmount = confirmedSourceAmount;
        const delegatedProfileId =
          typeof receiptTarget.telegramAutomationPolicy?.profileId === "string"
            ? receiptTarget.telegramAutomationPolicy.profileId
            : "";
        const delegatedProfile =
          receiptTarget.ownerChannel === "telegram"
            ? relayEvmFundingProfileSpec(delegatedProfileId)
            : null;
        const delegatedRelay = delegatedProfile != null;
        const relayExecutionConfiguration = delegatedRelay
          ? loadRelayEvmExecutionConfiguration()
          : null;
        const minimumSequentialTtlMs =
          relayExecutionConfiguration?.minimumSequentialTtlMs ?? 0;
        const sequentialQuoteTtlMs = relayExecutionConfiguration
          ? relayEvmSequentialQuoteTtlMs(relayExecutionConfiguration)
          : 60_000;
        const baselineAllowance = delegatedRelay
          ? await captureRelayEvmAllowanceBaseline(delegatedProfile, {
              owner: frozen.profile.address,
            })
          : null;
        // A detached terminal child starts a new durable operation generation.
        // Relay's operationId must advance with it: reusing the receipt-only
        // correlation can replay the provider's expired quote/order from the
        // failed generation even though our DB idempotency key is `retry:N`.
        const operationIdempotencyKey =
          await fundingReceiveReceiptOperationIdempotencyKey(db, {
            receiptId: receiptTarget.receipt.receiptId,
            userId: receiptTarget.userId,
          });
        const quoteCorrelationId = relayReceiveQuoteCorrelationId(
          receiptTarget.receipt.receiptId,
          operationIdempotencyKey,
        );
        const quote = await adapter.quote({
          route: exactInputRoute(route),
          source: frozen.source.source,
          destination: frozen.destination.target,
          sourceAmount,
          minimumOutput: quotePlan.requestedDestinationAmount,
          userAddress: frozen.profile.address,
          recipientAddress: destinationAddress(frozen.destination),
          senderWalletId: frozen.profile.walletId,
          quoteCorrelationId,
          deadline: new Date(now.getTime() + sequentialQuoteTtlMs),
          maximumQuoteTtlMs: sequentialQuoteTtlMs,
          maximumSlippageBps: receiptTarget.automationPolicy.maximumSlippageBps,
          now,
        });
        const planned = await buildRelayPlanningQuote({
          codec: input.referenceCodec,
          destination: {
            ...frozen.destination,
            destinationLocationPatternId: route.destinationLocationPatternId,
          },
          policyRevision: receiptTarget.policyRevision,
          profile: frozen.profile,
          quote,
          quoteCorrelationId,
          route,
          ...(delegatedProfile
            ? {
                serverExecutionProfileId: delegatedProfile.profileId,
              }
            : {}),
          source: {
            ...frozen.source,
            sourceLocationPatternId: route.sourceLocationPatternId,
            quoteInputAmount: sourceAmount,
            maximumSourceRaw: sourceAmount.raw,
          },
          supportMetadata: {
            fundingReceiveReceiptId: receiptTarget.receipt.receiptId,
            fundingReceiveObservationRevision:
              receiptTarget.receipt.observationRevision,
            fundingReceiveVariantId: receiptTarget.receipt.variantId,
            ...(baselineAllowance
              ? {
                  ...relayEvmAllowanceBaselineSupportMetadata(
                    baselineAllowance,
                  ),
                }
              : {}),
          },
        });
        const fees = planned.candidate.fees.map((fee, index) => ({
          ...fee,
          estimatedUsd: planned.feeUsd[index] ?? null,
        }));
        if (
          receiptTarget.ownerChannel === "telegram" &&
          new Date(planned.candidate.expiresAt).getTime() - now.getTime() <
            minimumSequentialTtlMs
        ) {
          return null;
        }
        if (
          !receiveAutomationEconomicsWithinPolicy(
            {
              fees,
              minimumDestination: planned.candidate.minimumOutput,
            },
            receiptTarget.automationPolicy,
          )
        ) {
          return { kind: "outside_policy" } as const;
        }
        const consentToken = randomBytes(32).toString("base64url");
        const expiresAt = new Date(planned.candidate.expiresAt);
        if (expiresAt.getTime() <= now.getTime()) return null;
        return {
          verify: async (client: PoolClient) => {
            await lockFundingPolicyForTransaction(client);
            const currentPolicy =
              await resolveFundingControlPlaneSnapshot(client);
            if (
              !exactCurrentRoute(currentPolicy, receiptTarget, frozen) ||
              !(await exactCurrentWallet(
                client,
                receiptTarget,
                frozen.profile,
                true,
              ))
            ) {
              throw new Error("Relay receipt authority changed before commit");
            }
          },
          commit: async (client: PoolClient) => {
            const idempotencyKey =
              await fundingReceiveReceiptOperationIdempotencyKey(client, {
                receiptId: receiptTarget.receipt.receiptId,
                userId: receiptTarget.userId,
              });
            if (idempotencyKey !== operationIdempotencyKey) {
              throw new Error("Relay receipt operation generation changed");
            }
            const quoteRow = await createFundingQuoteInTransaction(client, {
              userId: receiptTarget.userId,
              discoveryProjectionId: stableOpaqueId(
                "funding_projection",
                receiptTarget.receipt.receiptId,
              ),
              selectedSourceOptionSnapshot:
                planned.commitPlan.operation.sourceSnapshot ?? {},
              marketContextSnapshot: null,
              destinationOptionSnapshot:
                receiptTarget.destinationTargetSnapshot,
              venueBindingSnapshot: receiptTarget.venueBindingSnapshot,
              planSnapshot: planned.commitPlan,
              policyVersion: receiptTarget.policyVersion,
              policyRevision: receiptTarget.policyRevision,
              canonicalRequest: {
                kind: "automatic_receive_receipt",
                receiptId: receiptTarget.receipt.receiptId,
                observationRevision: receiptTarget.receipt.observationRevision,
                ownershipRevision: receiptTarget.ownershipRevision,
                routeId: route.routeId,
              },
              consentToken,
              expiresAt,
            });
            const committed = await commitFundingOperationInTransaction(
              client,
              {
                userId: receiptTarget.userId,
                quoteId: quoteRow.id,
                consentToken,
                idempotencyKey,
                plan: planned.commitPlan,
                subjectLookupHmac: fundingSubjectLookupHmac(
                  receiptTarget.userId,
                  input.subjectLookupHmacKey,
                ),
                subjectLookupKeyVersion: input.subjectLookupKeyVersion,
                now,
              },
            );
            return committed.operation.id;
          },
        };
      },
      validateOperationLink: (client, operation) =>
        (() => {
          const delegatedProfileId =
            typeof target.telegramAutomationPolicy?.profileId === "string"
              ? target.telegramAutomationPolicy.profileId
              : "";
          return validateOperationLink(client, {
            ...operation,
            expectedSource:
              quotePlan.confirmedSourceAmount?.asset ?? target.receipt.asset,
            expectedSourceRaw: quotePlan.confirmedSourceAmount?.raw ?? "0",
            routeId: frozen.routeId,
            ...(target.ownerChannel === "telegram" &&
            relayEvmFundingProfileSpec(delegatedProfileId)
              ? { delegatedProfileId }
              : {}),
          });
        })(),
    };
    return { kind: "automatic_execution", execution, quotePlan };
  };
}
