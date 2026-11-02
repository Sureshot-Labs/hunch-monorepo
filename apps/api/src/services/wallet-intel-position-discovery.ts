import { getDedicatedRedis, discardDedicatedRedis } from "../redis.js";
import {
  discoverBackgroundPolymarketPositions,
  loadBackgroundPositionConfig,
  type PositionDiscoveryStore,
} from "./polymarket-background-positions.js";

/** Runtime adapter only: no DB writes or financial sync. A lost Redis connection
 * permits a bounded fresh attempt, never a fabricated complete inventory.
 */
export async function discoverWalletIntelPositions(input: {
  owner: string;
  baseUrl: string;
  protocolAddresses: readonly string[];
}) {
  const redis = await getDedicatedRedis("wallet-position-discovery", {
    connectDeadlineMs: 1000,
  });
  let failed = false;
  const bounded = async <T>(task: () => Promise<T>): Promise<T> => {
    if (!redis || failed) throw new Error("position_checkpoint_unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            failed = true;
            discardDedicatedRedis("wallet-position-discovery", redis);
            reject(new Error("position_checkpoint_timeout"));
          }, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const store: PositionDiscoveryStore | null = redis
    ? {
        get: (key) => bounded(() => redis.get(key)),
        set: (key, value, options) =>
          bounded(() => redis.set(key, value, options)),
        del: (key) => bounded(() => redis.del(key)),
      }
    : null;
  return discoverBackgroundPolymarketPositions({
    ...input,
    store,
    config: loadBackgroundPositionConfig(),
  });
}
