import { pool } from "../db.js";
import { getDedicatedRedis, discardDedicatedRedis } from "../redis.js";
import { venueHasLifecycleCapability } from "@hunch/shared";
import { DiscoveryRepository, discoveryReadOnly } from "../repos/discovery.js";
import { DiscoveryBuilder } from "./discovery-builder.js";
import { DiscoveryService } from "./discovery-service.js";
import { DiscoveryStore } from "./discovery-store.js";
import {
  resolveVenueLifecyclePolicy,
  resolveWalletIntelRefreshPolicy,
} from "./runtime-policies.js";
import { resolveLimitlessPositionContract } from "./limitless-protocol-config.js";

async function store() {
  const redis = await getDedicatedRedis("discovery", {
    connectDeadlineMs: 1000,
  });
  if (!redis) throw Error("discovery_redis_unavailable");
  const bounded = async <T>(task: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            discardDedicatedRedis("discovery", redis);
            reject(Error("discovery_redis_timeout"));
          }, 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return new DiscoveryStore({
    get: (key) => bounded(redis.get(key)),
    set: (key, value, options) => bounded(redis.set(key, value, options)),
    eval: (script, options) => bounded(redis.eval(script, options)),
  });
}
export const discoveryService = new DiscoveryService(
  new DiscoveryBuilder(
    new DiscoveryRepository(pool),
    resolveLimitlessPositionContract(),
  ),
  store,
  () =>
    discoveryReadOnly(
      pool,
      async (client) => {
        const lifecycle = await resolveVenueLifecyclePolicy(client),
          refresh = await resolveWalletIntelRefreshPolicy(client);
        return {
          venues: ["polymarket", "limitless", "kalshi"].filter(
            (venue) =>
              venueHasLifecycleCapability(
                lifecycle.effective,
                venue,
                "increaseExposure",
              ) &&
              venueHasLifecycleCapability(
                lifecycle.effective,
                venue,
                "discovery",
              ),
          ),
          revision: lifecycle.revision,
          whaleUsd: refresh.effective.whaleUsd,
          whaleUsdSolana: refresh.effective.whaleUsdSolana,
        };
      },
      1500,
    ),
  Date.now,
  (section) =>
    console.warn(
      JSON.stringify({
        msg: "Discovery refresh deferred; retaining last complete snapshot",
        section,
      }),
    ),
);
