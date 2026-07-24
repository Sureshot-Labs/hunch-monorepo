import { ethers } from "ethers";

import {
  createPolymarketRelayerHeaderPayload,
  type PolymarketRelayerCredentials,
} from "./polymarket-relayer-signing.js";

export const POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS =
  "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
export const POLYMARKET_RELAYER_BASE_URL = "https://relayer-v2.polymarket.com";
export const POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
} satisfies Record<string, Array<{ name: string; type: string }>>;

export const POLYMARKET_RELAYER_SUCCESS_STATES = new Set([
  "STATE_MINED",
  "STATE_CONFIRMED",
]);
export const POLYMARKET_RELAYER_FAILED_STATES = new Set([
  "STATE_FAILED",
  "STATE_INVALID",
]);

export type DepositWalletCall = {
  target: string;
  value: string;
  data: string;
};

export type DepositWalletBatchTypedData = ReturnType<
  typeof buildDepositWalletBatchTypedData
>;

export type PolymarketRelayerTransaction = {
  transactionID?: string;
  transactionHash?: string;
  state?: string;
};

export function buildDepositWalletBatchTypedData(input: {
  depositWalletAddress: string;
  nonce: string;
  deadline: string;
  calls: DepositWalletCall[];
}) {
  const depositWalletAddress = ethers.getAddress(input.depositWalletAddress);
  return {
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: depositWalletAddress,
    },
    types: POLYMARKET_DEPOSIT_WALLET_BATCH_TYPES,
    primaryType: "Batch" as const,
    message: {
      wallet: depositWalletAddress,
      nonce: BigInt(input.nonce).toString(),
      deadline: BigInt(input.deadline).toString(),
      calls: input.calls.map((call) => ({
        target: ethers.getAddress(call.target),
        value: BigInt(call.value || "0").toString(),
        data: call.data,
      })),
    },
  };
}

export function validateCanonicalRedemptionBatch(input: {
  adapterAddress: string;
  calldata: string;
  depositWalletAddress: string;
  typedData: DepositWalletBatchTypedData;
}): boolean {
  try {
    const adapter = ethers.getAddress(input.adapterAddress);
    const wallet = ethers.getAddress(input.depositWalletAddress);
    const typed = input.typedData;
    const calls = typed.message.calls;
    return (
      typed.primaryType === "Batch" &&
      typed.domain.name === "DepositWallet" &&
      typed.domain.version === "1" &&
      typed.domain.chainId === 137 &&
      ethers.getAddress(typed.domain.verifyingContract) === wallet &&
      ethers.getAddress(typed.message.wallet) === wallet &&
      calls.length === 1 &&
      calls[0] != null &&
      ethers.getAddress(calls[0].target) === adapter &&
      BigInt(calls[0].value) === 0n &&
      calls[0].data.toLowerCase() === input.calldata.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function buildDepositWalletSubmitBody(input: {
  ownerAddress: string;
  depositWalletAddress: string;
  nonce: string;
  deadline: string;
  calls: DepositWalletCall[];
  signature: string;
}) {
  return {
    type: "WALLET" as const,
    from: ethers.getAddress(input.ownerAddress),
    to: POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS,
    nonce: input.nonce,
    signature: input.signature,
    depositWalletParams: {
      depositWallet: ethers.getAddress(input.depositWalletAddress),
      deadline: input.deadline,
      calls: input.calls.map((call) => ({
        target: ethers.getAddress(call.target),
        data: call.data,
        value: call.value || "0",
      })),
    },
  };
}

export async function fetchPolymarketRelayerNonce(
  ownerAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL("/nonce", POLYMARKET_RELAYER_BASE_URL);
  url.searchParams.set("address", ethers.getAddress(ownerAddress));
  url.searchParams.set("type", "WALLET");
  const payload = await fetchRelayerJson<{ nonce?: string }>(
    url.toString(),
    { method: "GET" },
    fetchImpl,
  );
  if (!payload.nonce || !/^\d+$/.test(payload.nonce)) {
    throw new Error("Polymarket relayer nonce response is invalid.");
  }
  return payload.nonce;
}

export async function submitPolymarketDepositWalletBatch(input: {
  body: ReturnType<typeof buildDepositWalletSubmitBody>;
  credentials: PolymarketRelayerCredentials;
  fetchImpl?: typeof fetch;
}): Promise<PolymarketRelayerTransaction> {
  const headers = createPolymarketRelayerHeaderPayload({
    ...input.credentials,
    method: "POST",
    path: "/submit",
    body: input.body,
  });
  return fetchRelayerJson<PolymarketRelayerTransaction>(
    `${POLYMARKET_RELAYER_BASE_URL}/submit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input.body),
    },
    input.fetchImpl ?? fetch,
  );
}

export async function fetchPolymarketRelayerTransaction(
  transactionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PolymarketRelayerTransaction | null> {
  const url = new URL("/transaction", POLYMARKET_RELAYER_BASE_URL);
  url.searchParams.set("id", transactionId);
  const payload = await fetchRelayerJson<
    PolymarketRelayerTransaction[] | PolymarketRelayerTransaction
  >(url.toString(), { method: "GET" }, fetchImpl);
  return Array.isArray(payload) ? (payload[0] ?? null) : payload;
}

export async function waitForPolymarketRelayerTransaction(input: {
  transactionId: string;
  attempts?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PolymarketRelayerTransaction | null> {
  let latest: PolymarketRelayerTransaction | null = null;
  const attempts = Math.max(1, input.attempts ?? 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await fetchPolymarketRelayerTransaction(
      input.transactionId,
      input.fetchImpl ?? fetch,
    );
    if (
      latest &&
      (POLYMARKET_RELAYER_SUCCESS_STATES.has(latest.state ?? "") ||
        POLYMARKET_RELAYER_FAILED_STATES.has(latest.state ?? ""))
    ) {
      return latest;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, input.intervalMs ?? 2_000)),
      );
    }
  }
  return latest;
}

async function fetchRelayerJson<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object"
        ? Object.values(payload as Record<string, unknown>).find(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
        : null;
    throw new Error(
      message ?? `Polymarket relayer request failed: ${response.status}`,
    );
  }
  return payload as T;
}
