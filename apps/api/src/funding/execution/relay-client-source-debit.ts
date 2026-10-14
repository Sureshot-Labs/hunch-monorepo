import { sameAsset, sameAccountAddress } from "../domain/asset-identity.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import type { JsonValue, Money, NormalizedAction } from "../domain/types.js";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";
import { RELAY_EVM_FUNDING_PROFILE_SPECS } from "./relay-evm-profile-specs.js";
import { RELAY_ROUTE_SPECS } from "../../funding-providers/relay/mappings.js";
import { Interface } from "ethers";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type RelayClientSourceDebitPostcondition = Readonly<{
  postconditionEvidenceKind: "exact_erc20_source_debit_v1";
  expectedSourceAssetId: string;
  expectedSourceAssetDecimals: number;
  expectedSourceAddress: string;
  expectedSourceRecipient: string;
  expectedSourceRaw: string;
}>;

const RELAY_EVM_ROUTE_SOURCE_ASSETS = new Map([
  ...Object.values(RELAY_EVM_FUNDING_PROFILE_SPECS).flatMap((profile) =>
    profile.routeIds.map((routeId) => [routeId, profile.sourceAsset] as const),
  ),
  // Receipt requirements do not grant delegated execution authority. Native
  // inbound routes use the ordinary user-controlled EVM executor, not a new
  // Telegram profile or allowance lane.
  ...Object.values(RELAY_ROUTE_SPECS)
    .filter(
      (spec) => spec.sourceVm === "evm" && spec.destinationVm === "hypercore",
    )
    .map((spec) => [spec.routeId, spec.source] as const),
]);
const ERC20_APPROVAL = new Interface([
  "function approve(address spender,uint256 amount)",
]);

function relayDepositRecipient(action: NormalizedAction): string | null {
  if (action.kind === "evm_transaction") {
    return action.actionId.endsWith(":deposit") ? action.to : null;
  }
  if (action.kind !== "evm_transaction_batch") return null;
  const deposits = action.calls.filter((call) =>
    call.actionId.endsWith(":deposit"),
  );
  return deposits.length === 1 ? (deposits[0]?.to ?? null) : null;
}

/**
 * Client-executed Relay routes use the same immutable provider action as the
 * delegated path, but do not pass through the delegated allowance lane that
 * records its source debit. Attach the exact receipt postcondition here so a
 * canonical client receipt can produce that durable debit evidence.
 */
export function withRelayClientSourceDebitPostcondition(
  input: Readonly<{
    action: NormalizedAction;
    actionValidationResult: JsonRecord;
    routeId: string | null | undefined;
    sourceAmount: Money | null | undefined;
  }>,
): JsonRecord {
  if (relayClientSourceDebitPostcondition(input.actionValidationResult)) {
    return input.actionValidationResult;
  }
  const routeSourceAsset = input.routeId
    ? RELAY_EVM_ROUTE_SOURCE_ASSETS.get(input.routeId)
    : null;
  const sourceAmount = input.sourceAmount;
  const signerAddress = input.actionValidationResult.signerAddress;
  const recipient = relayDepositRecipient(input.action);
  if (
    !routeSourceAsset ||
    !sourceAmount ||
    !isPositiveRawAmount(sourceAmount.raw) ||
    !sameAsset(routeSourceAsset, sourceAmount.asset) ||
    input.action.networkId !== sourceAmount.asset.networkId ||
    typeof signerAddress !== "string"
  ) {
    return input.actionValidationResult;
  }
  const nativeDestination =
    input.routeId &&
    RELAY_ROUTE_SPECS[input.routeId]?.destinationVm === "hypercore"
      ? RELAY_ROUTE_SPECS[input.routeId].destination.networkId
      : null;
  // A separate, exact approval only changes allowance. An atomic group that
  // also contains deposit must never inherit this non-money classification.
  if (
    nativeDestination &&
    input.action.kind === "evm_transaction" &&
    input.action.actionId.endsWith(":approve") &&
    input.actionValidationResult.relayStepKind === "approve" &&
    input.action.valueRaw === "0" &&
    sameAccountAddress(
      input.action.networkId,
      input.action.to,
      sourceAmount.asset.assetId,
    )
  ) {
    try {
      const approval = ERC20_APPROVAL.decodeFunctionData(
        "approve",
        input.action.data,
      );
      if (
        sameAccountAddress(
          input.action.networkId,
          approval[0],
          RELAY_DEPOSITORY_V2,
        ) &&
        approval[1] === BigInt(sourceAmount.raw) &&
        ERC20_APPROVAL.encodeFunctionData("approve", [
          approval[0],
          approval[1],
        ]).toLowerCase() === input.action.data.toLowerCase()
      ) {
        return {
          ...input.actionValidationResult,
          relayNativeDestination: nativeDestination,
          relayNativeApproval: "exact_erc20_approval_v1",
        };
      }
    } catch {
      /* An unrecognised action retains its conservative classification. */
    }
  }
  if (
    !recipient ||
    !sameAccountAddress(input.action.networkId, recipient, RELAY_DEPOSITORY_V2)
  ) {
    return input.actionValidationResult;
  }
  return {
    ...input.actionValidationResult,
    ...(nativeDestination ? { relayNativeDestination: nativeDestination } : {}),
    postconditionEvidenceKind: "exact_erc20_source_debit_v1",
    expectedSourceAssetId: sourceAmount.asset.assetId,
    expectedSourceAssetDecimals: sourceAmount.asset.decimals,
    expectedSourceAddress: signerAddress,
    expectedSourceRecipient: recipient,
    expectedSourceRaw: sourceAmount.raw,
  };
}

export function relayClientSourceDebitPostcondition(
  validation: JsonRecord,
): RelayClientSourceDebitPostcondition | null {
  const decimals = validation.expectedSourceAssetDecimals;
  if (
    validation.postconditionEvidenceKind !== "exact_erc20_source_debit_v1" ||
    typeof validation.expectedSourceAssetId !== "string" ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    typeof validation.expectedSourceAddress !== "string" ||
    typeof validation.expectedSourceRecipient !== "string" ||
    !isPositiveRawAmount(validation.expectedSourceRaw)
  ) {
    return null;
  }
  return {
    postconditionEvidenceKind: "exact_erc20_source_debit_v1",
    expectedSourceAssetId: validation.expectedSourceAssetId,
    expectedSourceAssetDecimals: decimals,
    expectedSourceAddress: validation.expectedSourceAddress,
    expectedSourceRecipient: validation.expectedSourceRecipient,
    expectedSourceRaw: validation.expectedSourceRaw,
  };
}
