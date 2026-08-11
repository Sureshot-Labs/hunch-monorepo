import { ethers } from "ethers";

import {
  buildPolymarketFundingPlan,
  decodePolymarketFundingCalldata,
  type PolymarketFundingPlan,
} from "../../services/polymarket-funding-router.js";
import type {
  FundingReasonCode,
  NormalizedAction,
  VenueAccountBinding,
} from "../domain/types.js";
import type { ResolvedActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { PreparationContractError } from "./core-adapter.js";
import type { PolymarketRouterFundingSnapshot } from "./polymarket-funding-snapshot.js";

export type PolymarketFundingObservation = Readonly<{
  clobPusdRaw: string | null;
  depositPusdRaw: string | null;
  observedAt: string;
  routerNonceRaw: string | null;
}>;

export type PolymarketFundingReceiptState =
  | "ambiguous"
  | "pending"
  | "reverted"
  | "success"
  | "unobserved";

export type PolymarketFundingPostconditionResult = Readonly<{
  status: "failed" | "reconcile_required" | "satisfied" | "unavailable";
  reasonCodes: readonly FundingReasonCode[];
  checks: Readonly<{
    clobVisible: boolean;
    exactPusdAttributed: boolean;
    nonceAdvanced: boolean;
    receiptSucceeded: boolean;
    targetBalanceObserved: boolean;
  }>;
  expectedDepositPusdRaw: string | null;
}>;

export function buildExactPolymarketDepositUsdceWrapPlan(input: {
  receiptRaw: string;
  snapshot: PolymarketRouterFundingSnapshot;
}): PolymarketFundingPlan | null {
  const receiptRaw = BigInt(input.receiptRaw);
  if (receiptRaw <= 0n) return null;
  const depositPusdRaw = BigInt(input.snapshot.depositPusdRaw);
  const depositLockedRaw = BigInt(input.snapshot.depositLockedRaw);
  const depositAvailableRaw =
    depositPusdRaw > depositLockedRaw ? depositPusdRaw - depositLockedRaw : 0n;
  const plan = buildPolymarketFundingPlan({
    signer: input.snapshot.signerAddress,
    depositWallet: input.snapshot.depositWallet,
    routerAddress: input.snapshot.routerAddress,
    routerNonce: BigInt(input.snapshot.routerNonceRaw),
    requiredRaw: depositAvailableRaw + receiptRaw,
    depositPusdRaw,
    depositLockedRaw,
    depositUsdceRaw: receiptRaw,
    depositRouterUsdceAllowanceRaw: BigInt(
      input.snapshot.depositRouterUsdceAllowanceRaw,
    ),
    signerPusdRaw: 0n,
    signerLockedRaw: 0n,
    signerUsdceRaw: 0n,
    routerPusdAllowanceRaw: 0n,
    routerUsdceAllowanceRaw: 0n,
    fundingCapRaw: receiptRaw,
  });
  return plan?.totalAmountRaw === input.receiptRaw &&
    plan.depositUsdceAmountRaw === input.receiptRaw &&
    plan.pUsdAmountRaw === "0" &&
    plan.signerUsdceAmountRaw === "0"
    ? plan
    : null;
}

export function buildPolymarketFundingActionValidation(input: {
  destinationAssetId: string;
  plan: PolymarketFundingPlan;
  profileAddress: string;
  routerAddress: string;
  sponsorship: ResolvedActionSponsorship;
}) {
  return {
    valid: true as const,
    signerAddress: input.profileAddress,
    canonicalRouterAddress: input.routerAddress,
    expectedNonceRaw: input.plan.routerNonce,
    expectedTotalAmountRaw: input.plan.totalAmountRaw,
    postconditionEvidenceKind: "exact_erc20_destination_credit_v1",
    expectedDestinationAssetId: input.destinationAssetId,
    expectedDestinationAddress: input.plan.depositWallet,
    expectedDestinationRaw: input.plan.totalAmountRaw,
    fundingPlanHash: canonicalJsonHash(input.plan),
    sponsorshipPolicyId: input.sponsorship.policyId,
    signingMode: input.sponsorship.signingMode,
  };
}

function raw(value: string | null | undefined): bigint | null {
  return value != null && /^(0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : null;
}

function normalizedAddress(value: string): string {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    throw new PreparationContractError(
      "evidence_invalid",
      "Polymarket Funding Router plan contains an invalid address",
    );
  }
}

function validatePlan(input: {
  canonicalRouterAddress: string;
  binding: VenueAccountBinding;
  plan: PolymarketFundingPlan;
}): Readonly<{
  expectedNonce: bigint;
  totalAmount: bigint;
}> {
  if (
    input.binding.venueId !== "polymarket" ||
    input.binding.settlementLocation.asset.networkId !== "evm:137"
  ) {
    throw new PreparationContractError(
      "binding_mismatch",
      "Polymarket Funding Router requires the exact Polygon venue binding",
    );
  }
  if (
    normalizedAddress(input.plan.depositWallet) !==
    normalizedAddress(input.binding.accountRef)
  ) {
    throw new PreparationContractError(
      "binding_mismatch",
      "Polymarket Funding Router plan targets another Deposit Wallet",
    );
  }
  if (
    normalizedAddress(input.plan.routerAddress) !==
    normalizedAddress(input.canonicalRouterAddress)
  ) {
    throw new PreparationContractError(
      "evidence_invalid",
      "Polymarket Funding Router plan targets a non-canonical router",
    );
  }
  const requiredRaw = raw(input.plan.requiredRaw);
  const depositAvailableRaw = raw(input.plan.depositAvailableRaw);
  const totalAmountRaw = raw(input.plan.totalAmountRaw);
  const pUsdAmountRaw = raw(input.plan.pUsdAmountRaw);
  const depositUsdceAmountRaw = raw(input.plan.depositUsdceAmountRaw);
  const signerUsdceAmountRaw = raw(input.plan.signerUsdceAmountRaw);
  const usdceAmountRaw = raw(input.plan.usdceAmountRaw);
  const routerNonce = raw(input.plan.routerNonce);
  if (
    requiredRaw == null ||
    depositAvailableRaw == null ||
    totalAmountRaw == null ||
    pUsdAmountRaw == null ||
    depositUsdceAmountRaw == null ||
    signerUsdceAmountRaw == null ||
    usdceAmountRaw == null ||
    routerNonce == null ||
    totalAmountRaw <= 0n ||
    requiredRaw <= depositAvailableRaw ||
    requiredRaw - depositAvailableRaw !== totalAmountRaw ||
    pUsdAmountRaw > totalAmountRaw ||
    totalAmountRaw - pUsdAmountRaw !== usdceAmountRaw ||
    depositUsdceAmountRaw + signerUsdceAmountRaw !== usdceAmountRaw
  ) {
    throw new PreparationContractError(
      "evidence_invalid",
      "Polymarket Funding Router plan amounts are inconsistent",
    );
  }
  let decoded: ReturnType<typeof decodePolymarketFundingCalldata>;
  try {
    decoded = decodePolymarketFundingCalldata(input.plan.calldata);
  } catch {
    throw new PreparationContractError(
      "evidence_invalid",
      "Polymarket Funding Router calldata is invalid",
    );
  }
  if (
    decoded.expectedNonce !== routerNonce ||
    decoded.totalAmount !== totalAmountRaw ||
    decoded.pUsdAmount !== pUsdAmountRaw
  ) {
    throw new PreparationContractError(
      "evidence_invalid",
      "Polymarket Funding Router calldata differs from the canonical plan",
    );
  }
  return { expectedNonce: routerNonce, totalAmount: totalAmountRaw };
}

export function buildPolymarketFundingFollowupAction(
  input: Readonly<{
    binding: VenueAccountBinding;
    canonicalRouterAddress: string;
    inspectionRevision: string;
    operationId: string;
    plan: PolymarketFundingPlan;
  }>,
): NormalizedAction {
  validatePlan(input);
  const action = {
    kind: "evm_transaction" as const,
    networkId: "evm:137",
    senderWalletId: input.binding.executionWalletId,
    to: ethers.getAddress(input.canonicalRouterAddress),
    data: ethers.hexlify(input.plan.calldata),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  return {
    ...action,
    actionId: `action_${canonicalJsonHash({
      action,
      bindingId: input.binding.bindingId,
      inspectionRevision: input.inspectionRevision,
      operationId: input.operationId,
      plan: input.plan,
    }).slice(0, 32)}`,
  };
}

export function verifyPolymarketFundingPostconditions(
  input: Readonly<{
    after: PolymarketFundingObservation | null;
    before: PolymarketFundingObservation;
    binding: VenueAccountBinding;
    canonicalRouterAddress: string;
    plan: PolymarketFundingPlan;
    receipt: PolymarketFundingReceiptState;
    attributedPusdRaw: string | null;
  }>,
): PolymarketFundingPostconditionResult {
  const validated = validatePlan(input);
  const emptyChecks = {
    clobVisible: false,
    exactPusdAttributed: false,
    nonceAdvanced: false,
    receiptSucceeded: false,
    targetBalanceObserved: false,
  };
  if (
    input.receipt === "unobserved" ||
    input.receipt === "pending" ||
    input.receipt === "ambiguous"
  ) {
    return {
      status: "reconcile_required",
      reasonCodes: ["operation_reconcile_required"],
      checks: emptyChecks,
      expectedDepositPusdRaw: null,
    };
  }
  if (input.receipt === "reverted") {
    return {
      status: "failed",
      reasonCodes: ["invalid_action"],
      checks: emptyChecks,
      expectedDepositPusdRaw: null,
    };
  }
  const beforeNonce = raw(input.before.routerNonceRaw);
  const beforePusd = raw(input.before.depositPusdRaw);
  if (
    beforeNonce == null ||
    beforePusd == null ||
    beforeNonce !== validated.expectedNonce ||
    !input.after
  ) {
    return {
      status: "unavailable",
      reasonCodes:
        beforeNonce != null && beforeNonce !== validated.expectedNonce
          ? ["preparation_evidence_stale"]
          : ["rpc_unavailable"],
      checks: { ...emptyChecks, receiptSucceeded: true },
      expectedDepositPusdRaw: null,
    };
  }
  const afterNonce = raw(input.after.routerNonceRaw);
  const afterPusd = raw(input.after.depositPusdRaw);
  const clobPusd = raw(input.after.clobPusdRaw);
  const attributedPusd = raw(input.attributedPusdRaw);
  const expectedPusd = beforePusd + validated.totalAmount;
  const exactPusdAttributed = attributedPusd === validated.totalAmount;
  const nonceAdvanced = afterNonce === validated.expectedNonce + 1n;
  const targetBalanceObserved = afterPusd != null && afterPusd >= expectedPusd;
  const clobVisible = clobPusd != null && clobPusd >= expectedPusd;
  const checks = {
    clobVisible,
    exactPusdAttributed,
    nonceAdvanced,
    receiptSucceeded: true,
    targetBalanceObserved,
  };
  if (!nonceAdvanced || !exactPusdAttributed || !targetBalanceObserved) {
    return {
      status: "unavailable",
      reasonCodes: ["operation_reconcile_required"],
      checks,
      expectedDepositPusdRaw: expectedPusd.toString(),
    };
  }
  if (!clobVisible) {
    return {
      status: "unavailable",
      reasonCodes: ["clob_collateral_not_visible"],
      checks,
      expectedDepositPusdRaw: expectedPusd.toString(),
    };
  }
  return {
    status: "satisfied",
    reasonCodes: [],
    checks,
    expectedDepositPusdRaw: expectedPusd.toString(),
  };
}
