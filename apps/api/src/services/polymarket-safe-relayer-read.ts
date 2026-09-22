import { POLYMARKET_RELAYER_BASE_URL } from "./polymarket-deposit-wallet-relayer.js";
import { deriveSafeProxyAddress } from "./polymarket-safe-address.js";
import { validatePolymarketRelayerReadAddressForLinkedWallets } from "./polymarket-relayer-signing.js";

export class SafeRelayerReadError extends Error {
  constructor(
    readonly reason: "transport" | "timeout" | "http" | "invalid_response",
    readonly upstreamStatus?: number,
  ) {
    super("Polymarket could not verify the Safe wallet. Try again.");
  }
}

/** Read-only, fixed upstream. Never accepts a caller-selected Safe or URL. */
export async function readPolymarketSafeRelayer(input: {
  address: string;
  kind: "deployed" | "nonce";
  walletAddresses: readonly string[];
  fetchImpl?: typeof fetch;
}) {
  const owner = validatePolymarketRelayerReadAddressForLinkedWallets(input);
  const safeAddress = deriveSafeProxyAddress(owner);
  if (!safeAddress) throw new Error("Unable to derive the owner Safe address");
  const url = new URL(`/${input.kind}`, POLYMARKET_RELAYER_BASE_URL);
  url.searchParams.set(
    "address",
    input.kind === "deployed" ? safeAddress : owner,
  );
  // /deployed defaults to Safe in the SDK; nonce MUST use SAFE, not WALLET.
  if (input.kind === "nonce") url.searchParams.set("type", "SAFE");
  const signal = AbortSignal.timeout(2_500);
  let payload: unknown;
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      signal,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new SafeRelayerReadError("http", response.status);
    try {
      payload = await response.json();
    } catch {
      throw new SafeRelayerReadError(
        signal.aborted ? "timeout" : "invalid_response",
      );
    }
  } catch (error) {
    if (error instanceof SafeRelayerReadError) throw error;
    throw new SafeRelayerReadError(signal.aborted ? "timeout" : "transport");
  }
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  if (input.kind === "deployed" && typeof record?.deployed === "boolean") {
    return {
      kind: "deployed" as const,
      safeAddress,
      deployed: record.deployed,
    };
  }
  if (
    input.kind === "nonce" &&
    typeof record?.nonce === "string" &&
    /^\d+$/.test(record.nonce)
  ) {
    return { kind: "nonce" as const, safeAddress, nonce: record.nonce };
  }
  throw new SafeRelayerReadError("invalid_response");
}
