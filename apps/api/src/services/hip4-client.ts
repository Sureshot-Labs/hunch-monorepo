import {
  hip4Identity,
  parseHip4Coin,
  type Hip4ReadPolicy,
} from "@hunch/shared";

export type Hip4InfoRequest =
  | { type: "outcomeMeta" | "spotMeta" }
  | { type: "settledOutcome"; outcome: number }
  | { type: "l2Book" | "recentTrades"; coin: string };

export class Hip4ReadError extends Error {
  constructor(
    public readonly reason:
      | "budget_exhausted"
      | "provider_error"
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
          ? 20 + Math.ceil(policy.maxTradesPerResponse / 20)
          : 20;
    if (!(await admit(weight))) throw new Hip4ReadError("budget_exhausted");
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(policy.requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Hip4ReadError("provider_error");
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
      return JSON.parse(text);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
}
