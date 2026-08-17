import type {
  FundingIntent,
  FundingTarget,
  Money,
  PlacementDecision,
  VenueId,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import { compareUnsignedDecimals } from "../../account-value/decimal.js";
import {
  FundingPlannerError,
  assertSameAsset,
  money,
  multiplyBpsCeil,
  rawAmount,
  subtractFloor,
} from "./money.js";

export const MINIMUM_AUTOMATIC_TRADE_REFILL_USD = "0.5";

export function minimumAutomaticTradeRefillUsd(
  policy: Pick<FundingRuntimePolicy, "placement">,
): string {
  return compareUnsignedDecimals(
    policy.placement.minimumDestinationUsd,
    MINIMUM_AUTOMATIC_TRADE_REFILL_USD,
  ) >= 0
    ? policy.placement.minimumDestinationUsd
    : MINIMUM_AUTOMATIC_TRADE_REFILL_USD;
}

export type PlacementPolicyInput = Readonly<{
  intent: FundingIntent;
  target: FundingTarget;
  targetVenueId: VenueId | null;
  targetRequirement: Money;
  availableNow: Money;
  minimumExecutableDestination?: Money | null;
  requestedBuffer?: Readonly<{
    amount: Money;
    estimatedUsd: string;
  }> | null;
  selectionReason: "explicit" | "single_valid_option" | "current_trade";
  policy: Pick<
    FundingRuntimePolicy,
    "automation" | "contractVersion" | "placement"
  >;
}>;

function requiredMoney(value: Money | null, label: string): Money {
  if (!value || rawAmount(value.raw, label) === 0n) {
    throw new FundingPlannerError(
      "invalid_amount",
      `${label} must be a positive exact amount`,
    );
  }
  return value;
}

/**
 * Pure placement boundary. It cannot quote, reserve, prepare a wallet, persist a
 * preference, or execute an action.
 */
export function decidePlacement(
  input: PlacementPolicyInput,
): PlacementDecision {
  const { intent, policy, targetRequirement, availableNow } = input;
  assertSameAsset(
    targetRequirement.asset,
    availableNow.asset,
    "target requirement and available cash",
  );

  if (intent.purpose === "manual_rebalance") {
    if (!policy.automation.automaticRebalance) {
      throw new FundingPlannerError(
        "manual_rebalance_forbidden",
        "automatic and planner-driven rebalance are disabled",
      );
    }
    throw new FundingPlannerError(
      "manual_rebalance_forbidden",
      "manual rebalance has no route in the initial funding policy",
    );
  }

  if (intent.purpose === "add_funds") {
    const destinationRequirement = requiredMoney(
      intent.requestedDestinationAmount,
      "add-funds destination amount",
    );
    assertSameAsset(
      destinationRequirement.asset,
      targetRequirement.asset,
      "add-funds destination",
    );
    const sourceAmount = intent.confirmedSourceAmount ?? destinationRequirement;
    return {
      mode: "confirmed_deposit_amount",
      sourceAmount,
      destinationRequirement,
      targetVenueId: input.targetVenueId,
      target: input.target,
      boundedBuffer: null,
      reason: input.selectionReason,
      policyVersion: policy.contractVersion,
    };
  }

  if (intent.purpose === "trade_shortfall") {
    const requested = requiredMoney(
      intent.requestedDestinationAmount,
      "trade collateral",
    );
    assertSameAsset(requested.asset, targetRequirement.asset, "trade target");
    const serverAdditionalDestination =
      intent.serverAdditionalDestinationAmount ?? null;
    if (serverAdditionalDestination) {
      assertSameAsset(
        serverAdditionalDestination.asset,
        requested.asset,
        "server-confirmed trade shortfall",
      );
      if (
        rawAmount(serverAdditionalDestination.raw) > rawAmount(requested.raw)
      ) {
        throw new FundingPlannerError(
          "invalid_amount",
          "server-confirmed trade shortfall exceeds the trade collateral",
        );
      }
    }
    const shortfallRaw = serverAdditionalDestination
      ? serverAdditionalDestination.raw
      : subtractFloor(requested.raw, availableNow.raw);
    const minimumExecutableDestination = input.minimumExecutableDestination;
    if (minimumExecutableDestination) {
      assertSameAsset(
        minimumExecutableDestination.asset,
        requested.asset,
        "minimum executable trade destination",
      );
    }
    const maximumBufferRaw = multiplyBpsCeil(
      shortfallRaw,
      policy.placement.maximumBufferBps,
    );
    const requestedBuffer = input.requestedBuffer;
    const bufferRaw = requestedBuffer?.amount.raw ?? "0";
    if (requestedBuffer) {
      assertSameAsset(
        requestedBuffer.amount.asset,
        requested.asset,
        "trade shortfall buffer",
      );
    }
    let exceedsUsdCap = false;
    try {
      exceedsUsdCap =
        rawAmount(bufferRaw) > 0n &&
        compareUnsignedDecimals(
          requestedBuffer?.estimatedUsd ?? "0",
          policy.placement.maximumBufferUsd,
        ) > 0;
    } catch {
      throw new FundingPlannerError(
        "invalid_policy",
        "trade shortfall buffer lacks a valid USD estimate",
      );
    }
    if (rawAmount(bufferRaw) > rawAmount(maximumBufferRaw) || exceedsUsdCap) {
      throw new FundingPlannerError(
        "invalid_policy",
        "trade shortfall buffer exceeds the raw or USD policy cap",
      );
    }
    const explicitlyBufferedRaw =
      rawAmount(shortfallRaw) + rawAmount(bufferRaw);
    const minimumRefillRaw =
      rawAmount(shortfallRaw) === 0n
        ? 0n
        : rawAmount(minimumExecutableDestination?.raw ?? "0") >
            rawAmount(requested.raw)
          ? rawAmount(requested.raw)
          : rawAmount(minimumExecutableDestination?.raw ?? "0");
    const destinationRequirementRaw =
      explicitlyBufferedRaw > minimumRefillRaw
        ? explicitlyBufferedRaw
        : minimumRefillRaw;
    const destinationRequirement = money(
      requested.asset,
      destinationRequirementRaw,
    );
    const boundedBufferRaw =
      destinationRequirementRaw > rawAmount(shortfallRaw)
        ? destinationRequirementRaw - rawAmount(shortfallRaw)
        : 0n;
    return {
      mode: "trade_shortfall_only",
      sourceAmount: intent.confirmedSourceAmount ?? destinationRequirement,
      destinationRequirement,
      targetVenueId: input.targetVenueId,
      target: input.target,
      boundedBuffer:
        boundedBufferRaw === 0n
          ? null
          : money(requested.asset, boundedBufferRaw),
      reason: "current_trade",
      policyVersion: policy.contractVersion,
    };
  }

  if (intent.purpose === "convert_asset") {
    const sourceAmount = requiredMoney(
      intent.confirmedSourceAmount,
      "conversion source amount",
    );
    const destinationRequirement = requiredMoney(
      intent.requestedDestinationAmount,
      "conversion destination amount",
    );
    assertSameAsset(
      destinationRequirement.asset,
      targetRequirement.asset,
      "conversion target",
    );
    return {
      mode: "confirmed_conversion_amount",
      sourceAmount,
      destinationRequirement,
      targetVenueId: input.targetVenueId,
      target: input.target,
      boundedBuffer: null,
      reason: input.selectionReason,
      policyVersion: policy.contractVersion,
    };
  }

  const destinationRequirement = requiredMoney(
    intent.requestedDestinationAmount,
    "withdrawal amount",
  );
  const sourceAmount = intent.confirmedSourceAmount ?? destinationRequirement;
  return {
    mode: "confirmed_withdrawal_amount",
    sourceAmount,
    destinationRequirement,
    targetVenueId: null,
    target: input.target,
    boundedBuffer: null,
    reason: "explicit",
    policyVersion: policy.contractVersion,
  };
}
