import { type WalletApiRequestSignatureInput } from "@privy-io/server-auth";
import { ethers } from "ethers";

import type { User } from "../auth.js";
import { env } from "../env.js";
import { type PrivyWalletProfile, PrivyService } from "../privy-service.js";

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

export type EmbeddedPrivyWalletContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
};

function requireAddress(value: string, message: string): string {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(message);
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

export function findEmbeddedAuthorizationSignature(
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

export async function resolveEmbeddedPrivyWalletContext(inputs: {
  user: User;
  signer: string;
  venueLabel: string;
}): Promise<EmbeddedPrivyWalletContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }

  const signer = requireAddress(
    inputs.signer,
    `${inputs.venueLabel} automation requires an EVM signer wallet.`,
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
      `Embedded ${inputs.venueLabel} automation is only available for internal Trading Wallets.`,
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

export function createEmbeddedPrivyWalletRpcRequest(args: {
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

export function buildEmbeddedPersonalSignRequest(inputs: {
  context: EmbeddedPrivyWalletContext;
  id: string;
  label: string;
  message: string;
  encoding?: "utf-8" | "hex";
}): EmbeddedPrivyAuthorizationRequest {
  return createEmbeddedPrivyWalletRpcRequest({
    id: inputs.id,
    label: inputs.label,
    walletId: inputs.context.walletId,
    body: {
      method: "personal_sign",
      address: inputs.context.signer,
      chain_type: "ethereum",
      params: {
        message: inputs.message,
        encoding: inputs.encoding ?? "utf-8",
      },
    },
  });
}

export async function executePreparedPrivyAuthorizationRequest(
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

export async function executePreparedPrivySignatureRequest(inputs: {
  request: EmbeddedPrivyAuthorizationRequest;
  authorizationSignature: string;
}): Promise<string> {
  const payload = await executePreparedPrivyAuthorizationRequest(
    inputs.request,
    inputs.authorizationSignature,
  );
  return parsePrivyRpcSignatureResponse(payload);
}
