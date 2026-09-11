import { scaleUnsignedDecimalByRawRatio } from "../../account-value/decimal.js";
import { withdrawalRawAvailabilityKnown } from "../domain/withdrawal-capacity.js";
import { FundingPlannerError } from "./money.js";
import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import {
  stableOpaqueId,
  stableWalletAssetLocationIdentity,
} from "../../account-value/canonical.js";
import type { Pool, PoolClient } from "@hunch/infra";
import { WithdrawalDestinationRuntime } from "../execution/withdrawal-destination-runtime.js";
import { buildPolymarketPreRouteHandoffSteps } from "../../funding-providers/relay/operation-plan.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../domain/network-fees.js";
import type {
  JsonValue,
  SourceOption,
  ResolvedExternalRecipient,
} from "../domain/types.js";
import { inspectSolanaWithdrawalCost } from "../execution/solana-withdrawal-cost.js";
import { DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY } from "../execution/direct-solana-sponsorship-policy.js";
import { solanaSponsorBudgetAvailable } from "../execution/solana-sponsor-budget.js";
import { getRedis } from "../../redis.js";
import { relaySolanaSponsorshipEnabled } from "../../funding-providers/relay/solana-sponsorship.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import {
  buildExactErc20WithdrawalAction,
  DIRECT_WITHDRAWAL_ADAPTER_ID,
  DIRECT_WITHDRAWAL_PROVIDER_ID,
  DIRECT_WITHDRAWAL_ROUTE_ID,
} from "../execution/direct-withdrawal-transfer.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  FundingCommitPlan,
  FundingCommitStep,
} from "../persistence/funding-operation-repository.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import type { PlannedSourceOption } from "./planning-types.js";
import {
  productionFundingProfileHasNativeGas,
  resolveProductionOwnedSourceExecution,
} from "./production-source-planner.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function nativeSolComponents(account: AccountValueReadModel, address: string) {
  return account.projection.components.filter(
    (row) =>
      sameAsset(row.amount.asset, SOLANA_NATIVE_ASSET) &&
      row.category !== "in_transit" &&
      row.observationFreshness === "fresh" &&
      !row.observationError &&
      row.location.details.address === address,
  );
}

function exactAvailableComponent(
  account: AccountValueReadModel,
  input: FundingSourcePlanningInput,
) {
  const availableByComponent = new Map(
    account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  return account.projection.components.flatMap((component) => {
    const available = availableByComponent.get(component.componentId);
    const execution = resolveProductionOwnedSourceExecution({
      account,
      component,
      allowDepositWalletUsdceHandoff: true,
    });
    const availableRaw =
      available && isPositiveRawAmount(available.availableRaw)
        ? BigInt(available.availableRaw)
        : 0n;
    const withdrawableRaw = availableRaw.toString();
    if (
      component.location.accountId !== input.accountId ||
      (input.request.withdrawalSourceComponentId != null &&
        component.componentId !== input.request.withdrawalSourceComponentId) ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !sameAsset(component.amount.asset, input.requiredAmount.asset) ||
      !available ||
      !withdrawalRawAvailabilityKnown(available) ||
      !isPositiveRawAmount(available.availableRaw) ||
      BigInt(withdrawableRaw) < BigInt(input.requiredAmount.raw) ||
      !execution ||
      (!execution.profile.signingModes.includes("web_client") &&
        !execution.profile.signingModes.includes("privy_authorization"))
    ) {
      return [];
    }
    return [{ component, available, execution, withdrawableRaw }];
  });
}

/**
 * Same-asset withdrawals are not provider quotes. They are exact ERC-20 or
 * native-SOL transfers from an owned executable wallet. A Polymarket Deposit
 * Wallet adds the existing exact relayer handoff to its controller first.
 */
export class DirectWithdrawalSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = DIRECT_WITHDRAWAL_ADAPTER_ID;

  constructor(
    private readonly account: AccountValueReadModel,
    private readonly dependencies: {
      inspectCost?: typeof inspectSolanaWithdrawalCost;
      sponsorBudgetAvailable?: (userId: string) => Promise<boolean>;
    } = {},
  ) {}

  async capacity(
    componentId: string,
    recipient: Pick<
      ResolvedExternalRecipient,
      "address" | "addressFingerprint" | "asset"
    >,
    options: {
      requestedRaw?: bigint;
      normalizeAmount?: boolean;
      ownReservedRaw?: bigint;
      ownReservedSolRaw?: bigint;
      frozenPayer?: string;
    } = {},
  ) {
    const {
      requestedRaw,
      ownReservedRaw = 0n,
      ownReservedSolRaw = 0n,
      frozenPayer,
    } = options;
    const component = this.account.projection.components.find(
      (row) => row.componentId === componentId,
    );
    const available = this.account.cashAvailability.components.find(
      (row) => row.componentId === componentId,
    );
    const execution =
      component &&
      resolveProductionOwnedSourceExecution({
        account: this.account,
        component,
      });
    if (
      !component ||
      !available ||
      !execution ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !withdrawalRawAvailabilityKnown(available) ||
      !sameAsset(component.amount.asset, recipient.asset)
    )
      throw new FundingPlannerError(
        "source_not_selected",
        "Withdrawal source unavailable: refresh the selected balance",
      );
    if (recipient.asset.networkId !== "solana:mainnet")
      throw new Error("Withdrawal capacity currently supports Solana assets");
    const solIds = new Set(
      nativeSolComponents(this.account, execution.profile.address).map(
        (row) => row.componentId,
      ),
    );
    if (solIds.size > 1) throw new Error("Withdrawal gas balance is ambiguous");
    const availableSolRaw =
      this.account.cashAvailability.components
        .filter(
          (row) =>
            solIds.has(row.componentId) && withdrawalRawAvailabilityKnown(row),
        )
        .reduce((sum, row) => sum + BigInt(row.availableRaw), 0n) +
      (sameAsset(recipient.asset, SOLANA_NATIVE_ASSET)
        ? ownReservedRaw
        : ownReservedSolRaw);
    const profile = execution.profile;
    return (this.dependencies.inspectCost ?? inspectSolanaWithdrawalCost)({
      profile,
      recipient,
      asset: recipient.asset,
      availableRaw: BigInt(available.availableRaw) + ownReservedRaw,
      availableSolRaw,
      requestedRaw,
      normalizeAmount: options.normalizeAmount,
      sponsorEligible:
        frozenPayer !== "user" &&
        relaySolanaSponsorshipEnabled() &&
        profile.source !== "external" &&
        !!profile.serverWalletRef &&
        profile.signingModes.includes("privy_authorization") &&
        (await (
          this.dependencies.sponsorBudgetAvailable ??
          (async (userId) =>
            solanaSponsorBudgetAvailable(await getRedis(), userId))
        )(component.location.accountId)),
    });
  }

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    if (
      input.request.purpose !== "withdrawal" ||
      input.destination.target.kind !== "external_recipient" ||
      !input.destination.externalRecipientId ||
      !input.destination.recipientAddress ||
      (!input.requiredAmount.asset.networkId.startsWith("evm:") &&
        !sameAsset(input.requiredAmount.asset, SOLANA_NATIVE_ASSET) &&
        !(
          input.requiredAmount.asset.networkId === "solana:mainnet" &&
          input.requiredAmount.asset.assetId === RELAY_PINNED_ASSETS.solanaUsdc
        )) ||
      !isPositiveRawAmount(input.requiredAmount.raw)
    ) {
      return [];
    }
    const selectionExpiresAt = new Date(
      Math.min(
        input.now.getTime() + input.policy.ttl.quoteMs,
        Date.parse(input.destination.target.recipient.expiresAt),
      ),
    ).toISOString();
    // This adapter has no provider quote. The short quote TTL only fences
    // source selection and commit. Once committed, the immutable exact-amount
    // transfer must remain executable after an optional Deposit Wallet ->
    // controller handoff; persistence still caps every action at 15 minutes.
    const executionExpiresAt = new Date(
      Date.parse(input.destination.target.recipient.expiresAt),
    ).toISOString();
    const planned = await Promise.all(
      exactAvailableComponent(this.account, input).map(
        async ({
          component,
          execution,
          withdrawableRaw,
        }): Promise<PlannedSourceOption[]> => {
          const hasDepositWalletHandoff = execution.preRouteHandoff != null;
          const existingControllerComponent = hasDepositWalletHandoff
            ? this.account.projection.components.find((candidate) => {
                const address = candidate.location.details.address;
                return (
                  candidate.location.kind === "wallet" &&
                  typeof address === "string" &&
                  sameAsset(
                    candidate.amount.asset,
                    input.requiredAmount.asset,
                  ) &&
                  sameAccountAddress(
                    input.requiredAmount.asset.networkId,
                    address,
                    execution.profile.address,
                  )
                );
              })
            : null;
          const controllerCreditIdentity = hasDepositWalletHandoff
            ? existingControllerComponent
              ? {
                  componentId: existingControllerComponent.componentId,
                  locationId: existingControllerComponent.location.locationId,
                }
              : stableWalletAssetLocationIdentity({
                  accountId: input.accountId,
                  address: execution.profile.address,
                  asset: input.requiredAmount.asset,
                  balanceClass: "polymarket",
                })
            : null;
          const actionInput = {
            amount: input.requiredAmount,
            profile: execution.profile,
            recipient: {
              address: input.destination.recipientAddress as string,
              addressFingerprint:
                input.destination.target.kind === "external_recipient"
                  ? input.destination.target.recipient.addressFingerprint
                  : "",
            },
          };
          const cost =
            input.requiredAmount.asset.networkId === "solana:mainnet"
              ? await this.capacity(
                  component.componentId,
                  {
                    ...actionInput.recipient,
                    asset: input.requiredAmount.asset,
                  },
                  { requestedRaw: BigInt(input.requiredAmount.raw) },
                )
              : null;
          if (cost && !cost.built) return [];
          const built =
            cost?.built ?? buildExactErc20WithdrawalAction(actionInput);
          if (cost) withdrawableRaw = cost.maximumSourceRaw.toString();
          const sponsorship =
            cost?.payer === "privy_sponsor"
              ? {
                  payerRequirement: "privy_sponsor" as const,
                  policyId: DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY,
                  signingMode: "privy_authorization" as const,
                }
              : resolveActionSponsorship({
                  action: built.action,
                  profile: execution.profile,
                });
          if (
            !cost &&
            sponsorship.payerRequirement === "user" &&
            !productionFundingProfileHasNativeGas(
              this.account,
              execution.profile,
            )
          ) {
            return [];
          }
          const transferStep: FundingCommitStep = {
            ordinal: 0,
            segmentOrdinal: 0,
            stepKind: "transaction",
            state: "action_required",
            actionFingerprint: canonicalJsonHash(built.action),
            executorId:
              built.action.kind === "svm_transaction"
                ? "wallet_profile_svm_v1"
                : "wallet_profile_evm_v1",
            payerRequirement: sponsorship.payerRequirement,
            dependsOnOrdinal: null,
            normalizedAction: jsonRecord(built.action),
            actionValidationResult: jsonRecord({
              ...built.validation,
              sponsorshipPolicyId: sponsorship.policyId,
              signingMode: sponsorship.signingMode,
              ...(cost
                ? { withdrawalUserSolCostRaw: cost.userSolCostRaw.toString() }
                : {}),
            }),
            actionExpiresAt: executionExpiresAt,
          };
          const steps = buildPolymarketPreRouteHandoffSteps({
            source: { preRouteHandoff: execution.preRouteHandoff },
            sourceAmount: input.requiredAmount,
            profile: execution.profile,
            steps: [transferStep],
          });
          const source = {
            kind: "owned_location" as const,
            location: execution.executionLocation,
          };
          const estimatedUsd =
            component.estimatedUsd && BigInt(component.amount.raw) > 0n
              ? scaleUnsignedDecimalByRawRatio({
                  value: component.estimatedUsd.value,
                  numeratorRaw: input.requiredAmount.raw,
                  denominatorRaw: component.amount.raw,
                })
              : null;
          const option: SourceOption = {
            sourceOptionId: stableOpaqueId(
              "source_option",
              canonicalJsonHash({
                adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
                componentId: component.componentId,
                recipientId: input.destination.externalRecipientId,
                amount: input.requiredAmount,
              }),
            ),
            kind:
              component.location.kind === "venue_account"
                ? "venue_cash"
                : "wallet_asset",
            safeLabel:
              execution.safeLabel ??
              (execution.profile.source === "external"
                ? "Connected wallet"
                : "Hunch wallet"),
            source,
            amountMode: "exact_output",
            quotedSourceAmount: input.requiredAmount,
            maximumSourceRaw: withdrawableRaw,
            expectedDestination: input.requiredAmount,
            minimumDestination: input.requiredAmount,
            estimatedUsd,
            fees: cost
              ? [
                  ...(cost.payer === "user"
                    ? [
                        {
                          kind: "network",
                          amount: {
                            asset: SOLANA_NATIVE_ASSET,
                            raw: cost.networkFeeRaw.toString(),
                          },
                          estimatedUsd: null,
                        },
                      ]
                    : []),
                  ...(cost.accountRentRaw > 0n
                    ? [
                        {
                          kind: "account_rent",
                          amount: {
                            asset: SOLANA_NATIVE_ASSET,
                            raw: cost.accountRentRaw.toString(),
                          },
                          estimatedUsd: null,
                        },
                      ]
                    : []),
                ]
              : [],
            eta: null,
            experienceMode: "prepare_first",
            requiredActions: steps.map((step) => ({
              kind:
                step.stepKind === "external_handoff"
                  ? ("external_handoff" as const)
                  : built.action.kind,
              safeLabel:
                step.stepKind === "external_handoff"
                  ? "Move Polymarket funds to your controller wallet"
                  : "Send funds to the withdrawal address",
              actor: "user" as const,
              valueMoving: true,
              sponsorship:
                step.payerRequirement === "privy_sponsor"
                  ? ("requested" as const)
                  : ("none" as const),
            })),
            expiresAt: selectionExpiresAt,
            recommended: false,
            selectable: true,
            reasonCodes: [],
          };
          const plan: FundingCommitPlan = {
            operation: {
              purpose: "withdrawal",
              initialState: { status: "in_progress", stage: "committed" },
              experienceMode: "prepare_first",
              planKind: "wallet_route",
              sourceSnapshot: jsonRecord(option),
              destinationTargetSnapshot: jsonRecord(input.destination.target),
              externalRecipientId: input.destination.externalRecipientId,
              venueId: null,
              marketId: null,
              marketContextSnapshot: null,
              venueBindingSnapshot: null,
              walletExecutionSnapshot: jsonRecord(execution.profile),
              placementSnapshot: jsonRecord(input.placement),
              requestedSourceAmount: jsonRecord(input.requiredAmount),
              requestedDestinationAmount: jsonRecord(input.requiredAmount),
              supportMetadata: {
                adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
                routeId: DIRECT_WITHDRAWAL_ROUTE_ID,
                withdrawalExecutionKind: "exact_same_asset_transfer",
                sourceComponentId: component.componentId,
                sourceLocationId: component.location.locationId,
                executionWalletId: execution.profile.walletId,
                ...(cost
                  ? {
                      withdrawalPayer: cost.payer,
                      withdrawalUserSolCostRaw: cost.userSolCostRaw.toString(),
                      withdrawalActionFingerprint: canonicalJsonHash(
                        built.action,
                      ),
                    }
                  : {}),
                ...(execution.preRouteHandoff
                  ? { preRouteHandoff: jsonRecord(execution.preRouteHandoff) }
                  : {}),
              },
            },
            segments: [
              {
                providerId: DIRECT_WITHDRAWAL_PROVIDER_ID,
                adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
                adapterVersion: 1,
                // `same_network_swap` is the persisted v1 name for an exact
                // same-network asset movement; this adapter performs no swap.
                segmentKind: "same_network_swap",
                status: "planned",
                sourceSnapshot: jsonRecord(source),
                destinationTargetSnapshot: jsonRecord(input.destination.target),
                quotedInput: jsonRecord(input.requiredAmount),
                quotedExpectedOutput: jsonRecord(input.requiredAmount),
                quotedMinOutput: jsonRecord(input.requiredAmount),
                providerQuoteRefCiphertext: null,
                providerQuoteRefLookupHmac: null,
                depositAddressCiphertext: null,
                depositAddressLookupHmac: null,
                lookupKeyVersion: 1,
                refundLocationSnapshot: jsonRecord(execution.executionLocation),
                quoteExpiresAt: executionExpiresAt,
                supportMetadata: {
                  executionKind:
                    built.action.kind === "svm_transaction"
                      ? "exact_sol_transfer"
                      : "exact_erc20_transfer",
                },
              },
            ],
            steps,
            reservations: [
              {
                segmentOrdinal: 0,
                componentId: component.componentId,
                locationId: component.location.locationId,
                networkId: input.requiredAmount.asset.networkId,
                assetId: input.requiredAmount.asset.assetId,
                assetDecimals: input.requiredAmount.asset.decimals,
                rawAmount: (
                  BigInt(input.requiredAmount.raw) +
                  (cost &&
                  sameAsset(input.requiredAmount.asset, SOLANA_NATIVE_ASSET)
                    ? cost.userSolCostRaw
                    : 0n)
                ).toString(),
                mode: "subtract_available",
                expiresAt: executionExpiresAt,
              },
              ...(cost &&
              cost.userSolCostRaw > 0n &&
              !sameAsset(input.requiredAmount.asset, SOLANA_NATIVE_ASSET)
                ? nativeSolComponents(
                    this.account,
                    execution.profile.address,
                  ).map((row) => ({
                    segmentOrdinal: 0,
                    componentId: row.componentId,
                    locationId: row.location.locationId,
                    networkId: SOLANA_NATIVE_ASSET.networkId,
                    assetId: SOLANA_NATIVE_ASSET.assetId,
                    assetDecimals: 9,
                    rawAmount: cost.userSolCostRaw.toString(),
                    mode: "subtract_available" as const,
                    expiresAt: executionExpiresAt,
                  }))
                : []),
              ...(controllerCreditIdentity
                ? [
                    {
                      segmentOrdinal: null,
                      componentId: controllerCreditIdentity.componentId,
                      locationId: controllerCreditIdentity.locationId,
                      networkId: input.requiredAmount.asset.networkId,
                      assetId: input.requiredAmount.asset.assetId,
                      assetDecimals: input.requiredAmount.asset.decimals,
                      rawAmount: input.requiredAmount.raw,
                      mode: "subtract_available" as const,
                      expiresAt: executionExpiresAt,
                      // The exact handoff creates this same-asset controller
                      // balance after commit. Fence it without counting it as a
                      // second economic source for the withdrawal.
                      economicRole: "future_credit_fence" as const,
                    },
                  ]
                : []),
            ],
          };
          return [
            {
              option,
              commitPlan: plan,
              routeId: DIRECT_WITHDRAWAL_ROUTE_ID,
              providerId: DIRECT_WITHDRAWAL_PROVIDER_ID,
              compositeEligible: false,
            },
          ];
        },
      ),
    );
    return planned.flat();
  }

  async verifyCommit(
    _client: PoolClient,
    input: Readonly<{
      userId: string;
      operation: FundingCommitPlan["operation"];
    }>,
  ): Promise<void> {
    if (
      input.operation.supportMetadata?.adapterId !==
      DIRECT_WITHDRAWAL_ADAPTER_ID
    ) {
      return;
    }
    const amount = input.operation.requestedSourceAmount as Readonly<{
      asset?: Readonly<{
        networkId?: unknown;
        assetId?: unknown;
        decimals?: unknown;
      }>;
      raw?: unknown;
    }> | null;
    const componentId = input.operation.supportMetadata.sourceComponentId;
    const sourceLocationId = input.operation.supportMetadata.sourceLocationId;
    const executionWalletId = input.operation.supportMetadata.executionWalletId;
    if (
      input.operation.purpose !== "withdrawal" ||
      typeof componentId !== "string" ||
      typeof sourceLocationId !== "string" ||
      typeof executionWalletId !== "string" ||
      typeof amount?.asset?.networkId !== "string" ||
      typeof amount.asset.assetId !== "string" ||
      typeof amount.asset.decimals !== "number" ||
      !isPositiveRawAmount(amount.raw)
    ) {
      throw new Error("direct withdrawal frozen source is invalid");
    }
    const frozenAsset = {
      networkId: amount.asset.networkId,
      assetId: amount.asset.assetId,
      decimals: amount.asset.decimals,
    };
    const frozenRaw = amount.raw;
    const component = this.account.projection.components.find(
      (candidate) =>
        candidate.componentId === componentId &&
        candidate.location.locationId === sourceLocationId &&
        candidate.location.accountId === input.userId &&
        sameAsset(candidate.amount.asset, frozenAsset),
    );
    const available = this.account.cashAvailability.components.find(
      (candidate) => candidate.componentId === componentId,
    );
    const execution = component
      ? resolveProductionOwnedSourceExecution({
          account: this.account,
          component,
          allowDepositWalletUsdceHandoff: true,
        })
      : null;
    if (
      !component ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !available ||
      !withdrawalRawAvailabilityKnown(available) ||
      !isPositiveRawAmount(available.availableRaw) ||
      BigInt(available.availableRaw) < BigInt(frozenRaw) ||
      execution?.profile.walletId !== executionWalletId
    ) {
      throw new Error("direct withdrawal source is no longer available");
    }
    if (frozenAsset.networkId === "solana:mainnet") {
      if (!input.operation.externalRecipientId)
        throw new Error("Withdrawal recipient missing");
      const recipient = await new WithdrawalDestinationRuntime(
        _client as unknown as Pool,
      ).resolve(input.userId, input.operation.externalRecipientId);
      const metadata = input.operation.supportMetadata;
      const cost = await this.capacity(componentId, recipient, {
        requestedRaw: BigInt(frozenRaw),
        frozenPayer:
          typeof metadata.withdrawalPayer === "string"
            ? metadata.withdrawalPayer
            : undefined,
      });
      if (
        !cost.built ||
        cost.payer !== metadata.withdrawalPayer ||
        cost.userSolCostRaw.toString() !== metadata.withdrawalUserSolCostRaw ||
        canonicalJsonHash(cost.built.action) !==
          metadata.withdrawalActionFingerprint
      )
        throw new Error(
          "Withdrawal costs changed; review the withdrawal again",
        );
    }
  }
}
