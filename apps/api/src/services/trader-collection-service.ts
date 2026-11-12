import { createHash } from "node:crypto";
import type {
  Collection,
  CollectionResponse,
} from "../schemas/trader-collections.js";
export const SNAPSHOT_TTL = 30 * 60,
  FRESH_FOR = 5 * 60,
  QUOTE_TTL = 300;
export const PARTIAL_INTERVAL = 210,
  NORMAL_INTERVAL = 90,
  SLICE_SECONDS = 150,
  TICK_SECONDS = 15;
export const HANDOFF_SECONDS = PARTIAL_INTERVAL + SLICE_SECONDS + TICK_SECONDS;
export const TRADER_SAVE_CALC = `if redis.call('GET',KEYS[1])~=ARGV[1] or tonumber(redis.call('TIME')[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('SET',KEYS[2],ARGV[3],'EXAT',ARGV[2]);return 1`;
export const TRADER_START = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',604800)
redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4])
return 1`;
export function servingWindow(
  body: CollectionResponse | null,
  nextEnd: number,
  k: Collection,
  now: number,
): CollectionResponse | null {
  const end = body ? Date.parse(body.windowEnd) / 1000 : 0;
  if (body && now - end < SNAPSHOT_TTL) return body;
  if (
    Number.isSafeInteger(nextEnd) &&
    nextEnd > 0 &&
    nextEnd > end &&
    nextEnd <= now &&
    now - nextEnd < SNAPSHOT_TTL
  ) {
    const iso = (at: number) => new Date(at * 1000).toISOString();
    return {
      collection: k,
      snapshotId: "preparing:" + nextEnd,
      generatedAt: iso(nextEnd),
      windowEnd: iso(nextEnd),
      windowStart: k === "winning-streaks" ? null : iso(nextEnd - 86400),
      policyVersion: 1,
      methodologyVersion: 2,
      freshness: "stale",
      availability: "preparing",
      groups: [],
    };
  }
  return body;
}
// Never defer a replacement just because an old-window final snapshot was
// generated recently. Budget for the first normal partial and a running slice.
export const replacementDue = (expiresAt: number, now: number) =>
  expiresAt - now <= PARTIAL_INTERVAL + SLICE_SECONDS + TICK_SECONDS;
export const delayNewSweep = (
  generatedAt: number,
  expiresAt: number,
  now: number,
) =>
  now - generatedAt < NORMAL_INTERVAL &&
  !replacementDue(expiresAt, now + NORMAL_INTERVAL);
// Both sides of window expiry need the same prompt handoff, including when the
// final valid evaluation finished too late to publish. Empty/unavailable
// sweeps keep the normal backoff.
export const expediteNextSweep = (
  observed: number,
  windowEnd: number,
  now: number,
) => observed > 0 && replacementDue(windowEnd + SNAPSHOT_TTL, now);
// One bounded private queue; idle GC after the existing 7-day shortlist horizon.
const saveProgress = (
  index: number,
) => `if ARGV[#ARGV]=='' then redis.call('DEL',KEYS[${index}])
else redis.call('SET',KEYS[${index}],ARGV[#ARGV],'EX',604800) end
for i=${index + 1},#KEYS do redis.call('UNLINK',KEYS[i]) end`;
export const TRADER_PUBLISH = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
for i=2,4 do redis.call('SET',KEYS[i],ARGV[i],'EX',ARGV[5]) end
${saveProgress(5)}
return 1`;
export const TRADER_CHECKPOINT = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
${saveProgress(2)};return 1`;

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
  sincePublication: number;
  replaceExpiring?: boolean;
  selected: number;
  observed: number;
}): "checkpoint" | "publish" | "retain" | "finish_without_publication" {
  if (slice.stopped || slice.lostLease) return "retain";
  // A venue cooldown is NOT a lost Redis lease. Keep the good observations and
  // unprocessed owners for a later holder; don't replace the public snapshot.
  if (slice.cooling) return slice.remaining ? "checkpoint" : "retain";
  if (
    slice.remaining &&
    ((!slice.replaceExpiring && slice.sincePublication < PARTIAL_INTERVAL) ||
      !slice.observed)
  )
    return "checkpoint";
  return slice.selected && !slice.observed
    ? "finish_without_publication"
    : "publish";
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
  if (
    !Number.isFinite(age) ||
    age < -60 ||
    age >= SNAPSHOT_TTL + HANDOFF_SECONDS
  )
    return null;
  const handoff = age >= SNAPSHOT_TTL || body.availability === "preparing";
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
  if (!handoff && category && !groups.length)
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
            ? "observed_position_deltas"
            : k === "winning-streaks"
              ? "inferred_closed_positions"
              : "estimated_realizations",
        selectedWallets: 0,
        observedWallets: 0,
        eligibleWallets: 0,
      },
    });
  const response: CollectionResponse = {
    ...body,
    freshness: handoff || age > FRESH_FOR ? "stale" : "fresh",
    availability:
      age >= SNAPSHOT_TTL ? "between_windows" : (body.availability ?? "ranked"),
    ...(handoff ? { diagnostics: undefined } : {}),
    groups: handoff ? [] : groups,
  };
  const etag =
    '"' +
    createHash("sha256").update(JSON.stringify(response)).digest("base64url") +
    '"';
  return { response, etag };
}
