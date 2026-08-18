import type { PrivyPolicyMetadata } from "../privy-service.js";
import { isRecord } from "../lib/type-guards.js";
import { isExactPolymarketDepositUsdceWrapRule } from "../funding/execution/delegated-funding-profiles.js";
import {
  canonicalAccountAddress,
  isEvmAddress,
  sameAccountAddress,
} from "../funding/domain/asset-identity.js";
import {
  POLYMARKET_AUTH_MESSAGE,
  POLYMARKET_AUTH_TYPES,
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_POLYGON_CHAIN_ID,
  POLYMARKET_TYPED_DATA_SIGN_TYPES,
} from "./polymarket-signing-schema.js";
import { POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES } from "./polymarket-deposit-wallet-relayer.js";
import type { TradeSide } from "./trading-types.js";

export type PrivyBotPolicyProfile = "buy" | "sell" | "buy_sell";

export type PolicyValidationResult = {
  fundingMaxRaw?: bigint | null;
  /**
   * A staged policy may omit this rule while the Funding Router is not used
   * for controller-wallet top-ups.  When it is present, its shape is closed
   * over the canonical Polygon pUSD token and immutable Funding Router.
   */
  fundingRouterControllerApprovalPresent?: boolean;
  issues: string[];
  valid: boolean;
};

export const POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW = (1n << 256n) - 1n;

const POLYMARKET_PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

type TypedDataField = { name: string; type: string };

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeScalar(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalEvmAddress(value: string): string | null {
  return isEvmAddress(value) ? canonicalAccountAddress("evm:137", value) : null;
}

function readPolicyConditions(rule: Record<string, unknown>) {
  return Array.isArray(rule.conditions) ? rule.conditions.filter(isRecord) : [];
}

function matchingConditionValues(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  operators: readonly string[];
}): string[] {
  return input.conditions.flatMap((condition) => {
    if (
      condition.field !== input.field ||
      condition.field_source !== input.fieldSource ||
      !input.operators.includes(String(condition.operator))
    ) {
      return [];
    }
    return stringValues(condition.value);
  });
}

function conditionValues(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  operators: readonly string[];
}): string[] {
  return matchingConditionValues(input).map(normalizeScalar);
}

function addressConditionValues(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  operators: readonly string[];
}): string[] {
  return matchingConditionValues(input).flatMap((value) => {
    const canonical = canonicalEvmAddress(value);
    return canonical ? [canonical] : [];
  });
}

function canonicalEvmAddressSet(values: readonly string[]): Set<string> {
  return new Set(
    values.flatMap((value) => {
      const canonical = canonicalEvmAddress(value);
      return canonical ? [canonical] : [];
    }),
  );
}

function hasExactAddressCondition(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  value: string;
}): boolean {
  const expected = canonicalEvmAddress(input.value);
  return Boolean(
    expected &&
    addressConditionValues({ ...input, operators: ["eq"] }).includes(expected),
  );
}

function hasExactCondition(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  value: string;
}): boolean {
  return conditionValues({ ...input, operators: ["eq"] }).includes(
    normalizeScalar(input.value),
  );
}

function hasExactZeroCondition(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
}): boolean {
  const values = conditionValues({ ...input, operators: ["eq"] });
  if (values.length !== 1) return false;
  try {
    return BigInt(values[0] ?? "") === 0n;
  } catch {
    return false;
  }
}

function normalizeTypedDataFields(value: unknown): TypedDataField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((field) => {
    if (!isRecord(field)) return [];
    if (typeof field.name !== "string" || typeof field.type !== "string") {
      return [];
    }
    return [{ name: field.name, type: field.type }];
  });
}

function fieldsEqual(
  actual: TypedDataField[],
  expected: readonly TypedDataField[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) =>
        field.name === expected[index]?.name &&
        field.type === expected[index]?.type,
    )
  );
}

function hasTypedDataSchema(input: {
  conditions: Record<string, unknown>[];
  primaryType: "Batch" | "ClobAuth" | "Order" | "TypedDataSign";
}): boolean {
  const expectedTypes: Record<string, readonly TypedDataField[]> =
    input.primaryType === "Batch"
      ? POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES
      : input.primaryType === "ClobAuth"
        ? POLYMARKET_AUTH_TYPES
        : input.primaryType === "Order"
          ? POLYMARKET_ORDER_TYPES
          : POLYMARKET_TYPED_DATA_SIGN_TYPES;
  return input.conditions.some((condition) => {
    if (condition.field_source !== "ethereum_typed_data_message") return false;
    const typedData = condition.typed_data;
    if (!isRecord(typedData) || typedData.primary_type !== input.primaryType) {
      return false;
    }
    const types = typedData.types;
    if (!isRecord(types)) return false;
    return Object.entries(expectedTypes).every(([typeName, fields]) =>
      fieldsEqual(normalizeTypedDataFields(types[typeName]), fields),
    );
  });
}

function isExactMakerAmountCap(input: {
  conditions: Record<string, unknown>[];
  field: string;
  maxMakerAmountMicros: bigint;
}): boolean {
  return conditionValues({
    conditions: input.conditions,
    field: input.field,
    fieldSource: "ethereum_typed_data_message",
    operators: ["lte"],
  }).some((value) => {
    try {
      return BigInt(value) === input.maxMakerAmountMicros;
    } catch {
      return false;
    }
  });
}

function coveredExchangeAddresses(input: {
  conditions: Record<string, unknown>[];
  allowedExchangeAddresses: Set<string>;
}): Set<string> | null {
  const values = addressConditionValues({
    conditions: input.conditions,
    field: "verifying_contract",
    fieldSource: "ethereum_typed_data_domain",
    operators: ["eq", "in"],
  });
  if (
    values.length === 0 ||
    values.some((value) => !input.allowedExchangeAddresses.has(value))
  ) {
    return null;
  }
  return new Set(values);
}

function hasExactFundingAbi(condition: Record<string, unknown>): boolean {
  const abi = condition.abi;
  if (!Array.isArray(abi) || abi.length !== 1 || !isRecord(abi[0])) {
    return false;
  }
  const item = abi[0];
  if (
    item.type !== "function" ||
    item.name !== "fund" ||
    item.stateMutability !== "nonpayable" ||
    !Array.isArray(item.inputs) ||
    item.inputs.length !== 3
  ) {
    return false;
  }
  const inputs = item.inputs;
  return ["expectedNonce", "totalAmount", "pUsdAmount"].every((name, index) => {
    const parameter = inputs[index];
    return (
      isRecord(parameter) &&
      parameter.name === name &&
      parameter.type === "uint256"
    );
  });
}

function hasExactFundingRouterApprovalAbi(
  condition: Record<string, unknown>,
): boolean {
  const abi = condition.abi;
  if (!Array.isArray(abi) || abi.length !== 1 || !isRecord(abi[0])) {
    return false;
  }
  const item = abi[0];
  if (
    item.type !== "function" ||
    item.name !== "approve" ||
    item.stateMutability !== "nonpayable" ||
    !Array.isArray(item.inputs) ||
    item.inputs.length !== 2
  ) {
    return false;
  }
  const inputs = item.inputs;
  return ["spender", "amount"].every((name, index) => {
    const parameter = inputs[index];
    return (
      isRecord(parameter) &&
      parameter.name === name &&
      parameter.type === (index === 0 ? "address" : "uint256")
    );
  });
}

function readExactFundingRuleCap(input: {
  conditions: Record<string, unknown>[];
  routerAddress: string;
}): bigint | null {
  if (
    !hasExactCondition({
      conditions: input.conditions,
      field: "chain_id",
      fieldSource: "ethereum_transaction",
      value: String(POLYMARKET_POLYGON_CHAIN_ID),
    }) ||
    !hasExactAddressCondition({
      conditions: input.conditions,
      field: "to",
      fieldSource: "ethereum_transaction",
      value: input.routerAddress,
    }) ||
    !hasExactCondition({
      conditions: input.conditions,
      field: "value",
      fieldSource: "ethereum_transaction",
      value: "0x0",
    })
  ) {
    return null;
  }
  const calldataConditions = input.conditions.filter(
    (condition) => condition.field_source === "ethereum_calldata",
  );
  if (calldataConditions.length !== 2) return null;
  const functionName = calldataConditions.find(
    (condition) => condition.field === "function_name",
  );
  const totalAmount = calldataConditions.find(
    (condition) => condition.field === "fund.totalAmount",
  );
  if (
    !functionName ||
    functionName.operator !== "eq" ||
    !stringValues(functionName.value).some(
      (value) => normalizeScalar(value) === "fund",
    ) ||
    !hasExactFundingAbi(functionName) ||
    !totalAmount ||
    totalAmount.operator !== "lte" ||
    !hasExactFundingAbi(totalAmount)
  ) {
    return null;
  }
  const values = stringValues(totalAmount.value);
  if (values.length !== 1) return null;
  try {
    const cap = BigInt(values[0] ?? "");
    return cap > 0n ? cap : null;
  } catch {
    return null;
  }
}

function readExactFundingRouterControllerApprovalRule(input: {
  conditions: Record<string, unknown>[];
  fundingRouterAddress: string;
  pUsdAddress: string;
}): boolean {
  if (
    !hasExactCondition({
      conditions: input.conditions,
      field: "chain_id",
      fieldSource: "ethereum_transaction",
      value: String(POLYMARKET_POLYGON_CHAIN_ID),
    }) ||
    !hasExactAddressCondition({
      conditions: input.conditions,
      field: "to",
      fieldSource: "ethereum_transaction",
      value: input.pUsdAddress,
    }) ||
    !hasExactZeroCondition({
      conditions: input.conditions,
      field: "value",
      fieldSource: "ethereum_transaction",
    })
  ) {
    return false;
  }
  const calldataConditions = input.conditions.filter(
    (condition) => condition.field_source === "ethereum_calldata",
  );
  if (
    calldataConditions.length !== 3 ||
    !calldataConditions.every(hasExactFundingRouterApprovalAbi)
  ) {
    return false;
  }
  const functionName = calldataConditions.find(
    (condition) => condition.field === "function_name",
  );
  const spender = calldataConditions.find(
    (condition) => condition.field === "approve.spender",
  );
  const amount = calldataConditions.find(
    (condition) => condition.field === "approve.amount",
  );
  return Boolean(
    functionName &&
    functionName.operator === "eq" &&
    stringValues(functionName.value).length === 1 &&
    stringValues(functionName.value).some(
      (value) => normalizeScalar(value) === "approve",
    ) &&
    spender &&
    spender.operator === "eq" &&
    hasExactFundingRouterApprovalAbi(spender) &&
    addressConditionValues({
      conditions: [spender],
      field: "approve.spender",
      fieldSource: "ethereum_calldata",
      operators: ["eq"],
    }).length === 1 &&
    hasExactAddressCondition({
      conditions: [spender],
      field: "approve.spender",
      fieldSource: "ethereum_calldata",
      value: input.fundingRouterAddress,
    }) &&
    amount &&
    amount.operator === "eq" &&
    hasExactFundingRouterApprovalAbi(amount) &&
    stringValues(amount.value).length === 1 &&
    stringValues(amount.value).some((value) => {
      try {
        return BigInt(value) === POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW;
      } catch {
        return false;
      }
    }),
  );
}

export function validatePolymarketBotPolicy(input: {
  exchangeAddresses: readonly string[];
  fundingRouterAddress: string;
  maxBuyUsd: number;
  policy: PrivyPolicyMetadata;
  pUsdAddress?: string;
}): PolicyValidationResult {
  const issues: string[] = [];
  if (input.policy.chainType !== "ethereum") {
    issues.push("Policy chain type must be ethereum (EVM). ");
  }
  if (!Number.isFinite(input.maxBuyUsd) || input.maxBuyUsd <= 0) {
    issues.push("Policy max buy must be positive.");
  }
  const normalizedFundingRouter =
    canonicalEvmAddress(input.fundingRouterAddress) ?? "";
  const normalizedPusd =
    canonicalEvmAddress(input.pUsdAddress ?? POLYMARKET_PUSD_ADDRESS) ?? "";
  if (!normalizedFundingRouter) {
    issues.push("Funding router address must be configured.");
  }
  if (!normalizedPusd) {
    issues.push("Polygon pUSD address must be configured.");
  }
  const allowedExchangeAddresses = canonicalEvmAddressSet(
    input.exchangeAddresses,
  );
  if (allowedExchangeAddresses.size !== 2) {
    issues.push("Both regular and neg-risk Polymarket exchanges are required.");
  }
  const maxMakerAmountMicros = BigInt(
    Math.round(Math.max(0, input.maxBuyUsd) * 1_000_000),
  );
  let clobAuthCovered = false;
  let fundingCovered = false;
  let fundingMaxRaw: bigint | null = null;
  let fundingRouterControllerApprovalPresent = false;
  const directCoverage = new Set<string>();
  const depositCoverage = new Set<string>();
  const allowRules = input.policy.rules.filter(
    (rule) => rule.action === "ALLOW",
  );
  if (allowRules.length === 0) issues.push("Policy has no ALLOW rules.");
  if (
    input.policy.rules.some(
      (rule) =>
        rule.action === "DENY" &&
        (rule.method === "*" ||
          rule.method === "eth_signTypedData_v4" ||
          rule.method === "eth_sendTransaction"),
    )
  ) {
    issues.push("Policy contains a DENY rule that overlaps bot signing.");
  }

  for (const rule of allowRules) {
    const conditions = readPolicyConditions(rule);
    if (rule.method === "eth_sendTransaction") {
      const controllerApproval = readExactFundingRouterControllerApprovalRule({
        conditions,
        fundingRouterAddress: normalizedFundingRouter,
        pUsdAddress: normalizedPusd,
      });
      if (controllerApproval) {
        if (fundingRouterControllerApprovalPresent) {
          issues.push("Funding Router controller approval rule is duplicated.");
        } else {
          fundingRouterControllerApprovalPresent = true;
        }
        continue;
      }
      const cap = readExactFundingRuleCap({
        conditions,
        routerAddress: normalizedFundingRouter,
      });
      if (fundingCovered || cap == null) {
        issues.push("Funding ALLOW rule is missing or unsafe.");
      } else {
        fundingCovered = true;
        fundingMaxRaw = cap;
      }
      continue;
    }
    if (rule.method !== "eth_signTypedData_v4") {
      issues.push(`Unsafe allowed method: ${String(rule.method)}.`);
      continue;
    }
    if (
      !hasExactCondition({
        conditions,
        field: "chain_id",
        fieldSource: "ethereum_typed_data_domain",
        value: String(POLYMARKET_POLYGON_CHAIN_ID),
      })
    ) {
      issues.push("Every ALLOW rule must require Polygon chainId 137.");
      continue;
    }
    if (hasTypedDataSchema({ conditions, primaryType: "ClobAuth" })) {
      if (
        !hasExactCondition({
          conditions,
          field: "message",
          fieldSource: "ethereum_typed_data_message",
          value: POLYMARKET_AUTH_MESSAGE,
        })
      ) {
        issues.push("ClobAuth rule must require the canonical auth message.");
        continue;
      }
      clobAuthCovered = true;
      continue;
    }
    const primaryType = hasTypedDataSchema({ conditions, primaryType: "Order" })
      ? "Order"
      : hasTypedDataSchema({ conditions, primaryType: "TypedDataSign" })
        ? "TypedDataSign"
        : null;
    if (!primaryType) {
      issues.push("ALLOW rule has an unsupported typed-data schema.");
      continue;
    }
    const fieldPrefix = primaryType === "TypedDataSign" ? "contents." : "";
    const exchanges = coveredExchangeAddresses({
      allowedExchangeAddresses,
      conditions,
    });
    if (!exchanges) {
      issues.push("Order rule has an unsafe Polymarket exchange allowlist.");
      continue;
    }
    if (
      !hasExactCondition({
        conditions,
        field: `${fieldPrefix}side`,
        fieldSource: "ethereum_typed_data_message",
        value: "0",
      })
    ) {
      issues.push("Order rule must restrict side to BUY.");
      continue;
    }
    const expectedSignatureType = primaryType === "TypedDataSign" ? "3" : "2";
    if (
      !hasExactCondition({
        conditions,
        field: `${fieldPrefix}signatureType`,
        fieldSource: "ethereum_typed_data_message",
        value: expectedSignatureType,
      })
    ) {
      issues.push("Order rule has the wrong signature type restriction.");
      continue;
    }
    if (
      !isExactMakerAmountCap({
        conditions,
        field: `${fieldPrefix}makerAmount`,
        maxMakerAmountMicros,
      })
    ) {
      issues.push("Order rule makerAmount cap does not match configuration.");
      continue;
    }
    const coverage =
      primaryType === "TypedDataSign" ? depositCoverage : directCoverage;
    for (const address of exchanges) coverage.add(address);
  }

  if (!clobAuthCovered) issues.push("Canonical ClobAuth rule is missing.");
  if (!fundingCovered) issues.push("Canonical funding router rule is missing.");
  for (const exchangeAddress of allowedExchangeAddresses) {
    if (!directCoverage.has(exchangeAddress)) {
      issues.push(`Direct Order rule does not cover ${exchangeAddress}.`);
    }
    if (!depositCoverage.has(exchangeAddress)) {
      issues.push(
        `Deposit-wallet Order rule does not cover ${exchangeAddress}.`,
      );
    }
  }
  return {
    fundingMaxRaw: issues.length === 0 ? fundingMaxRaw : null,
    fundingRouterControllerApprovalPresent,
    issues,
    valid: issues.length === 0,
  };
}

export function validatePolymarketBotSellPolicy(input: {
  builderCode: string;
  exchangeAddresses: readonly string[];
  policy: PrivyPolicyMetadata;
}): PolicyValidationResult {
  const issues: string[] = [];
  const allowedExchangeAddresses = canonicalEvmAddressSet(
    input.exchangeAddresses,
  );
  const builderCode = normalizeScalar(input.builderCode);
  if (!/^0x[a-f0-9]{64}$/.test(builderCode)) {
    issues.push("SELL policy requires the canonical Hunch builder code.");
  }
  if (input.policy.chainType !== "ethereum") {
    issues.push("Policy chain type must be ethereum (EVM). ");
  }
  let clobAuthCovered = false;
  const coverage = new Set<string>();
  const allowRules = input.policy.rules.filter(
    (rule) => rule.action === "ALLOW",
  );
  if (allowRules.length === 0) issues.push("Policy has no ALLOW rules.");
  for (const rule of allowRules) {
    if (rule.method !== "eth_signTypedData_v4") {
      issues.push(`Unsafe allowed method: ${String(rule.method)}.`);
      continue;
    }
    const conditions = readPolicyConditions(rule);
    if (
      !hasExactCondition({
        conditions,
        field: "chain_id",
        fieldSource: "ethereum_typed_data_domain",
        value: String(POLYMARKET_POLYGON_CHAIN_ID),
      })
    ) {
      issues.push("Every SELL policy rule must require Polygon chainId 137.");
      continue;
    }
    if (hasTypedDataSchema({ conditions, primaryType: "ClobAuth" })) {
      if (
        clobAuthCovered ||
        !hasExactCondition({
          conditions,
          field: "message",
          fieldSource: "ethereum_typed_data_message",
          value: POLYMARKET_AUTH_MESSAGE,
        })
      ) {
        issues.push("SELL ClobAuth rule is missing, duplicated or unsafe.");
      } else {
        clobAuthCovered = true;
      }
      continue;
    }
    if (!hasTypedDataSchema({ conditions, primaryType: "TypedDataSign" })) {
      issues.push(
        "SELL rule must use canonical DepositWallet typed data on Polygon.",
      );
      continue;
    }
    const exchanges = coveredExchangeAddresses({
      allowedExchangeAddresses,
      conditions,
    });
    if (!exchanges) {
      issues.push("SELL rule has an unsafe exchange allowlist.");
      continue;
    }
    if (
      !hasExactCondition({
        conditions,
        field: "contents.side",
        fieldSource: "ethereum_typed_data_message",
        value: "1",
      }) ||
      !hasExactCondition({
        conditions,
        field: "contents.signatureType",
        fieldSource: "ethereum_typed_data_message",
        value: "3",
      }) ||
      !hasExactCondition({
        conditions,
        field: "contents.builder",
        fieldSource: "ethereum_typed_data_message",
        value: builderCode,
      })
    ) {
      issues.push(
        "SELL rule must require side 1, signatureType 3 and the Hunch builder.",
      );
      continue;
    }
    for (const exchange of exchanges) coverage.add(exchange);
  }
  if (
    input.policy.rules.some(
      (rule) => rule.action === "ALLOW" && rule.method === "*",
    )
  ) {
    issues.push("SELL policy contains a wildcard ALLOW rule.");
  }
  if (
    input.policy.rules.some(
      (rule) =>
        rule.action === "DENY" &&
        (rule.method === "*" || rule.method === "eth_signTypedData_v4"),
    )
  ) {
    issues.push("SELL policy contains an overlapping DENY rule.");
  }
  if (!clobAuthCovered) {
    issues.push("Canonical ClobAuth rule is missing from the SELL policy.");
  }
  for (const exchange of allowedExchangeAddresses) {
    if (!coverage.has(exchange)) {
      issues.push(`Deposit-wallet SELL rule does not cover ${exchange}.`);
    }
  }
  return { issues, valid: issues.length === 0 };
}

type PolymarketPolicyRuleKind =
  | "clob_auth"
  | "funding"
  | "funding_wrap"
  | "direct_buy"
  | "deposit_buy"
  | "deposit_sell"
  | "unknown";

function classifyPolymarketPolicyAllowRule(
  rule: PrivyPolicyMetadata["rules"][number],
  fundingRouterAddress: string,
): PolymarketPolicyRuleKind {
  if (rule.method === "eth_sendTransaction") {
    return isExactPolymarketDepositUsdceWrapRule({
      routerAddress: fundingRouterAddress,
      rule,
    })
      ? "funding_wrap"
      : "funding";
  }
  if (rule.method !== "eth_signTypedData_v4") return "unknown";
  const conditions = readPolicyConditions(rule);
  if (hasTypedDataSchema({ conditions, primaryType: "ClobAuth" })) {
    return "clob_auth";
  }
  if (hasTypedDataSchema({ conditions, primaryType: "Order" })) {
    return "direct_buy";
  }
  if (!hasTypedDataSchema({ conditions, primaryType: "TypedDataSign" })) {
    return "unknown";
  }
  if (
    hasExactCondition({
      conditions,
      field: "contents.side",
      fieldSource: "ethereum_typed_data_message",
      value: "0",
    })
  ) {
    return "deposit_buy";
  }
  if (
    hasExactCondition({
      conditions,
      field: "contents.side",
      fieldSource: "ethereum_typed_data_message",
      value: "1",
    })
  ) {
    return "deposit_sell";
  }
  return "unknown";
}

export function validatePolymarketBotPolicyProfile(input: {
  builderCode: string;
  exchangeAddresses: readonly string[];
  fundingRouterAddress: string;
  maxBuyUsd: number;
  policy: PrivyPolicyMetadata;
  profile: PrivyBotPolicyProfile;
}): PolicyValidationResult {
  const expectedKinds: Record<
    PrivyBotPolicyProfile,
    readonly PolymarketPolicyRuleKind[]
  > = {
    buy: ["clob_auth", "funding", "direct_buy", "deposit_buy"],
    sell: ["clob_auth", "deposit_sell"],
    buy_sell: [
      "clob_auth",
      "funding",
      "funding_wrap",
      "direct_buy",
      "deposit_buy",
      "deposit_sell",
    ],
  };
  const expected = new Set(expectedKinds[input.profile]);
  const counts = new Map<PolymarketPolicyRuleKind, number>();
  const nonAllowRules = input.policy.rules.filter(
    (candidate) => candidate.action !== "ALLOW",
  );
  for (const rule of input.policy.rules.filter(
    (candidate) => candidate.action === "ALLOW",
  )) {
    const kind = classifyPolymarketPolicyAllowRule(
      rule,
      input.fundingRouterAddress,
    );
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const shapeIssues: string[] = [];
  if (nonAllowRules.length > 0) {
    shapeIssues.push(
      `Policy profile ${input.profile} must not contain rules outside its exact ALLOW set.`,
    );
  }
  if (input.policy.rules.length !== expected.size) {
    shapeIssues.push(
      `Policy profile ${input.profile} must contain exactly ${expected.size} rules.`,
    );
  }
  for (const kind of expected) {
    if (counts.get(kind) !== 1) {
      shapeIssues.push(
        `Policy profile ${input.profile} must contain exactly one ${kind} rule.`,
      );
    }
  }
  for (const [kind, count] of counts) {
    if (!expected.has(kind) && count > 0) {
      shapeIssues.push(
        `Policy profile ${input.profile} contains unexpected ${kind} permissions.`,
      );
    }
  }

  const selectRules = (kinds: ReadonlySet<PolymarketPolicyRuleKind>) => ({
    ...input.policy,
    rules: input.policy.rules.filter(
      (rule) =>
        rule.action !== "ALLOW" ||
        kinds.has(
          classifyPolymarketPolicyAllowRule(rule, input.fundingRouterAddress),
        ),
    ),
  });
  const validations =
    input.profile === "buy"
      ? [
          validatePolymarketBotPolicy({
            exchangeAddresses: input.exchangeAddresses,
            fundingRouterAddress: input.fundingRouterAddress,
            maxBuyUsd: input.maxBuyUsd,
            policy: input.policy,
          }),
        ]
      : input.profile === "sell"
        ? [
            validatePolymarketBotSellPolicy({
              builderCode: input.builderCode,
              exchangeAddresses: input.exchangeAddresses,
              policy: input.policy,
            }),
          ]
        : [
            validatePolymarketBotPolicy({
              exchangeAddresses: input.exchangeAddresses,
              fundingRouterAddress: input.fundingRouterAddress,
              maxBuyUsd: input.maxBuyUsd,
              policy: selectRules(
                new Set(["clob_auth", "funding", "direct_buy", "deposit_buy"]),
              ),
            }),
            validatePolymarketBotSellPolicy({
              builderCode: input.builderCode,
              exchangeAddresses: input.exchangeAddresses,
              policy: selectRules(new Set(["clob_auth", "deposit_sell"])),
            }),
          ];
  const issues = Array.from(
    new Set([...shapeIssues, ...validations.flatMap((value) => value.issues)]),
  );
  return {
    fundingMaxRaw:
      issues.length === 0
        ? (validations.find((value) => value.fundingMaxRaw != null)
            ?.fundingMaxRaw ?? null)
        : null,
    issues,
    valid: issues.length === 0,
  };
}

export function validatePolymarketBotRedeemPolicy(input: {
  adapterAddresses: readonly string[];
  policy: PrivyPolicyMetadata;
}): PolicyValidationResult {
  const issues: string[] = [];
  const allowedAdapters = canonicalEvmAddressSet(input.adapterAddresses);
  if (input.policy.chainType !== "ethereum") {
    issues.push("Policy chain type must be ethereum (EVM). ");
  }
  if (allowedAdapters.size !== 2) {
    issues.push("Canonical redemption adapters must be configured.");
  }
  const allowRules = input.policy.rules.filter(
    (rule) => rule.action === "ALLOW",
  );
  if (allowRules.length === 0) issues.push("REDEEM policy has no ALLOW rule.");
  const coveredAdapters = new Set<string>();
  for (const rule of allowRules) {
    if (rule.method !== "eth_signTypedData_v4") {
      issues.push("REDEEM policy must allow only eth_signTypedData_v4.");
      continue;
    }
    const conditions = readPolicyConditions(rule);
    if (
      !hasExactCondition({
        conditions,
        field: "chain_id",
        fieldSource: "ethereum_typed_data_domain",
        value: String(POLYMARKET_POLYGON_CHAIN_ID),
      }) ||
      !hasTypedDataSchema({ conditions, primaryType: "Batch" }) ||
      !hasExactZeroCondition({
        conditions,
        field: "calls.value",
        fieldSource: "ethereum_typed_data_message",
      })
    ) {
      issues.push(
        "REDEEM rule must use the canonical zero-value DepositWallet Batch schema on Polygon.",
      );
      continue;
    }
    const targets = addressConditionValues({
      conditions,
      field: "calls.target",
      fieldSource: "ethereum_typed_data_message",
      operators: ["eq", "in"],
    });
    if (
      targets.length === 0 ||
      targets.some((target) => !allowedAdapters.has(target))
    ) {
      issues.push("REDEEM rule has an unsafe adapter target allowlist.");
      continue;
    }
    for (const target of targets) coveredAdapters.add(target);
  }
  if (
    input.policy.rules.some(
      (candidate) => candidate.action === "ALLOW" && candidate.method === "*",
    )
  ) {
    issues.push("REDEEM policy contains a wildcard ALLOW rule.");
  }
  if (
    input.policy.rules.some(
      (candidate) =>
        candidate.action === "DENY" &&
        (candidate.method === "*" ||
          candidate.method === "eth_signTypedData_v4"),
    )
  ) {
    issues.push("REDEEM policy contains an overlapping DENY rule.");
  }
  for (const adapter of allowedAdapters) {
    if (!coveredAdapters.has(adapter)) {
      issues.push(`DepositWallet REDEEM rule does not cover ${adapter}.`);
    }
  }
  return { issues, valid: issues.length === 0 };
}

function typedDataTypesMatch(
  actual: Record<string, readonly { name: string; type: string }[]>,
  expected: Record<string, readonly TypedDataField[]>,
): boolean {
  return Object.entries(expected).every(([typeName, fields]) =>
    fieldsEqual(normalizeTypedDataFields(actual[typeName]), fields),
  );
}

function numericValue(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function validatePolymarketBotTypedData(input: {
  action?: TradeSide;
  builderCode?: string;
  exchangeAddresses: readonly string[];
  maxBuyUsd: number;
  signer: string;
  typedData: {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
    types: Record<string, readonly { name: string; type: string }[]>;
  };
}): PolicyValidationResult {
  const issues: string[] = [];
  const { domain, message, primaryType, types } = input.typedData;
  if (Number(domain.chainId) !== POLYMARKET_POLYGON_CHAIN_ID) {
    issues.push("Typed data must use Polygon chainId 137.");
  }
  const signer = canonicalEvmAddress(input.signer);
  if (!signer) {
    issues.push("Typed data signer is invalid.");
  }
  if (primaryType === "ClobAuth") {
    if (
      domain.name !== "ClobAuthDomain" ||
      String(domain.version) !== "1" ||
      !typedDataTypesMatch(types, POLYMARKET_AUTH_TYPES) ||
      message.message !== POLYMARKET_AUTH_MESSAGE ||
      !isEvmAddress(String(message.address)) ||
      !signer ||
      !sameAccountAddress("evm:137", String(message.address), signer)
    ) {
      issues.push("Typed data is not canonical Polymarket ClobAuth.");
    }
    return { issues, valid: issues.length === 0 };
  }

  const allowedExchanges = canonicalEvmAddressSet(input.exchangeAddresses);
  const verifyingContract = canonicalEvmAddress(
    String(domain.verifyingContract),
  );
  if (
    domain.name !== "Polymarket CTF Exchange" ||
    String(domain.version) !== "2" ||
    !verifyingContract ||
    !allowedExchanges.has(verifyingContract)
  ) {
    issues.push("Typed data has an invalid Polymarket order domain.");
  }
  const order =
    primaryType === "Order"
      ? message
      : primaryType === "TypedDataSign" && isRecord(message.contents)
        ? message.contents
        : null;
  const expectedTypes =
    primaryType === "Order"
      ? POLYMARKET_ORDER_TYPES
      : primaryType === "TypedDataSign"
        ? POLYMARKET_TYPED_DATA_SIGN_TYPES
        : null;
  if (!order || !expectedTypes || !typedDataTypesMatch(types, expectedTypes)) {
    issues.push("Typed data has an unsupported Polymarket order schema.");
    return { issues, valid: false };
  }
  if (
    primaryType === "TypedDataSign" &&
    (message.name !== "DepositWallet" ||
      String(message.version) !== "1" ||
      Number(message.chainId) !== POLYMARKET_POLYGON_CHAIN_ID)
  ) {
    issues.push("Deposit-wallet wrapper is invalid.");
  }
  const expectedSignatureType = primaryType === "TypedDataSign" ? 3n : 2n;
  const orderSignerMatches =
    primaryType === "TypedDataSign"
      ? isEvmAddress(String(message.verifyingContract)) &&
        isEvmAddress(String(order.signer)) &&
        sameAccountAddress(
          "evm:137",
          String(order.signer),
          String(message.verifyingContract),
        )
      : Boolean(
          signer &&
          isEvmAddress(String(order.signer)) &&
          sameAccountAddress("evm:137", String(order.signer), signer),
        );
  const expectedAction = input.action ?? "BUY";
  const expectedSide = expectedAction === "BUY" ? 0n : 1n;
  if (
    numericValue(order.side) !== expectedSide ||
    numericValue(order.signatureType) !== expectedSignatureType ||
    !orderSignerMatches
  ) {
    issues.push(
      `Polymarket order must be a ${expectedAction} signed by the Trading Wallet.`,
    );
  }
  if (expectedAction === "SELL") {
    const builderCode = normalizeScalar(input.builderCode ?? "");
    if (
      !/^0x[a-f0-9]{64}$/.test(builderCode) ||
      normalizeScalar(String(order.builder ?? "")) !== builderCode
    ) {
      issues.push(
        "Polymarket SELL order must use the canonical Hunch builder.",
      );
    }
  }
  if (expectedAction === "BUY") {
    const makerAmount = numericValue(order.makerAmount);
    const maxMakerAmount = BigInt(Math.round(input.maxBuyUsd * 1_000_000));
    if (
      makerAmount == null ||
      makerAmount < 0n ||
      makerAmount > maxMakerAmount
    ) {
      issues.push("Polymarket order exceeds the configured makerAmount cap.");
    }
  }
  return { issues, valid: issues.length === 0 };
}
