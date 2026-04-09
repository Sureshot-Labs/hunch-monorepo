import { createHash } from "node:crypto";
import { type WalletApiRequestSignatureInput } from "@privy-io/server-auth";
import bs58 from "bs58";

import type { User } from "../auth.js";
import { env } from "../env.js";
import {
  type PrivyWalletProfile,
  PrivyService,
} from "../privy-service.js";

const PRIVY_WALLET_API_BASE_URL = "https://api.privy.io";
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function buildPrivyIdempotencyKey(inputs: {
  executionKey: string;
  requestId: string;
}): string {
  const digest = createHash("sha256")
    .update(`embedded-solana:${inputs.executionKey}:${inputs.requestId}`)
    .digest("hex")
    .slice(0, 32);
  return `hunch-sol-${digest}`;
}

function isKalshiReduceOrderEscrowInitializationMessage(
  message: string,
): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("invalidaccountowner") &&
      (normalized.includes("inituserreduceorderescrow") ||
        normalized.includes("user_outcome_vault check failed"))) ||
    ((normalized.includes("invalid account owner") ||
      normalized.includes("invalidaccountowner")) &&
      normalized.includes("predictmksnpfkfiz33ndsdbe2dy43kypg4u2dbvhvb"))
  );
}

function isKalshiInsufficientTradeFundsMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("predictmksnpfkfiz33ndsdbe2dy43kypg4u2dbvhvb") &&
    normalized.includes("instruction: transferchecked") &&
    normalized.includes("error: insufficient funds")
  );
}

function isExpiredBlockhashMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("blockhash not found") ||
    normalized.includes("blockhash expired") ||
    normalized.includes("transaction expired") ||
    normalized.includes("block height exceeded")
  );
}

function normalizeEmbeddedSolanaRpcErrorMessage(message: string): string {
  if (isExpiredBlockhashMessage(message)) {
    return "Transaction expired. Refresh quote and try again.";
  }
  if (isKalshiReduceOrderEscrowInitializationMessage(message)) {
    return "Trade could not be prepared yet. Retry the sell in a moment.";
  }
  if (isKalshiInsufficientTradeFundsMessage(message)) {
    return "Selected wallet no longer has enough balance for this trade. Refresh balances or reduce the order size.";
  }
  return message;
}

export type EmbeddedPrivyAuthorizationRequest = {
  id: string;
  label: string;
  input: WalletApiRequestSignatureInput;
};

export type EmbeddedPrivyAuthorizationSignature = {
  id: string;
  signature: string;
};

export type EmbeddedSolanaTransactionSpec = {
  id: string;
  label: string;
  transaction: string;
  encoding?: "base64";
  sponsor?: boolean;
  caip2?: string | null;
};

export type EmbeddedSolanaWalletContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
};

function isSolanaAddress(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    return bs58.decode(trimmed).length === 32;
  } catch {
    return false;
  }
}

function requireSolanaAddress(value: string, message: string): string {
  const trimmed = value.trim();
  if (!isSolanaAddress(trimmed)) {
    throw new Error(message);
  }
  return trimmed;
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

function createPrivyWalletRpcRequest(args: {
  id: string;
  label: string;
  walletId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string | null;
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
        ...(args.idempotencyKey
          ? { "privy-idempotency-key": args.idempotencyKey }
          : {}),
      },
    },
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
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const rawMessage =
      (payload &&
        typeof payload.error === "string" &&
        payload.error.trim().length > 0 &&
        payload.error) ||
      (payload &&
        typeof payload.message === "string" &&
        payload.message.trim().length > 0 &&
        payload.message) ||
      `Privy wallet request failed (${response.status})`;
    throw new Error(normalizeEmbeddedSolanaRpcErrorMessage(rawMessage));
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

function parsePrivySolanaSignatureResponse(
  payload: Record<string, unknown>,
): string {
  const data =
    payload && typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : null;
  const signatureCandidates = [
    data?.hash,
    data?.signature,
    payload.hash,
    payload.signature,
  ];
  for (const candidate of signatureCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  throw new Error(
    "Privy wallet response did not include a Solana transaction signature.",
  );
}

export async function resolveEmbeddedSolanaWalletContext(inputs: {
  user: User;
  signer: string;
}): Promise<EmbeddedSolanaWalletContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }
  const signer = requireSolanaAddress(
    inputs.signer,
    "Embedded execution requires a Solana signer wallet.",
  );
  const privyUser = await PrivyService.getUserById(inputs.user.privyUserId);
  const walletProfiles = PrivyService.classifyWallets(privyUser);
  const walletProfile =
    walletProfiles.find(
      (profile) =>
        profile.walletType === "solana" && profile.address === signer,
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

export function buildEmbeddedSolanaSignAndSendRequest(inputs: {
  context: EmbeddedSolanaWalletContext;
  transaction: EmbeddedSolanaTransactionSpec;
  executionKey?: string | null;
}): EmbeddedPrivyAuthorizationRequest {
  const transaction = inputs.transaction.transaction.trim();
  if (!transaction) {
    throw new Error(
      `${inputs.transaction.label} is missing a serialized Solana transaction.`,
    );
  }

  return createPrivyWalletRpcRequest({
    id: inputs.transaction.id,
    label: inputs.transaction.label,
    walletId: inputs.context.walletId,
    idempotencyKey: inputs.executionKey
      ? buildPrivyIdempotencyKey({
          executionKey: inputs.executionKey,
          requestId: inputs.transaction.id,
        })
      : null,
    body: {
      chain_type: "solana",
      method: "signAndSendTransaction",
      sponsor: inputs.transaction.sponsor !== false,
      params: {
        transaction,
        encoding: inputs.transaction.encoding ?? "base64",
      },
      caip2: inputs.transaction.caip2?.trim() || SOLANA_MAINNET_CAIP2,
    },
  });
}

export function prepareEmbeddedSolanaTransactionRequests(inputs: {
  context: EmbeddedSolanaWalletContext;
  transactions: EmbeddedSolanaTransactionSpec[];
  executionKey?: string | null;
}): EmbeddedPrivyAuthorizationRequest[] {
  return inputs.transactions.map((transaction) =>
    buildEmbeddedSolanaSignAndSendRequest({
      context: inputs.context,
      transaction,
      executionKey: inputs.executionKey,
    }),
  );
}

export async function executeEmbeddedSolanaTransactionRequests(inputs: {
  requests: EmbeddedPrivyAuthorizationRequest[];
  signatures: EmbeddedPrivyAuthorizationSignature[];
}): Promise<string[]> {
  const transactionSignatures: string[] = [];
  for (const request of inputs.requests) {
    const authorizationSignature = findAuthorizationSignature(
      inputs.signatures,
      request.id,
    );
    const payload = await executePreparedPrivyAuthorizationRequest(
      request,
      authorizationSignature,
    );
    transactionSignatures.push(parsePrivySolanaSignatureResponse(payload));
  }
  return transactionSignatures;
}
