import { createHash } from "node:crypto";
import type {
  Collection,
  CollectionResponse,
} from "../schemas/trader-collections.js";
export const SNAPSHOT_TTL = 30 * 60,
  FRESH_FOR = 5 * 60,
  QUOTE_TTL = 300;
export const TRADER_PUBLISH = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
for i=2,4 do redis.call('SET',KEYS[i],ARGV[i],'EX',ARGV[5]) end
if KEYS[5] then redis.call('DEL',KEYS[5]) end
return 1`;
export const TRADER_CHECKPOINT = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',600);return 1`;

/** A connected Redis socket can stop responding or queue work while reconnecting.
 * On timeout discard only this lane's client, including any queued late command.
 * The fenced scripts and expiring lease still protect ambiguous remote outcomes. */
export async function traderRedisCommand<T>(
  command: () => Promise<T>,
  discard: () => void,
  deadlineMs = 2000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      command(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          discard();
          reject(new Error("trader_cache_timeout"));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function traderSliceAction(slice: {
  stopped: boolean;
  lostLease: boolean;
  cooling: boolean;
  remaining: number;
  ageSeconds: number;
  attempts: number;
  selected: number;
  observed: number;
}): "checkpoint" | "publish" | "retain" {
  if (slice.stopped || slice.lostLease) return "retain";
  // A venue cooldown is NOT a lost Redis lease. Keep the good observations and
  // unprocessed owners for a later holder; don't replace the public snapshot.
  if (slice.cooling) return slice.remaining ? "checkpoint" : "retain";
  if (
    slice.remaining &&
    slice.ageSeconds < 210 &&
    slice.attempts < 3 * slice.selected
  )
    return "checkpoint";
  return slice.selected && !slice.observed ? "retain" : "publish";
}
export type LoadCollection = (
  k: Collection,
) => Promise<CollectionResponse | null>;
/** This read path has no capability to query SQL, call a provider or schedule work. */
export async function readCollection(
  load: LoadCollection,
  k: Collection,
  category: string | undefined,
  now: number,
) {
  const body = await load(k);
  if (!body || body.collection !== k) return null;
  const age = now - Date.parse(body.windowEnd) / 1000;
  if (!Number.isFinite(age) || age < -60 || age >= SNAPSHOT_TTL) return null;
  // A cached book observation cannot certify a live future price. Discard the
  // opportunity immediately at a known market expiry, even if the ask is young.
  const visibleQuote = (quote: { asOf: string; validUntil: string }) =>
    now < Date.parse(quote.validUntil) / 1000 &&
    now - Date.parse(quote.asOf) / 1000 <= QUOTE_TTL;
  const groups = body.groups
    .filter((g) => !category || g.category === category)
    .map((g) => {
      const items = g.items
        .filter(
          (item) =>
            item.achievement.kind !== "big_move" ||
            visibleQuote(item.achievement.quote),
        )
        .map((item, i) => ({
          ...item,
          rank: i + 1,
          latestOpenPosition:
            item.latestOpenPosition &&
            visibleQuote(item.latestOpenPosition.quote)
              ? item.latestOpenPosition
              : null,
        }));
      return {
        ...g,
        items,
        status:
          g.status === "ready" && !items.length
            ? ("insufficient_evidence" as const)
            : g.status,
      };
    });
  if (category && !groups.length)
    groups.push({
      category,
      status: "unsupported",
      sourceAsOf: body.windowEnd,
      items: [],
      coverage: {
        universe: "recent_active_tracked_shortlist",
        resultScope: "servable_hunch_catalog_positions",
        venues: ["polymarket"],
        basis:
          k === "big-moves"
            ? "verified_fills"
            : k === "winning-streaks"
              ? "verified_episodes"
              : "verified_realizations",
        selectedWallets: 0,
        observedWallets: 0,
        eligibleWallets: 0,
      },
    });
  const response: CollectionResponse = {
    ...body,
    freshness: age > FRESH_FOR ? "stale" : "fresh",
    groups,
  };
  const etag =
    '"' +
    createHash("sha256").update(JSON.stringify(response)).digest("base64url") +
    '"';
  return { response, etag };
}
