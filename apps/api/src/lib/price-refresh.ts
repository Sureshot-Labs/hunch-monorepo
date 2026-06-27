import {
  enqueuePriceRefreshTokens,
  type PriceRefreshRedis,
  type PriceRefreshPriority,
  type PriceRefreshVenue,
} from "@hunch/infra";

import { env } from "../env.js";
import { getRedis } from "../redis.js";

export type RequestPriceRefreshInputs = {
  tokenIds: Array<string | null | undefined>;
  venue?: PriceRefreshVenue;
  maxTokens?: number;
  priority?: PriceRefreshPriority;
};

export async function requestPriceRefreshForTokens(
  inputs: RequestPriceRefreshInputs,
): Promise<void> {
  if (!env.priceRefreshQueueEnabled) return;
  if (!inputs.tokenIds.length) return;

  try {
    const redis = await getRedis();
    if (!redis) return;

    await enqueuePriceRefreshTokens(redis as unknown as PriceRefreshRedis, {
      tokenIds: inputs.tokenIds,
      venue: inputs.venue,
      maxQueueSize: env.priceRefreshQueueMax,
      maxTokens: inputs.maxTokens ?? env.priceRefreshEnqueueMaxPerRequest,
      priority: inputs.priority,
    });
  } catch (error) {
    console.warn("[price-refresh] failed to enqueue tokens", error);
  }
}
