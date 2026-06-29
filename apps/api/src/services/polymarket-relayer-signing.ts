import {
  BuilderSigner,
  type BuilderHeaderPayload,
} from "@polymarket/builder-signing-sdk";
import { ethers } from "ethers";

export type PolymarketRelayerCredentials = {
  key: string;
  secret: string;
  passphrase: string;
};

export type PolymarketRelayerSignInput = PolymarketRelayerCredentials & {
  method: string;
  path: string;
  body?: unknown;
  timestamp?: number;
};

const ALLOWED_POLYMARKET_RELAYER_SUBMIT_TYPES = new Set([
  "SAFE",
  "PROXY",
  "SAFE-CREATE",
  "WALLET",
  "WALLET-CREATE",
]);

export function parsePolymarketRelayerSubmitBody(
  body: unknown,
): Record<string, unknown> {
  const parsed =
    typeof body === "string"
      ? JSON.parse(body)
      : body && typeof body === "object"
        ? body
        : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Polymarket relayer submit body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function getPolymarketRelayerSubmitFromAddress(body: unknown): string {
  const parsed = parsePolymarketRelayerSubmitBody(body);
  const from = typeof parsed.from === "string" ? parsed.from : "";
  if (!from) {
    throw new Error("Polymarket relayer submit body is missing from");
  }
  try {
    return ethers.getAddress(from);
  } catch {
    throw new Error("Polymarket relayer submit body has invalid from");
  }
}

export function validatePolymarketRelayerSignRequestForWallet(input: {
  method: string;
  path: string;
  body?: unknown;
  walletAddress: string;
}): void {
  if (input.method !== "POST" || input.path !== "/submit") {
    throw new Error("Polymarket relayer signing only supports POST /submit");
  }

  const body = parsePolymarketRelayerSubmitBody(input.body);
  const normalizedFrom = getPolymarketRelayerSubmitFromAddress(input.body);
  let normalizedWallet: string;
  try {
    normalizedWallet = ethers.getAddress(input.walletAddress);
  } catch {
    throw new Error("Authenticated wallet address is invalid");
  }
  if (normalizedFrom !== normalizedWallet) {
    throw new Error(
      "Polymarket relayer submit body does not match authenticated wallet",
    );
  }

  const type = typeof body.type === "string" ? body.type : "";
  if (!ALLOWED_POLYMARKET_RELAYER_SUBMIT_TYPES.has(type)) {
    throw new Error("Polymarket relayer submit type is not allowed");
  }
}

export function validatePolymarketRelayerSignRequestForLinkedWallets(input: {
  method: string;
  path: string;
  body?: unknown;
  walletAddresses: readonly string[];
}): string {
  const normalizedFrom = getPolymarketRelayerSubmitFromAddress(input.body);
  const ownsFromWallet = input.walletAddresses.some((walletAddress) => {
    try {
      return ethers.getAddress(walletAddress) === normalizedFrom;
    } catch {
      return false;
    }
  });

  if (!ownsFromWallet) {
    throw new Error(
      "Polymarket relayer submit body does not match an authenticated user wallet",
    );
  }

  validatePolymarketRelayerSignRequestForWallet({
    method: input.method,
    path: input.path,
    body: input.body,
    walletAddress: normalizedFrom,
  });

  return normalizedFrom;
}

export function normalizePolymarketRelayerBody(body: unknown): string {
  return typeof body === "string"
    ? body
    : body == null
      ? ""
      : JSON.stringify(body);
}

export function createPolymarketRelayerHeaderPayload(
  input: PolymarketRelayerSignInput,
): BuilderHeaderPayload {
  const signer = new BuilderSigner({
    key: input.key,
    secret: input.secret,
    passphrase: input.passphrase,
  });
  return signer.createBuilderHeaderPayload(
    input.method,
    input.path,
    normalizePolymarketRelayerBody(input.body),
    input.timestamp,
  );
}
