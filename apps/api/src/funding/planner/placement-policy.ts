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

export type PlacementPolicyInput = Readonly<{
  intent: FundingIntent;
  target: FundingTarget;
  targetVenueId: VenueId | null;
  targetRequirement: Money;
  availableNow: Money;
  requestedBuffer?: Readonly<{
    amount: Money;
    estimatedUsd: string;
  }> | null;
  selectionReason: "explicit" | "single_valid_option" | "current_trade";
  policy: Pick<FundingRuntimePolicy, "automation" | "placement" | "version">;
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
      policyVersion: policy.version,
    };
  }

  if (intent.purpose === "trade_shortfall") {
    const requested = requiredMoney(
      intent.requestedDestinationAmount,
      "trade collateral",
    );
    assertSameAsset(requested.asset, targetRequirement.asset, "trade target");
    const shortfallRaw = subtractFloor(requested.raw, availableNow.raw);
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
    const destinationRequirement = money(
      requested.asset,
      rawAmount(shortfallRaw) + rawAmount(bufferRaw),
    );
    return {
      mode: "trade_shortfall_only",
      sourceAmount: intent.confirmedSourceAmount ?? destinationRequirement,
      destinationRequirement,
      targetVenueId: input.targetVenueId,
      target: input.target,
      boundedBuffer:
        rawAmount(bufferRaw) === 0n
          ? null
          : money(requested.asset, rawAmount(bufferRaw)),
      reason: "current_trade",
      policyVersion: policy.version,
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
      policyVersion: policy.version,
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
    policyVersion: policy.version,
  };
}
