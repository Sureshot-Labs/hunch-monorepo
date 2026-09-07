import type { PoolClient } from "@hunch/infra";
import { Interface } from "ethers";
import { deriveSafeProxyAddress } from "../../services/polymarket-funder.js";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { deriveExecutionGas } from "../../account-value/execution-gas.js";
import {
  stableOpaqueId,
  stableWalletAssetLocationIdentity,
} from "../../account-value/canonical.js";
import {
  multiplyRawByUnitPrice,
  rawForUsdCeil,
} from "../../account-value/decimal.js";
import {
  buildPolymarketFundingPlan,
  buildMaximumPolymarketFundingPlan,
  PolymarketFundingPlanError,
} from "../../services/polymarket-funding-router.js";
import { buildPolymarketPreRouteHandoffSteps } from "../../funding-providers/relay/operation-plan.js";
import type {
  AssetLocation,
  AssetRef,
  FundingPurpose,
  JsonValue,
  SourceOption,
  Money,
  WalletExecutionProfile,
} from "../domain/types.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { sameAsset } from "../planner/money.js";
import { minimumAutomaticTradeRefillUsd } from "../planner/placement-policy.js";
import { POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW } from "../../services/polymarket-automation-policy.js";
import {
  findExactFundingWalletProfile,
  type FundingSourceAdapter,
  type FundingSourcePlanningInput,
} from "../planner/source-adapter.js";
import {
  isPolymarketDepositRouterProfileId,
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
} from "../execution/delegated-funding-profile-ids.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  type PlannedSourceOption,
} from "../planner/planning-types.js";
import {
  buildPolymarketControllerApprovalActionValidation,
  buildPolymarketFundingActionValidation,
  buildPolymarketFundingFollowupAction,
} from "./polymarket-funding-followup.js";
import {
  parsePolymarketFundingEvidence,
  POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
} from "./polymarket-funding-snapshot.js";
import { lockPolymarketFundingOperationPredecessor } from "./polymarket-funding-commit-guard.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20_APPROVAL = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const ERC20_TRANSFER = new Interface([
  "function transfer(address recipient,uint256 amount)",
]);

/** Credit another controller owned by this account, without making its
 * Router (or server signer) impersonate the Safe owner. */
function prependOwnedControllerTransfer(input: {
  owner: WalletExecutionProfile;
  recipient: WalletExecutionProfile;
  amount: Money;
  quoteCorrelationId: string;
  steps: FundingCommitPlan["steps"];
}): FundingCommitPlan["steps"] {
  const action = {
    kind: "evm_transaction" as const,
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        quoteCorrelationId: input.quoteCorrelationId,
        owner: input.owner.address,
        recipient: input.recipient.address,
        amount: input.amount,
      }),
    ),
    networkId: "evm:137",
    senderWalletId: input.owner.walletId,
    to: input.amount.asset.assetId,
    data: ERC20_TRANSFER.encodeFunctionData("transfer", [
      input.recipient.address,
      input.amount.raw,
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const sponsorship = resolveActionSponsorship({
    action,
    profile: input.owner,
  });
  return [
    {
      ordinal: 0,
      segmentOrdinal: null,
      stepKind: "transaction",
      state: "action_required",
      executorId: "wallet_profile_evm_v1",
      payerRequirement: sponsorship.payerRequirement,
      dependsOnOrdinal: null,
      normalizedAction: jsonRecord(action),
      actionFingerprint: canonicalJsonHash(action),
      actionValidationResult: {
        valid: true,
        validatorId: POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
        kind: "owned_safe_controller_transfer",
        signerAddress: input.owner.address,
        postconditionEvidenceKind: "exact_erc20_destination_credit_v1",
        expectedDestinationAssetId: input.amount.asset.assetId,
        expectedDestinationAddress: input.recipient.address,
        expectedDestinationRaw: input.amount.raw,
        sponsorshipPolicyId: sponsorship.policyId,
        signingMode: sponsorship.signingMode,
      },
    },
    ...input.steps.map((step) => ({
      ...step,
      ordinal: step.ordinal + 1,
      dependsOnOrdinal:
        step.dependsOnOrdinal == null ? 0 : step.dependsOnOrdinal + 1,
    })),
  ];
}

function jsonRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function detail(location: AssetLocation, key: string): string | null {
  const value = location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function supportsExactOutputVenuePreparation(purpose: FundingPurpose): boolean {
  switch (purpose) {
    case "add_funds":
    case "trade_shortfall":
    case "manual_rebalance":
      return true;
    case "convert_asset":
    case "withdrawal":
      return false;
  }
}

function minimumAutomaticRelayDestinationRaw(
  input: FundingSourcePlanningInput,
): bigint | null {
  // A trade shortfall is the exact remaining consumer requirement. Preserve
  // every available local contribution; the generic refill floor is for
  // standalone add-funds/rebalance routes and must not reserve an artificial
  // $0.50 gap inside a confirmed Buy.
  if (input.request.purpose === "trade_shortfall") return 0n;
  const unitPriceUsd =
    input.destinationFacts?.collateralValuation?.unitPriceUsd;
  if (!unitPriceUsd) return null;
  return BigInt(
    rawForUsdCeil({
      usd: minimumAutomaticTradeRefillUsd(input.policy),
      decimals: input.requiredAmount.asset.decimals,
      unitPriceUsd,
    }),
  );
}

export class PolymarketFundingSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = POLYMARKET_FUNDING_SOURCE_ADAPTER_ID;

  constructor(
    private readonly account: AccountValueReadModel,
    private readonly config: Readonly<{
      canonicalRouterAddress: string | null;
      usdceAsset: AssetRef;
    }> = {
      canonicalRouterAddress:
        fundingSidecarRuntimeConfig.polymarketFundingRouterAddress || null,
      usdceAsset: {
        networkId: "evm:137",
        assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
        decimals: 6,
      },
    },
  ) {}

  async verifyCommit(
    client: PoolClient,
    input: Readonly<{
      userId: string;
      operation: FundingCommitPlan["operation"];
    }>,
  ): Promise<void> {
    if (
      input.operation.supportMetadata?.preparationKind !==
      "polymarket_funding_router"
    ) {
      return;
    }
    const metadataBinding =
      input.operation.supportMetadata?.venueBindingOptionId;
    const snapshotBinding =
      input.operation.venueBindingSnapshot?.venueBindingOptionId;
    const venueBindingOptionId =
      typeof metadataBinding === "string" && metadataBinding.trim()
        ? metadataBinding
        : typeof snapshotBinding === "string" && snapshotBinding.trim()
          ? snapshotBinding
          : "";
    await lockPolymarketFundingOperationPredecessor(client, {
      userId: input.userId,
      venueBindingOptionId,
    });
  }

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    const option = await this.build(input);
    return option ? [option] : [];
  }

  private availableInputComponent(input: {
    accountId: string;
    address: string;
    asset: AssetRef;
    locationMatches?: (location: AssetLocation) => boolean;
  }): Readonly<{
    component: AccountValueReadModel["projection"]["components"][number];
    availableRaw: string;
  }> | null {
    const availabilityByComponent = new Map(
      this.account.cashAvailability.components.map((component) => [
        component.componentId,
        component,
      ]),
    );
    const matches = this.account.projection.components.flatMap((component) => {
      const availability = availabilityByComponent.get(component.componentId);
      const address = detail(component.location, "address");
      if (
        component.location.accountId !== input.accountId ||
        component.category === "in_transit" ||
        component.observationFreshness !== "fresh" ||
        component.observationError ||
        component.valuationEligibility !== "included" ||
        !sameAsset(component.amount.asset, input.asset) ||
        !address ||
        !sameAccountAddress(input.asset.networkId, address, input.address) ||
        !availability ||
        availability.freshness !== "fresh" ||
        BigInt(availability.availableRaw) <= 0n ||
        (input.locationMatches && !input.locationMatches(component.location))
      ) {
        return [];
      }
      return [{ component, availableRaw: availability.availableRaw }];
    });
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private async build(
    input: FundingSourcePlanningInput,
  ): Promise<PlannedSourceOption | null> {
    // A server execution profile is a single, exact authority envelope.
    // In particular, do not contribute a partial local preparation while a
    // Relay profile is being evaluated: doing so would turn the otherwise
    // viable Relay source into a residual-only composite candidate.
    if (
      input.request.serverExecutionProfileId != null &&
      !isPolymarketDepositRouterProfileId(
        input.request.serverExecutionProfileId,
      )
    ) {
      return null;
    }
    const facts = input.destinationFacts;
    const snapshot = parsePolymarketFundingEvidence(
      facts?.sourcePlanningEvidence ?? null,
    );
    if (
      !supportsExactOutputVenuePreparation(input.request.purpose) ||
      facts?.option.venueId !== "polymarket" ||
      facts.target.kind !== "owned_location" ||
      !facts.collateralValuation ||
      !snapshot ||
      !this.config.canonicalRouterAddress ||
      !sameAccountAddress(
        "evm:137",
        snapshot.routerAddress,
        this.config.canonicalRouterAddress,
      ) ||
      !sameAsset(input.requiredAmount.asset, facts.option.requiredAsset) ||
      BigInt(input.requiredAmount.raw) <= 0n
    ) {
      return null;
    }
    const profile = findExactFundingWalletProfile({
      account: this.account,
      walletId: facts.venueBinding.executionWalletId,
      networkId: "evm:137",
      address: snapshot.signerAddress,
    });
    if (
      !profile ||
      (!profile.signingModes.includes("web_client") &&
        !profile.signingModes.includes("privy_authorization"))
    ) {
      return null;
    }
    const usdceAsset = this.config.usdceAsset;
    const controllerPusdInput = this.availableInputComponent({
      accountId: input.accountId,
      address: snapshot.signerAddress,
      asset: facts.option.requiredAsset,
    });
    const controllerUsdceInput = this.availableInputComponent({
      accountId: input.accountId,
      address: snapshot.signerAddress,
      asset: usdceAsset,
    });
    const depositUsdceInput =
      input.request.serverExecutionProfileId == null
        ? this.availableInputComponent({
            accountId: input.accountId,
            address: snapshot.depositWallet,
            asset: usdceAsset,
            locationMatches: (location) => {
              const linkedAddress = detail(location, "linkedAddress");
              return (
                location.kind === "venue_account" &&
                detail(location, "venueId") === "polymarket" &&
                detail(location, "polymarketFunderKind") === "deposit_wallet" &&
                linkedAddress != null &&
                sameAccountAddress(
                  "evm:137",
                  linkedAddress,
                  snapshot.signerAddress,
                )
              );
            },
          })
        : null;
    // Reuse the exact controller USDC.e input path for an already-owned Safe.
    // This adds no new wallet deployment and never grants a router allowance
    // from the Safe; only its connected owner signs the preliminary transfer.
    const safeAddress = deriveSafeProxyAddress(snapshot.signerAddress);
    const canUseSafe = Boolean(
      safeAddress &&
      input.request.serverExecutionProfileId == null &&
      (profile.source !== "external" ||
        (profile.controllerWalletRef != null &&
          this.account.connectedExternalWalletRefs?.includes(
            profile.controllerWalletRef,
          ))),
    );
    const availableSafeInput = (asset: AssetRef) =>
      canUseSafe && safeAddress
        ? this.availableInputComponent({
            accountId: input.accountId,
            address: safeAddress,
            asset,
            locationMatches: (location) =>
              location.kind === "venue_account" &&
              detail(location, "venueId") === "polymarket" &&
              detail(location, "polymarketFunderKind") === "safe" &&
              detail(location, "linkedAddress")?.toLowerCase() ===
                snapshot.signerAddress.toLowerCase(),
          })
        : null;
    let safeUsdceInput = availableSafeInput(usdceAsset);
    let safeUsdceProfile = profile;
    let safeUsdceAddress = safeAddress;
    // A linked Safe may have a different controller from the destination.
    // Its owner still signs extraction; an exact owner -> destination
    // controller transfer then feeds the unchanged Router contract.
    if (!safeUsdceInput && input.request.serverExecutionProfileId == null) {
      for (const candidate of this.account.ownership?.wallets ?? []) {
        if (
          candidate.networkId !== "evm:137" ||
          candidate.address.toLowerCase() === profile.address.toLowerCase() ||
          !candidate.controllerWalletRef ||
          !candidate.signingModes.includes("web_client") ||
          (candidate.source === "external" &&
            !this.account.connectedExternalWalletRefs?.includes(
              candidate.controllerWalletRef,
            )) ||
          deriveExecutionGas(this.account, candidate).status !== "ready"
        )
          continue;
        const candidateSafe = deriveSafeProxyAddress(candidate.address);
        if (!candidateSafe) continue;
        const resolved = this.availableInputComponent({
          accountId: input.accountId,
          address: candidateSafe,
          asset: usdceAsset,
          locationMatches: (location) =>
            location.kind === "venue_account" &&
            detail(location, "venueId") === "polymarket" &&
            detail(location, "polymarketFunderKind") === "safe" &&
            detail(location, "linkedAddress")?.toLowerCase() ===
              candidate.address.toLowerCase(),
        });
        if (!resolved) continue;
        safeUsdceInput = resolved;
        safeUsdceProfile = candidate;
        safeUsdceAddress = candidateSafe;
        break;
      }
    }
    const safePusdInput = availableSafeInput(facts.option.requiredAsset);
    const availableRaw = (
      observedRaw: string,
      resolved: ReturnType<
        PolymarketFundingSourceAdapter["availableInputComponent"]
      >,
    ): bigint => {
      if (!resolved) return 0n;
      const observed = BigInt(observedRaw);
      const available = BigInt(resolved.availableRaw);
      return observed < available ? observed : available;
    };
    const safePusdRaw = availableRaw(
      safePusdInput?.component.amount.raw ?? "0",
      safePusdInput,
    );
    const safeUsdceRaw = availableRaw(
      safeUsdceInput?.component.amount.raw ?? "0",
      safeUsdceInput,
    );
    const controllerPusdRaw = availableRaw(
      snapshot.signerPusdRaw,
      controllerPusdInput,
    );
    const controllerUsdceRaw = availableRaw(
      snapshot.signerUsdceRaw,
      controllerUsdceInput,
    );
    const depositUsdceRaw = availableRaw(
      snapshot.depositUsdceRaw,
      depositUsdceInput,
    );
    const buildPlan = (maximumFundingRaw: bigint) =>
      buildMaximumPolymarketFundingPlan({
        signer: snapshot.signerAddress,
        depositWallet: snapshot.depositWallet,
        routerAddress: snapshot.routerAddress,
        routerNonce: BigInt(snapshot.routerNonceRaw),
        maximumFundingRaw,
        depositPusdRaw: BigInt(snapshot.depositPusdRaw),
        depositLockedRaw: BigInt(snapshot.depositLockedRaw),
        // The preceding relayer action hands exact USDC.e back to this
        // controller, so Router consumes it through its native USDC.e input.
        signerPusdRaw: controllerPusdRaw + safePusdRaw,
        signerLockedRaw: 0n,
        signerUsdceRaw: controllerUsdceRaw + depositUsdceRaw + safeUsdceRaw,
        // A client plan may durably include the missing controller approvals.
        // Deposit Wallet approval is never planned: its only allowed role is
        // the exact relayer transfer back to this controller.
        routerPusdAllowanceRaw: POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
        routerUsdceAllowanceRaw: POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
        fundingCapRaw: maximumFundingRaw,
      });
    const requiredRaw = BigInt(input.requiredAmount.raw);
    const delegatedPusdFund =
      input.request.serverExecutionProfileId ===
      POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
    // The generic runtime snapshot derives its funding capacity from the
    // *current* Router allowances.  That is correct for a user-signed route,
    // but circular for this exact delegated profile: missing approvals are
    // durable prerequisite steps in the same operation.  Plan only the exact
    // shortfall here; the Privy profile validator and the executor still
    // enforce the configured policy cap before any approval or fund call.
    const planningFundingCapRaw = requiredRaw;
    let plan;
    try {
      plan = delegatedPusdFund
        ? buildPolymarketFundingPlan({
            signer: snapshot.signerAddress,
            depositWallet: snapshot.depositWallet,
            routerAddress: snapshot.routerAddress,
            routerNonce: BigInt(snapshot.routerNonceRaw),
            requiredRaw,
            // The Router policy bounds the one `fund` call by totalAmount.
            // It can therefore prepare the controller's pUSD and USDC.e
            // together, but never any Deposit Wallet/third-party balance.
            depositPusdRaw: 0n,
            depositLockedRaw: 0n,
            signerPusdRaw: controllerPusdRaw,
            signerLockedRaw: 0n,
            signerUsdceRaw: controllerUsdceRaw,
            // These exact MaxUint approvals are separate, policy-bounded
            // prerequisite steps when absent. Plan the Router call against
            // that post-approval state; the actual snapshots below decide
            // which prerequisites to persist.
            routerPusdAllowanceRaw: POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
            routerUsdceAllowanceRaw: POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
            fundingCapRaw: planningFundingCapRaw,
          })
        : buildPlan(requiredRaw);
      if (plan && BigInt(plan.totalAmountRaw) < requiredRaw) {
        const minimumRelayRaw = minimumAutomaticRelayDestinationRaw(input);
        if (minimumRelayRaw == null) return null;
        const maximumPreparationRaw =
          requiredRaw > minimumRelayRaw ? requiredRaw - minimumRelayRaw : 0n;
        plan =
          maximumPreparationRaw > 0n ? buildPlan(maximumPreparationRaw) : null;
      }
    } catch (error) {
      // A stale/missing balance, cap, or allowance makes this exact source
      // unavailable; it must not abort discovery of independent sources such
      // as direct external ingress.
      if (error instanceof PolymarketFundingPlanError) return null;
      throw error;
    }
    if (!plan || plan.routerNonce !== snapshot.routerNonceRaw) {
      return null;
    }
    const plannedDestinationAmount = {
      asset: input.requiredAmount.asset,
      raw: plan.totalAmountRaw,
    };
    const fullyFunded = plan.totalAmountRaw === input.requiredAmount.raw;
    if (delegatedPusdFund && BigInt(plan.pUsdAmountRaw) <= 0n) {
      return null;
    }
    const requiresUsdceApproval =
      BigInt(snapshot.routerUsdceAllowanceRaw) <
      BigInt(plan.signerUsdceAmountRaw);
    const requiresPusdApproval =
      BigInt(snapshot.routerPusdAllowanceRaw) < BigInt(plan.pUsdAmountRaw);
    const plannedPusdRaw = BigInt(plan.pUsdAmountRaw);
    const controllerPusdContributionRaw =
      plannedPusdRaw < controllerPusdRaw ? plannedPusdRaw : controllerPusdRaw;
    const safePusdContributionRaw =
      plannedPusdRaw - controllerPusdContributionRaw;
    const plannedUsdceRaw = BigInt(plan.signerUsdceAmountRaw);
    const controllerUsdceContributionRaw =
      plannedUsdceRaw < controllerUsdceRaw
        ? plannedUsdceRaw
        : controllerUsdceRaw;
    const incomingUsdceRaw = plannedUsdceRaw - controllerUsdceContributionRaw;
    const depositUsdceContributionRaw =
      incomingUsdceRaw < depositUsdceRaw ? incomingUsdceRaw : depositUsdceRaw;
    const safeUsdceContributionRaw =
      incomingUsdceRaw - depositUsdceContributionRaw;
    const controllerUsdceIdentity = controllerUsdceInput
      ? {
          componentId: controllerUsdceInput.component.componentId,
          locationId: controllerUsdceInput.component.location.locationId,
        }
      : stableWalletAssetLocationIdentity({
          accountId: input.accountId,
          address: snapshot.signerAddress,
          asset: usdceAsset,
          balanceClass: "polymarket",
        });
    const resolvedInputs = [
      ...(safePusdContributionRaw > 0n && safePusdInput
        ? [
            {
              asset: facts.option.requiredAsset,
              rawAmount: safePusdContributionRaw.toString(),
              resolved: safePusdInput,
            },
          ]
        : []),
      ...(controllerPusdContributionRaw > 0n && controllerPusdInput
        ? [
            {
              asset: facts.option.requiredAsset,
              rawAmount: controllerPusdContributionRaw.toString(),
              resolved: controllerPusdInput,
            },
          ]
        : []),
      ...(controllerUsdceContributionRaw > 0n && controllerUsdceInput
        ? [
            {
              asset: usdceAsset,
              rawAmount: controllerUsdceContributionRaw.toString(),
              resolved: controllerUsdceInput,
            },
          ]
        : []),
      ...(depositUsdceContributionRaw > 0n && depositUsdceInput
        ? [
            {
              asset: usdceAsset,
              rawAmount: depositUsdceContributionRaw.toString(),
              resolved: depositUsdceInput,
            },
          ]
        : []),
      ...(safeUsdceContributionRaw > 0n && safeUsdceInput
        ? [
            {
              asset: usdceAsset,
              rawAmount: safeUsdceContributionRaw.toString(),
              resolved: safeUsdceInput,
            },
          ]
        : []),
    ];
    const expectedInputCount =
      Number(safeUsdceContributionRaw > 0n) +
      Number(controllerPusdContributionRaw > 0n) +
      Number(controllerUsdceContributionRaw > 0n) +
      Number(depositUsdceContributionRaw > 0n);
    if (
      resolvedInputs.length === 0 ||
      resolvedInputs.length !==
        expectedInputCount + Number(safePusdContributionRaw > 0n)
    ) {
      return null;
    }
    // Each inventory location contributes independently. Exact transfers run
    // before the shared controller approvals/fund; incoming credit is fenced
    // once at the controller, not counted as an additional economic input.
    const preRouteHandoffs = [
      {
        resolved: depositUsdceInput,
        raw: depositUsdceContributionRaw,
        asset: usdceAsset,
        funderAddress: snapshot.depositWallet,
        kind: "polymarket_deposit_wallet_to_controller_v1" as const,
      },
      {
        resolved: safeUsdceInput,
        raw: safeUsdceContributionRaw,
        asset: usdceAsset,
        funderAddress: safeUsdceAddress,
        profile: safeUsdceProfile,
        kind: "polymarket_safe_to_controller_v1" as const,
      },
      {
        resolved: safePusdInput,
        raw: safePusdContributionRaw,
        asset: facts.option.requiredAsset,
        funderAddress: safeAddress,
        kind: "polymarket_safe_to_controller_v1" as const,
      },
    ].flatMap((entry) =>
      entry.resolved && entry.raw > 0n && entry.funderAddress
        ? [
            {
              sourceAmount: { asset: entry.asset, raw: entry.raw.toString() },
              handoff: {
                kind: entry.kind,
                sourceLocation: entry.resolved.component.location,
                funderAddress: entry.funderAddress,
                controllerAddress: (entry.profile ?? profile).address,
                tokenAddress: entry.asset.assetId,
              },
              profile: entry.profile ?? profile,
            },
          ]
        : [],
    );
    const quoteCorrelationId = stableOpaqueId(
      "funding_quote",
      canonicalJsonHash({
        accountId: input.accountId,
        adapterId: this.adapterId,
        destinationOptionId: facts.option.destinationOptionId,
        fundingPlan: plan,
        inputs: resolvedInputs.map((entry) => ({
          componentId: entry.resolved.component.componentId,
          rawAmount: entry.rawAmount,
        })),
        policyRevision: input.policyRevision,
        requiredAmount: input.requiredAmount,
      }),
    );
    const action = buildPolymarketFundingFollowupAction({
      binding: facts.venueBinding,
      canonicalRouterAddress: snapshot.routerAddress,
      inspectionRevision: facts.bindingOption.inspectionRevision,
      operationId: quoteCorrelationId,
      plan,
    });
    if (action.kind !== "evm_transaction") return null;
    const reservationExpiresAt = new Date(
      Date.parse(facts.spendability.expiresAt) +
        FUNDING_OPERATION_RECONCILIATION_TTL_MS,
    ).toISOString();
    const approvalAction = (assetId: string) => {
      const approval = {
        kind: "evm_transaction" as const,
        networkId: "evm:137",
        senderWalletId: action.senderWalletId,
        to: assetId,
        data: ERC20_APPROVAL.encodeFunctionData("approve", [
          snapshot.routerAddress,
          POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
        ]),
        valueRaw: "0",
        gasLimitRaw: null,
      };
      return {
        ...approval,
        actionId: `action_${canonicalJsonHash({
          approval,
          operationId: quoteCorrelationId,
        }).slice(0, 32)}`,
      };
    };
    const approvalActions = [
      ...(requiresUsdceApproval
        ? [
            {
              action: approvalAction(usdceAsset.assetId),
              actionKind: "controller_usdce_router_approval" as const,
            },
          ]
        : []),
      ...(requiresPusdApproval
        ? [
            {
              action: approvalAction(facts.option.requiredAsset.assetId),
              actionKind: "controller_pusd_router_approval" as const,
            },
          ]
        : []),
    ];
    const sponsorship = resolveActionSponsorship({ action, profile });
    const approvalCommitSteps = approvalActions.map((approval, ordinal) => {
      const approvalSponsorship = resolveActionSponsorship({
        action: approval.action,
        profile,
      });
      return {
        ordinal,
        segmentOrdinal: null,
        stepKind: "transaction" as const,
        state: delegatedPusdFund
          ? ("planned" as const)
          : ("action_required" as const),
        actionFingerprint: canonicalJsonHash(approval.action),
        executorId: delegatedPusdFund
          ? POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID
          : "wallet_profile_evm_v1",
        payerRequirement: approvalSponsorship.payerRequirement,
        dependsOnOrdinal: ordinal === 0 ? null : ordinal - 1,
        normalizedAction: jsonRecord(approval.action),
        ...(delegatedPusdFund ? { actionExpiresAt: null } : {}),
        actionValidationResult:
          buildPolymarketControllerApprovalActionValidation({
            kind: approval.actionKind,
            profileAddress: profile.address,
            routerAddress: snapshot.routerAddress,
            sponsorship: approvalSponsorship,
          }),
      };
    });
    const source = {
      kind: "venue_preparation" as const,
      venueId: "polymarket",
      venueBindingId: facts.venueBinding.bindingId,
      inputCount: resolvedInputs.length,
      inputs: resolvedInputs.map((entry) => ({
        asset: entry.asset,
        locationId: entry.resolved.component.location.locationId,
        rawAmount: entry.rawAmount,
      })),
    };
    const option: SourceOption = {
      sourceOptionId: stableOpaqueId(
        "source",
        canonicalJsonHash({ quoteCorrelationId, actionId: action.actionId }),
      ),
      kind: "venue_preparation",
      safeLabel:
        delegatedPusdFund && BigInt(plan.signerUsdceAmountRaw) > 0n
          ? "Use controller pUSD + USDC.e in one Polymarket funding step"
          : "Prepare Polymarket Deposit Wallet funds",
      source,
      amountMode: "exact_output",
      maximumSourceRaw: plan.totalAmountRaw,
      expectedDestination: plannedDestinationAmount,
      minimumDestination: plannedDestinationAmount,
      estimatedUsd: multiplyRawByUnitPrice({
        raw: plannedDestinationAmount.raw,
        decimals: input.requiredAmount.asset.decimals,
        unitPriceUsd: facts.collateralValuation.unitPriceUsd,
      }),
      fees: [],
      eta: { minSeconds: 5, maxSeconds: 90 },
      experienceMode: "prepare_first",
      requiredActions: [
        ...preRouteHandoffs.map(({ sourceAmount }) => ({
          kind: "external_handoff" as const,
          safeLabel:
            sourceAmount.asset.assetId === facts.option.requiredAsset.assetId
              ? "Move Polymarket pUSD to the Trading Wallet"
              : "Move Polymarket USDC.e to the Trading Wallet",
          actor: "user" as const,
          valueMoving: true,
          sponsorship: "none" as const,
        })),
        ...(safeUsdceContributionRaw > 0n && safeUsdceProfile !== profile
          ? [
              {
                kind: "evm_transaction" as const,
                safeLabel:
                  "Transfer recovered USDC.e to the selected Trading Wallet",
                actor: "user" as const,
                valueMoving: true,
                sponsorship: "none" as const,
              },
            ]
          : []),
        ...approvalActions.map(() => ({
          kind: "evm_transaction" as const,
          safeLabel: "Approve Polymarket Funding Router",
          actor: delegatedPusdFund ? ("server" as const) : ("user" as const),
          valueMoving: false,
          sponsorship: delegatedPusdFund
            ? ("requested" as const)
            : sponsorship.payerRequirement === "privy_sponsor"
              ? ("requested" as const)
              : ("none" as const),
        })),
        {
          kind: "evm_transaction",
          safeLabel: "Fund Polymarket Deposit Wallet",
          actor: delegatedPusdFund ? "server" : "user",
          valueMoving: true,
          sponsorship:
            sponsorship.payerRequirement === "privy_sponsor"
              ? "requested"
              : "none",
        },
      ],
      expiresAt: facts.spendability.expiresAt,
      recommended: fullyFunded,
      selectable: fullyFunded,
      reasonCodes: fullyFunded ? [] : ["minimum_output_not_met"],
    };
    const commitPlan: PlannedSourceOption["commitPlan"] = {
      operation: {
        purpose: input.request.purpose,
        initialState: {
          status: "in_progress",
          stage: "committed",
        },
        experienceMode: "prepare_first",
        planKind: "venue_preparation",
        sourceSnapshot: jsonRecord(option),
        destinationTargetSnapshot: jsonRecord(input.destination.target),
        externalRecipientId: null,
        venueId: "polymarket",
        marketId: input.marketContext?.marketId ?? null,
        marketContextSnapshot: input.marketContext
          ? jsonRecord(input.marketContext)
          : null,
        venueBindingSnapshot: jsonRecord(facts.venueBinding),
        walletExecutionSnapshot: jsonRecord(
          safeUsdceContributionRaw > 0n && safeUsdceProfile !== profile
            ? { profiles: [profile, safeUsdceProfile] }
            : profile,
        ),
        placementSnapshot: jsonRecord(input.placement),
        requestedSourceAmount: delegatedPusdFund
          ? jsonRecord({
              asset: facts.option.requiredAsset,
              raw: plan.totalAmountRaw,
            })
          : null,
        requestedDestinationAmount: jsonRecord(plannedDestinationAmount),
        supportMetadata: {
          preparationKind: "polymarket_funding_router",
          adapterId: this.adapterId,
          planValidation: {
            validatorId: this.adapterId,
            version:
              safeUsdceContributionRaw > 0n && safeUsdceProfile !== profile
                ? 4
                : preRouteHandoffs.some(
                      ({ handoff }) =>
                        handoff.kind === "polymarket_safe_to_controller_v1",
                    )
                  ? 3
                  : 1,
          },
          venueBindingOptionId: facts.bindingOption.venueBindingOptionId,
          fundingPlan: jsonRecord(plan),
          ...(preRouteHandoffs.length
            ? {
                preRouteHandoffs: preRouteHandoffs.map(({ handoff }) =>
                  jsonRecord(handoff),
                ),
              }
            : {}),
          before: {
            routerNonceRaw: snapshot.routerNonceRaw,
            depositPusdRaw: snapshot.depositPusdRaw,
            clobPusdRaw: snapshot.clobPusdRaw,
            observedAt: snapshot.observedAt,
          },
        },
      },
      segments: [],
      steps: preRouteHandoffs.reduceRight<
        PlannedSourceOption["commitPlan"]["steps"]
      >(
        (steps, entry) =>
          buildPolymarketPreRouteHandoffSteps({
            source: { preRouteHandoff: entry.handoff },
            sourceAmount: entry.sourceAmount,
            profile: entry.profile,
            steps:
              entry.profile === profile
                ? steps
                : prependOwnedControllerTransfer({
                    owner: entry.profile,
                    recipient: profile,
                    amount: entry.sourceAmount,
                    quoteCorrelationId,
                    steps,
                  }),
          }),
        [
          ...approvalCommitSteps,
          {
            ordinal: approvalActions.length,
            segmentOrdinal: null,
            stepKind: "venue_preparation",
            state: delegatedPusdFund ? "planned" : "action_required",
            actionFingerprint: canonicalJsonHash(action),
            executorId: delegatedPusdFund
              ? input.request.serverExecutionProfileId
              : "wallet_profile_evm_v1",
            payerRequirement: sponsorship.payerRequirement,
            dependsOnOrdinal:
              approvalActions.length > 0 ? approvalActions.length - 1 : null,
            normalizedAction: jsonRecord(action),
            ...(delegatedPusdFund ? { actionExpiresAt: null } : {}),
            actionValidationResult: {
              ...buildPolymarketFundingActionValidation({
                destinationAssetId:
                  facts.venueBinding.settlementLocation.asset.assetId,
                plan,
                profileAddress: profile.address,
                routerAddress: snapshot.routerAddress,
                sponsorship,
              }),
            },
          },
        ],
      ),
      reservations: [
        ...(safeUsdceContributionRaw > 0n && safeUsdceProfile !== profile
          ? [
              {
                segmentOrdinal: null,
                ...stableWalletAssetLocationIdentity({
                  accountId: input.accountId,
                  address: safeUsdceProfile.address,
                  asset: usdceAsset,
                  balanceClass: "polymarket",
                }),
                networkId: usdceAsset.networkId,
                assetId: usdceAsset.assetId,
                assetDecimals: usdceAsset.decimals,
                rawAmount: safeUsdceContributionRaw.toString(),
                mode: "subtract_available" as const,
                economicRole: "future_credit_fence" as const,
                expiresAt: reservationExpiresAt,
              },
            ]
          : []),
        ...(safePusdContributionRaw > 0n
          ? [
              {
                segmentOrdinal: null,
                ...(controllerPusdInput
                  ? {
                      componentId: controllerPusdInput.component.componentId,
                      locationId:
                        controllerPusdInput.component.location.locationId,
                    }
                  : stableWalletAssetLocationIdentity({
                      accountId: input.accountId,
                      address: snapshot.signerAddress,
                      asset: facts.option.requiredAsset,
                      balanceClass: "polymarket",
                    })),
                networkId: facts.option.requiredAsset.networkId,
                assetId: facts.option.requiredAsset.assetId,
                assetDecimals: facts.option.requiredAsset.decimals,
                rawAmount: plannedPusdRaw.toString(),
                mode: "subtract_available" as const,
                expiresAt: reservationExpiresAt,
                ...(controllerPusdContributionRaw > 0n
                  ? {
                      economicRole: "source_input" as const,
                      sourceInputRawAmount:
                        controllerPusdContributionRaw.toString(),
                    }
                  : { economicRole: "future_credit_fence" as const }),
              },
            ]
          : []),
        ...resolvedInputs
          // The handoff credits controller USDC.e before Router consumes it.
          // The aggregate reservation below owns that identity, so avoid a
          // duplicate reservation for the pre-existing controller portion.
          .filter(
            (entry) =>
              (safePusdContributionRaw === 0n ||
                entry.resolved.component.componentId !==
                  controllerPusdInput?.component.componentId) &&
              (incomingUsdceRaw === 0n ||
                entry.resolved.component.componentId !==
                  controllerUsdceInput?.component.componentId),
          )
          .map((entry) => ({
            segmentOrdinal: null,
            componentId: entry.resolved.component.componentId,
            locationId: entry.resolved.component.location.locationId,
            networkId: entry.asset.networkId,
            assetId: entry.asset.assetId,
            assetDecimals: entry.asset.decimals,
            rawAmount: entry.rawAmount,
            mode: "subtract_available" as const,
            expiresAt: reservationExpiresAt,
          })),
        ...(incomingUsdceRaw > 0n
          ? [
              {
                segmentOrdinal: null,
                componentId: controllerUsdceIdentity.componentId,
                locationId: controllerUsdceIdentity.locationId,
                networkId: usdceAsset.networkId,
                assetId: usdceAsset.assetId,
                assetDecimals: usdceAsset.decimals,
                // Before the handoff this future USDC.e may not exist. Once it
                // lands, this exact controller identity stays fenced until the
                // Router consumes it. Economic reporting still counts only
                // the pre-existing controller USDC.e here; the incoming
                // amount is already represented by the Deposit Wallet source.
                rawAmount: plannedUsdceRaw.toString(),
                mode: "subtract_available" as const,
                expiresAt: reservationExpiresAt,
                ...(controllerUsdceContributionRaw > 0n
                  ? {
                      economicRole: "source_input" as const,
                      sourceInputRawAmount:
                        controllerUsdceContributionRaw.toString(),
                    }
                  : { economicRole: "future_credit_fence" as const }),
              },
            ]
          : []),
      ],
    };
    return {
      option,
      routeId: null,
      providerId: null,
      commitPlan,
      compositeEligible:
        !fullyFunded && commitPlanRunsWithoutUserWalletAction(commitPlan),
    };
  }
}
