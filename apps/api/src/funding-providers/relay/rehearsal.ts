import { Interface, MaxUint256, ZeroAddress, getAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

export const RELAY_ROUTER_V3 = "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f";
export const RELAY_APPROVAL_PROXY_V3 =
  "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE";
export const RELAY_DEPOSITORY_V2 = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
export const RELAY_SOLVER = "0xf70da97812CB96acDF810712Aa562db8dfA3dbEF";
export const POLYGON_PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const RELAY_SOLANA_CHAIN_ID = 792703809;
export const SOLANA_NATIVE = "11111111111111111111111111111111";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const POLYGON_USDCE_LEGACY =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const RELAY_SEQUENTIAL_SWAP_EXECUTOR =
  "0x7cB3e87095F6CF95982DC6f57445171a6D3b511c";
export const POLYMARKET_COLLATERAL_OFFRAMP =
  "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
export const MAYAN_ALLOWANCE_HOLDER =
  "0x0000000000001fF3684f28c67538d4D072C22734";
export const MAYAN_FORWARDER = "0x7150ea07D00d8E5a46bcC809f1c9FDf5cb5f8E81";
export const EVM_NATIVE_ASSET_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export type RelayRehearsalScenarioId =
  | "polygon-pol-to-base-eth"
  | "polygon-pusd-to-base-usdc"
  | "base-usdc-to-polygon-pusd"
  | "polygon-pol-to-solana-sol"
  | "polygon-pusd-to-solana-usdc";

export type RelayRehearsalScenario = {
  id: RelayRehearsalScenarioId;
  originChainId: 137 | 8453;
  destinationChainId: 137 | 8453 | typeof RELAY_SOLANA_CHAIN_ID;
  originVm: "evm";
  destinationVm: "evm" | "svm";
  originCurrency: string;
  destinationCurrency: string;
  sourceAsset: "POL" | "pUSD" | "USDC";
  destinationAsset: "ETH" | "SOL" | "USDC" | "pUSD";
  originDecimals: 6 | 18;
  destinationDecimals: 6 | 9 | 18;
};

export const relayRehearsalScenarios: Record<
  RelayRehearsalScenarioId,
  RelayRehearsalScenario
> = {
  "polygon-pol-to-base-eth": {
    id: "polygon-pol-to-base-eth",
    originChainId: 137,
    destinationChainId: 8453,
    originVm: "evm",
    destinationVm: "evm",
    originCurrency: ZeroAddress,
    destinationCurrency: ZeroAddress,
    sourceAsset: "POL",
    destinationAsset: "ETH",
    originDecimals: 18,
    destinationDecimals: 18,
  },
  "polygon-pusd-to-base-usdc": {
    id: "polygon-pusd-to-base-usdc",
    originChainId: 137,
    destinationChainId: 8453,
    originVm: "evm",
    destinationVm: "evm",
    originCurrency: POLYGON_PUSD,
    destinationCurrency: BASE_USDC,
    sourceAsset: "pUSD",
    destinationAsset: "USDC",
    originDecimals: 6,
    destinationDecimals: 6,
  },
  "base-usdc-to-polygon-pusd": {
    id: "base-usdc-to-polygon-pusd",
    originChainId: 8453,
    destinationChainId: 137,
    originVm: "evm",
    destinationVm: "evm",
    originCurrency: BASE_USDC,
    destinationCurrency: POLYGON_PUSD,
    sourceAsset: "USDC",
    destinationAsset: "pUSD",
    originDecimals: 6,
    destinationDecimals: 6,
  },
  "polygon-pol-to-solana-sol": {
    id: "polygon-pol-to-solana-sol",
    originChainId: 137,
    destinationChainId: RELAY_SOLANA_CHAIN_ID,
    originVm: "evm",
    destinationVm: "svm",
    originCurrency: ZeroAddress,
    destinationCurrency: SOLANA_NATIVE,
    sourceAsset: "POL",
    destinationAsset: "SOL",
    originDecimals: 18,
    destinationDecimals: 9,
  },
  "polygon-pusd-to-solana-usdc": {
    id: "polygon-pusd-to-solana-usdc",
    originChainId: 137,
    destinationChainId: RELAY_SOLANA_CHAIN_ID,
    originVm: "evm",
    destinationVm: "svm",
    originCurrency: POLYGON_PUSD,
    destinationCurrency: SOLANA_USDC,
    sourceAsset: "pUSD",
    destinationAsset: "USDC",
    originDecimals: 6,
    destinationDecimals: 6,
  },
};

const erc20Interface = new Interface([
  "function approve(address spender, uint256 amount)",
]);
const routerV3Interface = new Interface([
  "function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable",
]);
const approvalProxyV3Interface = new Interface([
  "function transferAndMulticall(address[] tokens,uint256[] amounts,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable",
]);
const depositoryV2Interface = new Interface([
  "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
]);
const cleanupInterface = new Interface([
  "function cleanupErc20sViaCall(address[] tokens,address[] recipients,bytes[] calls,uint256[] values)",
]);
const cleanupDepositInterface = new Interface([
  "function depositErc20(address depositor,address token,bytes32 id)",
]);
const sequentialSwapInterface = new Interface([
  "function sequentialSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 minOut,address recipient,(uint16,address,uint256,uint256,bytes) params,bytes data)",
]);
const collateralOfframpInterface = new Interface([
  "function unwrap(address asset,address to,uint256 amount)",
]);
const mayanAllowanceHolderInterface = new Interface([
  "function exec(address tokenIn,address tokenOut,uint256 amountIn,address recipient,bytes data)",
]);
const mayanExecutorInterface = new Interface([
  "function execute((address,address,uint256) order,bytes[] calls,bytes32 orderHash)",
]);

type UnknownRecord = Record<string, unknown>;

export type ValidatedRelayAction = {
  chainId: number;
  data: string;
  from: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  stepId: "approve" | "deposit";
  to: string;
  value: bigint;
};

export type ValidatedRelayQuote = {
  actions: ValidatedRelayAction[];
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  requestId: string;
  routeShape:
    | "relay-router-v3-native"
    | "relay-approval-proxy-v3-erc20"
    | "relay-depository-v2-erc20";
};

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function tuple(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be a tuple`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function bigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value))
  ) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(String(value));
}

function address(value: unknown, label: string): string {
  try {
    return getAddress(string(value, label));
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertAddress(actual: string, expected: string, label: string): void {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function assertIdentifier(
  actual: unknown,
  expected: string,
  vm: "evm" | "svm",
  label: string,
): void {
  const actualString = string(actual, label);
  if (vm === "evm") {
    assertAddress(address(actualString, label), expected, label);
    return;
  }
  if (actualString !== expected) throw new Error(`${label} mismatch`);
}

function parseCurrencyAmount(
  details: UnknownRecord,
  field: "currencyIn" | "currencyOut",
  expected: {
    address: string;
    amount?: bigint;
    chainId: number;
    decimals: number;
    vm: "evm" | "svm";
  },
): { amount: bigint; minimumAmount: bigint } {
  const value = record(details[field], `details.${field}`);
  const currency = record(value.currency, `details.${field}.currency`);
  if (Number(currency.chainId) !== expected.chainId) {
    throw new Error(`details.${field}.currency.chainId mismatch`);
  }
  assertIdentifier(
    currency.address,
    expected.address,
    expected.vm,
    `details.${field}.currency.address`,
  );
  if (
    currency.decimals !== undefined &&
    Number(currency.decimals) !== expected.decimals
  ) {
    throw new Error(`details.${field}.currency.decimals mismatch`);
  }
  const amount = bigint(value.amount, `details.${field}.amount`);
  const minimumAmount = bigint(
    value.minimumAmount,
    `details.${field}.minimumAmount`,
  );
  if (expected.amount !== undefined && amount !== expected.amount) {
    throw new Error(`details.${field}.amount mismatch`);
  }
  if (minimumAmount > amount) {
    throw new Error(`details.${field}.minimumAmount exceeds amount`);
  }
  return { amount, minimumAmount };
}

function parseTransactionAction(input: {
  expectedStepId: "approve" | "deposit";
  originChainId: number;
  quoteStep: UnknownRecord;
  user: string;
}): { action: ValidatedRelayAction; requestId: string } {
  const stepId = string(input.quoteStep.id, "step.id");
  if (stepId !== input.expectedStepId) {
    throw new Error(`unexpected step ${stepId}`);
  }
  if (input.quoteStep.kind !== "transaction") {
    throw new Error(`${stepId} must be a transaction step`);
  }
  const requestId = string(input.quoteStep.requestId, `${stepId}.requestId`);
  const items = array(input.quoteStep.items, `${stepId}.items`);
  if (items.length !== 1) throw new Error(`${stepId} must contain one item`);
  const item = record(items[0], `${stepId}.items[0]`);
  if (item.status !== "incomplete") {
    throw new Error(`${stepId} item must be incomplete`);
  }
  const data = record(item.data, `${stepId}.items[0].data`);
  const dataKeys = Object.keys(data).sort();
  if (
    dataKeys.join(",") !==
    [
      "chainId",
      "data",
      "from",
      "gas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "to",
      "value",
    ].join(",")
  ) {
    throw new Error(`${stepId} contains an unknown executable field`);
  }
  if (data.authorizationList !== undefined || data.txs !== undefined) {
    throw new Error(`${stepId} contains a disabled authorization capability`);
  }
  const chainId = Number(data.chainId);
  if (chainId !== input.originChainId) {
    throw new Error(`${stepId}.chainId mismatch`);
  }
  const from = address(data.from, `${stepId}.from`);
  assertAddress(from, input.user, `${stepId}.from`);
  const calldata = string(data.data, `${stepId}.data`);
  if (!/^0x[0-9a-f]+$/i.test(calldata) || calldata.length < 10) {
    throw new Error(`${stepId}.data must be non-empty calldata`);
  }
  if (item.check === undefined && stepId === "deposit") {
    throw new Error("deposit.check is required");
  }
  if (item.check !== undefined) {
    const check = record(item.check, `${stepId}.check`);
    if (check.method !== "GET") {
      throw new Error(`${stepId}.check.method mismatch`);
    }
    const endpoint = string(check.endpoint, `${stepId}.check.endpoint`);
    const requestIdFromCheck = new URL(
      endpoint,
      "https://api.relay.link",
    ).searchParams.get("requestId");
    if (requestIdFromCheck !== requestId) {
      throw new Error(`${stepId} request correlation mismatch`);
    }
  }

  return {
    requestId,
    action: {
      stepId: input.expectedStepId,
      chainId,
      from,
      to: address(data.to, `${stepId}.to`),
      data: calldata,
      value: bigint(data.value, `${stepId}.value`),
      gasLimit: bigint(data.gas, `${stepId}.gas`),
      maxFeePerGas: bigint(data.maxFeePerGas, `${stepId}.maxFeePerGas`),
      maxPriorityFeePerGas: bigint(
        data.maxPriorityFeePerGas,
        `${stepId}.maxPriorityFeePerGas`,
      ),
    },
  };
}

function validateNativeDeposit(
  action: ValidatedRelayAction,
  scenario: RelayRehearsalScenario,
  amount: bigint,
  user: string,
  recipient: string,
): void {
  assertAddress(action.to, RELAY_ROUTER_V3, "native deposit target");
  if (action.value !== amount) {
    throw new Error("native deposit value must equal exact input");
  }
  const decoded = routerV3Interface.decodeFunctionData(
    "multicall",
    action.data,
  );
  assertAddress(
    address(decoded.refundTo, "native refundTo"),
    ZeroAddress,
    "native refundTo",
  );
  assertAddress(
    address(decoded.nftRecipient, "native nftRecipient"),
    ZeroAddress,
    "native nftRecipient",
  );
  if (string(decoded.metadata, "native metadata") === "0x") {
    throw new Error("native Relay metadata must be present");
  }
  const calls = array(decoded.calls, "native calls");
  if (calls.length !== 2) {
    throw new Error("native Relay call sequence does not match policy");
  }
  let totalCallValue = 0n;
  for (const [index, callValue] of calls.entries()) {
    const call = tuple(callValue, `native calls[${index}]`);
    if (call.allowFailure !== false) {
      throw new Error(`native calls[${index}] may not allow failure`);
    }
    totalCallValue += bigint(call.value, `native calls[${index}].value`);
    const callData = string(call.callData, `native calls[${index}].callData`);
    if (!/^0x[0-9a-f]+$/i.test(callData)) {
      throw new Error(`native calls[${index}].callData invalid`);
    }
  }
  if (totalCallValue !== amount) {
    throw new Error("native inner call value must equal exact input");
  }
  const routeCall = tuple(
    required(calls[0], "native route call"),
    "route call",
  );
  const cleanupCall = tuple(
    required(calls[1], "native cleanup call"),
    "cleanup call",
  );
  if (scenario.id === "polygon-pol-to-base-eth") {
    assertAddress(
      address(routeCall.target, "native route target"),
      RELAY_SEQUENTIAL_SWAP_EXECUTOR,
      "native route target",
    );
    if (bigint(routeCall.value, "native route value") !== amount) {
      throw new Error("native route value must equal exact input");
    }
    const decoded = sequentialSwapInterface.decodeFunctionData(
      "sequentialSwap",
      string(routeCall.callData, "native route calldata"),
    );
    if (bigint(decoded.amountIn, "sequentialSwap amount") !== amount) {
      throw new Error("sequentialSwap amount mismatch");
    }
    assertAddress(
      address(decoded.tokenIn, "sequentialSwap tokenIn"),
      EVM_NATIVE_ASSET_SENTINEL,
      "sequentialSwap tokenIn",
    );
    assertAddress(
      address(decoded.tokenOut, "sequentialSwap tokenOut"),
      POLYGON_USDC,
      "sequentialSwap tokenOut",
    );
    assertAddress(
      address(decoded.recipient, "sequentialSwap recipient"),
      RELAY_ROUTER_V3,
      "sequentialSwap recipient",
    );
    if (bigint(decoded.minOut, "sequentialSwap minOut") <= 0n) {
      throw new Error("sequentialSwap minimum output must be positive");
    }
    const params = tuple(decoded.params, "sequentialSwap params");
    if (
      bigint(params[0], "sequentialSwap params kind") !== 0n ||
      !sameAddress(
        address(params[1], "sequentialSwap params target"),
        ZeroAddress,
      ) ||
      bigint(params[2], "sequentialSwap params value") !== 0n ||
      bigint(params[3], "sequentialSwap params cap") !== MaxUint256 ||
      string(params[4], "sequentialSwap params data") !== "0x"
    ) {
      throw new Error("sequentialSwap parameter envelope is outside policy");
    }
    const routeData = string(decoded.data, "sequentialSwap route data");
    if (
      !/^0xd0[0-9a-f]+$/iu.test(routeData) ||
      routeData.length % 2 !== 0 ||
      routeData.length > 65_538
    ) {
      throw new Error("sequentialSwap route data is outside pinned policy");
    }
  } else if (scenario.id === "polygon-pol-to-solana-sol") {
    assertAddress(
      address(routeCall.target, "Mayan allowance target"),
      MAYAN_ALLOWANCE_HOLDER,
      "Mayan allowance target",
    );
    if (bigint(routeCall.value, "Mayan allowance value") !== amount) {
      throw new Error("Mayan allowance value must equal exact input");
    }
    const decoded = mayanAllowanceHolderInterface.decodeFunctionData(
      "exec",
      string(routeCall.callData, "Mayan allowance calldata"),
    );
    assertAddress(
      address(decoded.tokenIn, "Mayan tokenIn"),
      MAYAN_FORWARDER,
      "Mayan tokenIn",
    );
    assertAddress(
      address(decoded.tokenOut, "Mayan tokenOut"),
      ZeroAddress,
      "Mayan tokenOut",
    );
    if (bigint(decoded.amountIn, "Mayan amount") !== amount) {
      throw new Error("Mayan amount mismatch");
    }
    assertAddress(
      address(decoded.recipient, "Mayan recipient"),
      MAYAN_FORWARDER,
      "Mayan recipient",
    );
    validateMayanExecutionPayload(string(decoded.data, "Mayan payload"), {
      recipient,
    });
  } else {
    throw new Error("native Relay route has no pinned inner-call policy");
  }
  validateRelayCleanupCall(cleanupCall, {
    token: POLYGON_USDC,
    user,
  });
}

function validateErc20Deposit(
  action: ValidatedRelayAction,
  scenario: RelayRehearsalScenario,
  amount: bigint,
  user: string,
): void {
  assertAddress(action.to, RELAY_APPROVAL_PROXY_V3, "ERC20 deposit target");
  if (action.value !== 0n) throw new Error("ERC20 deposit value must be zero");
  const decoded = approvalProxyV3Interface.decodeFunctionData(
    "transferAndMulticall",
    action.data,
  );
  const tokens = array(decoded.tokens, "ERC20 tokens").map((value, index) =>
    address(value, `ERC20 tokens[${index}]`),
  );
  const amounts = array(decoded.amounts, "ERC20 amounts").map((value, index) =>
    bigint(value, `ERC20 amounts[${index}]`),
  );
  if (tokens.length !== 1 || amounts.length !== 1) {
    throw new Error("ERC20 Relay call must move exactly one asset");
  }
  assertAddress(
    required(tokens[0], "ERC20 input token"),
    scenario.originCurrency,
    "ERC20 input token",
  );
  if (amounts[0] !== amount) {
    throw new Error("ERC20 Relay call amount must equal exact input");
  }
  const refundTo = address(decoded.refundTo, "ERC20 refundTo");
  const nftRecipient = address(decoded.nftRecipient, "ERC20 nftRecipient");
  assertAddress(refundTo, RELAY_SOLVER, "ERC20 refundTo");
  assertAddress(nftRecipient, RELAY_SOLVER, "ERC20 nftRecipient");
  if (string(decoded.metadata, "ERC20 metadata") === "0x") {
    throw new Error("ERC20 Relay metadata must be present");
  }
  const calls = array(decoded.calls, "ERC20 calls");
  if (calls.length !== 4) {
    throw new Error("ERC20 Relay call sequence does not match policy");
  }
  for (const [index, callValue] of calls.entries()) {
    const call = tuple(callValue, `ERC20 calls[${index}]`);
    if (call.allowFailure !== false) {
      throw new Error(`ERC20 calls[${index}] may not allow failure`);
    }
    if (bigint(call.value, `ERC20 calls[${index}].value`) !== 0n) {
      throw new Error(`ERC20 calls[${index}] may not send native value`);
    }
    const callData = string(call.callData, `ERC20 calls[${index}].callData`);
    if (!/^0x[0-9a-f]+$/i.test(callData)) {
      throw new Error(`ERC20 calls[${index}].callData invalid`);
    }
  }
  for (const [index, spender] of [
    RELAY_ROUTER_V3,
    POLYMARKET_COLLATERAL_OFFRAMP,
  ].entries()) {
    const call = tuple(
      required(calls[index], `ERC20 approval call ${index}`),
      `ERC20 approval call ${index}`,
    );
    assertAddress(
      address(call.target, `ERC20 approval target ${index}`),
      scenario.originCurrency,
      `ERC20 approval target ${index}`,
    );
    const decoded = erc20Interface.decodeFunctionData(
      "approve",
      string(call.callData, `ERC20 approval calldata ${index}`),
    );
    assertAddress(
      address(decoded.spender, `ERC20 inner spender ${index}`),
      spender,
      `ERC20 inner spender ${index}`,
    );
    if (bigint(decoded.amount, `ERC20 inner amount ${index}`) !== amount) {
      throw new Error(`ERC20 inner approval ${index} amount mismatch`);
    }
  }
  const unwrapCall = tuple(required(calls[2], "unwrap call"), "unwrap call");
  assertAddress(
    address(unwrapCall.target, "unwrap target"),
    POLYMARKET_COLLATERAL_OFFRAMP,
    "unwrap target",
  );
  const unwrap = collateralOfframpInterface.decodeFunctionData(
    "unwrap",
    string(unwrapCall.callData, "unwrap calldata"),
  );
  assertAddress(
    address(unwrap.asset, "unwrap asset"),
    POLYGON_USDCE_LEGACY,
    "unwrap asset",
  );
  assertAddress(
    address(unwrap.to, "unwrap recipient"),
    RELAY_ROUTER_V3,
    "unwrap recipient",
  );
  if (bigint(unwrap.amount, "unwrap amount") !== amount) {
    throw new Error("unwrap amount mismatch");
  }
  validateRelayCleanupCall(
    tuple(required(calls[3], "ERC20 cleanup call"), "ERC20 cleanup call"),
    { token: POLYGON_USDCE_LEGACY, user },
  );
}

function validateRelayCleanupCall(
  call: UnknownRecord,
  input: Readonly<{ token: string; user: string }>,
): void {
  assertAddress(
    address(call.target, "Relay cleanup target"),
    RELAY_ROUTER_V3,
    "Relay cleanup target",
  );
  if (bigint(call.value, "Relay cleanup value") !== 0n) {
    throw new Error("Relay cleanup call may not send native value");
  }
  const decoded = cleanupInterface.decodeFunctionData(
    "cleanupErc20sViaCall",
    string(call.callData, "Relay cleanup calldata"),
  );
  const tokens = array(decoded[0], "Relay cleanup tokens");
  const recipients = array(decoded[1], "Relay cleanup recipients");
  const nestedCalls = array(decoded[2], "Relay cleanup calls");
  const values = array(decoded[3], "Relay cleanup values");
  if (
    tokens.length !== 1 ||
    recipients.length !== 1 ||
    nestedCalls.length !== 1 ||
    values.length !== 1
  ) {
    throw new Error("Relay cleanup collection shape mismatch");
  }
  assertAddress(
    address(tokens[0], "Relay cleanup token"),
    input.token,
    "Relay cleanup token",
  );
  assertAddress(
    address(recipients[0], "Relay cleanup recipient"),
    RELAY_DEPOSITORY_V2,
    "Relay cleanup recipient",
  );
  if (bigint(values[0], "Relay cleanup nested value") !== 0n) {
    throw new Error("Relay cleanup nested call may not send native value");
  }
  const deposit = cleanupDepositInterface.decodeFunctionData(
    "depositErc20",
    string(nestedCalls[0], "Relay cleanup deposit calldata"),
  );
  assertAddress(
    address(deposit.depositor, "Relay cleanup depositor"),
    input.user,
    "Relay cleanup depositor",
  );
  assertAddress(
    address(deposit.token, "Relay cleanup deposit token"),
    input.token,
    "Relay cleanup deposit token",
  );
  const orderId = string(deposit.id, "Relay cleanup order ID");
  if (!/^0x[0-9a-f]{64}$/iu.test(orderId) || /^0x0{64}$/iu.test(orderId)) {
    throw new Error("Relay cleanup order ID must be non-zero bytes32");
  }
}

function validateMayanExecutionPayload(
  payload: string,
  input: Readonly<{ recipient: string }>,
): void {
  const decoded = mayanExecutorInterface.decodeFunctionData("execute", payload);
  const order = tuple(decoded.order, "Mayan order");
  assertAddress(
    address(order[0], "Mayan order recipient"),
    RELAY_ROUTER_V3,
    "Mayan order recipient",
  );
  assertAddress(
    address(order[1], "Mayan order output token"),
    POLYGON_USDC,
    "Mayan order output token",
  );
  if (bigint(order[2], "Mayan order minimum output") <= 0n) {
    throw new Error("Mayan order minimum output must be positive");
  }
  const calls = array(decoded.calls, "Mayan calls");
  const allowedSelectors = [
    "0xbd01c226",
    "0x38c9c147",
    "0x38c9c147",
    "0xaf72634f",
    "0x34ee90ca",
  ];
  if (
    calls.length !== allowedSelectors.length ||
    calls.some(
      (value, index) =>
        string(value, `Mayan calls[${index}]`).slice(0, 10).toLowerCase() !==
        allowedSelectors[index],
    )
  ) {
    throw new Error("Mayan nested call sequence is outside policy");
  }
  const recipientHex = Buffer.from(
    new PublicKey(input.recipient).toBytes(),
  ).toString("hex");
  const occurrences =
    payload.toLowerCase().split(recipientHex.toLowerCase()).length - 1;
  if (occurrences !== 1) {
    throw new Error("Mayan payload is not uniquely bound to the recipient");
  }
  const orderHash = string(decoded.orderHash, "Mayan order hash");
  if (!/^0x[0-9a-f]{64}$/iu.test(orderHash) || /^0x0{64}$/iu.test(orderHash)) {
    throw new Error("Mayan order hash must be non-zero bytes32");
  }
}

function validateV2Erc20Deposit(
  action: ValidatedRelayAction,
  scenario: RelayRehearsalScenario,
  amount: bigint,
  user: string,
): void {
  if (scenario.originChainId !== 8453) {
    throw new Error("Relay Depository V2 is not enabled for this origin chain");
  }
  assertAddress(action.to, RELAY_DEPOSITORY_V2, "V2 ERC20 deposit target");
  if (action.value !== 0n)
    throw new Error("V2 ERC20 deposit value must be zero");
  const decoded = depositoryV2Interface.decodeFunctionData(
    "depositErc20",
    action.data,
  );
  assertAddress(
    address(decoded.depositor, "V2 depositor"),
    user,
    "V2 depositor",
  );
  assertAddress(
    address(decoded.token, "V2 token"),
    scenario.originCurrency,
    "V2 token",
  );
  if (bigint(decoded.amount, "V2 amount") !== amount) {
    throw new Error("V2 Relay amount must equal exact input");
  }
  const orderId = string(decoded.id, "V2 order id");
  if (!/^0x[0-9a-f]{64}$/i.test(orderId) || /^0x0{64}$/i.test(orderId)) {
    throw new Error("V2 Relay order id must be non-zero bytes32");
  }
}

export function validateRelayRehearsalQuote(input: {
  amount: bigint;
  minimumOutputFloor: bigint;
  quote: unknown;
  recipient?: string;
  scenario: RelayRehearsalScenario;
  user: string;
}): ValidatedRelayQuote {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  const quote = record(input.quote, "quote");
  if (
    quote.depositAddress !== undefined &&
    quote.depositAddress !== "" &&
    quote.depositAddress !== null
  ) {
    throw new Error("Deposit Address mode is forbidden");
  }
  const details = record(quote.details, "quote.details");
  if (details.sender !== undefined) {
    assertIdentifier(
      details.sender,
      input.user,
      input.scenario.originVm,
      "details.sender",
    );
  }
  if (details.recipient !== undefined) {
    assertIdentifier(
      details.recipient,
      input.recipient ?? input.user,
      input.scenario.destinationVm,
      "details.recipient",
    );
  }
  parseCurrencyAmount(details, "currencyIn", {
    address: input.scenario.originCurrency,
    amount: input.amount,
    chainId: input.scenario.originChainId,
    decimals: input.scenario.originDecimals,
    vm: input.scenario.originVm,
  });
  const output = parseCurrencyAmount(details, "currencyOut", {
    address: input.scenario.destinationCurrency,
    chainId: input.scenario.destinationChainId,
    decimals: input.scenario.destinationDecimals,
    vm: input.scenario.destinationVm,
  });
  if (output.minimumAmount < input.minimumOutputFloor) {
    throw new Error("quote minimum output below authorized floor");
  }

  const steps = array(quote.steps, "quote.steps").map((value, index) =>
    record(value, `quote.steps[${index}]`),
  );
  const native = sameAddress(input.scenario.originCurrency, ZeroAddress);
  const expectedStepIds = native
    ? (["deposit"] as const)
    : steps.length === 1
      ? (["deposit"] as const)
      : (["approve", "deposit"] as const);
  if (steps.length !== expectedStepIds.length) {
    throw new Error("unexpected Relay step count");
  }
  const parsed = steps.map((step, index) =>
    parseTransactionAction({
      expectedStepId: required(expectedStepIds[index], "expected step ID"),
      originChainId: input.scenario.originChainId,
      quoteStep: step,
      user: input.user,
    }),
  );
  const requestIds = new Set(parsed.map((value) => value.requestId));
  if (requestIds.size !== 1) {
    throw new Error("Relay steps do not share one request ID");
  }
  const actions = parsed.map((value) => value.action);

  if (native) {
    validateNativeDeposit(
      required(actions[0], "native deposit action"),
      input.scenario,
      input.amount,
      input.user,
      input.recipient ?? input.user,
    );
  } else {
    const deposit = actions.find((action) => action.stepId === "deposit");
    if (!deposit) throw new Error("ERC20 quote has no deposit action");
    const usesV3 = sameAddress(deposit.to, RELAY_APPROVAL_PROXY_V3);
    const usesV2 = sameAddress(deposit.to, RELAY_DEPOSITORY_V2);
    if (!usesV3 && !usesV2) {
      throw new Error("ERC20 deposit target is not allowlisted");
    }
    const expectedSpender = usesV3
      ? RELAY_APPROVAL_PROXY_V3
      : RELAY_DEPOSITORY_V2;
    const approve = actions.find((action) => action.stepId === "approve");
    if (approve) {
      assertAddress(
        approve.to,
        input.scenario.originCurrency,
        "approve target",
      );
      if (approve.value !== 0n) throw new Error("approve value must be zero");
      const decoded = erc20Interface.decodeFunctionData(
        "approve",
        approve.data,
      );
      assertAddress(
        address(decoded.spender, "approve spender"),
        expectedSpender,
        "approve spender",
      );
      if (bigint(decoded.amount, "approve amount") !== input.amount) {
        throw new Error("approval amount must equal exact input");
      }
    }
    if (usesV3) {
      validateErc20Deposit(deposit, input.scenario, input.amount, input.user);
    } else {
      validateV2Erc20Deposit(deposit, input.scenario, input.amount, input.user);
    }
  }

  return {
    actions,
    expectedOutputRaw: output.amount,
    minimumOutputRaw: output.minimumAmount,
    requestId: required([...requestIds][0], "Relay request ID"),
    routeShape: native
      ? "relay-router-v3-native"
      : sameAddress(
            required(
              actions.find((action) => action.stepId === "deposit"),
              "deposit action",
            ).to,
            RELAY_APPROVAL_PROXY_V3,
          )
        ? "relay-approval-proxy-v3-erc20"
        : "relay-depository-v2-erc20",
  };
}
