import { env } from "../env.js";
import { getRedis } from "../redis.js";

export type HotVenue = "polymarket" | "kalshi" | "dflow";

const HOT_KEYS: Record<HotVenue, string> = {
  polymarket: "hot:tokens:polymarket",
  kalshi: "hot:tokens:kalshi",
  dflow: "hot:tokens:dflow",
};

function normalizeTokenId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function inferVenue(tokenId: string): HotVenue | null {
  if (tokenId.startsWith("sol:")) return "dflow";
  if (tokenId.startsWith("kalshi:")) return "kalshi";
  if (/^\d+$/.test(tokenId)) return "polymarket";
  return null;
}

export async function markHotTokens(inputs: {
  tokenIds: Array<string | null | undefined>;
  venue?: HotVenue;
}): Promise<void> {
  if (env.hotTokensMax <= 0) return;

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
    if (set.size < env.hotTokensMax) set.add(tokenId);
    byVenue.set(venue, set);
  }

  if (!byVenue.size) return;

  const now = Date.now();
  const cutoff = now - env.hotTokensTtlSec * 1000;

  try {
    for (const [venue, tokensSet] of byVenue.entries()) {
      const tokens = Array.from(tokensSet).slice(0, env.hotTokensMax);
      if (!tokens.length) continue;

      const key = HOT_KEYS[venue];
      const multi = r.multi();
      multi.zAdd(
        key,
        tokens.map((tokenId) => ({ score: now, value: tokenId })),
      );
      multi.zRemRangeByScore(key, 0, cutoff);
      await multi.exec();

      const size = await r.zCard(key);
      if (size > env.hotTokensMax) {
        await r.zRemRangeByRank(key, 0, size - env.hotTokensMax - 1);
      }
    }
  } catch (error) {
    console.warn("[hot-tokens] failed to mark hot tokens", error);
  }
}
