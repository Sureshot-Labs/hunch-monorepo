import {
  rpcReadCoordinator,
  type RpcReadCoordinator,
} from "./rpc-read-coordinator.js";

export const WALLET_BALANCES_RESULT_TTL_MS = 5_000;

/** Cache the observation time with the raw read, including per-token cache hits. */
export function readCachedWalletBalanceObservation<T>(
  key: string,
  loader: () => Promise<T>,
  options: Readonly<{
    coordinator?: RpcReadCoordinator;
    now?: () => Date;
  }> = {},
): Promise<Readonly<{ value: T; observedAt: string }>> {
  return (options.coordinator ?? rpcReadCoordinator).memo(
    `wallet-balance-observation:${key}`,
    { ttlMs: WALLET_BALANCES_RESULT_TTL_MS },
    async () => {
      // Capture before the RPC: a later receipt must never be mistaken for
      // evidence already reflected by an earlier (possibly cached) balance.
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      return { value: await loader(), observedAt };
    },
  );
}
