import type { Hip4Environment } from "@hunch/shared";

export type HyperliquidExchangeTransport = Readonly<{
  timeoutMs: number;
  responseMaxBytes: number;
  fetcher?: typeof fetch;
}>;

/** Shared native transport for already-admitted funding and trading actions.
 * Exactly one POST: a timeout, HTTP error or malformed reply cannot prove that
 * an action failed. No redirects, raw errors/logging, automatic retry or signer.
 * Durable admission must commit BEFORE calling this primitive. */
export async function postHyperliquidExchangeOnce(
  environment: Hip4Environment,
  request: unknown,
  options: HyperliquidExchangeTransport,
): Promise<{ kind: "response"; body: unknown } | { kind: "unknown" }> {
  try {
    if (
      !["mainnet", "testnet"].includes(environment) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      !Number.isSafeInteger(options.responseMaxBytes) ||
      options.responseMaxBytes <= 0
    )
      return { kind: "unknown" };
    const response = await (options.fetcher ?? fetch)(
      environment === "mainnet"
        ? "https://api.hyperliquid.xyz/exchange"
        : "https://api.hyperliquid-testnet.xyz/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "unknown" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { kind: "unknown" };
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > options.responseMaxBytes) return { kind: "unknown" };
        text += decoder.decode(chunk.value, { stream: true });
      }
      return {
        kind: "response",
        body: JSON.parse(text + decoder.decode()) as unknown,
      };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    return { kind: "unknown" };
  }
}
