import { type WalletApiRequestSignatureInput } from "@privy-io/server-auth";
import { ethers } from "ethers";

import type { User } from "../auth.js";
import { env } from "../env.js";
import {
  type PrivyWalletProfile,
  PrivyService,
} from "../privy-service.js";

const PRIVY_WALLET_API_BASE_URL = "https://api.privy.io";

export type EmbeddedPrivyAuthorizationRequest = {
  id: string;
  label: string;
  input: WalletApiRequestSignatureInput;
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
  sponsor?: boolean;
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

function normalizeValueHex(value: string | null | undefined): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return `0x${BigInt(trimmed).toString(16)}` as `0x${string}`;
  } catch {
    return null;
  }
}

function buildPrivyWalletRpcUrl(walletId: string): string {
  return `${PRIVY_WALLET_API_BASE_URL}/api/v1/wallets/${walletId}/rpc`;
}

function buildPrivyWalletHeaders(
  signatureInput: WalletApiRequestSignatureInput,
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
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
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

function parsePrivyRpcTransactionHashResponse(payload: Record<string, unknown>): {
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
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
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

async function waitForEvmTransaction(
  chainId: number,
  txHash: string,
  context: string,
): Promise<void> {
  const provider = evmProviderForChain(chainId);
  const receipt = await provider.waitForTransaction(txHash, 1, 90_000);
  if (!receipt) {
    throw new Error(`${context} is still pending.`);
  }
  if (receipt.status !== 1) {
    throw new Error(`${context} failed onchain.`);
  }
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

export async function executeEmbeddedEthereumTransactionRequests(inputs: {
  chainId: number;
  requests: EmbeddedPrivyAuthorizationRequest[];
  signatures: EmbeddedPrivyAuthorizationSignature[];
}): Promise<string[]> {
  const transactionHashes: string[] = [];
  for (const request of inputs.requests) {
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
      transactionHashes.push(userOperationHash);
      continue;
    }

    throw new Error(
      `${request.label} did not produce a transaction hash after Privy sponsorship.`,
    );
  }
  return transactionHashes;
}
