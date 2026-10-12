import {
  hip4Identity,
  parseHip4Coin,
  type Hip4ReadPolicy,
} from "@hunch/shared";

// Transport reservation, deliberately independent of the local processing cap.
// recentTrades has no request limit. Keep a conservative 2000-row envelope.
export const HIP4_RECENT_TRADES_RESPONSE_BOUND = 2000;

export type Hip4InfoRequest =
  | { type: "outcomeMeta" | "spotMeta" | "spotMetaAndAssetCtxs" }
  | { type: "settledOutcome"; outcome: number }
  | { type: "l2Book" | "recentTrades"; coin: string };

export class Hip4ReadError extends Error {
  constructor(
    public readonly reason:
      | "budget_exhausted"
      | "http_error"
      | "timeout"
      | "transport_error"
      | "response_too_large"
      | "invalid_response",
  ) {
    super(reason);
  }
}

export function createHip4ReadClient(
  policy: Hip4ReadPolicy,
  admit: (weight: number) => Promise<boolean>,
  fetcher: typeof fetch = fetch,
) {
  const endpoint =
    policy.environment === "mainnet"
      ? "https://api.hyperliquid.xyz/info"
      : "https://api.hyperliquid-testnet.xyz/info";
  return async (request: Hip4InfoRequest): Promise<unknown> => {
    if (
      ![
        "outcomeMeta",
        "spotMeta",
        "spotMetaAndAssetCtxs",
        "settledOutcome",
        "l2Book",
        "recentTrades",
      ].includes(request.type)
    )
      throw new Hip4ReadError("invalid_response");
    if (request.type === "settledOutcome")
      hip4Identity(policy.environment, request.outcome);
    if (request.type === "l2Book" || request.type === "recentTrades")
      parseHip4Coin(request.coin);
    // Conservative admission includes payload-dependent recentTrades weight.
    // No caller may route exchange/account actions through this client.
    const weight =
      request.type === "l2Book"
        ? 2
        : request.type === "recentTrades"
          ? 20 + Math.ceil(HIP4_RECENT_TRADES_RESPONSE_BOUND / 20)
          : 20;
    if (!(await admit(weight))) throw new Hip4ReadError("budget_exhausted");
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(policy.requestTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Hip4ReadError("http_error");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Hip4ReadError("invalid_response");
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > policy.responseMaxBytes)
            throw new Hip4ReadError("response_too_large");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        try {
          return JSON.parse(text);
        } catch {
          throw new Hip4ReadError("invalid_response");
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Hip4ReadError) throw error;
      throw new Hip4ReadError(
        error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name)
          ? "timeout"
          : "transport_error",
      );
    }
  };
}
