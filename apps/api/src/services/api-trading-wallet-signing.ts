import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { PrivyService, type PrivyWalletApiClient } from "../privy-service.js";
import type { TradeIntent } from "./trading-types.js";
import { tradingError } from "./api-trading-utils.js";

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
  return Boolean(env.privyWalletAuthorizationKey);
}

export function createServerWalletClient(): PrivyWalletApiClient {
  if (!env.privyWalletAuthorizationKey) {
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

export async function assertServerEvmWalletAuthorization(input: {
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
  const privyUser = await PrivyService.getUserById(privyUserId);
  const wallet = PrivyService.classifyWallets(privyUser).find(
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
