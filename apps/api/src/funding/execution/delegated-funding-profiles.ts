import type { NormalizedAction } from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { decodePolymarketFundingCalldata } from "../../services/polymarket-funding-router.js";
import {
  BASE_USDC,
  RELAY_DEPOSITORY_V2,
} from "../../funding-providers/relay/rehearsal.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  type DelegatedFundingSecurityClass,
} from "./delegated-funding-profile-ids.js";

export {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
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
  [TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID]: Object.freeze({
    profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    securityClass: "routed_value_movement",
    networkId: "evm:8453",
    venueId: "polymarket",
    executorId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  }),
});

type PolicyCondition = Readonly<Record<string, unknown>>;

const RELAY_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const RELAY_DEPOSIT_ERC20_ABI = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

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

function conditionAbiEquals(
  condition: PolicyCondition,
  abi: readonly unknown[],
): boolean {
  return canonicalJsonHash(condition.abi ?? null) === canonicalJsonHash(abi);
}

function conditionsForRule(
  rule: Readonly<Record<string, unknown>>,
): readonly PolicyCondition[] {
  return Array.isArray(rule.conditions)
    ? rule.conditions
        .map(record)
        .filter((value): value is PolicyCondition => value != null)
    : [];
}

function exactPolicyCondition(
  conditions: readonly PolicyCondition[],
  input: Readonly<{
    field: string;
    fieldSource: string;
    operator: string;
    value: string;
    abi?: readonly unknown[];
  }>,
): boolean {
  return (
    conditions.filter(
      (condition) =>
        condition.field === input.field &&
        condition.field_source === input.fieldSource &&
        condition.operator === input.operator &&
        scalar(condition.value) === input.value.toLowerCase() &&
        (!input.abi || conditionAbiEquals(condition, input.abi)),
    ).length === 1
  );
}

function positiveCapCondition(
  conditions: readonly PolicyCondition[],
  field: string,
  abi: readonly unknown[],
): bigint | null {
  const matches = conditions.filter(
    (condition) =>
      condition.field === field &&
      condition.field_source === "ethereum_calldata" &&
      condition.operator === "lte" &&
      conditionAbiEquals(condition, abi),
  );
  if (matches.length !== 1) return null;
  const value = scalar(matches[0]?.value);
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  return BigInt(value);
}

export function relayEvmPolicyRuleKind(
  rule: Readonly<Record<string, unknown>>,
  expectedDepositor?: string,
): "approve" | "deposit" | null {
  if (rule.action !== "ALLOW" || rule.method !== "eth_sendTransaction") {
    return null;
  }
  const conditions = conditionsForRule(rule);
  const common =
    exactPolicyCondition(conditions, {
      field: "chain_id",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: "8453",
    }) &&
    exactPolicyCondition(conditions, {
      field: "value",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: "0x0",
    });
  if (!common) return null;
  const approve =
    conditions.length === 6 &&
    exactPolicyCondition(conditions, {
      field: "to",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: BASE_USDC,
    }) &&
    exactPolicyCondition(conditions, {
      field: "function_name",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: "approve",
      abi: RELAY_APPROVE_ABI,
    }) &&
    exactPolicyCondition(conditions, {
      field: "approve.spender",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: RELAY_DEPOSITORY_V2,
      abi: RELAY_APPROVE_ABI,
    }) &&
    positiveCapCondition(conditions, "approve.amount", RELAY_APPROVE_ABI) !=
      null;
  if (approve) return "approve";
  const deposit =
    conditions.length === 7 &&
    exactPolicyCondition(conditions, {
      field: "to",
      fieldSource: "ethereum_transaction",
      operator: "eq",
      value: RELAY_DEPOSITORY_V2,
    }) &&
    exactPolicyCondition(conditions, {
      field: "function_name",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: "depositErc20",
      abi: RELAY_DEPOSIT_ERC20_ABI,
    }) &&
    exactPolicyCondition(conditions, {
      field: "depositErc20.token",
      fieldSource: "ethereum_calldata",
      operator: "eq",
      value: BASE_USDC,
      abi: RELAY_DEPOSIT_ERC20_ABI,
    }) &&
    conditions.filter(
      (condition) =>
        condition.field === "depositErc20.depositor" &&
        condition.field_source === "ethereum_calldata" &&
        condition.operator === "eq" &&
        conditionAbiEquals(condition, RELAY_DEPOSIT_ERC20_ABI) &&
        (expectedDepositor === undefined ||
          scalar(condition.value) === expectedDepositor.toLowerCase()),
    ).length === 1 &&
    positiveCapCondition(
      conditions,
      "depositErc20.amount",
      RELAY_DEPOSIT_ERC20_ABI,
    ) != null;
  return deposit ? "deposit" : null;
}

export function validateRelayEvmPolicyRules(
  rules: readonly Readonly<Record<string, unknown>>[],
  expectedDepositor?: string,
  allowedDepositors?: readonly string[],
): Readonly<{
  valid: boolean;
  maxSourceRaw: bigint | null;
  issues: readonly string[];
}> {
  const relayRules = rules.flatMap((rule) => {
    const kind = relayEvmPolicyRuleKind(rule);
    return kind ? [{ kind, rule }] : [];
  });
  const approve = relayRules.filter((entry) => entry.kind === "approve");
  const deposit = relayRules.filter((entry) => entry.kind === "deposit");
  const issues: string[] = [];
  const normalizedExpectedDepositor = expectedDepositor?.toLowerCase() ?? null;
  const normalizedAllowedDepositors = (
    allowedDepositors ?? (expectedDepositor ? [expectedDepositor] : [])
  ).map((address) => address.toLowerCase());
  const allowedDepositorSet = new Set(normalizedAllowedDepositors);
  const depositors = deposit.map((entry) => {
    const matches = conditionsForRule(entry.rule).filter(
      (condition) =>
        condition.field === "depositErc20.depositor" &&
        condition.field_source === "ethereum_calldata" &&
        condition.operator === "eq" &&
        conditionAbiEquals(condition, RELAY_DEPOSIT_ERC20_ABI),
    );
    return matches.length === 1 ? scalar(matches[0]?.value) : "";
  });
  if (
    normalizedAllowedDepositors.length === 0 ||
    normalizedAllowedDepositors.some(
      (address) => !/^0x[0-9a-f]{40}$/u.test(address),
    ) ||
    allowedDepositorSet.size !== normalizedAllowedDepositors.length
  ) {
    issues.push("Relay policy requires a unique exact depositor allowlist");
  }
  if (
    normalizedExpectedDepositor &&
    !allowedDepositorSet.has(normalizedExpectedDepositor)
  ) {
    issues.push("Relay policy does not allow the executing-wallet depositor");
  }
  if (approve.length !== 1)
    issues.push("Relay policy requires one exact approve rule");
  if (
    deposit.length !== normalizedAllowedDepositors.length ||
    depositors.some((address) => !allowedDepositorSet.has(address)) ||
    new Set(depositors).size !== depositors.length
  ) {
    issues.push("Relay policy deposit rules must equal the exact allowlist");
  }
  const approveCap = approve[0]
    ? positiveCapCondition(
        conditionsForRule(approve[0].rule),
        "approve.amount",
        RELAY_APPROVE_ABI,
      )
    : null;
  const depositCaps = deposit.map((entry) =>
    positiveCapCondition(
      conditionsForRule(entry.rule),
      "depositErc20.amount",
      RELAY_DEPOSIT_ERC20_ABI,
    ),
  );
  if (
    approveCap == null ||
    depositCaps.length === 0 ||
    depositCaps.some(
      (depositCap) => depositCap == null || depositCap !== approveCap,
    )
  ) {
    issues.push("Relay approve and deposit caps must be equal and positive");
  }
  return {
    valid: issues.length === 0,
    maxSourceRaw: issues.length === 0 ? approveCap : null,
    issues,
  };
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
