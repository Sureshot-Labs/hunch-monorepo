import type { Pool } from "@hunch/infra";
import { hip4SpotMetadataSchema } from "@hunch/shared";
import { createHip4ReadClient } from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";

export type Hip4OrderSpotMetadataRead = () => Promise<{
  metadata: ReturnType<typeof hip4SpotMetadataSchema.parse>;
  observedAt: number;
}>;

/** One observation bundle only. Fees and cash validate the same freshly read
 * quote-token metadata instead of charging the shared budget twice. A new
 * factory is required for every quote/prepare/submit; no completed cache or
 * private account reads live here. Timestamp starts before provider IO. */
export function createHip4OrderSpotMetadataRead(
  pool: Pick<Pool, "query">,
  fetcher?: typeof fetch,
): Hip4OrderSpotMetadataRead {
  let pending: ReturnType<Hip4OrderSpotMetadataRead> | undefined;
  return () => {
    pending ??= (async () => {
      const { policy } = await readHip4Policy(pool, "accountRead");
      if (!policy.enabled || policy.environment !== "mainnet")
        throw new Error("native_account_read_unavailable");
      const provider = createHip4ReadClient(
        policy,
        (weight) =>
          admitHip4Request(
            pool,
            "mainnet",
            weight,
            policy.requestWeightPerMinute,
          ),
        fetcher,
      );
      const observedAt = Date.now();
      const metadata = hip4SpotMetadataSchema.parse(
        await provider({ type: "spotMeta" }),
      );
      return { metadata, observedAt };
    })();
    return pending.then((observation) => structuredClone(observation));
  };
}
