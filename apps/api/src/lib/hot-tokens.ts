import { env } from "../env.js";
import { getRedis } from "../redis.js";

export type HotVenue = "polymarket" | "kalshi" | "dflow" | "limitless";

const HOT_KEYS: Record<HotVenue, string> = {
  polymarket: "hot:tokens:polymarket",
  kalshi: "hot:tokens:kalshi",
  dflow: "hot:tokens:dflow",
  limitless: "hot:tokens:limitless",
};

const HOT_STREAM_KEYS: Record<HotVenue, string> = {
  polymarket: "hot:tokens:stream:polymarket",
  kalshi: "hot:tokens:stream:kalshi",
  dflow: "hot:tokens:stream:dflow",
  limitless: "hot:tokens:stream:limitless",
};

function normalizeTokenId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function inferVenue(tokenId: string): HotVenue | null {
  if (tokenId.startsWith("sol:")) return "dflow";
  if (tokenId.startsWith("kalshi:")) return "kalshi";
  if (tokenId.startsWith("limitless:")) return "limitless";
  if (/^\d+$/.test(tokenId)) return "polymarket";
  return null;
}

type MarkHotInputs = {
  tokenIds: Array<string | null | undefined>;
  venue?: HotVenue;
};

async function markTokensForKeySet(
  inputs: MarkHotInputs,
  options: {
    keys: Record<HotVenue, string>;
    maxTokens: number;
    ttlSec: number;
    logLabel: string;
  },
): Promise<void> {
  if (options.maxTokens <= 0) return;

  const r = await getRedis();
  if (!r) return;

  const byVenue = new Map<HotVenue, Set<string>>();
  for (const raw of inputs.tokenIds) {
    if (!raw) continue;
    const tokenId = normalizeTokenId(String(raw));
    if (!tokenId) continue;
    const venue = inputs.venue ?? inferVenue(tokenId);
    if (!venue) continue;
    const set = byVenue.get(venue) ?? new Set<string>();
    if (set.size < options.maxTokens) set.add(tokenId);
    byVenue.set(venue, set);
  }

  if (!byVenue.size) return;

  const now = Date.now();
  const cutoff = now - options.ttlSec * 1000;

  try {
    for (const [venue, tokensSet] of byVenue.entries()) {
      const tokens = Array.from(tokensSet).slice(0, options.maxTokens);
      if (!tokens.length) continue;

      const key = options.keys[venue];
      const multi = r.multi();
      multi.zAdd(
        key,
        tokens.map((tokenId) => ({ score: now, value: tokenId })),
      );
      multi.zRemRangeByScore(key, 0, cutoff);
      await multi.exec();

      const size = await r.zCard(key);
      if (size > options.maxTokens) {
        await r.zRemRangeByRank(key, 0, size - options.maxTokens - 1);
      }
    }
  } catch (error) {
    console.warn(`[hot-tokens] ${options.logLabel}`, error);
  }
}

export async function markHotTokens(inputs: MarkHotInputs): Promise<void> {
  await markTokensForKeySet(inputs, {
    keys: HOT_KEYS,
    maxTokens: env.hotTokensMax,
    ttlSec: env.hotTokensTtlSec,
    logLabel: "failed to mark hot tokens",
  });
}

export async function markStreamHotTokens(inputs: MarkHotInputs): Promise<void> {
  await markTokensForKeySet(inputs, {
    keys: HOT_STREAM_KEYS,
    maxTokens: env.hotStreamTokensMax,
    ttlSec: env.hotStreamTokensTtlSec,
    logLabel: "failed to mark stream hot tokens",
  });
}
