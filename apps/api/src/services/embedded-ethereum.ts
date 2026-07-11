import { ethers } from "ethers";

import type { User } from "../auth.js";
import { env } from "../env.js";
import {
  type PrivyWalletApiClient,
  type PrivyWalletApiRequestSignatureInput,
  type PrivyWalletProfile,
  PrivyService,
} from "../privy-service.js";

const PRIVY_WALLET_API_BASE_URL = "https://api.privy.io";

export type EmbeddedPrivyAuthorizationRequest = {
  id: string;
  label: string;
  input: PrivyWalletApiRequestSignatureInput;
};

export type EmbeddedPrivyAuthorizationSignature = {
  id: string;
  signature: string;
};

export type EmbeddedEthereumTransactionSpec = {
  id: string;
  label: string;
  to: string;
  data?: string | null;
  value?: string | null;
  gas?: string | null;
  sponsor?: boolean;
  referenceId?: string;
};

export type EmbeddedEthereumWalletContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
};

type PrivyTransactionStatus =
  | "broadcasted"
  | "confirmed"
  | "execution_reverted"
  | "failed"
  | "replaced"
  | "finalized"
  | "provider_error"
  | "pending";

export type EmbeddedEthereumAcceptedReference = {
  referenceId: string | null;
  transactionId: string | null;
  txHash: string | null;
  userOperationHash: string | null;
};

type EmbeddedEthereumPrivyTransaction = {
  status: PrivyTransactionStatus | null;
  transactionHash: string | null;
  transactionId: string | null;
};

const TOKEN_IFACE = new ethers.Interface([
  "function approve(address spender,uint256 value) returns (bool)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function setApprovalForAll(address operator,bool approved)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function isApprovedForAll(address account,address operator) view returns (bool)",
]);

type TokenPostcondition =
  | {
      kind: "approval";
      chainId: number;
      tokenAddress: string;
      owner: string;
      spender: string;
      amount: bigint;
    }
  | {
      kind: "transfer";
      chainId: number;
      tokenAddress: string;
      recipient: string;
      amount: bigint;
      recipientBalanceBefore: bigint;
    }
  | {
      kind: "approvalForAll";
      chainId: number;
      tokenAddress: string;
      owner: string;
      operator: string;
      approved: boolean;
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

function normalizeHex(value: string | null | undefined): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

function normalizeValueHex(
  value: string | null | undefined,
): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = BigInt(trimmed);
    if (parsed <= 0n) return null;
    return `0x${parsed.toString(16)}` as `0x${string}`;
  } catch {
    return null;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveEvmRpcUrl(chainId: number): string | null {
  const override = env.evmRpcUrlsByChain[String(chainId)];
  if (override?.trim()) return override.trim();
  switch (chainId) {
    case 1:
      return env.ethereumRpcUrl;
    case 10:
      return env.optimismRpcUrl;
    case 56:
      return env.bscRpcUrl;
    case 137:
      return env.polygonRpcUrl;
    case 8453:
      return env.baseRpcUrl;
    case 42161:
      return env.arbitrumRpcUrl;
    case 43114:
      return env.avalancheRpcUrl;
    case 59144:
      return env.lineaRpcUrl;
    default:
      return null;
  }
}

function evmProviderForChain(chainId: number): ethers.JsonRpcProvider {
  const rpcUrl = resolveEvmRpcUrl(chainId);
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for EVM chain ${chainId}.`);
  }
  return new ethers.JsonRpcProvider(rpcUrl);
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

async function buildTokenPostcondition(
  chainId: number,
  request: EmbeddedPrivyAuthorizationRequest,
): Promise<TokenPostcondition | null> {
  const transaction = getRequestTransaction(request);
  if (!transaction) return null;

  let decoded: ethers.TransactionDescription | null = null;
  try {
    decoded = TOKEN_IFACE.parseTransaction({
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
      kind: "approval",
      chainId,
      tokenAddress: transaction.to,
      owner: transaction.from,
      spender,
      amount,
    };
  }

  if (decoded.name === "transfer") {
    const recipient = normalizeAddress(String(decoded.args[0]));
    const amount = BigInt(decoded.args[1].toString());
    if (!recipient || amount <= 0n) return null;
    if (recipient.toLowerCase() === transaction.from.toLowerCase()) return null;

    const token = new ethers.Contract(
      transaction.to,
      TOKEN_IFACE,
      evmProviderForChain(chainId),
    );
    const recipientBalanceBefore = BigInt(
      (await token.balanceOf(recipient)).toString(),
    );
    return {
      kind: "transfer",
      chainId,
      tokenAddress: transaction.to,
      recipient,
      amount,
      recipientBalanceBefore,
    };
  }

  if (decoded.name === "setApprovalForAll") {
    const operator = normalizeAddress(String(decoded.args[0]));
    const approved = Boolean(decoded.args[1]);
    if (!operator) return null;
    return {
      kind: "approvalForAll",
      chainId,
      tokenAddress: transaction.to,
      owner: transaction.from,
      operator,
      approved,
    };
  }

  return null;
}

async function isTokenPostconditionSatisfied(
  condition: TokenPostcondition,
): Promise<boolean> {
  const token = new ethers.Contract(
    condition.tokenAddress,
    TOKEN_IFACE,
    evmProviderForChain(condition.chainId),
  );
  if (condition.kind === "approval") {
    const allowance = BigInt(
      (await token.allowance(condition.owner, condition.spender)).toString(),
    );
    return allowance >= condition.amount;
  }

  if (condition.kind === "approvalForAll") {
    const approved = Boolean(
      await token.isApprovedForAll(condition.owner, condition.operator),
    );
    return approved === condition.approved;
  }

  const recipientBalance = BigInt(
    (await token.balanceOf(condition.recipient)).toString(),
  );
  return (
    recipientBalance >= condition.recipientBalanceBefore + condition.amount
  );
}

async function waitForTokenPostcondition(
  condition: TokenPostcondition | null,
  context: string,
): Promise<void> {
  if (!condition) return;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if (await isTokenPostconditionSatisfied(condition)) return;
    } catch {
      // RPCs can transiently fail immediately after sponsored submission.
    }
    await sleep(1_000);
  }
  throw new Error(`${context} did not update on-chain in time.`);
}

export async function fetchEmbeddedEthereumPrivyTransaction(input: {
  transactionId: string;
}): Promise<EmbeddedEthereumPrivyTransaction> {
  const response = await fetch(
    `${PRIVY_WALLET_API_BASE_URL}/v1/transactions/${input.transactionId}`,
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

  return { status, transactionHash, transactionId: input.transactionId };
}

export async function fetchEmbeddedEthereumPrivyTransactionByReference(input: {
  referenceId: string;
}): Promise<EmbeddedEthereumPrivyTransaction | null> {
  const url = new URL(`${PRIVY_WALLET_API_BASE_URL}/v1/transactions`);
  url.searchParams.set("reference_id", input.referenceId);
  const response = await fetch(url, {
    method: "GET",
    headers: buildPrivyAppAuthHeaders(),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`Privy reference lookup failed (${response.status})`);
  }
  const records = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        "data" in payload &&
        Array.isArray(payload.data)
      ? payload.data
      : [];
  const record = records.find((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
  if (!record) return null;
  return {
    status:
      typeof record.status === "string"
        ? (record.status as PrivyTransactionStatus)
        : null,
    transactionHash:
      typeof record.transaction_hash === "string" && record.transaction_hash
        ? record.transaction_hash
        : null,
    transactionId:
      typeof record.transaction_id === "string" && record.transaction_id
        ? record.transaction_id
        : null,
  };
}

async function waitForPrivyTransaction(
  transactionId: string,
  context: string,
): Promise<string | null> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { status, transactionHash } =
      await fetchEmbeddedEthereumPrivyTransaction({ transactionId });
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

async function waitForEvmTransaction(
  chainId: number,
  txHash: string,
  context: string,
  timeoutMs = 90_000,
): Promise<void> {
  const provider = evmProviderForChain(chainId);
  const receipt = await provider.waitForTransaction(txHash, 1, timeoutMs);
  if (!receipt) {
    throw new Error(`${context} is still pending.`);
  }
  if (receipt.status !== 1) {
    throw new Error(`${context} failed onchain.`);
  }
}

export async function waitForEmbeddedEthereumTransactionReceipt(inputs: {
  chainId: number;
  context: string;
  timeoutMs?: number;
  txHash: string;
}): Promise<void> {
  await waitForEvmTransaction(
    inputs.chainId,
    inputs.txHash,
    inputs.context,
    inputs.timeoutMs,
  );
}

export async function fetchEmbeddedEthereumTransactionReceipt(inputs: {
  chainId: number;
  txHash: string;
}): Promise<{
  blockNumber: number;
  succeeded: boolean;
  transactionHash: string;
} | null> {
  const receipt = await evmProviderForChain(
    inputs.chainId,
  ).getTransactionReceipt(inputs.txHash);
  if (!receipt) return null;
  return {
    blockNumber: receipt.blockNumber,
    succeeded: receipt.status === 1,
    transactionHash: receipt.hash,
  };
}

export async function resolveEmbeddedEthereumWalletContext(inputs: {
  user: User;
  signer: string;
}): Promise<EmbeddedEthereumWalletContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }
  const signer = requireAddress(
    inputs.signer,
    "Embedded execution requires an EVM signer wallet.",
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
      "Embedded execution is only available for internal Trading Wallets.",
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

export function buildEmbeddedEthereumSendTransactionRequest(inputs: {
  context: EmbeddedEthereumWalletContext;
  chainId: number;
  transaction: EmbeddedEthereumTransactionSpec;
}): EmbeddedPrivyAuthorizationRequest {
  const chainId = Math.trunc(inputs.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error("Embedded EVM execution requires a valid chain id.");
  }
  const signer = requireAddress(
    inputs.context.signer,
    "Invalid embedded signer address.",
  );
  const to = requireAddress(
    inputs.transaction.to,
    `${inputs.transaction.label} is missing a valid target address.`,
  );
  const data =
    normalizeHex(inputs.transaction.data ?? "0x") ??
    (() => {
      throw new Error(
        `${inputs.transaction.label} is missing valid transaction calldata.`,
      );
    })();
  const value = normalizeValueHex(inputs.transaction.value);

  return createPrivyWalletRpcRequest({
    id: inputs.transaction.id,
    label: inputs.transaction.label,
    walletId: inputs.context.walletId,
    body: {
      method: "eth_sendTransaction",
      caip2: `eip155:${chainId}`,
      sponsor: inputs.transaction.sponsor !== false,
      params: {
        transaction: {
          from: signer as `0x${string}`,
          to: to as `0x${string}`,
          data,
          ...(value ? { value } : {}),
        },
      },
    },
  });
}

export function prepareEmbeddedEthereumTransactionRequests(inputs: {
  context: EmbeddedEthereumWalletContext;
  chainId: number;
  transactions: EmbeddedEthereumTransactionSpec[];
}): EmbeddedPrivyAuthorizationRequest[] {
  return inputs.transactions.map((transaction) =>
    buildEmbeddedEthereumSendTransactionRequest({
      context: inputs.context,
      chainId: inputs.chainId,
      transaction,
    }),
  );
}

export async function executeServerEmbeddedEthereumTransaction(inputs: {
  chainId: number;
  onAccepted?: (
    reference: EmbeddedEthereumAcceptedReference,
  ) => void | Promise<void>;
  onSubmitted?: (txHash: string) => void | Promise<void>;
  signer: string;
  timeoutMs?: number;
  transaction: EmbeddedEthereumTransactionSpec;
  walletClient: PrivyWalletApiClient;
  walletId: string;
}): Promise<string> {
  const chainId = Math.trunc(inputs.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error("Embedded EVM execution requires a valid chain id.");
  }
  const signer = requireAddress(
    inputs.signer,
    "Invalid embedded signer address.",
  );
  const to = requireAddress(
    inputs.transaction.to,
    `${inputs.transaction.label} is missing a valid target address.`,
  );
  const data =
    normalizeHex(inputs.transaction.data ?? "0x") ??
    (() => {
      throw new Error(
        `${inputs.transaction.label} is missing valid transaction calldata.`,
      );
    })();
  const value = normalizeValueHex(inputs.transaction.value);
  const gasLimit = normalizeValueHex(inputs.transaction.gas);

  const result = await inputs.walletClient.walletApi.ethereum.sendTransaction({
    address: signer,
    caip2: `eip155:${chainId}`,
    sponsor: inputs.transaction.sponsor !== false,
    referenceId: inputs.transaction.referenceId,
    transaction: {
      from: signer,
      to,
      data,
      ...(value ? { value } : {}),
      ...(gasLimit ? { gas_limit: gasLimit } : {}),
    },
    walletId: inputs.walletId,
  });
  let txHash = result.hash?.trim() ?? "";
  await inputs.onAccepted?.({
    referenceId: result.referenceId,
    transactionId: result.transactionId,
    txHash: txHash || null,
    userOperationHash: result.userOperationHash,
  });
  if (!txHash && result.transactionId) {
    txHash =
      (await waitForPrivyTransaction(
        result.transactionId,
        inputs.transaction.label,
      )) ?? "";
  }
  if (!txHash) {
    throw new Error(
      `${inputs.transaction.label} did not return a transaction hash.`,
    );
  }
  await inputs.onSubmitted?.(txHash);
  await waitForEvmTransaction(
    chainId,
    txHash,
    inputs.transaction.label,
    inputs.timeoutMs,
  );
  return txHash;
}

export async function executeEmbeddedEthereumTransactionRequests(inputs: {
  chainId: number;
  requests: EmbeddedPrivyAuthorizationRequest[];
  signatures: EmbeddedPrivyAuthorizationSignature[];
}): Promise<string[]> {
  const transactionHashes: string[] = [];
  for (const request of inputs.requests) {
    const postcondition = await buildTokenPostcondition(
      inputs.chainId,
      request,
    );
    const authorizationSignature = findAuthorizationSignature(
      inputs.signatures,
      request.id,
    );
    const payload = await executePreparedPrivyAuthorizationRequest(
      request,
      authorizationSignature,
    );
    const { hash, transactionId, userOperationHash } =
      parsePrivyRpcTransactionHashResponse(payload);
    const resolvedHash =
      hash ??
      (transactionId
        ? await waitForPrivyTransaction(transactionId, request.label)
        : null);

    if (resolvedHash) {
      await waitForEvmTransaction(inputs.chainId, resolvedHash, request.label);
      transactionHashes.push(resolvedHash);
      continue;
    }

    if (userOperationHash) {
      await waitForTokenPostcondition(postcondition, request.label);
      transactionHashes.push(userOperationHash);
      continue;
    }

    throw new Error(
      `${request.label} did not produce a transaction hash after Privy sponsorship.`,
    );
  }
  return transactionHashes;
}
