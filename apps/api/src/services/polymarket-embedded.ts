import { Interface, ethers } from "ethers";
import type { User } from "../auth.js";
import { env } from "../env.js";
import {
  type PrivyWalletApiRequestSignatureInput,
  type PrivyWalletApiClient,
  type PrivyWalletProfile,
  PrivyService,
} from "../privy-service.js";
import type { PolymarketFunderCandidate } from "./polymarket-funder.js";
import { POLYGON_NATIVE_USDC_ADDRESS } from "./polymarket-onchain.js";

const POLY_CHAIN_ID = 137;
const POLY_CAIP2 = "eip155:137";
const AUTH_MESSAGE = "This message attests that I control the given wallet";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const MAX_UINT256 = `0x${"f".repeat(64)}` as const;
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR = "0xa22cb465";
const SAFE_PROXY_DOMAIN_NAME = "Polymarket Contract Proxy Factory";
const POLYMARKET_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const POLYMARKET_AUTH_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
] as const;

const POLYMARKET_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

const POLYMARKET_ORDER_TYPES_V2 = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

const FEE_AUTH_TYPES = {
  FeeAuth: [
    { name: "signer", type: "address" },
    { name: "vault", type: "address" },
    { name: "exchange", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "feeBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const FEE_AUTH_TYPES_V3 = {
  FeeAuthV3: [
    { name: "signer", type: "address" },
    { name: "vault", type: "address" },
    { name: "exchange", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "feeBps", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const SAFE_TX_DOMAIN_TYPES = [
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const SAFE_PROXY_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const SAFE_PROXY_TYPES = {
  CreateProxy: [
    { name: "paymentToken", type: "address" },
    { name: "payment", type: "uint256" },
    { name: "paymentReceiver", type: "address" },
  ],
} as const;

const SAFE_ABI = new Interface([
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)",
]);

const MAGIC_PROXY_FACTORY_ABI = new Interface([
  "function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)",
]);

const SAFE_PROXY_FACTORY_ABI = new Interface([
  "function createProxy(address paymentToken,uint256 payment,address paymentReceiver,(uint8 v,bytes32 r,bytes32 s) createSig)",
]);

const TOKEN_APPROVAL_ABI = new Interface([
  "function approve(address spender,uint256 value) returns (bool)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function wrap(address _asset,address _to,uint256 _amount)",
  "function unwrap(address _asset,address _to,uint256 _amount)",
  "function setApprovalForAll(address operator,bool approved)",
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function isApprovedForAll(address account,address operator) view returns (bool)",
]);

const PRIVY_WALLET_API_BASE_URL = "https://api.privy.io";

export const HUNCH_PRIVY_ACCESS_TOKEN_HEADER = "x-hunch-privy-access-token";
export const HUNCH_PRIVY_IDENTITY_TOKEN_HEADER = "x-hunch-privy-identity-token";

export type PolymarketOrderPayload = {
  salt: string | number;
  maker: string;
  signer: string;
  tokenId: string | number;
  makerAmount: string | number;
  takerAmount: string | number;
  expiration?: string | number;
  timestamp: string | number;
  metadata: string;
  builder: string;
  side: number | string;
  signatureType: number | string;
};

export type FeeAuthPayload = {
  signer: string;
  vault: string;
  exchange: string;
  orderHash: string;
  feeBps: string | number;
  nonce?: string | number;
  deadline: string | number;
};

type ApprovalTask = {
  kind: "erc20_approve" | "erc1155_approve_all";
  target: string;
  data: string;
  description: string;
};

type ApprovalPostcondition =
  | {
      kind: "erc20";
      tokenAddress: string;
      owner: string;
      spender: string;
      amount: bigint;
    }
  | {
      kind: "erc1155";
      tokenAddress: string;
      owner: string;
      operator: string;
      approved: boolean;
    };

export type EmbeddedPolymarketExecutionSummary = {
  signer: string;
  funder: string;
  funderKind: "signer" | "safe" | "magic";
  transactionHashes: string[];
};

export type EmbeddedPrivyAuthorizationRequest = {
  id: string;
  label: string;
  input: PrivyWalletApiRequestSignatureInput;
};

export type EmbeddedPrivyAuthorizationSignature = {
  id: string;
  signature: string;
};

export type EmbeddedPolymarketTypedData = {
  primaryType?: string;
  primary_type?: string;
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
};

export type DepositWalletBatchPurpose = "withdraw" | "redeem";

export type EmbeddedPolymarketWalletContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
};

export type EmbeddedPolymarketContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
  walletApiClient: PrivyWalletApiClient;
};

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function requireAddress(value: string, message: string): string {
  const normalized = normalizeAddress(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function getRequestTransaction(request: EmbeddedPrivyAuthorizationRequest): {
  from: string;
  to: string;
  data: string;
} | null {
  const params =
    request.input.body &&
    typeof request.input.body.params === "object" &&
    request.input.body.params !== null
      ? (request.input.body.params as Record<string, unknown>)
      : null;
  const transaction =
    params &&
    typeof params.transaction === "object" &&
    params.transaction !== null
      ? (params.transaction as Record<string, unknown>)
      : null;
  const from = normalizeAddress(
    typeof transaction?.from === "string" ? transaction.from : null,
  );
  const to = normalizeAddress(
    typeof transaction?.to === "string" ? transaction.to : null,
  );
  const data = normalizeHex(
    typeof transaction?.data === "string" ? transaction.data : null,
  );
  if (!from || !to || !data) return null;
  return { from, to, data };
}

function padHex(value: string): string {
  return value.replace(/^0x/i, "").padStart(64, "0");
}

function encodeApprove(spender: string): string {
  return `${ERC20_APPROVE_SELECTOR}${padHex(spender)}${padHex(MAX_UINT256)}`;
}

function encodeSetApprovalForAll(operator: string): string {
  return `${ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR}${padHex(operator)}${padHex("1")}`;
}

function splitSignature(signature: string): {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
} {
  const raw = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (raw.length !== 130) {
    throw new Error("Invalid signature length.");
  }
  const r = `0x${raw.slice(0, 64)}` as `0x${string}`;
  const s = `0x${raw.slice(64, 128)}` as `0x${string}`;
  let v = Number.parseInt(raw.slice(128, 130), 16);
  if (!Number.isFinite(v)) {
    throw new Error("Invalid signature v value.");
  }
  if (v < 27) v += 27;
  return { v, r, s };
}

function signatureToBytes(signature: string): `0x${string}` {
  const { v, r, s } = splitSignature(signature);
  const vHex = v.toString(16).padStart(2, "0");
  return `0x${r.slice(2)}${s.slice(2)}${vHex}` as `0x${string}`;
}

function polygonProvider() {
  return new ethers.JsonRpcProvider(env.polygonRpcUrl);
}

function buildPrivyWalletRpcUrl(walletId: string): string {
  return `${PRIVY_WALLET_API_BASE_URL}/api/v1/wallets/${walletId}/rpc`;
}

function buildPrivyWalletHeaders(
  signatureInput: PrivyWalletApiRequestSignatureInput,
  authorizationSignature: string,
): HeadersInit {
  return {
    Authorization: `Basic ${Buffer.from(
      `${env.privyAppId}:${env.privyAppSecret}`,
    ).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "privy-app-id": signatureInput.headers["privy-app-id"],
    ...(signatureInput.headers["privy-idempotency-key"]
      ? {
          "privy-idempotency-key":
            signatureInput.headers["privy-idempotency-key"],
        }
      : {}),
    "privy-authorization-signature": authorizationSignature,
  };
}

function buildPrivyAppAuthHeaders(): HeadersInit {
  return {
    Authorization: `Basic ${Buffer.from(
      `${env.privyAppId}:${env.privyAppSecret}`,
    ).toString("base64")}`,
    Accept: "application/json",
    "privy-app-id": env.privyAppId,
  };
}

async function executePreparedPrivyAuthorizationRequest(
  request: EmbeddedPrivyAuthorizationRequest,
  authorizationSignature: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(request.input.url, {
    method: request.input.method,
    headers: buildPrivyWalletHeaders(request.input, authorizationSignature),
    body: JSON.stringify(request.input.body),
  });
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const message =
      (payload &&
        typeof payload.error === "string" &&
        payload.error.trim().length > 0 &&
        payload.error) ||
      (payload &&
        typeof payload.message === "string" &&
        payload.message.trim().length > 0 &&
        payload.message) ||
      `Privy wallet request failed (${response.status})`;
    throw new Error(message);
  }
  return payload ?? {};
}

function findAuthorizationSignature(
  signatures: EmbeddedPrivyAuthorizationSignature[],
  requestId: string,
): string {
  const match = signatures.find((entry) => entry.id === requestId)?.signature;
  const trimmed = match?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`Missing Privy authorization signature for ${requestId}.`);
  }
  return trimmed;
}

function isPrivyInflightAuthorizationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("inflight eip-7702 authorization") ||
    message.includes("aa10 sender already constructed")
  );
}

async function waitForInflightAuthorizationRetry(attempt: number) {
  const delayMs = 1_250 * (attempt + 1);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function buildApprovalPostcondition(
  request: EmbeddedPrivyAuthorizationRequest,
): Promise<ApprovalPostcondition | null> {
  const transaction = getRequestTransaction(request);
  if (!transaction) return null;

  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = TOKEN_APPROVAL_ABI.parseTransaction({
      data: transaction.data,
      value: 0n,
    });
  } catch {
    decoded = null;
  }
  if (!decoded) return null;

  if (decoded.name === "approve") {
    const spender = normalizeAddress(String(decoded.args[0]));
    const amount = BigInt(decoded.args[1].toString());
    if (!spender || amount <= 0n) return null;
    return {
      kind: "erc20",
      tokenAddress: transaction.to,
      owner: transaction.from,
      spender,
      amount,
    };
  }

  if (decoded.name === "setApprovalForAll") {
    const operator = normalizeAddress(String(decoded.args[0]));
    const approved = Boolean(decoded.args[1]);
    if (!operator) return null;
    return {
      kind: "erc1155",
      tokenAddress: transaction.to,
      owner: transaction.from,
      operator,
      approved,
    };
  }

  return null;
}

async function isApprovalPostconditionSatisfied(
  condition: ApprovalPostcondition,
): Promise<boolean> {
  const token = new ethers.Contract(
    condition.tokenAddress,
    TOKEN_APPROVAL_ABI,
    polygonProvider(),
  );
  if (condition.kind === "erc20") {
    const allowance = BigInt(
      (await token.allowance(condition.owner, condition.spender)).toString(),
    );
    return allowance >= condition.amount;
  }

  const approved = Boolean(
    await token.isApprovedForAll(condition.owner, condition.operator),
  );
  return approved === condition.approved;
}

async function waitForApprovalPostcondition(
  condition: ApprovalPostcondition | null,
  context: string,
): Promise<void> {
  if (!condition) return;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if (await isApprovalPostconditionSatisfied(condition)) return;
    } catch {
      // RPCs can transiently fail immediately after sponsored submission.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${context} did not update on-chain in time.`);
}

function parsePrivyRpcSignatureResponse(
  payload: Record<string, unknown>,
): string {
  const data =
    payload &&
    typeof payload.data === "object" &&
    payload.data !== null &&
    "signature" in payload.data
      ? (payload.data as Record<string, unknown>)
      : null;
  const signature =
    data && typeof data.signature === "string" ? data.signature.trim() : "";
  if (!signature) {
    throw new Error("Privy wallet response did not include a signature.");
  }
  return signature;
}

function parsePrivyRpcTransactionHashResponse(
  payload: Record<string, unknown>,
): {
  hash: string | null;
  transactionId: string | null;
  userOperationHash: string | null;
} {
  const data =
    payload &&
    typeof payload.data === "object" &&
    payload.data !== null &&
    "hash" in payload.data
      ? (payload.data as Record<string, unknown>)
      : null;
  const hash =
    data && typeof data.hash === "string" && data.hash.trim().length > 0
      ? data.hash.trim()
      : null;
  const transactionId =
    data &&
    typeof data.transaction_id === "string" &&
    data.transaction_id.trim().length > 0
      ? data.transaction_id.trim()
      : null;
  const userOperationHash =
    data &&
    typeof data.user_operation_hash === "string" &&
    data.user_operation_hash.trim().length > 0
      ? data.user_operation_hash.trim()
      : null;
  if (!hash && !transactionId && !userOperationHash) {
    throw new Error(
      "Privy wallet response did not include a transaction hash or transaction id.",
    );
  }
  return { hash, transactionId, userOperationHash };
}

type PrivyTransactionStatus =
  | "broadcasted"
  | "confirmed"
  | "execution_reverted"
  | "failed"
  | "replaced"
  | "finalized"
  | "provider_error"
  | "pending";

async function waitForPrivyTransaction(
  transactionId: string,
  context: string,
): Promise<string | null> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${PRIVY_WALLET_API_BASE_URL}/v1/transactions/${transactionId}`,
      {
        method: "GET",
        headers: buildPrivyAppAuthHeaders(),
      },
    );
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      const message =
        (payload &&
          typeof payload.error === "string" &&
          payload.error.trim().length > 0 &&
          payload.error) ||
        (payload &&
          typeof payload.message === "string" &&
          payload.message.trim().length > 0 &&
          payload.message) ||
        `Privy transaction lookup failed (${response.status})`;
      throw new Error(message);
    }

    const status =
      payload && typeof payload.status === "string"
        ? (payload.status as PrivyTransactionStatus)
        : null;
    const transactionHash =
      payload &&
      typeof payload.transaction_hash === "string" &&
      payload.transaction_hash.trim().length > 0
        ? payload.transaction_hash.trim()
        : null;

    if (status === "confirmed" || status === "finalized") {
      return transactionHash;
    }
    if (
      status === "execution_reverted" ||
      status === "failed" ||
      status === "provider_error" ||
      status === "replaced"
    ) {
      throw new Error(`${context} failed in Privy with status ${status}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${context} is still pending in Privy.`);
}

async function waitForPolygonTransaction(txHash: string, context: string) {
  const provider = polygonProvider();
  const receipt = await provider.waitForTransaction(txHash, 1, 90_000);
  if (!receipt) {
    throw new Error(`${context} is still pending.`);
  }
  if (receipt.status !== 1) {
    throw new Error(`${context} failed onchain.`);
  }
}

async function sendSponsoredPolygonTransaction(inputs: {
  walletApiClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  to: string;
  data: string;
  context: string;
}) {
  const signer = requireAddress(inputs.signer, "Invalid signer address.");
  const to = requireAddress(inputs.to, "Invalid Polygon target address.");
  const result =
    await inputs.walletApiClient.walletApi.ethereum.sendTransaction({
      walletId: inputs.walletId,
      address: signer,
      chainType: "ethereum",
      caip2: POLY_CAIP2,
      sponsor: true,
      transaction: {
        from: signer as `0x${string}`,
        to: to as `0x${string}`,
        data: normalizeHex(inputs.data) as `0x${string}`,
      },
    });
  await waitForPolygonTransaction(result.hash, inputs.context);
  return result.hash;
}

async function signTypedDataWithEmbeddedWallet(inputs: {
  walletApiClient: PrivyWalletApiClient;
  walletId: string;
  signer: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    message: Record<string, unknown>;
    primaryType: string;
  };
}) {
  const signer = requireAddress(inputs.signer, "Invalid signer address.");
  const result = await inputs.walletApiClient.walletApi.ethereum.signTypedData({
    walletId: inputs.walletId,
    address: signer,
    chainType: "ethereum",
    typedData: inputs.typedData,
  });
  return result.signature;
}

function canonicalizeOrderPayload(
  payload: PolymarketOrderPayload,
): PolymarketOrderPayload {
  return {
    ...payload,
    maker: requireAddress(payload.maker, "Invalid Polymarket maker address."),
    signer: requireAddress(
      payload.signer,
      "Invalid Polymarket signer address.",
    ),
  };
}

function isPolymarketOrderPayloadV2(payload: PolymarketOrderPayload): boolean {
  return Boolean(
    payload.timestamp != null && payload.metadata && payload.builder,
  );
}

function isFeeAuthPayloadV3(payload: FeeAuthPayload): boolean {
  return payload.nonce == null;
}

function canonicalizeFeeAuthPayload(payload: FeeAuthPayload): FeeAuthPayload {
  return {
    ...payload,
    signer: requireAddress(
      payload.signer,
      "Invalid Polymarket signer address.",
    ),
    vault: requireAddress(payload.vault, "Invalid Polymarket vault address."),
    exchange: requireAddress(
      payload.exchange,
      "Invalid Polymarket exchange address.",
    ),
  };
}

export async function resolveEmbeddedPolymarketWalletContext(inputs: {
  user: User;
  signer: string;
}): Promise<EmbeddedPolymarketWalletContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }
  const signer = requireAddress(
    inputs.signer,
    "Polymarket automation requires an EVM signer wallet.",
  );
  const privyUser = await PrivyService.getUserById(inputs.user.privyUserId);
  const walletProfiles = PrivyService.classifyWallets(privyUser);
  const walletProfile =
    walletProfiles.find(
      (profile) =>
        profile.walletType === "ethereum" &&
        profile.address.toLowerCase() === signer.toLowerCase(),
    ) ?? null;
  if (!walletProfile?.isInternalWallet) {
    throw new Error(
      "Embedded Polymarket automation is only available for internal Trading Wallets.",
    );
  }
  const walletId = walletProfile.walletId?.trim() ?? "";
  if (!walletId) {
    throw new Error(
      "Embedded Trading Wallet is missing a Privy wallet id. Refresh your session and try again.",
    );
  }
  return {
    signer,
    walletProfile,
    walletId,
  };
}

function createPrivyWalletRpcRequest(args: {
  id: string;
  label: string;
  walletId: string;
  body: Record<string, unknown>;
}): EmbeddedPrivyAuthorizationRequest {
  return {
    id: args.id,
    label: args.label,
    input: {
      version: 1,
      method: "POST",
      url: buildPrivyWalletRpcUrl(args.walletId),
      body: args.body,
      headers: {
        "privy-app-id": env.privyAppId,
      },
    },
  };
}

function readTypedDataPrimaryType(typedData: EmbeddedPolymarketTypedData) {
  const primaryType = typedData.primaryType ?? typedData.primary_type;
  return typeof primaryType === "string" ? primaryType.trim() : "";
}

function readTypedDataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTypedDataNumberString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") return value.toString();
  return readTypedDataString(value);
}

function normalizeTypedDataHex(value: unknown): string | null {
  return normalizeHex(typeof value === "string" ? value : null);
}

function normalizeTypedDataAddress(value: unknown): string | null {
  return normalizeAddress(typeof value === "string" ? value : null);
}

function addressesEqual(left: string | null, right: string | null) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function requireTypedDataChainId(value: unknown, context: string) {
  const chainId = readTypedDataNumberString(value);
  if (chainId !== POLY_CHAIN_ID.toString()) {
    throw new Error(`${context} must use Polygon chainId ${POLY_CHAIN_ID}.`);
  }
}

function allowedPolymarketOperators() {
  return new Set(
    [
      env.polymarketExchangeAddress,
      env.polymarketNegRiskExchangeAddress,
      env.polymarketNegRiskAdapterAddress,
      env.polymarketCtfCollateralAdapterAddress,
      env.polymarketNegRiskCollateralAdapterAddress,
    ]
      .map((value) => normalizeAddress(value))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
}

function allowedDepositWalletTransferTokens() {
  return new Set(
    [
      env.polymarketUsdcAddress,
      env.polymarketUsdceAddress,
      POLYGON_NATIVE_USDC_ADDRESS,
    ]
      .map((value) => normalizeAddress(value))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
}

function validateDepositWalletBatchCall(
  call: unknown,
  {
    depositWallet,
    signer,
    purpose,
  }: {
    depositWallet: string;
    signer: string;
    purpose?: DepositWalletBatchPurpose | null;
  },
) {
  if (typeof call !== "object" || call === null) {
    throw new Error("Invalid deposit wallet call.");
  }
  const record = call as Record<string, unknown>;
  const target = normalizeTypedDataAddress(record.target);
  const data = normalizeTypedDataHex(record.data);
  const value = readTypedDataNumberString(record.value || "0");
  if (!target || !data) {
    throw new Error("Deposit wallet calls require target and data.");
  }
  if (value !== "0") {
    throw new Error("Deposit wallet approval calls cannot send native value.");
  }

  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = TOKEN_APPROVAL_ABI.parseTransaction({ data, value: 0n });
  } catch {
    decoded = null;
  }
  if (!decoded) {
    throw new Error(
      "Deposit wallet batch only supports approval, pUSD transfer, or USDC.e wrap/unwrap calls.",
    );
  }

  if (purpose === "withdraw") {
    const allowedTransferTokens = allowedDepositWalletTransferTokens();
    if (decoded.name === "transfer") {
      const recipient = normalizeAddress(String(decoded.args[0] ?? ""));
      let amount = 0n;
      try {
        amount = BigInt(String(decoded.args[1] ?? "0"));
      } catch {
        amount = 0n;
      }
      if (
        !allowedTransferTokens.has(target.toLowerCase()) ||
        !recipient ||
        amount <= 0n
      ) {
        throw new Error("Unsupported deposit wallet ERC20 transfer call.");
      }
      return;
    }

    if (decoded.name === "approve") {
      const pusdToken = normalizeAddress(env.polymarketUsdcAddress);
      const collateralOfframp = normalizeAddress(
        env.polymarketCollateralOfframpAddress,
      );
      const spender = normalizeAddress(String(decoded.args[0] ?? ""));
      let amount = 0n;
      try {
        amount = BigInt(String(decoded.args[1] ?? "0"));
      } catch {
        amount = 0n;
      }
      if (
        !addressesEqual(target, pusdToken) ||
        !addressesEqual(spender, collateralOfframp) ||
        amount <= 0n
      ) {
        throw new Error("Unsupported deposit wallet pUSD unwrap approval.");
      }
      return;
    }

    if (decoded.name === "unwrap") {
      const collateralOfframp = normalizeAddress(
        env.polymarketCollateralOfframpAddress,
      );
      const usdceToken = normalizeAddress(env.polymarketUsdceAddress);
      const asset = normalizeAddress(String(decoded.args[0] ?? ""));
      const recipient = normalizeAddress(String(decoded.args[1] ?? ""));
      let amount = 0n;
      try {
        amount = BigInt(String(decoded.args[2] ?? "0"));
      } catch {
        amount = 0n;
      }
      if (
        !addressesEqual(target, collateralOfframp) ||
        !addressesEqual(asset, usdceToken) ||
        !addressesEqual(recipient, depositWallet) ||
        amount <= 0n
      ) {
        throw new Error("Unsupported deposit wallet pUSD unwrap call.");
      }
      return;
    }

    throw new Error(
      "Deposit wallet withdraw batches only support transfer and pUSD unwrap calls.",
    );
  }

  if (purpose === "redeem") {
    const conditionalTokens = normalizeAddress(
      env.polymarketConditionalTokensAddress,
    );
    const negRiskAdapter = normalizeAddress(
      env.polymarketNegRiskAdapterAddress,
    );
    const ctfCollateralAdapter = normalizeAddress(
      env.polymarketCtfCollateralAdapterAddress,
    );
    const negRiskCollateralAdapter = normalizeAddress(
      env.polymarketNegRiskCollateralAdapterAddress,
    );
    if (decoded.name === "redeemPositions") {
      const inputCount = decoded.fragment.inputs.length;
      const standardCtfRedeem =
        addressesEqual(target, conditionalTokens) && inputCount === 4;
      const ctfCollateralAdapterRedeem =
        addressesEqual(target, ctfCollateralAdapter) && inputCount === 4;
      const negRiskCollateralAdapterRedeem =
        addressesEqual(target, negRiskCollateralAdapter) && inputCount === 4;
      const negRiskRedeem =
        addressesEqual(target, negRiskAdapter) && inputCount === 2;
      if (
        !standardCtfRedeem &&
        !ctfCollateralAdapterRedeem &&
        !negRiskCollateralAdapterRedeem &&
        !negRiskRedeem
      ) {
        throw new Error("Unsupported deposit wallet redemption call.");
      }
      return;
    }

    if (decoded.name === "approve") {
      const usdceToken = normalizeAddress(env.polymarketUsdceAddress);
      const collateralOnramp = normalizeAddress(
        env.polymarketCollateralOnrampAddress,
      );
      const spender = normalizeAddress(String(decoded.args[0] ?? ""));
      let amount = 0n;
      try {
        amount = BigInt(String(decoded.args[1] ?? "0"));
      } catch {
        amount = 0n;
      }
      if (
        !addressesEqual(target, usdceToken) ||
        !addressesEqual(spender, collateralOnramp) ||
        amount <= 0n
      ) {
        throw new Error("Unsupported deposit wallet redemption wrap approval.");
      }
      return;
    }

    if (decoded.name === "wrap") {
      const collateralOnramp = normalizeAddress(
        env.polymarketCollateralOnrampAddress,
      );
      const usdceToken = normalizeAddress(env.polymarketUsdceAddress);
      const asset = normalizeAddress(String(decoded.args[0] ?? ""));
      const recipient = normalizeAddress(String(decoded.args[1] ?? ""));
      let amount = 0n;
      try {
        amount = BigInt(String(decoded.args[2] ?? "0"));
      } catch {
        amount = 0n;
      }
      if (
        !addressesEqual(target, collateralOnramp) ||
        !addressesEqual(asset, usdceToken) ||
        !addressesEqual(recipient, depositWallet) ||
        amount <= 0n
      ) {
        throw new Error(
          "Unsupported deposit wallet redemption pUSD wrap call.",
        );
      }
      return;
    }

    throw new Error(
      "Deposit wallet redeem batches only support redemption and USDC.e wrap calls.",
    );
  }

  const allowedOperators = allowedPolymarketOperators();
  if (decoded.name === "approve") {
    const pusdToken = normalizeAddress(env.polymarketUsdcAddress);
    const usdceToken = normalizeAddress(env.polymarketUsdceAddress);
    const collateralOnramp = normalizeAddress(
      env.polymarketCollateralOnrampAddress,
    );
    const spender = normalizeAddress(String(decoded.args[0] ?? ""));
    const approvesPusdOperator =
      addressesEqual(target, pusdToken) &&
      (spender ? allowedOperators.has(spender.toLowerCase()) : false);
    const approvesUsdceWrap =
      addressesEqual(target, usdceToken) &&
      (spender ? addressesEqual(spender, collateralOnramp) : false);
    if (!approvesPusdOperator && !approvesUsdceWrap) {
      throw new Error("Unsupported deposit wallet ERC20 approval target.");
    }
    return;
  }

  if (decoded.name === "wrap") {
    const collateralOnramp = normalizeAddress(
      env.polymarketCollateralOnrampAddress,
    );
    const usdceToken = normalizeAddress(env.polymarketUsdceAddress);
    const asset = normalizeAddress(String(decoded.args[0] ?? ""));
    const recipient = normalizeAddress(String(decoded.args[1] ?? ""));
    let amount = 0n;
    try {
      amount = BigInt(String(decoded.args[2] ?? "0"));
    } catch {
      amount = 0n;
    }
    if (
      !addressesEqual(target, collateralOnramp) ||
      !addressesEqual(asset, usdceToken) ||
      !addressesEqual(recipient, depositWallet) ||
      amount <= 0n
    ) {
      throw new Error("Unsupported deposit wallet pUSD wrap call.");
    }
    return;
  }

  if (decoded.name === "transfer") {
    const allowedTransferTokens = allowedDepositWalletTransferTokens();
    const recipient = normalizeAddress(String(decoded.args[0] ?? ""));
    let amount = 0n;
    try {
      amount = BigInt(String(decoded.args[1] ?? "0"));
    } catch {
      amount = 0n;
    }
    if (
      !allowedTransferTokens.has(target.toLowerCase()) ||
      !addressesEqual(recipient, signer) ||
      amount <= 0n
    ) {
      throw new Error("Unsupported deposit wallet ERC20 transfer call.");
    }
    return;
  }

  if (decoded.name === "setApprovalForAll") {
    const conditionalTokens = normalizeAddress(
      env.polymarketConditionalTokensAddress,
    );
    const operator = normalizeAddress(String(decoded.args[0] ?? ""));
    const approved = Boolean(decoded.args[1]);
    if (
      !addressesEqual(target, conditionalTokens) ||
      !operator ||
      !allowedOperators.has(operator.toLowerCase()) ||
      !approved
    ) {
      throw new Error("Unsupported deposit wallet conditional-token approval.");
    }
    return;
  }

  throw new Error(
    "Deposit wallet batch only supports approval, pUSD transfer, or USDC.e wrap calls.",
  );
}

function validateDepositWalletBatchTypedData(
  typedData: EmbeddedPolymarketTypedData,
  context: EmbeddedPolymarketWalletContext,
  purpose?: DepositWalletBatchPurpose | null,
) {
  const domain = typedData.domain;
  const message = typedData.message;
  if (readTypedDataString(domain.name) !== "DepositWallet") {
    throw new Error("Deposit wallet batch has an invalid domain.");
  }
  if (readTypedDataString(domain.version) !== "1") {
    throw new Error("Deposit wallet batch has an invalid domain version.");
  }
  requireTypedDataChainId(domain.chainId, "Deposit wallet batch");

  const verifyingContract = normalizeTypedDataAddress(domain.verifyingContract);
  const wallet = normalizeTypedDataAddress(message.wallet);
  if (!addressesEqual(verifyingContract, wallet)) {
    throw new Error("Deposit wallet batch wallet mismatch.");
  }
  const signer = normalizeAddress(context.signer);
  if (!wallet || !signer) {
    throw new Error("Deposit wallet batch requires wallet and signer.");
  }

  const nonce = readTypedDataNumberString(message.nonce);
  const deadline = readTypedDataNumberString(message.deadline);
  if (!/^\d+$/.test(nonce) || !/^\d+$/.test(deadline)) {
    throw new Error("Deposit wallet batch requires numeric nonce/deadline.");
  }

  const calls = Array.isArray(message.calls) ? message.calls : [];
  if (calls.length < 1 || calls.length > 24) {
    throw new Error("Deposit wallet batch call count is invalid.");
  }
  for (const call of calls) {
    validateDepositWalletBatchCall(call, {
      depositWallet: wallet,
      signer,
      purpose,
    });
  }
}

function validateDepositWalletTypedDataSign(
  typedData: EmbeddedPolymarketTypedData,
) {
  const domain = typedData.domain;
  const message = typedData.message;
  const appName = readTypedDataString(domain.name);
  if (appName !== "Polymarket CTF Exchange") {
    throw new Error("Unsupported Polymarket deposit wallet typed data.");
  }
  requireTypedDataChainId(domain.chainId, "Polymarket typed data");

  if (readTypedDataString(message.name) !== "DepositWallet") {
    throw new Error("Polymarket typed data must target a deposit wallet.");
  }
  if (readTypedDataString(message.version) !== "1") {
    throw new Error("Invalid deposit wallet typed-data version.");
  }
  requireTypedDataChainId(message.chainId, "Deposit wallet typed data");
  const depositWallet = normalizeTypedDataAddress(message.verifyingContract);
  const contents =
    typeof message.contents === "object" && message.contents !== null
      ? (message.contents as Record<string, unknown>)
      : null;
  if (!depositWallet || !contents) {
    throw new Error("Deposit wallet typed data is missing contents.");
  }

  const maker = normalizeTypedDataAddress(contents.maker);
  const signer = normalizeTypedDataAddress(contents.signer);
  const signatureType = readTypedDataNumberString(contents.signatureType);
  if (
    signatureType !== "3" ||
    !addressesEqual(maker, depositWallet) ||
    !addressesEqual(signer, depositWallet)
  ) {
    throw new Error("Invalid deposit wallet order typed data.");
  }
}

function validateEmbeddedPolymarketTypedData(
  typedData: EmbeddedPolymarketTypedData,
  context: EmbeddedPolymarketWalletContext,
  options: {
    depositWalletBatchPurpose?: DepositWalletBatchPurpose | null;
  } = {},
) {
  const primaryType = readTypedDataPrimaryType(typedData);
  if (primaryType === "Batch") {
    validateDepositWalletBatchTypedData(
      typedData,
      context,
      options.depositWalletBatchPurpose,
    );
    return;
  }
  if (options.depositWalletBatchPurpose) {
    throw new Error("Deposit wallet batch purpose is only valid for batches.");
  }
  if (primaryType === "TypedDataSign") {
    validateDepositWalletTypedDataSign(typedData);
    return;
  }
  throw new Error("Unsupported embedded Polymarket typed data.");
}

export function buildEmbeddedPolymarketTypedDataRequest(inputs: {
  context: EmbeddedPolymarketWalletContext;
  typedData: EmbeddedPolymarketTypedData;
  id?: string | null;
  label?: string | null;
  depositWalletBatchPurpose?: DepositWalletBatchPurpose | null;
}): EmbeddedPrivyAuthorizationRequest {
  validateEmbeddedPolymarketTypedData(inputs.typedData, inputs.context, {
    depositWalletBatchPurpose: inputs.depositWalletBatchPurpose,
  });
  const primaryType = readTypedDataPrimaryType(inputs.typedData);
  return createPrivyWalletRpcRequest({
    id: inputs.id?.trim() || "polymarket-typed-data-signature",
    label: inputs.label?.trim() || "Polymarket typed-data signature",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: primaryType,
          domain: inputs.typedData.domain,
          types: inputs.typedData.types,
          message: inputs.typedData.message,
        },
      },
    },
  });
}

export function buildEmbeddedPolymarketConnectRequest(inputs: {
  context: EmbeddedPolymarketWalletContext;
  timestamp: string;
  nonce: number;
}): EmbeddedPrivyAuthorizationRequest {
  const typedData = buildEmbeddedPolymarketConnectPayload({
    signer: inputs.context.signer,
    timestamp: inputs.timestamp,
    nonce: inputs.nonce,
  });
  return createPrivyWalletRpcRequest({
    id: "polymarket-connect",
    label: "Polymarket connect",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: typedData.primaryType,
          domain: typedData.domain,
          types: typedData.types,
          message: typedData.message,
        },
      },
    },
  });
}

function buildEmbeddedPolymarketOrderTypedData(inputs: {
  signer: string;
  payload: PolymarketOrderPayload;
  exchangeAddress: string;
}) {
  const exchangeAddress = requireAddress(
    inputs.exchangeAddress,
    "Invalid Polymarket exchange address.",
  );
  const typedPayload = canonicalizeOrderPayload(inputs.payload);
  if (typedPayload.signer.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Polymarket order signer must match the selected Trading Wallet.",
    );
  }
  const signatureType = readTypedDataNumberString(typedPayload.signatureType);
  if (signatureType !== "2") {
    throw new Error(
      "Embedded Polymarket orders must use a deposit wallet or deployed legacy Safe.",
    );
  }
  if (!isPolymarketOrderPayloadV2(typedPayload)) {
    throw new Error("Polymarket embedded orders must use CLOB V2 payloads.");
  }
  return {
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: POLY_CHAIN_ID,
      verifyingContract: exchangeAddress,
    },
    types: {
      EIP712Domain: POLYMARKET_DOMAIN_TYPES,
      Order: POLYMARKET_ORDER_TYPES_V2.Order,
    },
    primaryType: "Order",
    message: typedPayload,
  } as const;
}

export function buildEmbeddedPolymarketOrderRequest(inputs: {
  context: EmbeddedPolymarketWalletContext;
  payload: PolymarketOrderPayload;
  exchangeAddress: string;
}): EmbeddedPrivyAuthorizationRequest {
  const typedData = buildEmbeddedPolymarketOrderTypedData({
    signer: inputs.context.signer,
    payload: inputs.payload,
    exchangeAddress: inputs.exchangeAddress,
  });
  return createPrivyWalletRpcRequest({
    id: "polymarket-order-signature",
    label: "Polymarket order signature",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: typedData.primaryType,
          domain: typedData.domain,
          types: typedData.types,
          message: typedData.message,
        },
      },
    },
  });
}

function buildEmbeddedPolymarketFeeAuthTypedData(inputs: {
  signer: string;
  payload: FeeAuthPayload;
  feeCollectorAddress: string;
}) {
  const feeCollectorAddress = requireAddress(
    inputs.feeCollectorAddress,
    "Invalid Polymarket fee collector address.",
  );
  const typedPayload = canonicalizeFeeAuthPayload(inputs.payload);
  if (typedPayload.signer.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Polymarket fee authorization signer must match the selected Trading Wallet.",
    );
  }
  return {
    domain: {
      name: "Polymarket Aggregator FeeCollector",
      version: isFeeAuthPayloadV3(typedPayload) ? "3" : "2",
      chainId: POLY_CHAIN_ID,
      verifyingContract: feeCollectorAddress,
    },
    types: {
      EIP712Domain: POLYMARKET_DOMAIN_TYPES,
      ...(isFeeAuthPayloadV3(typedPayload)
        ? { FeeAuthV3: FEE_AUTH_TYPES_V3.FeeAuthV3 }
        : { FeeAuth: FEE_AUTH_TYPES.FeeAuth }),
    },
    primaryType: isFeeAuthPayloadV3(typedPayload) ? "FeeAuthV3" : "FeeAuth",
    message: typedPayload,
  } as const;
}

export function buildEmbeddedPolymarketFeeAuthRequest(inputs: {
  context: EmbeddedPolymarketWalletContext;
  payload: FeeAuthPayload;
  feeCollectorAddress: string;
}): EmbeddedPrivyAuthorizationRequest {
  const typedData = buildEmbeddedPolymarketFeeAuthTypedData({
    signer: inputs.context.signer,
    payload: inputs.payload,
    feeCollectorAddress: inputs.feeCollectorAddress,
  });
  return createPrivyWalletRpcRequest({
    id: "polymarket-fee-auth-signature",
    label: "Polymarket fee authorization",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: typedData.primaryType,
          domain: typedData.domain,
          types: typedData.types,
          message: typedData.message,
        },
      },
    },
  });
}

function buildEmbeddedSignerApprovalRequest(inputs: {
  context: EmbeddedPolymarketWalletContext;
  task: ApprovalTask;
  requestId: string;
}): EmbeddedPrivyAuthorizationRequest {
  return createPrivyWalletRpcRequest({
    id: inputs.requestId,
    label: inputs.task.description,
    walletId: inputs.context.walletId,
    body: {
      method: "eth_sendTransaction",
      caip2: POLY_CAIP2,
      sponsor: true,
      params: {
        transaction: {
          from: inputs.context.signer,
          to: requireAddress(inputs.task.target, "Invalid approval target."),
          data: normalizeHex(inputs.task.data),
        },
      },
    },
  });
}

export async function executeEmbeddedPolymarketConnectRequest(inputs: {
  request: EmbeddedPrivyAuthorizationRequest;
  authorizationSignature: string;
}): Promise<string> {
  const payload = await executePreparedPrivyAuthorizationRequest(
    inputs.request,
    inputs.authorizationSignature,
  );
  return parsePrivyRpcSignatureResponse(payload);
}

export async function executeEmbeddedPolymarketOrderRequest(inputs: {
  request: EmbeddedPrivyAuthorizationRequest;
  authorizationSignature: string;
}): Promise<string> {
  const payload = await executePreparedPrivyAuthorizationRequest(
    inputs.request,
    inputs.authorizationSignature,
  );
  return parsePrivyRpcSignatureResponse(payload);
}

export async function executeEmbeddedPolymarketFeeAuthRequest(inputs: {
  request: EmbeddedPrivyAuthorizationRequest;
  authorizationSignature: string;
}): Promise<string> {
  const payload = await executePreparedPrivyAuthorizationRequest(
    inputs.request,
    inputs.authorizationSignature,
  );
  return parsePrivyRpcSignatureResponse(payload);
}

export async function executeEmbeddedPolymarketTypedDataRequest(inputs: {
  request: EmbeddedPrivyAuthorizationRequest;
  authorizationSignature: string;
}): Promise<string> {
  const payload = await executePreparedPrivyAuthorizationRequest(
    inputs.request,
    inputs.authorizationSignature,
  );
  return parsePrivyRpcSignatureResponse(payload);
}

export async function resolveEmbeddedPolymarketContext(inputs: {
  user: User;
  signer: string;
  accessToken?: string | null;
  identityToken?: string | null;
}): Promise<EmbeddedPolymarketContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }
  const signer = requireAddress(
    inputs.signer,
    "Polymarket automation requires an EVM signer wallet.",
  );
  const { authUserId, walletProfiles, walletClient } =
    await PrivyService.createUserWalletClientWithFallback({
      accessToken: inputs.accessToken,
      identityToken: inputs.identityToken,
    });
  if (authUserId !== inputs.user.privyUserId) {
    throw new Error("Privy access token does not belong to the current user.");
  }
  const walletProfile =
    walletProfiles.find(
      (profile) =>
        profile.walletType === "ethereum" &&
        profile.address.toLowerCase() === signer.toLowerCase(),
    ) ?? null;
  if (!walletProfile?.isInternalWallet) {
    throw new Error(
      "Embedded Polymarket automation is only available for internal Trading Wallets.",
    );
  }
  const walletId = walletProfile.walletId?.trim() ?? "";
  if (!walletId) {
    throw new Error(
      "Embedded Trading Wallet is missing a Privy wallet id. Refresh your session and try again.",
    );
  }
  return {
    signer,
    walletProfile,
    walletId,
    walletApiClient: walletClient,
  };
}

export function buildEmbeddedPolymarketConnectPayload(inputs: {
  signer: string;
  timestamp: string;
  nonce: number;
}) {
  const signer = requireAddress(inputs.signer, "Invalid Polymarket signer.");
  return {
    domain: {
      name: "ClobAuthDomain",
      version: "1",
      chainId: POLY_CHAIN_ID,
    },
    types: {
      EIP712Domain: POLYMARKET_AUTH_DOMAIN_TYPES,
      ClobAuth: POLYMARKET_AUTH_TYPES.ClobAuth,
    },
    primaryType: "ClobAuth",
    message: {
      address: signer,
      timestamp: inputs.timestamp,
      nonce: inputs.nonce.toString(),
      message: AUTH_MESSAGE,
    },
  } as const;
}

export async function signEmbeddedPolymarketConnect(inputs: {
  context: EmbeddedPolymarketContext;
  timestamp: string;
  nonce: number;
}) {
  return signTypedDataWithEmbeddedWallet({
    walletApiClient: inputs.context.walletApiClient,
    walletId: inputs.context.walletId,
    signer: inputs.context.signer,
    typedData: buildEmbeddedPolymarketConnectPayload({
      signer: inputs.context.signer,
      timestamp: inputs.timestamp,
      nonce: inputs.nonce,
    }),
  });
}

export async function signEmbeddedPolymarketOrder(inputs: {
  context: EmbeddedPolymarketContext;
  payload: PolymarketOrderPayload;
  exchangeAddress: string;
}) {
  const exchangeAddress = requireAddress(
    inputs.exchangeAddress,
    "Invalid Polymarket exchange address.",
  );
  const typedPayload = canonicalizeOrderPayload(inputs.payload);
  if (
    typedPayload.signer.toLowerCase() !== inputs.context.signer.toLowerCase()
  ) {
    throw new Error(
      "Embedded Polymarket order signer must match the selected Trading Wallet.",
    );
  }
  if (!isPolymarketOrderPayloadV2(typedPayload)) {
    throw new Error("Embedded Polymarket orders must use CLOB V2 payloads.");
  }
  return signTypedDataWithEmbeddedWallet({
    walletApiClient: inputs.context.walletApiClient,
    walletId: inputs.context.walletId,
    signer: inputs.context.signer,
    typedData: {
      domain: {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: POLY_CHAIN_ID,
        verifyingContract: exchangeAddress,
      },
      types: {
        EIP712Domain: POLYMARKET_DOMAIN_TYPES,
        Order: POLYMARKET_ORDER_TYPES_V2.Order,
      },
      primaryType: "Order",
      message: typedPayload,
    },
  });
}

export async function signEmbeddedPolymarketFeeAuth(inputs: {
  context: EmbeddedPolymarketContext;
  payload: FeeAuthPayload;
  feeCollectorAddress: string;
}) {
  const feeCollectorAddress = requireAddress(
    inputs.feeCollectorAddress,
    "Invalid Polymarket fee collector address.",
  );
  const typedPayload = canonicalizeFeeAuthPayload(inputs.payload);
  if (
    typedPayload.signer.toLowerCase() !== inputs.context.signer.toLowerCase()
  ) {
    throw new Error(
      "Embedded Polymarket fee authorization signer must match the selected Trading Wallet.",
    );
  }
  return signTypedDataWithEmbeddedWallet({
    walletApiClient: inputs.context.walletApiClient,
    walletId: inputs.context.walletId,
    signer: inputs.context.signer,
    typedData: {
      domain: {
        name: "Polymarket Aggregator FeeCollector",
        version: isFeeAuthPayloadV3(typedPayload) ? "3" : "2",
        chainId: POLY_CHAIN_ID,
        verifyingContract: feeCollectorAddress,
      },
      types: {
        EIP712Domain: POLYMARKET_DOMAIN_TYPES,
        ...(isFeeAuthPayloadV3(typedPayload)
          ? { FeeAuthV3: FEE_AUTH_TYPES_V3.FeeAuthV3 }
          : { FeeAuth: FEE_AUTH_TYPES.FeeAuth }),
      },
      primaryType: isFeeAuthPayloadV3(typedPayload) ? "FeeAuthV3" : "FeeAuth",
      message: typedPayload,
    },
  });
}

export async function deployEmbeddedPolymarketSafe(inputs: {
  context: EmbeddedPolymarketContext;
}) {
  const typedData = {
    domain: {
      name: SAFE_PROXY_DOMAIN_NAME,
      chainId: POLY_CHAIN_ID,
      verifyingContract: requireAddress(
        env.polymarketSafeFactoryAddress,
        "Invalid Polymarket Safe factory address.",
      ),
    },
    types: {
      EIP712Domain: SAFE_PROXY_DOMAIN_TYPES,
      CreateProxy: SAFE_PROXY_TYPES.CreateProxy,
    },
    primaryType: "CreateProxy",
    message: {
      paymentToken: ZERO_ADDRESS,
      payment: "0",
      paymentReceiver: ZERO_ADDRESS,
    },
  } as const;

  const signature = await signTypedDataWithEmbeddedWallet({
    walletApiClient: inputs.context.walletApiClient,
    walletId: inputs.context.walletId,
    signer: inputs.context.signer,
    typedData,
  });
  const { v, r, s } = splitSignature(signature);
  const data = SAFE_PROXY_FACTORY_ABI.encodeFunctionData("createProxy", [
    ZERO_ADDRESS,
    0n,
    ZERO_ADDRESS,
    { v, r, s },
  ]);

  return sendSponsoredPolygonTransaction({
    walletApiClient: inputs.context.walletApiClient,
    walletId: inputs.context.walletId,
    signer: inputs.context.signer,
    to: env.polymarketSafeFactoryAddress,
    data,
    context: "Polymarket Safe deployment",
  });
}

function buildApprovalTasks(inputs: {
  funder: string;
  currentApprovals: {
    exchangeApproved: boolean;
    negRiskExchangeApproved: boolean;
    negRiskAdapterApproved: boolean;
    ctfCollateralAdapterApproved: boolean;
    negRiskCollateralAdapterApproved: boolean;
    feeCollectorApproved: boolean;
    exchangeAllowanceOk: boolean;
    negRiskExchangeAllowanceOk: boolean;
    negRiskAdapterAllowanceOk: boolean;
    feeCollectorAllowanceOk: boolean;
  };
}): ApprovalTask[] {
  const tasks: ApprovalTask[] = [];
  if (!inputs.currentApprovals.exchangeAllowanceOk) {
    tasks.push({
      kind: "erc20_approve",
      target: env.polymarketUsdcAddress,
      data: encodeApprove(env.polymarketExchangeAddress),
      description: "USDC exchange approval",
    });
  }
  if (!inputs.currentApprovals.negRiskExchangeAllowanceOk) {
    tasks.push({
      kind: "erc20_approve",
      target: env.polymarketUsdcAddress,
      data: encodeApprove(env.polymarketNegRiskExchangeAddress),
      description: "USDC neg-risk exchange approval",
    });
  }
  if (
    env.polymarketNegRiskAdapterAddress &&
    !inputs.currentApprovals.negRiskAdapterAllowanceOk
  ) {
    tasks.push({
      kind: "erc20_approve",
      target: env.polymarketUsdcAddress,
      data: encodeApprove(env.polymarketNegRiskAdapterAddress),
      description: "USDC neg-risk adapter approval",
    });
  }
  if (!inputs.currentApprovals.exchangeApproved) {
    tasks.push({
      kind: "erc1155_approve_all",
      target: env.polymarketConditionalTokensAddress,
      data: encodeSetApprovalForAll(env.polymarketExchangeAddress),
      description: "Conditional tokens exchange approval",
    });
  }
  if (!inputs.currentApprovals.negRiskExchangeApproved) {
    tasks.push({
      kind: "erc1155_approve_all",
      target: env.polymarketConditionalTokensAddress,
      data: encodeSetApprovalForAll(env.polymarketNegRiskExchangeAddress),
      description: "Conditional tokens neg-risk exchange approval",
    });
  }
  if (
    env.polymarketNegRiskAdapterAddress &&
    !inputs.currentApprovals.negRiskAdapterApproved
  ) {
    tasks.push({
      kind: "erc1155_approve_all",
      target: env.polymarketConditionalTokensAddress,
      data: encodeSetApprovalForAll(env.polymarketNegRiskAdapterAddress),
      description: "Conditional tokens neg-risk adapter approval",
    });
  }
  if (
    env.polymarketCtfCollateralAdapterAddress &&
    !inputs.currentApprovals.ctfCollateralAdapterApproved
  ) {
    tasks.push({
      kind: "erc1155_approve_all",
      target: env.polymarketConditionalTokensAddress,
      data: encodeSetApprovalForAll(env.polymarketCtfCollateralAdapterAddress),
      description: "Conditional tokens collateral adapter approval",
    });
  }
  if (
    env.polymarketNegRiskCollateralAdapterAddress &&
    !inputs.currentApprovals.negRiskCollateralAdapterApproved
  ) {
    tasks.push({
      kind: "erc1155_approve_all",
      target: env.polymarketConditionalTokensAddress,
      data: encodeSetApprovalForAll(
        env.polymarketNegRiskCollateralAdapterAddress,
      ),
      description: "Conditional tokens neg-risk collateral adapter approval",
    });
  }
  return tasks;
}

export function prepareEmbeddedPolymarketSignerApprovalRequests(inputs: {
  context: EmbeddedPolymarketWalletContext;
  funder: string;
  currentApprovals: {
    exchangeApproved: boolean;
    negRiskExchangeApproved: boolean;
    negRiskAdapterApproved: boolean;
    ctfCollateralAdapterApproved: boolean;
    negRiskCollateralAdapterApproved: boolean;
    feeCollectorApproved: boolean;
    exchangeAllowanceOk: boolean;
    negRiskExchangeAllowanceOk: boolean;
    negRiskAdapterAllowanceOk: boolean;
    feeCollectorAllowanceOk: boolean;
  };
}): EmbeddedPrivyAuthorizationRequest[] {
  const funder = requireAddress(inputs.funder, "Invalid Polymarket funder.");
  if (funder.toLowerCase() !== inputs.context.signer.toLowerCase()) {
    return [];
  }
  return buildApprovalTasks({
    funder,
    currentApprovals: inputs.currentApprovals,
  }).map((task, index) =>
    buildEmbeddedSignerApprovalRequest({
      context: inputs.context,
      task,
      requestId: `approval-${index}`,
    }),
  );
}

export async function executeEmbeddedSignerApprovalRequests(inputs: {
  requests: EmbeddedPrivyAuthorizationRequest[];
  signatures: EmbeddedPrivyAuthorizationSignature[];
}): Promise<string[]> {
  const pendingTransactions: Array<{
    request: EmbeddedPrivyAuthorizationRequest;
    postcondition: ApprovalPostcondition | null;
    hash: string | null;
    transactionId: string | null;
    userOperationHash: string | null;
  }> = [];
  for (const request of inputs.requests) {
    const postcondition = await buildApprovalPostcondition(request);
    const authorizationSignature = findAuthorizationSignature(
      inputs.signatures,
      request.id,
    );
    let payload: Record<string, unknown> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        payload = await executePreparedPrivyAuthorizationRequest(
          request,
          authorizationSignature,
        );
        break;
      } catch (error) {
        lastError = error;
        if (!isPrivyInflightAuthorizationError(error) || attempt === 2) {
          throw error;
        }
        await waitForInflightAuthorizationRetry(attempt);
      }
    }

    if (!payload) {
      throw (
        lastError ??
        new Error(`${request.label} did not produce a Privy wallet response.`)
      );
    }

    const { hash, transactionId, userOperationHash } =
      parsePrivyRpcTransactionHashResponse(payload);
    pendingTransactions.push({
      request,
      postcondition,
      hash,
      transactionId,
      userOperationHash,
    });
  }

  return Promise.all(
    pendingTransactions.map(async (pending) => {
      const resolvedHash =
        pending.hash ??
        (pending.transactionId
          ? await waitForPrivyTransaction(
              pending.transactionId,
              pending.request.label,
            )
          : null);
      if (resolvedHash) {
        await waitForPolygonTransaction(resolvedHash, pending.request.label);
        return resolvedHash;
      }
      if (pending.userOperationHash) {
        await waitForApprovalPostcondition(
          pending.postcondition,
          pending.request.label,
        );
        return pending.userOperationHash;
      }
      throw new Error(
        `${pending.request.label} did not produce a transaction hash after Privy sponsorship.`,
      );
    }),
  );
}

async function executeSafeApprovalTasks(inputs: {
  context: EmbeddedPolymarketContext;
  safeAddress: string;
  tasks: ApprovalTask[];
}) {
  const provider = polygonProvider();
  const safeAddress = requireAddress(
    inputs.safeAddress,
    "Invalid Safe address.",
  );
  const nonceResult = await provider.call({
    to: safeAddress,
    data: SAFE_ABI.encodeFunctionData("nonce", []),
  });
  const ownersResult = await provider.call({
    to: safeAddress,
    data: SAFE_ABI.encodeFunctionData("getOwners", []),
  });
  const thresholdResult = await provider.call({
    to: safeAddress,
    data: SAFE_ABI.encodeFunctionData("getThreshold", []),
  });
  const nonceDecoded = SAFE_ABI.decodeFunctionResult("nonce", nonceResult);
  const ownersDecoded = SAFE_ABI.decodeFunctionResult(
    "getOwners",
    ownersResult,
  );
  const thresholdDecoded = SAFE_ABI.decodeFunctionResult(
    "getThreshold",
    thresholdResult,
  );
  const nonce = nonceDecoded[0] as bigint;
  const owners = (ownersDecoded[0] as string[]).map((owner) =>
    owner.toLowerCase(),
  );
  const threshold = Number(thresholdDecoded[0] as bigint);
  if (
    !owners.includes(inputs.context.signer.toLowerCase()) ||
    threshold !== 1
  ) {
    throw new Error(
      "Embedded automation only supports 1/1 Safe funders owned by the Trading Wallet.",
    );
  }

  let nextNonce = nonce;
  const transactionHashes: string[] = [];
  for (const task of inputs.tasks) {
    const typedData = {
      domain: {
        chainId: POLY_CHAIN_ID,
        verifyingContract: safeAddress,
      },
      types: {
        EIP712Domain: SAFE_TX_DOMAIN_TYPES,
        SafeTx: SAFE_TX_TYPES.SafeTx,
      },
      primaryType: "SafeTx",
      message: {
        to: requireAddress(task.target, "Invalid Safe target."),
        value: "0",
        data: normalizeHex(task.data),
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: nextNonce.toString(),
      },
    } as const;
    const signature = await signTypedDataWithEmbeddedWallet({
      walletApiClient: inputs.context.walletApiClient,
      walletId: inputs.context.walletId,
      signer: inputs.context.signer,
      typedData,
    });
    const execData = SAFE_ABI.encodeFunctionData("execTransaction", [
      requireAddress(task.target, "Invalid Safe target."),
      0n,
      normalizeHex(task.data),
      0,
      0n,
      0n,
      0n,
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      signatureToBytes(signature),
    ]);
    const txHash = await sendSponsoredPolygonTransaction({
      walletApiClient: inputs.context.walletApiClient,
      walletId: inputs.context.walletId,
      signer: inputs.context.signer,
      to: safeAddress,
      data: execData,
      context: task.description,
    });
    transactionHashes.push(txHash);
    nextNonce += 1n;
  }
  return transactionHashes;
}

async function executeMagicApprovalTasks(inputs: {
  context: EmbeddedPolymarketContext;
  tasks: ApprovalTask[];
}) {
  const txHashes: string[] = [];
  for (const task of inputs.tasks) {
    const proxyData = MAGIC_PROXY_FACTORY_ABI.encodeFunctionData("proxy", [
      [
        {
          typeCode: 0,
          to: requireAddress(task.target, "Invalid magic proxy target."),
          value: 0n,
          data: normalizeHex(task.data),
        },
      ],
    ]);
    const txHash = await sendSponsoredPolygonTransaction({
      walletApiClient: inputs.context.walletApiClient,
      walletId: inputs.context.walletId,
      signer: inputs.context.signer,
      to: env.polymarketMagicProxyFactoryAddress,
      data: proxyData,
      context: task.description,
    });
    txHashes.push(txHash);
  }
  return txHashes;
}

async function executeSignerApprovalTasks(inputs: {
  context: EmbeddedPolymarketContext;
  tasks: ApprovalTask[];
}) {
  const txHashes: string[] = [];
  for (const task of inputs.tasks) {
    const txHash = await sendSponsoredPolygonTransaction({
      walletApiClient: inputs.context.walletApiClient,
      walletId: inputs.context.walletId,
      signer: inputs.context.signer,
      to: task.target,
      data: task.data,
      context: task.description,
    });
    txHashes.push(txHash);
  }
  return txHashes;
}

export async function ensureEmbeddedPolymarketApprovals(inputs: {
  context: EmbeddedPolymarketContext;
  funder: string;
  funderCandidate: PolymarketFunderCandidate | null;
  currentApprovals: {
    exchangeApproved: boolean;
    negRiskExchangeApproved: boolean;
    negRiskAdapterApproved: boolean;
    ctfCollateralAdapterApproved: boolean;
    negRiskCollateralAdapterApproved: boolean;
    feeCollectorApproved: boolean;
    exchangeAllowanceOk: boolean;
    negRiskExchangeAllowanceOk: boolean;
    negRiskAdapterAllowanceOk: boolean;
    feeCollectorAllowanceOk: boolean;
  };
}): Promise<EmbeddedPolymarketExecutionSummary | null> {
  const funder = requireAddress(inputs.funder, "Invalid Polymarket funder.");
  const signer = inputs.context.signer;
  const tasks = buildApprovalTasks({
    funder,
    currentApprovals: inputs.currentApprovals,
  });
  if (tasks.length === 0) return null;

  if (funder.toLowerCase() === signer.toLowerCase()) {
    return {
      signer,
      funder,
      funderKind: "signer",
      transactionHashes: await executeSignerApprovalTasks({
        context: inputs.context,
        tasks,
      }),
    };
  }

  if (
    inputs.funderCandidate?.source === "magic_proxy" ||
    inputs.funderCandidate?.signatureType === 1
  ) {
    return {
      signer,
      funder,
      funderKind: "magic",
      transactionHashes: await executeMagicApprovalTasks({
        context: inputs.context,
        tasks,
      }),
    };
  }

  if (
    inputs.funderCandidate?.contractKind === "SAFE_LIKE" ||
    inputs.funderCandidate?.source === "safe_proxy" ||
    inputs.funderCandidate?.signatureType === 2
  ) {
    return {
      signer,
      funder,
      funderKind: "safe",
      transactionHashes: await executeSafeApprovalTasks({
        context: inputs.context,
        safeAddress: funder,
        tasks,
      }),
    };
  }

  throw new Error(
    "Embedded automation does not support a distinct EOA Polymarket funder.",
  );
}
