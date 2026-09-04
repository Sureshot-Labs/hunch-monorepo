import { createHash } from "node:crypto";
import { ethers } from "ethers";
import type { Pool } from "pg";

import { AuthService } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { loadFundingLifecycleProjectionForOperation } from "../funding/lifecycle/funding-lifecycle-read-model.js";
import type { EmbeddedEthereumTransactionSpec } from "./embedded-ethereum.js";

const POLYGON_CHAIN_ID = 137;
const BASE_CHAIN_ID = 8453;
const MAX_SPONSORED_GAS_LIMIT = 5_000_000n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const DEAD_ADDRESS = `0x${"00".repeat(19)}dead`;
const LEGACY_WITHDRAWAL_TRANSACTION_ID = "bridge-transfer";
const LEGACY_WITHDRAWAL_TRANSACTION_LABEL = "Bridge transfer";
const DIRECT_TRANSFER_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161]);

const erc20Interface = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
  "function transfer(address recipient,uint256 amount)",
]);
const erc1155Interface = new ethers.Interface([
  "function setApprovalForAll(address operator,bool approved)",
]);
const collateralInterface = new ethers.Interface([
  "function wrap(address asset,address recipient,uint256 amount)",
  "function unwrap(address asset,address recipient,uint256 amount)",
]);
const polymarketFundingRouterInterface = new ethers.Interface([
  "function fund(uint256 expectedNonce,uint256 totalAmount,uint256 pUsdAmount)",
]);
const conditionalTokensInterface = new ethers.Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
]);
const limitlessNegRiskInterface = new ethers.Interface([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
]);
const limitlessAmmInterface = new ethers.Interface([
  "function buy(uint256 investmentAmount,uint256 outcomeIndex,uint256 minOutcomeTokens)",
  "function sell(uint256 returnAmount,uint256 outcomeIndex,uint256 maxOutcomeTokens)",
]);

type SponsorshipDb = Pick<Pool, "query">;

type SponsoredTransaction = Readonly<{
  chainId: number;
  signer: string;
  transaction: EmbeddedEthereumTransactionSpec;
  userId: string;
}>;

export type EmbeddedEvmSponsorshipDependencies = Readonly<{
  isAuthorizedDestination: (address: string) => Promise<boolean>;
  isKnownLimitlessMarket: (address: string) => Promise<boolean>;
  isKnownLimitlessNegRiskAdapter: (address: string) => Promise<boolean>;
  isKnownLimitlessNegRiskRedemption: (
    adapterAddress: string,
    conditionId: string,
  ) => Promise<boolean>;
  isSupportedBridgeToken: (
    chainId: number,
    address: string,
  ) => Promise<boolean>;
  matchesBridgeOrder: (transaction: SponsoredTransaction) => Promise<boolean>;
  matchesFundingAction: (transaction: SponsoredTransaction) => Promise<boolean>;
  matchesPositionAction: (
    transaction: SponsoredTransaction,
  ) => Promise<boolean>;
}>;

function normalizedAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function addressesEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizedAddress(left);
  const normalizedRight = normalizedAddress(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft.toLowerCase() === normalizedRight.toLowerCase(),
  );
}

function normalizeData(value: string | null | undefined): string {
  const data = value?.trim() || "0x";
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error("Sponsored EVM transaction calldata is invalid.");
  }
  if (data.length > 65_538) {
    throw new Error("Sponsored EVM transaction calldata is too large.");
  }
  return data.toLowerCase();
}

function quantity(value: string | null | undefined, label: string): bigint {
  const raw = value?.trim();
  if (!raw) return 0n;
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(raw)) {
    throw new Error(`${label} is invalid.`);
  }
  const parsed = BigInt(raw);
  if (parsed < 0n) throw new Error(`${label} is invalid.`);
  return parsed;
}

function transactionValue(transaction: EmbeddedEthereumTransactionSpec) {
  return quantity(transaction.value, "Sponsored EVM transaction value");
}

function transactionGas(transaction: EmbeddedEthereumTransactionSpec) {
  const gas = quantity(transaction.gas, "Sponsored EVM gas limit");
  if (gas > MAX_SPONSORED_GAS_LIMIT) {
    throw new Error("Sponsored EVM gas limit is too high.");
  }
  return gas;
}

function parsedTransaction(
  iface: ethers.Interface,
  transaction: EmbeddedEthereumTransactionSpec,
): ethers.TransactionDescription | null {
  try {
    return iface.parseTransaction({
      data: normalizeData(transaction.data),
      value: transactionValue(transaction),
    });
  } catch {
    return null;
  }
}

function positiveBigInt(value: unknown): bigint | null {
  try {
    const parsed = BigInt(String(value));
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function isNonBurnAddress(value: string | null | undefined): boolean {
  const normalized = normalizedAddress(value)?.toLowerCase();
  return Boolean(
    normalized && normalized !== ZERO_ADDRESS && normalized !== DEAD_ADDRESS,
  );
}

function addressSet(values: Array<string | null | undefined>): Set<string> {
  return new Set(
    values
      .map(normalizedAddress)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
}

function polymarketOperators(): Set<string> {
  return addressSet([
    env.polymarketExchangeAddress,
    env.polymarketNegRiskExchangeAddress,
    env.polymarketNegRiskAdapterAddress,
    env.polymarketCtfCollateralAdapterAddress,
    env.polymarketNegRiskCollateralAdapterAddress,
    env.polymarketCollateralOnrampAddress,
    env.polymarketCollateralOfframpAddress,
    env.polymarketFundingRouterAddress,
    env.feeCollectorAddress,
    env.feeCollectorLegacyAddress,
  ]);
}

function limitlessOperators(): Set<string> {
  return addressSet([
    env.limitlessClobAddress,
    env.limitlessNegRiskAddress,
    env.limitlessNegRiskRequestAddress,
  ]);
}

function isNonPayable(transaction: EmbeddedEthereumTransactionSpec): boolean {
  return transactionValue(transaction) === 0n;
}

async function isAllowedOperator(input: {
  address: string;
  staticOperators: Set<string>;
  dependencies: EmbeddedEvmSponsorshipDependencies;
}): Promise<boolean> {
  const operator = normalizedAddress(input.address);
  if (!operator) return false;
  return (
    input.staticOperators.has(operator.toLowerCase()) ||
    (await input.dependencies.isKnownLimitlessMarket(operator))
  );
}

async function validateErc20Call(input: {
  chainId: number;
  dependencies: EmbeddedEvmSponsorshipDependencies;
  transaction: EmbeddedEthereumTransactionSpec;
}): Promise<boolean> {
  const decoded = parsedTransaction(erc20Interface, input.transaction);
  if (!decoded || !isNonPayable(input.transaction)) return false;
  const target = normalizedAddress(input.transaction.to);
  if (!target) return false;

  if (decoded.name === "transfer") {
    const recipient = normalizedAddress(String(decoded.args[0] ?? ""));
    const amount = positiveBigInt(decoded.args[1]);
    return Boolean(
      recipient &&
      amount &&
      DIRECT_TRANSFER_CHAIN_IDS.has(input.chainId) &&
      (await input.dependencies.isSupportedBridgeToken(
        input.chainId,
        target,
      )) &&
      (await input.dependencies.isAuthorizedDestination(recipient)),
    );
  }

  if (decoded.name !== "approve" || !positiveBigInt(decoded.args[1])) {
    return false;
  }
  const spender = normalizedAddress(String(decoded.args[0] ?? ""));
  if (!spender) return false;

  if (input.chainId === POLYGON_CHAIN_ID) {
    const supportedTokens = addressSet([
      env.polymarketPusdAddress,
      env.polymarketUsdceAddress,
    ]);
    return (
      supportedTokens.has(target.toLowerCase()) &&
      polymarketOperators().has(spender.toLowerCase())
    );
  }

  if (
    input.chainId === BASE_CHAIN_ID &&
    addressesEqual(target, env.limitlessUsdcAddress)
  ) {
    return isAllowedOperator({
      address: spender,
      staticOperators: limitlessOperators(),
      dependencies: input.dependencies,
    });
  }

  return false;
}

async function validateApprovalForAll(input: {
  chainId: number;
  dependencies: EmbeddedEvmSponsorshipDependencies;
  transaction: EmbeddedEthereumTransactionSpec;
}): Promise<boolean> {
  const decoded = parsedTransaction(erc1155Interface, input.transaction);
  if (
    !decoded ||
    decoded.name !== "setApprovalForAll" ||
    !isNonPayable(input.transaction) ||
    decoded.args[1] !== true
  ) {
    return false;
  }
  const target = normalizedAddress(input.transaction.to);
  const operator = normalizedAddress(String(decoded.args[0] ?? ""));
  if (!target || !operator) return false;

  if (
    input.chainId === POLYGON_CHAIN_ID &&
    addressesEqual(target, env.polymarketConditionalTokensAddress)
  ) {
    return polymarketOperators().has(operator.toLowerCase());
  }
  if (
    input.chainId === BASE_CHAIN_ID &&
    addressesEqual(target, env.limitlessConditionalTokensAddress)
  ) {
    return (
      (await isAllowedOperator({
        address: operator,
        staticOperators: limitlessOperators(),
        dependencies: input.dependencies,
      })) || (await input.dependencies.isKnownLimitlessNegRiskAdapter(operator))
    );
  }
  return false;
}

async function validatePolymarketProtocolCall(input: {
  dependencies: EmbeddedEvmSponsorshipDependencies;
  transaction: EmbeddedEthereumTransactionSpec;
}): Promise<boolean> {
  if (!isNonPayable(input.transaction)) return false;
  const target = normalizedAddress(input.transaction.to);
  if (!target) return false;

  const conversion = parsedTransaction(collateralInterface, input.transaction);
  if (conversion && ["wrap", "unwrap"].includes(conversion.name)) {
    const expectedTarget =
      conversion.name === "wrap"
        ? env.polymarketCollateralOnrampAddress
        : env.polymarketCollateralOfframpAddress;
    const asset = normalizedAddress(String(conversion.args[0] ?? ""));
    const recipient = normalizedAddress(String(conversion.args[1] ?? ""));
    const amount = positiveBigInt(conversion.args[2]);
    return Boolean(
      addressesEqual(target, expectedTarget) &&
      addressesEqual(asset, env.polymarketUsdceAddress) &&
      recipient &&
      amount &&
      (await input.dependencies.isAuthorizedDestination(recipient)),
    );
  }

  const funding = parsedTransaction(
    polymarketFundingRouterInterface,
    input.transaction,
  );
  if (funding?.name === "fund") {
    const totalAmount = positiveBigInt(funding.args[1]);
    const pUsdAmount = positiveBigInt(funding.args[2]) ?? 0n;
    return Boolean(
      env.polymarketFundingRouterAddress &&
      addressesEqual(target, env.polymarketFundingRouterAddress) &&
      totalAmount &&
      pUsdAmount <= totalAmount,
    );
  }

  const redemption = parsedTransaction(
    conditionalTokensInterface,
    input.transaction,
  );
  if (redemption?.name === "redeemPositions") {
    const collateral = normalizedAddress(String(redemption.args[0] ?? ""));
    const parentCollectionId = String(redemption.args[1] ?? "").toLowerCase();
    const indexSets = Array.from(redemption.args[3] ?? []) as bigint[];
    return (
      addressesEqual(target, env.polymarketCtfCollateralAdapterAddress) &&
      addressesEqual(collateral, env.polymarketUsdceAddress) &&
      parentCollectionId === ZERO_BYTES32 &&
      indexSets.length > 0 &&
      indexSets.every((entry) => entry === 1n || entry === 2n || entry === 3n)
    );
  }

  return false;
}

async function validateLimitlessProtocolCall(input: {
  dependencies: EmbeddedEvmSponsorshipDependencies;
  transaction: EmbeddedEthereumTransactionSpec;
}): Promise<boolean> {
  if (!isNonPayable(input.transaction)) return false;
  const target = normalizedAddress(input.transaction.to);
  if (!target) return false;

  const amm = parsedTransaction(limitlessAmmInterface, input.transaction);
  if (amm && ["buy", "sell"].includes(amm.name)) {
    const amount = positiveBigInt(amm.args[0]);
    const outcomeIndex = positiveBigInt(amm.args[1]) ?? 0n;
    const limit = positiveBigInt(amm.args[2]);
    return Boolean(
      amount &&
      (outcomeIndex === 0n || outcomeIndex === 1n) &&
      limit &&
      (await input.dependencies.isKnownLimitlessMarket(target)),
    );
  }

  const standardRedemption = parsedTransaction(
    conditionalTokensInterface,
    input.transaction,
  );
  if (standardRedemption?.name === "redeemPositions") {
    const collateral = normalizedAddress(
      String(standardRedemption.args[0] ?? ""),
    );
    const parentCollectionId = String(
      standardRedemption.args[1] ?? "",
    ).toLowerCase();
    const indexSets = Array.from(standardRedemption.args[3] ?? []) as bigint[];
    return (
      addressesEqual(target, env.limitlessConditionalTokensAddress) &&
      addressesEqual(collateral, env.limitlessUsdcAddress) &&
      parentCollectionId === ZERO_BYTES32 &&
      indexSets.length > 0 &&
      indexSets.every((entry) => entry === 1n || entry === 2n)
    );
  }

  const negRiskRedemption = parsedTransaction(
    limitlessNegRiskInterface,
    input.transaction,
  );
  if (negRiskRedemption?.name === "redeemPositions") {
    const conditionId = String(negRiskRedemption.args[0] ?? "");
    const amounts = Array.from(negRiskRedemption.args[1] ?? []) as bigint[];
    return (
      amounts.length === 2 &&
      amounts.some((entry) => entry > 0n) &&
      (await input.dependencies.isKnownLimitlessNegRiskRedemption(
        target,
        conditionId,
      ))
    );
  }

  return false;
}

async function validateNativeTransfer(input: {
  chainId: number;
  dependencies: EmbeddedEvmSponsorshipDependencies;
  transaction: EmbeddedEthereumTransactionSpec;
}): Promise<boolean> {
  return (
    DIRECT_TRANSFER_CHAIN_IDS.has(input.chainId) &&
    normalizeData(input.transaction.data) === "0x" &&
    transactionValue(input.transaction) > 0n &&
    (await input.dependencies.isAuthorizedDestination(input.transaction.to))
  );
}

/**
 * Compatibility contract for the previous web bundle's embedded-wallet
 * withdrawal path. The old client cannot create a FundingOperation yet and
 * identifies this operation only through one exact, user-authorized transfer
 * payload. Keep this separate from the general destination allowlist so it
 * cannot authorize arbitrary contract calls.
 */
async function validateLegacySponsoredWithdrawal(input: {
  chainId: number;
  dependencies: EmbeddedEvmSponsorshipDependencies;
  executionMode: "sequential" | "atomic";
  transactions: readonly EmbeddedEthereumTransactionSpec[];
}): Promise<boolean> {
  if (input.executionMode !== "sequential" || input.transactions.length !== 1) {
    return false;
  }
  const transaction = input.transactions[0];
  if (
    !transaction ||
    transaction.id !== LEGACY_WITHDRAWAL_TRANSACTION_ID ||
    transaction.label !== LEGACY_WITHDRAWAL_TRANSACTION_LABEL ||
    transaction.sponsor === false ||
    !DIRECT_TRANSFER_CHAIN_IDS.has(input.chainId)
  ) {
    return false;
  }

  const decoded = parsedTransaction(erc20Interface, transaction);
  if (decoded?.name === "transfer" && isNonPayable(transaction)) {
    const token = normalizedAddress(transaction.to);
    const recipient = normalizedAddress(String(decoded.args[0] ?? ""));
    const amount = positiveBigInt(decoded.args[1]);
    return Boolean(
      token &&
      recipient &&
      isNonBurnAddress(recipient) &&
      amount &&
      (await input.dependencies.isSupportedBridgeToken(input.chainId, token)),
    );
  }

  return (
    normalizeData(transaction.data) === "0x" &&
    transactionValue(transaction) > 0n &&
    isNonBurnAddress(transaction.to)
  );
}

function exactTransactionMatches(
  chainId: number,
  transaction: EmbeddedEthereumTransactionSpec,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  const payloadChainId =
    candidate.chainId == null ? chainId : Number(candidate.chainId);
  if (payloadChainId !== chainId) return false;
  if (!addressesEqual(String(candidate.to ?? ""), transaction.to)) return false;
  try {
    if (
      normalizeData(
        typeof candidate.data === "string" ? candidate.data : "0x",
      ) !== normalizeData(transaction.data)
    ) {
      return false;
    }
    if (
      quantity(
        typeof candidate.value === "string" ? candidate.value : null,
        "Bridge transaction value",
      ) !== transactionValue(transaction)
    ) {
      return false;
    }
    const candidateGas = quantity(
      typeof candidate.gas === "string" ? candidate.gas : null,
      "Bridge transaction gas",
    );
    return candidateGas === transactionGas(transaction);
  } catch {
    return false;
  }
}

function readNestedRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function readPositiveRaw(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return positiveBigInt(value);
}

async function matchesBridgeOrder(
  db: SponsorshipDb,
  input: SponsoredTransaction,
): Promise<boolean> {
  const { rows } = await db.query<{
    amount_in: string;
    metadata: Record<string, unknown> | null;
    src_chain_id: string;
    src_token: string;
  }>(
    `
      select src_chain_id, src_token, amount_in, metadata
      from bridge_orders
      where user_id = $1
        and src_chain_id = $2
        and created_at >= now() - interval '30 minutes'
        and status in ('created', 'submitted')
      order by created_at desc
      limit 20
    `,
    [input.userId, String(input.chainId)],
  );

  for (const row of rows) {
    const metadata = row.metadata ?? {};
    const senderAddress =
      typeof metadata.senderAddress === "string"
        ? metadata.senderAddress
        : readNestedRecord(metadata, ["across"])?.senderAddress;
    if (
      typeof senderAddress === "string" &&
      !addressesEqual(senderAddress, input.signer)
    ) {
      continue;
    }
    if (
      exactTransactionMatches(input.chainId, input.transaction, metadata.tx)
    ) {
      return true;
    }
    const providerApprovals = readNestedRecord(metadata, [
      "across",
    ])?.approvalTxns;
    if (
      Array.isArray(providerApprovals) &&
      providerApprovals.some((entry) =>
        exactTransactionMatches(input.chainId, input.transaction, entry),
      )
    ) {
      return true;
    }

    const decoded = parsedTransaction(erc20Interface, input.transaction);
    const tx = readNestedRecord(metadata, ["tx"]);
    if (
      decoded?.name !== "approve" ||
      !tx ||
      !addressesEqual(input.transaction.to, row.src_token) ||
      !addressesEqual(String(decoded.args[0] ?? ""), String(tx.to ?? ""))
    ) {
      continue;
    }
    const estimationAmount = readPositiveRaw(
      readNestedRecord(metadata, ["estimation", "srcChainTokenIn"])?.amount,
    );
    const tokenInAmount = readPositiveRaw(
      readNestedRecord(metadata, ["tokenIn"])?.amount,
    );
    const baseAmount =
      estimationAmount ?? tokenInAmount ?? readPositiveRaw(row.amount_in);
    const approvedAmount = positiveBigInt(decoded.args[1]);
    if (!baseAmount || !approvedAmount) continue;
    const expectedBuffer = baseAmount + (baseAmount * 100n + 9_999n) / 10_000n;
    if (approvedAmount === expectedBuffer) return true;
  }
  return false;
}

async function matchesFundingAction(
  db: SponsorshipDb,
  input: SponsoredTransaction,
): Promise<boolean> {
  const { rows } = await db.query<{
    normalized_action: Record<string, unknown>;
    operation_id: string;
    step_id: string;
  }>(
    `
      select step.normalized_action, operation.id as operation_id, step.id as step_id
      from funding_operation_steps step
      join funding_operations operation on operation.id = step.operation_id
      where operation.user_id = $1
        and (
          step.normalized_action->>'actionId' = $2
          or exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(step.normalized_action->'calls') = 'array'
                  then step.normalized_action->'calls'
                else '[]'::jsonb
              end
            ) as child_call
            where child_call->>'actionId' = $2
          )
        )
        and step.payer_requirement = 'privy_sponsor'
      order by step.updated_at desc
      limit 25
    `,
    [input.userId, input.transaction.id],
  );
  for (const row of rows) {
    if (!fundingActionMatchesTransaction(row.normalized_action, input)) {
      continue;
    }
    const projected = await loadFundingLifecycleProjectionForOperation(db, {
      operationId: row.operation_id,
    });
    const action = projected
      ? projected.lifecycle.actions.find(
          (candidate) => candidate.actionId === row.step_id,
        )
      : null;
    if (action?.state === "planned" || action?.state === "action_required") {
      return true;
    }
  }
  return false;
}

/**
 * Position actions have their own durable claim boundary. Sponsorship trusts
 * only the exact normalized call saved for the claimed operation; it does not
 * independently re-infer redemption collateral or adapter semantics.
 */
async function matchesPositionAction(
  db: SponsorshipDb,
  input: SponsoredTransaction,
): Promise<boolean> {
  const { rows } = await db.query<{
    execution_address: string;
    normalized_action: Record<string, unknown>;
  }>(
    `
      select
        position_action.execution_address,
        normalized_action.value as normalized_action
      from position_action_operations position_action
      cross join lateral jsonb_array_elements(
        position_action.normalized_actions
      ) as normalized_action(value)
      where position_action.user_id = $1
        and position_action.status = 'submitting'
        and position_action.execution_mode = 'privy_authorization'
        and position_action.broadcast_may_have_occurred = false
        and (
          normalized_action.value->>'actionId' = $2
          or exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(normalized_action.value->'calls') = 'array'
                  then normalized_action.value->'calls'
                else '[]'::jsonb
              end
            ) as child_call
            where child_call->>'actionId' = $2
          )
        )
      order by position_action.updated_at desc
      limit 5
    `,
    [input.userId, input.transaction.id],
  );
  return rows.some(
    (row) =>
      addressesEqual(row.execution_address, input.signer) &&
      fundingActionMatchesTransaction(row.normalized_action, input),
  );
}

function fundingActionMatchesTransaction(
  action: Record<string, unknown>,
  input: SponsoredTransaction,
): boolean {
  if (action.networkId !== `evm:${input.chainId}`) return false;

  let expectedCall: Record<string, unknown> | null = null;
  let expectedGas: string | null = null;
  if (
    action.kind === "evm_transaction" &&
    action.actionId === input.transaction.id
  ) {
    expectedCall = action;
    expectedGas =
      action.gasLimitRaw == null ? null : String(action.gasLimitRaw);
  } else if (action.kind === "evm_transaction_batch") {
    const matchingCalls = Array.isArray(action.calls)
      ? action.calls.filter(
          (call): call is Record<string, unknown> =>
            typeof call === "object" &&
            call !== null &&
            !Array.isArray(call) &&
            call.actionId === input.transaction.id,
        )
      : [];
    if (matchingCalls.length !== 1) return false;
    expectedCall = matchingCalls[0] ?? null;
  }
  if (
    !expectedCall ||
    !addressesEqual(String(expectedCall.to ?? ""), input.transaction.to)
  ) {
    return false;
  }

  try {
    return (
      normalizeData(String(expectedCall.data ?? "")) ===
        normalizeData(input.transaction.data) &&
      quantity(String(expectedCall.valueRaw ?? "0"), "Funding action value") ===
        transactionValue(input.transaction) &&
      quantity(expectedGas, "Funding action gas") ===
        transactionGas(input.transaction)
    );
  } catch {
    return false;
  }
}

async function isKnownLimitlessMarket(
  db: SponsorshipDb,
  address: string,
): Promise<boolean> {
  const normalized = normalizedAddress(address);
  if (!normalized) return false;
  const { rowCount } = await db.query(
    `
      select 1
      from unified_markets
      where venue = 'limitless'
        and lower(coalesce(metadata->>'address', metadata->>'marketAddress')) =
            lower($1)
      limit 1
    `,
    [normalized],
  );
  return Boolean(rowCount);
}

const LIMITLESS_EFFECTIVE_VENUE_ADAPTER_SQL = `coalesce(
  nullif(btrim(market_row.metadata->>'venueAdapter'), ''),
  nullif(btrim(event_row.metadata->>'venueAdapter'), '')
)`;

async function isKnownLimitlessNegRiskAdapter(
  db: SponsorshipDb,
  adapterAddress: string,
): Promise<boolean> {
  const normalizedAdapter = normalizedAddress(adapterAddress);
  if (!normalizedAdapter) return false;
  const { rowCount } = await db.query(
    `
      select 1
      from unified_markets market_row
      join unified_events event_row
        on event_row.id = market_row.event_id
       and event_row.venue = 'limitless'
      where market_row.venue = 'limitless'
        and nullif(btrim(market_row.condition_id), '') is not null
        and lower(${LIMITLESS_EFFECTIVE_VENUE_ADAPTER_SQL}) = lower($1)
      limit 1
    `,
    [normalizedAdapter],
  );
  return Boolean(rowCount);
}

async function isKnownLimitlessNegRiskRedemption(
  db: SponsorshipDb,
  adapterAddress: string,
  conditionId: string,
): Promise<boolean> {
  const normalizedAdapter = normalizedAddress(adapterAddress);
  const normalizedConditionId = conditionId.trim().toLowerCase();
  if (!normalizedAdapter || !/^0x[0-9a-f]{64}$/u.test(normalizedConditionId)) {
    return false;
  }
  const { rowCount } = await db.query(
    `
      select 1
      from unified_markets market_row
      join unified_events event_row
        on event_row.id = market_row.event_id
       and event_row.venue = 'limitless'
      where market_row.venue = 'limitless'
        and lower(market_row.condition_id) = $2
        and lower(${LIMITLESS_EFFECTIVE_VENUE_ADAPTER_SQL}) = lower($1)
      limit 1
    `,
    [normalizedAdapter, normalizedConditionId],
  );
  return Boolean(rowCount);
}

async function isSupportedBridgeToken(
  db: SponsorshipDb,
  chainId: number,
  address: string,
): Promise<boolean> {
  const normalized = normalizedAddress(address);
  if (!normalized) return false;
  const staticTokens =
    chainId === POLYGON_CHAIN_ID
      ? addressSet([
          env.polymarketPusdAddress,
          env.polymarketUsdceAddress,
          "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
        ])
      : chainId === BASE_CHAIN_ID
        ? addressSet([env.limitlessUsdcAddress])
        : new Set<string>();
  if (staticTokens.has(normalized.toLowerCase())) return true;
  const { rowCount } = await db.query(
    `
      select 1
      from bridge_token_cache
      where chain_id = $1
        and lower(address) = lower($2)
      limit 1
    `,
    [String(chainId), normalized],
  );
  return Boolean(rowCount);
}

async function isAuthorizedDestination(
  userId: string,
  address: string,
): Promise<boolean> {
  const normalized = normalizedAddress(address);
  if (!normalized) return false;
  if (await AuthService.getUserWalletByAddress(userId, normalized)) return true;

  const linkedWallets = await AuthService.getUserWallets(userId);
  for (const wallet of linkedWallets) {
    if (addressesEqual(wallet.walletAddress, normalized)) return true;
    const credentials = await AuthService.getVenueCredentialsInfo(
      userId,
      "polymarket",
      wallet.walletAddress,
    );
    if (addressesEqual(credentials?.funderAddress, normalized)) return true;
  }
  return false;
}

function defaultDependencies(
  userId: string,
  db: SponsorshipDb = pool,
): EmbeddedEvmSponsorshipDependencies {
  return {
    isAuthorizedDestination: (address) =>
      isAuthorizedDestination(userId, address),
    isKnownLimitlessMarket: (address) => isKnownLimitlessMarket(db, address),
    isKnownLimitlessNegRiskAdapter: (address) =>
      isKnownLimitlessNegRiskAdapter(db, address),
    isKnownLimitlessNegRiskRedemption: (adapterAddress, conditionId) =>
      isKnownLimitlessNegRiskRedemption(db, adapterAddress, conditionId),
    isSupportedBridgeToken: (chainId, address) =>
      isSupportedBridgeToken(db, chainId, address),
    matchesBridgeOrder: (transaction) => matchesBridgeOrder(db, transaction),
    matchesFundingAction: (transaction) =>
      matchesFundingAction(db, transaction),
    matchesPositionAction: (transaction) =>
      matchesPositionAction(db, transaction),
  };
}

export function buildEmbeddedEvmTransactionFingerprint(input: {
  chainId: number;
  executionMode?: "sequential" | "atomic";
  signer: string;
  transactions: readonly EmbeddedEthereumTransactionSpec[];
}): string {
  const signer = normalizedAddress(input.signer);
  if (!signer) throw new Error("Embedded EVM signer address is invalid.");
  const canonical = input.transactions.map((transaction) => ({
    to: normalizedAddress(transaction.to)?.toLowerCase() ?? transaction.to,
    data: normalizeData(transaction.data),
    value: transactionValue(transaction).toString(),
    gas: transactionGas(transaction).toString(),
    sponsor: transaction.sponsor !== false,
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        chainId: input.chainId,
        executionMode: input.executionMode ?? "sequential",
        signer: signer.toLowerCase(),
        transactions: canonical,
      }),
    )
    .digest("hex");
}

export async function assertEmbeddedEvmSponsorshipAllowed(input: {
  chainId: number;
  dependencies?: EmbeddedEvmSponsorshipDependencies;
  executionMode?: "sequential" | "atomic";
  signer: string;
  transactions: readonly EmbeddedEthereumTransactionSpec[];
  userId: string;
}): Promise<Readonly<{ legacySponsoredWithdrawal: boolean }>> {
  const signer = normalizedAddress(input.signer);
  if (!signer) throw new Error("Embedded EVM signer address is invalid.");
  const dependencies =
    input.dependencies ?? defaultDependencies(input.userId, pool);
  const legacySponsoredWithdrawal = await validateLegacySponsoredWithdrawal({
    chainId: input.chainId,
    dependencies,
    executionMode: input.executionMode ?? "sequential",
    transactions: input.transactions,
  });

  for (const transaction of input.transactions) {
    normalizeData(transaction.data);
    transactionValue(transaction);
    transactionGas(transaction);
    if (transaction.sponsor === false) continue;
    if (legacySponsoredWithdrawal) continue;

    const sponsoredTransaction: SponsoredTransaction = {
      chainId: input.chainId,
      signer,
      transaction,
      userId: input.userId,
    };
    if (
      (await dependencies.matchesFundingAction(sponsoredTransaction)) ||
      (await dependencies.matchesPositionAction(sponsoredTransaction)) ||
      (await dependencies.matchesBridgeOrder(sponsoredTransaction))
    ) {
      continue;
    }

    const allowed =
      (await validateErc20Call({
        chainId: input.chainId,
        dependencies,
        transaction,
      })) ||
      (await validateApprovalForAll({
        chainId: input.chainId,
        dependencies,
        transaction,
      })) ||
      (input.chainId === POLYGON_CHAIN_ID &&
        (await validatePolymarketProtocolCall({
          dependencies,
          transaction,
        }))) ||
      (input.chainId === BASE_CHAIN_ID &&
        (await validateLimitlessProtocolCall({
          dependencies,
          transaction,
        }))) ||
      (await validateNativeTransfer({
        chainId: input.chainId,
        dependencies,
        transaction,
      }));

    if (!allowed) {
      throw new Error(
        `Sponsored EVM transaction ${transaction.id} is not an allowed Hunch operation.`,
      );
    }
  }
  return { legacySponsoredWithdrawal };
}

export const embeddedEvmSponsorshipTestHooks = {
  exactTransactionMatches,
  fundingActionMatchesTransaction,
  matchesPositionAction,
  isKnownLimitlessNegRiskAdapter,
  isKnownLimitlessNegRiskRedemption,
  validateLegacySponsoredWithdrawal,
};
