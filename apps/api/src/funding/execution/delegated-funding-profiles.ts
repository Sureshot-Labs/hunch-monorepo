import type { NormalizedAction } from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { decodePolymarketFundingCalldata } from "../../services/polymarket-funding-router.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  type DelegatedFundingSecurityClass,
} from "./delegated-funding-profile-ids.js";

export {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  type DelegatedFundingSecurityClass,
} from "./delegated-funding-profile-ids.js";

export type DelegatedFundingExecutionProfile = Readonly<{
  profileId: string;
  securityClass: DelegatedFundingSecurityClass;
  networkId: string;
  venueId: string;
  executorId: string;
}>;

export const DELEGATED_FUNDING_EXECUTION_PROFILES: Readonly<
  Record<string, DelegatedFundingExecutionProfile>
> = Object.freeze({
  [POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID]: Object.freeze({
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    securityClass: "closed_destination_transform",
    networkId: "evm:137",
    venueId: "polymarket",
    executorId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  }),
});

type PolicyCondition = Readonly<Record<string, unknown>>;

export type DelegatedFundingPrivyPolicy = Readonly<{
  chainType: "ethereum" | "solana";
  id: string;
  rules: readonly Readonly<Record<string, unknown>>[];
}>;

const FUND_ABI = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "expectedNonce", type: "uint256" },
      { name: "totalAmount", type: "uint256" },
      { name: "pUsdAmount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().toLowerCase()
    : "";
}

function exactAbi(condition: PolicyCondition): boolean {
  return (
    canonicalJsonHash(condition.abi ?? null) === canonicalJsonHash(FUND_ABI)
  );
}

function exactCondition(
  conditions: readonly PolicyCondition[],
  input: Readonly<{
    field: string;
    fieldSource: string;
    operator: string;
    value: string;
    requireAbi?: boolean;
  }>,
): boolean {
  const matches = conditions.filter(
    (condition) =>
      condition.field === input.field &&
      condition.field_source === input.fieldSource &&
      condition.operator === input.operator &&
      scalar(condition.value) === input.value.toLowerCase() &&
      (!input.requireAbi || exactAbi(condition)),
  );
  return matches.length === 1;
}

export function isExactPolymarketDepositUsdceWrapRule(
  input: Readonly<{
    routerAddress: string;
    rule: Readonly<Record<string, unknown>>;
  }>,
): boolean {
  const expectedRouter = input.routerAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(expectedRouter)) return false;
  if (
    input.rule.action !== "ALLOW" ||
    input.rule.method !== "eth_sendTransaction"
  ) {
    return false;
  }
  const rawConditions = Array.isArray(input.rule.conditions)
    ? input.rule.conditions
    : [];
  const conditions = rawConditions
    .map(record)
    .filter((condition): condition is PolicyCondition => condition != null);
  return (
    conditions.length === 5 &&
    conditions.length === rawConditions.length &&
    exactCondition(conditions, {
      field: "chain_id",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: "137",
    }) &&
    exactCondition(conditions, {
      field: "to",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: expectedRouter,
    }) &&
    exactCondition(conditions, {
      field: "value",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: "0x0",
    }) &&
    exactCondition(conditions, {
      field: "function_name",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: "fund",
      requireAbi: true,
    }) &&
    exactCondition(conditions, {
      field: "fund.pUsdAmount",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: "0",
      requireAbi: true,
    }) &&
    !conditions.some(
      (condition) =>
        condition.field === "fund.totalAmount" ||
        condition.field === "fund.expectedNonce",
    )
  );
}

export function validatePolymarketDepositUsdceWrapPolicy(
  input: Readonly<{
    policy: DelegatedFundingPrivyPolicy;
    policyId: string;
    routerAddress: string;
  }>,
): Readonly<{
  valid: boolean;
  fingerprint: string;
  issues: readonly string[];
}> {
  const issues: string[] = [];
  const expectedRouter = input.routerAddress.trim().toLowerCase();
  if (
    input.policy.id !== input.policyId ||
    input.policy.chainType !== "ethereum"
  ) {
    issues.push(
      "automation policy identity or chain type differs from configuration",
    );
  }
  if (!/^0x[0-9a-f]{40}$/u.test(expectedRouter)) {
    issues.push("canonical Polygon Funding Router is invalid");
  }
  const wrapRules = input.policy.rules.filter((rule) =>
    isExactPolymarketDepositUsdceWrapRule({
      routerAddress: expectedRouter,
      rule,
    }),
  );
  if (wrapRules.length !== 1) {
    issues.push(
      "combined policy must contain exactly one canonical Router fund(..., pUsdAmount=0) wrap rule",
    );
  }
  return {
    valid: issues.length === 0,
    fingerprint: canonicalJsonHash(input.policy),
    issues,
  };
}

function positiveRaw(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function validatePolymarketDepositUsdceWrapAction(
  input: Readonly<{
    action: NormalizedAction;
    expectedRaw: string;
    routerAddress: string;
    walletId: string;
  }>,
): Readonly<{ expectedNonce: bigint; totalAmount: bigint }> {
  const expectedRaw = positiveRaw(input.expectedRaw);
  if (
    input.action.kind !== "evm_transaction" ||
    input.action.networkId !== "evm:137" ||
    input.action.senderWalletId !== input.walletId ||
    input.action.to.toLowerCase() !== input.routerAddress.toLowerCase() ||
    input.action.valueRaw !== "0" ||
    expectedRaw == null
  ) {
    throw new Error(
      "delegated wrap action differs from its closed-destination profile",
    );
  }
  const decoded = decodePolymarketFundingCalldata(input.action.data);
  if (decoded.totalAmount !== expectedRaw || decoded.pUsdAmount !== 0n) {
    throw new Error(
      "delegated wrap must consume exactly the full USDC.e receipt",
    );
  }
  return {
    expectedNonce: decoded.expectedNonce,
    totalAmount: decoded.totalAmount,
  };
}

export function delegatedFundingProfile(
  profileId: string,
): DelegatedFundingExecutionProfile | null {
  return DELEGATED_FUNDING_EXECUTION_PROFILES[profileId] ?? null;
}
