import { gammaPageSize, sleep, type GammaVersion } from "@hunch/shared";
import type { GammaEventsQuery, GammaPageEvent } from "./gammaClient.js";

export type GammaV2Checkpoint = {
  phase: "open" | "catalog" | "complete";
  offset: number;
};
export const initialGammaV2Checkpoint = (): GammaV2Checkpoint => ({
  phase: "open",
  offset: 0,
});
export function parseGammaV2Checkpoint(raw: string | null): GammaV2Checkpoint {
  if (raw == null) return initialGammaV2Checkpoint();
  const parsed = JSON.parse(raw) as GammaV2Checkpoint;
  if (
    !["open", "catalog", "complete"].includes(parsed.phase) ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0
  ) {
    throw new Error(
      "Invalid Gamma V2 checkpoint; inspect before resetting this key",
    );
  }
  return { phase: parsed.phase, offset: parsed.offset };
}

export type GammaSyncCounters = {
  pages: number;
  received: number;
  processedEvents: number;
  processedMarkets: number;
  skippedEvents: number;
};

// Bounded work inside the existing refresh cycle. The checkpoint is committed
// only after both source/unified upserts, so a crash simply replays a page.
export async function runGammaV2CatchUp(options: {
  checkpoint: GammaV2Checkpoint;
  pageSize: number;
  maxPages: number;
  maxOffset: number;
  fetchPage: (query: GammaEventsQuery) => Promise<{ events: GammaPageEvent[] }>;
  processPage: (
    events: GammaPageEvent[],
  ) => Promise<{ processedEvents: number; processedMarkets: number }>;
  saveCheckpoint: (checkpoint: GammaV2Checkpoint) => Promise<void>;
  pause?: () => Promise<void>;
}) {
  let checkpoint = { ...options.checkpoint };
  const totals: GammaSyncCounters = {
    pages: 0,
    received: 0,
    processedEvents: 0,
    processedMarkets: 0,
    skippedEvents: 0,
  };
  for (
    let requests = 0;
    requests < options.maxPages && checkpoint.phase !== "complete";
    requests += 1
  ) {
    if (checkpoint.offset > options.maxOffset) break;
    const { events } = await options.fetchPage({
      version: "v2",
      offset: checkpoint.offset,
      limit: gammaPageSize(options.pageSize),
      order: "id",
      ascending: true,
      ...(checkpoint.phase === "open"
        ? { active: true, archived: false, closed: false }
        : {}),
    });
    let next: GammaV2Checkpoint;
    if (!events.length) {
      next =
        checkpoint.phase === "open"
          ? { phase: "catalog", offset: 0 }
          : { phase: "complete", offset: checkpoint.offset };
    } else {
      const processed = await options.processPage(events);
      totals.pages += 1;
      totals.received += events.length;
      totals.processedEvents += processed.processedEvents;
      totals.processedMarkets += processed.processedMarkets;
      totals.skippedEvents += events.length - processed.processedEvents;
      next = { ...checkpoint, offset: checkpoint.offset + events.length };
    }
    await options.saveCheckpoint(next);
    checkpoint = next;
    if (checkpoint.phase !== "complete")
      await (options.pause ?? (() => sleep(100)))();
  }
  return {
    ...totals,
    checkpoint,
    unfinished: checkpoint.phase !== "complete",
    offsetCapReached:
      checkpoint.phase !== "complete" && checkpoint.offset > options.maxOffset,
  };
}

// A failed version/pass must not discard the other lane's successful work.
export async function runGammaHotLanes<T>(
  run: (version: GammaVersion, closed: boolean) => Promise<T>,
) {
  const results: Array<{
    version: GammaVersion;
    closed: boolean;
    result?: T;
    error?: string;
  }> = [];
  for (const closed of [false, true]) {
    for (const version of ["v2", "v1"] as const) {
      try {
        results.push({ version, closed, result: await run(version, closed) });
      } catch (error) {
        results.push({
          version,
          closed,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}
