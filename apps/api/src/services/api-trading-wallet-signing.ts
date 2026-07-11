import crypto from "node:crypto";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  PrivyService,
  type PrivyKeyQuorumMetadata,
  type PrivyManagedWalletMetadata,
  type PrivyPolicyMetadata,
  type PrivyUser,
  type PrivyWalletApiClient,
  type PrivyWalletProfile,
} from "../privy-service.js";
import {
  POLYMARKET_AUTH_MESSAGE,
  POLYMARKET_AUTH_TYPES,
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_POLYGON_CHAIN_ID,
  POLYMARKET_TYPED_DATA_SIGN_TYPES,
} from "./polymarket-signing-schema.js";
import type { TradeIntent, TradingVenue } from "./trading-types.js";
import { tradingError } from "./api-trading-utils.js";

export type PrivySignerState =
  | "not_configured"
  | "policy_invalid"
  | "grant_required"
  | "ready"
  | "revoke_required"
  | "unsafe_configuration";

export type PrivyServerSignerGrant = {
  policyIds: string[];
  signerId: string;
  walletAddress: string;
  walletChain: "ethereum";
};

export type PrivyServerSignerStatus = {
  attached: boolean;
  canRemoveAllSigners: boolean;
  grant: PrivyServerSignerGrant | null;
  message: string | null;
  policyId: string | null;
  policyMaxBuyUsd: number | null;
  signerId: string | null;
  state: PrivySignerState;
};

export type PrivySignerInspectorDependencies = {
  classifyWallets: (user: PrivyUser) => PrivyWalletProfile[];
  getKeyQuorumMetadata: (id: string) => Promise<PrivyKeyQuorumMetadata>;
  getManagedWalletMetadata: (
    walletId: string,
  ) => Promise<PrivyManagedWalletMetadata>;
  getPolicyMetadata: (policyId: string) => Promise<PrivyPolicyMetadata>;
  getUserById: (privyUserId: string) => Promise<PrivyUser>;
};

export type PrivyServerSignerConfiguration = {
  authorizationId: string;
  authorizationKey: string;
  exchangeAddresses: [string, string];
  policyId: string;
  policyMaxBuyUsd: number;
  fundingRouterAddress: string;
};

const defaultInspectorDependencies: PrivySignerInspectorDependencies = {
  classifyWallets: (user) => PrivyService.classifyWallets(user),
  getKeyQuorumMetadata: (id) => PrivyService.getKeyQuorumMetadata(id),
  getManagedWalletMetadata: (walletId) =>
    PrivyService.getManagedWalletMetadata(walletId),
  getPolicyMetadata: (policyId) => PrivyService.getPolicyMetadata(policyId),
  getUserById: (privyUserId) => PrivyService.getUserById(privyUserId),
};

type PolicyValidationResult = {
  fundingMaxRaw?: bigint | null;
  issues: string[];
  valid: boolean;
};

type TypedDataField = { name: string; type: string };
const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/;

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

function readPolicyConditions(rule: Record<string, unknown>) {
  return Array.isArray(rule.conditions) ? rule.conditions.filter(isRecord) : [];
}

function conditionValues(input: {
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
    return stringValues(condition.value).map(normalizeScalar);
  });
}

function hasExactCondition(input: {
  conditions: Record<string, unknown>[];
  field: string;
  fieldSource: string;
  value: string;
}): boolean {
  return conditionValues({
    ...input,
    operators: ["eq"],
  }).includes(normalizeScalar(input.value));
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
  primaryType: "ClobAuth" | "Order" | "TypedDataSign";
}): boolean {
  const expectedTypes: Record<string, readonly TypedDataField[]> =
    input.primaryType === "ClobAuth"
      ? POLYMARKET_AUTH_TYPES
      : input.primaryType === "Order"
        ? POLYMARKET_ORDER_TYPES
        : POLYMARKET_TYPED_DATA_SIGN_TYPES;
  return input.conditions.some((condition) => {
    if (condition.field_source !== "ethereum_typed_data_message") return false;
    const typedData = condition.typed_data;
    if (!isRecord(typedData)) return false;
    if (typedData.primary_type !== input.primaryType) return false;
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
  const values = conditionValues({
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

function readExactFundingRuleCap(input: {
  conditions: Record<string, unknown>[];
  routerAddress: string;
}): bigint | null {
  const transactionConditions = [
    ["chain_id", String(POLYMARKET_POLYGON_CHAIN_ID)],
    ["to", input.routerAddress],
    ["value", "0x0"],
  ] as const;
  if (
    !transactionConditions.every(([field, value]) =>
      hasExactCondition({
        conditions: input.conditions,
        field,
        fieldSource: "ethereum_transaction",
        value,
      }),
    )
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

export function validatePolymarketBotPolicy(input: {
  exchangeAddresses: readonly string[];
  fundingRouterAddress: string;
  maxBuyUsd: number;
  policy: PrivyPolicyMetadata;
}): PolicyValidationResult {
  const issues: string[] = [];
  if (input.policy.chainType !== "ethereum") {
    issues.push("Policy chain type must be ethereum (EVM). ");
  }
  if (!Number.isFinite(input.maxBuyUsd) || input.maxBuyUsd <= 0) {
    issues.push("Policy max buy must be positive.");
  }
  const normalizedFundingRouter = normalizeScalar(input.fundingRouterAddress);
  if (!EVM_ADDRESS_RE.test(normalizedFundingRouter)) {
    issues.push("Funding router address must be configured.");
  }
  const allowedExchangeAddresses = new Set(
    input.exchangeAddresses.map(normalizeScalar).filter(Boolean),
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
      const ruleFundingMaxRaw = readExactFundingRuleCap({
        conditions,
        routerAddress: normalizedFundingRouter,
      });
      if (fundingCovered || ruleFundingMaxRaw == null) {
        issues.push("Funding ALLOW rule is missing or unsafe.");
      } else {
        fundingCovered = true;
        fundingMaxRaw = ruleFundingMaxRaw;
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

    const primaryType = hasTypedDataSchema({
      conditions,
      primaryType: "Order",
    })
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
    issues,
    valid: issues.length === 0,
  };
}

const POLICY_FUNDING_CAP_CACHE_TTL_MS = 15_000;
let policyFundingCapCache: {
  expiresAt: number;
  key: string;
  value: Promise<bigint>;
} | null = null;

export async function resolvePolymarketBotPolicyFundingCapRaw(): Promise<bigint> {
  const policyId = env.privyPolymarketBotBuyPolicyId.trim();
  const fundingRouterAddress = env.polymarketFundingRouterAddress.trim();
  const policyMaxBuyUsd = env.privyPolymarketBotBuyPolicyMaxUsd;
  const exchangeAddresses = [
    env.polymarketExchangeAddress,
    env.polymarketNegRiskExchangeAddress,
  ] as const;
  if (!policyId || !fundingRouterAddress || policyMaxBuyUsd <= 0) {
    throw new Error("Polymarket bot policy configuration is incomplete.");
  }
  const key = [
    policyId,
    fundingRouterAddress.toLowerCase(),
    String(policyMaxBuyUsd),
    ...exchangeAddresses.map((address) => address.toLowerCase()),
  ].join("|");
  const now = Date.now();
  if (
    policyFundingCapCache?.key === key &&
    policyFundingCapCache.expiresAt > now
  ) {
    return policyFundingCapCache.value;
  }

  const value = (async () => {
    const policy = await PrivyService.getPolicyMetadata(policyId);
    const validation = validatePolymarketBotPolicy({
      exchangeAddresses,
      fundingRouterAddress,
      maxBuyUsd: policyMaxBuyUsd,
      policy,
    });
    if (
      policy.id !== policyId ||
      !validation.valid ||
      validation.fundingMaxRaw == null
    ) {
      throw new Error("Configured Privy Polymarket policy is unsafe.");
    }
    return validation.fundingMaxRaw;
  })();
  policyFundingCapCache = {
    expiresAt: now + POLICY_FUNDING_CAP_CACHE_TTL_MS,
    key,
    value,
  };
  try {
    return await value;
  } catch (error) {
    if (policyFundingCapCache?.value === value) policyFundingCapCache = null;
    throw error;
  }
}

function normalizePublicKey(publicKey: string): string {
  const trimmed = publicKey.trim().replace(/^wallet-auth:/, "");
  if (!trimmed) return "";
  try {
    const key = trimmed.includes("BEGIN PUBLIC KEY")
      ? crypto.createPublicKey(trimmed)
      : crypto.createPublicKey({
          format: "der",
          key: Buffer.from(trimmed, "base64"),
          type: "spki",
        });
    return key.export({ format: "der", type: "spki" }).toString("base64");
  } catch {
    return trimmed;
  }
}

export function derivePrivyAuthorizationPublicKey(
  authorizationPrivateKey: string,
): string {
  const encoded = authorizationPrivateKey.trim().replace(/^wallet-auth:/, "");
  if (!encoded) throw new Error("Privy authorization private key is empty.");
  const privateKey = crypto.createPrivateKey({
    format: "der",
    key: Buffer.from(encoded, "base64"),
    type: "pkcs8",
  });
  return crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
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
  const signer = input.signer.trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(signer))
    issues.push("Typed data signer is invalid.");

  if (primaryType === "ClobAuth") {
    if (
      domain.name !== "ClobAuthDomain" ||
      String(domain.version) !== "1" ||
      !typedDataTypesMatch(types, POLYMARKET_AUTH_TYPES) ||
      message.message !== POLYMARKET_AUTH_MESSAGE ||
      String(message.address).toLowerCase() !== signer
    ) {
      issues.push("Typed data is not canonical Polymarket ClobAuth.");
    }
    return { issues, valid: issues.length === 0 };
  }

  const allowedExchanges = new Set(
    input.exchangeAddresses.map((address) => address.trim().toLowerCase()),
  );
  if (
    domain.name !== "Polymarket CTF Exchange" ||
    String(domain.version) !== "2" ||
    !allowedExchanges.has(String(domain.verifyingContract).toLowerCase())
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
      ? EVM_ADDRESS_RE.test(String(message.verifyingContract).toLowerCase()) &&
        String(order.signer).toLowerCase() ===
          String(message.verifyingContract).toLowerCase()
      : EVM_ADDRESS_RE.test(String(order.signer).toLowerCase()) &&
        String(order.signer).toLowerCase() === signer;
  if (
    numericValue(order.side) !== 0n ||
    numericValue(order.signatureType) !== expectedSignatureType ||
    !orderSignerMatches
  ) {
    issues.push("Polymarket order must be a BUY signed by the Trading Wallet.");
  }
  const makerAmount = numericValue(order.makerAmount);
  const maxMakerAmount = BigInt(Math.round(input.maxBuyUsd * 1_000_000));
  if (makerAmount == null || makerAmount < 0n || makerAmount > maxMakerAmount) {
    issues.push("Polymarket order exceeds the configured makerAmount cap.");
  }
  return { issues, valid: issues.length === 0 };
}

function signerStatus(
  input: Partial<PrivyServerSignerStatus> & {
    state: PrivySignerState;
  },
): PrivyServerSignerStatus {
  return {
    attached: input.attached ?? false,
    canRemoveAllSigners: input.canRemoveAllSigners ?? false,
    grant: input.grant ?? null,
    message: input.message ?? null,
    policyId: input.policyId ?? null,
    policyMaxBuyUsd: input.policyMaxBuyUsd ?? null,
    signerId: input.signerId ?? null,
    state: input.state,
  };
}

export async function inspectServerEvmWalletAuthorization(input: {
  authorizationEnabled: boolean;
  configuration?: PrivyServerSignerConfiguration;
  dependencies?: PrivySignerInspectorDependencies;
  privyUserId: string | null | undefined;
  signer: string;
  walletId: string;
}): Promise<PrivyServerSignerStatus> {
  const configuration = input.configuration ?? {
    authorizationId: env.privyWalletAuthorizationId,
    authorizationKey: env.privyWalletAuthorizationKey,
    exchangeAddresses: [
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
    ],
    policyId: env.privyPolymarketBotBuyPolicyId,
    policyMaxBuyUsd: env.privyPolymarketBotBuyPolicyMaxUsd,
    fundingRouterAddress: env.polymarketFundingRouterAddress,
  };
  const signerId = configuration.authorizationId.trim();
  const policyId = configuration.policyId.trim();
  const policyMaxBuyUsd = configuration.policyMaxBuyUsd;
  const common = { policyId, policyMaxBuyUsd, signerId };
  if (
    !signerId ||
    !configuration.authorizationKey ||
    !policyId ||
    policyMaxBuyUsd <= 0 ||
    !configuration.fundingRouterAddress
  ) {
    return signerStatus({
      ...common,
      message: "Server-side Polymarket signer configuration is incomplete.",
      state: "not_configured",
    });
  }

  const privyUserId = input.privyUserId?.trim() ?? "";
  const walletId = input.walletId.trim();
  const walletAddress = input.signer.trim().toLowerCase();
  if (!privyUserId || !walletId || !walletAddress) {
    return signerStatus({
      ...common,
      message: "Trading Wallet ownership information is incomplete.",
      state: "unsafe_configuration",
    });
  }

  const dependencies = input.dependencies ?? defaultInspectorDependencies;
  let derivedPublicKey: string;
  try {
    derivedPublicKey = derivePrivyAuthorizationPublicKey(
      configuration.authorizationKey,
    );
  } catch {
    return signerStatus({
      ...common,
      message: "Configured Privy authorization key is invalid.",
      state: "policy_invalid",
    });
  }

  let user: PrivyUser;
  let wallet: PrivyManagedWalletMetadata;
  let quorum: PrivyKeyQuorumMetadata;
  let policy: PrivyPolicyMetadata;
  try {
    [user, wallet, quorum, policy] = await Promise.all([
      dependencies.getUserById(privyUserId),
      dependencies.getManagedWalletMetadata(walletId),
      dependencies.getKeyQuorumMetadata(signerId),
      dependencies.getPolicyMetadata(policyId),
    ]);
  } catch {
    return signerStatus({
      ...common,
      message: "Privy signer configuration could not be verified.",
      state: "policy_invalid",
    });
  }

  // Privy Wallet API owner_id is a key-quorum ID, not the user's did:privy ID.
  // Establish user ownership from the authenticated user's internal wallets.
  const ownedWallet = dependencies
    .classifyWallets(user)
    .find(
      (candidate) =>
        candidate.walletType === "ethereum" &&
        candidate.isInternalWallet &&
        candidate.address.toLowerCase() === walletAddress &&
        candidate.walletId?.trim() === walletId,
    );
  if (
    !ownedWallet ||
    wallet.id !== walletId ||
    wallet.chainType !== "ethereum" ||
    wallet.address.toLowerCase() !== walletAddress
  ) {
    return signerStatus({
      ...common,
      message:
        "Selected Trading Wallet does not match the authenticated Privy user.",
      state: "unsafe_configuration",
    });
  }

  const matchingSigners = wallet.additionalSigners.filter(
    (candidate) => candidate.signerId === signerId,
  );
  const foreignSigners = wallet.additionalSigners.filter(
    (candidate) => candidate.signerId !== signerId,
  );
  const canRemoveAllSigners =
    foreignSigners.length === 0 && matchingSigners.length <= 1;
  const grant: PrivyServerSignerGrant = {
    policyIds: [policyId],
    signerId,
    walletAddress,
    walletChain: "ethereum",
  };
  if (foreignSigners.length > 0 || matchingSigners.length > 1) {
    return signerStatus({
      ...common,
      attached: matchingSigners.length > 0,
      canRemoveAllSigners: false,
      grant,
      message:
        "Trading Wallet contains foreign or duplicate additional signers.",
      state: "unsafe_configuration",
    });
  }
  const matchingSigner = matchingSigners[0];
  if (
    matchingSigner &&
    (matchingSigner.overridePolicyIds.length !== 1 ||
      matchingSigner.overridePolicyIds[0] !== policyId)
  ) {
    return signerStatus({
      ...common,
      attached: true,
      canRemoveAllSigners,
      grant,
      message: "Hunch signer is attached with an unexpected Privy policy.",
      state: "unsafe_configuration",
    });
  }

  if (
    quorum.id !== signerId ||
    quorum.authorizationThreshold !== 1 ||
    quorum.authorizationPublicKeys.length !== 1 ||
    quorum.nestedKeyQuorumIds.length !== 0 ||
    quorum.userIds.length !== 0 ||
    !quorum.authorizationPublicKeys.some(
      (publicKey) =>
        normalizePublicKey(publicKey) === normalizePublicKey(derivedPublicKey),
    )
  ) {
    return signerStatus({
      ...common,
      attached: Boolean(matchingSigner),
      canRemoveAllSigners,
      grant,
      message: "Configured Privy authorization key does not match its quorum.",
      state: "policy_invalid",
    });
  }
  const policyValidation = validatePolymarketBotPolicy({
    exchangeAddresses: configuration.exchangeAddresses,
    fundingRouterAddress: configuration.fundingRouterAddress,
    maxBuyUsd: policyMaxBuyUsd,
    policy,
  });
  if (policy.id !== policyId || !policyValidation.valid) {
    return signerStatus({
      ...common,
      attached: Boolean(matchingSigner),
      canRemoveAllSigners,
      grant,
      message: "Configured Privy Polymarket policy is missing or unsafe.",
      state: "policy_invalid",
    });
  }

  if (!matchingSigner) {
    return signerStatus({
      ...common,
      canRemoveAllSigners,
      grant,
      message: "Grant bot access to this Trading Wallet in Hunch Settings.",
      state: "grant_required",
    });
  }
  if (!input.authorizationEnabled) {
    return signerStatus({
      ...common,
      attached: true,
      canRemoveAllSigners,
      grant,
      message: "Bot access is still attached and must be revoked.",
      state: "revoke_required",
    });
  }
  return signerStatus({
    ...common,
    attached: true,
    canRemoveAllSigners,
    grant,
    state: "ready",
  });
}

export function getPrivyWalletId(intent: TradeIntent): string {
  const walletId =
    typeof intent.executionAuthorization?.privyWalletId === "string"
      ? intent.executionAuthorization.privyWalletId.trim()
      : isRecord(intent.raw) && typeof intent.raw.privyWalletId === "string"
        ? intent.raw.privyWalletId.trim()
        : "";
  if (!walletId) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Privy wallet id is required for bot trading.",
      venue: intent.venue,
    });
  }
  return walletId;
}

export function hasServerWalletClientConfig(): boolean {
  return Boolean(
    env.privyWalletAuthorizationId &&
    env.privyWalletAuthorizationKey &&
    env.privyPolymarketBotBuyPolicyId &&
    env.privyPolymarketBotBuyPolicyMaxUsd > 0 &&
    env.polymarketFundingRouterAddress,
  );
}

export function createServerWalletClient(): PrivyWalletApiClient {
  if (!hasServerWalletClientConfig()) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Server-side Privy wallet authorization is not configured.",
      statusCode: 503,
    });
  }
  return PrivyService.createClient({
    walletAuthorizationKey: env.privyWalletAuthorizationKey,
  });
}

export async function assertServerEvmWalletOwnership(input: {
  dependencies?: Pick<
    PrivySignerInspectorDependencies,
    "classifyWallets" | "getUserById"
  >;
  privyUserId: string | null | undefined;
  signer: string;
  walletId: string;
}): Promise<void> {
  const privyUserId = input.privyUserId?.trim() ?? "";
  if (!privyUserId) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Trading authorization is missing a Privy user id.",
    });
  }
  const walletId = input.walletId.trim();
  const signer = input.signer.trim().toLowerCase();
  const dependencies = input.dependencies ?? defaultInspectorDependencies;
  const privyUser = await dependencies.getUserById(privyUserId);
  const wallet = dependencies
    .classifyWallets(privyUser)
    .find(
      (candidate) =>
        candidate.walletType === "ethereum" &&
        candidate.isInternalWallet &&
        candidate.address.toLowerCase() === signer,
    );
  if (!wallet || wallet.walletId?.trim() !== walletId) {
    throw tradingError({
      code: "insufficient_readiness",
      message:
        "Selected Trading Wallet does not match its Privy authorization.",
    });
  }
}

export async function assertServerEvmWalletAuthorization(input: {
  privyUserId: string | null | undefined;
  signer: string;
  venue: TradingVenue;
  walletId: string;
}): Promise<void> {
  if (input.venue !== "polymarket") {
    throw tradingError({
      code: "privy_policy_unsupported_for_venue",
      message: `Server-side Privy policy is not enabled for ${input.venue}.`,
      venue: input.venue,
    });
  }
  const status = await inspectServerEvmWalletAuthorization({
    authorizationEnabled: true,
    privyUserId: input.privyUserId,
    signer: input.signer,
    walletId: input.walletId,
  });
  if (status.state !== "ready") {
    throw tradingError({
      code: `privy_server_signer_${status.state}`,
      message: status.message ?? "Privy server signer is not ready.",
      venue: input.venue,
    });
  }
}

export async function signEvmTypedData(input: {
  walletClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  typedData: {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
    types: Record<string, readonly { name: string; type: string }[]>;
  };
}): Promise<string> {
  const validation = validatePolymarketBotTypedData({
    exchangeAddresses: [
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
    ],
    maxBuyUsd: env.privyPolymarketBotBuyPolicyMaxUsd,
    signer: input.signer,
    typedData: input.typedData,
  });
  if (!validation.valid) {
    throw tradingError({
      code: "privy_polymarket_typed_data_rejected",
      message:
        "Server signer rejected typed data outside the Polymarket BUY policy.",
      venue: "polymarket",
    });
  }
  const result = await input.walletClient.walletApi.ethereum.signTypedData({
    walletId: input.walletId,
    address: input.signer,
    chainType: "ethereum",
    typedData: input.typedData,
  });
  return result.signature;
}

export async function signEvmMessage(input: {
  walletClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  message: string | Uint8Array;
}): Promise<string> {
  const result = await input.walletClient.walletApi.ethereum.signMessage({
    walletId: input.walletId,
    address: input.signer,
    chainType: "ethereum",
    message: input.message,
  });
  return result.signature;
}
