import {
  hip4BookSchema,
  hip4TradeSchema,
  parseHip4Coin,
  hip4Identity,
  type Hip4ReadPolicy,
  type Hip4ReadMarket,
} from "@hunch/shared";
import type { Pool } from "pg";
import type { z } from "zod";
import { ageHip4Market, applyHip4Book } from "./hip4-mapping.js";
import {
  persistHip4Market,
  readHip4Policy,
  readHip4StoredMarket,
} from "./hip4-repository.js";
import type { Hip4Interval } from "./hip4-history.js";

type LiveEntry =
  | { channel: "l2Book"; book: z.infer<typeof hip4BookSchema> }
  | { channel: "trades"; trade: z.infer<typeof hip4TradeSchema> };
export function createHip4LiveBuffer(
  policy: Hip4ReadPolicy,
  wake: () => void,
  since = Date.now(),
) {
  let queue: LiveEntry[] = [];
  let gaps = new Set<string>();
  let selected = new Set<number>();
  let pendingOutcomes = new Set<number>();
  let lastDrain = since;
  const diagnostics = { invalid: 0, overflow: 0, queued: 0 };
  const gap = (reason: string) => {
    gaps.add(reason);
    wake();
  };
  return {
    diagnostics,
    gap,
    select: (outcomes: number[]) => {
      selected = new Set(
        outcomes
          .filter((id) => policy.outcomeAllowlist.includes(id))
          .slice(0, policy.maxLiveOutcomes),
      );
      // Keep the retiring hot set until its accepted observations and gaps
      // have been drained. Selection controls new ingress, not queued data.
      for (const outcome of selected) pendingOutcomes.add(outcome);
    },
    data: (channel: "l2Book" | "trades", payload: unknown) => {
      const entries: LiveEntry[] = [];
      try {
        if (channel === "l2Book")
          entries.push({ channel, book: hip4BookSchema.parse(payload) });
        else {
          if (
            !Array.isArray(payload) ||
            payload.length > policy.streamQueueSize
          ) {
            diagnostics.overflow++;
            gap("queue_overflow");
            return;
          }
          for (const row of payload)
            entries.push({ channel, trade: hip4TradeSchema.parse(row) });
        }
        for (const entry of entries) {
          const row = entry.channel === "l2Book" ? entry.book : entry.trade;
          const identity = parseHip4Coin(row.coin);
          if (
            !selected.has(identity.outcome) ||
            (channel === "trades" && identity.sideIndex !== 0) ||
            row.time > Date.now()
          )
            throw new Error();
        }
      } catch {
        diagnostics.invalid++;
        gap("invalid_stream_payload");
        return;
      }
      if (entries.length + queue.length > policy.streamQueueSize) {
        diagnostics.overflow++;
        gap("queue_overflow");
        return;
      }
      queue.push(...entries);
      diagnostics.queued = queue.length;
    },
    take: () => {
      const batch = {
        entries: queue,
        gaps: [...gaps],
        outcomes: [...pendingOutcomes],
        since: lastDrain,
      };
      lastDrain = Date.now();
      queue = [];
      gaps = new Set();
      pendingOutcomes = new Set(selected);
      diagnostics.queued = 0;
      return batch;
    },
  };
}

export async function flushHip4Live(
  pool: Pool,
  policy: Hip4ReadPolicy,
  revision: string,
  batch: ReturnType<ReturnType<typeof createHip4LiveBuffer>["take"]>,
  publish: (market: Hip4ReadMarket) => Promise<void>,
  now = Date.now(),
) {
  const current = await readHip4Policy(pool);
  if (!current.policy.enabled || current.revision !== revision) return;
  for (const outcome of batch.outcomes) {
    const stored = await readHip4StoredMarket(
      pool,
      policy.environment,
      outcome,
    );
    if (!stored) continue; // Bootstrap REST will provide the canonical identity.
    let market = stored.market;
    const entries = batch.entries.filter(
      (entry) =>
        parseHip4Coin(
          entry.channel === "l2Book" ? entry.book.coin : entry.trade.coin,
        ).outcome === outcome,
    );
    const trades = [];
    for (const entry of entries) {
      // A terminal snapshot does not invalidate trades already accepted by
      // the stream before settlement. Keep their ledger/candles on replay.
      if (entry.channel === "trades") trades.push(entry.trade);
      else if (!market.settlement)
        market = applyHip4Book(
          market,
          parseHip4Coin(entry.book.coin).sideIndex,
          entry.book,
          now,
          policy.bookMaxAgeMs,
        );
    }
    const start = Math.max(
      batch.since,
      now - Math.min(policy.historyMaxRangeMs, 86400000),
    );
    const intervals: Hip4Interval[] = batch.gaps.map((reason) => ({
      start,
      end: now,
      kind: "gap",
      reason,
    }));
    if (entries.length)
      intervals.push({
        start,
        end: now,
        kind: "observed",
        reason: "ws_partial",
      });
    if (trades.length)
      market.coverage = {
        ...market.coverage,
        trades: "recent_window",
        tradeObservedAt: new Date(now).toISOString(),
        tradeAttempt: { at: new Date(now).toISOString(), result: "ok" },
        tradeWindowStart: new Date(
          Math.min(...trades.map((trade) => trade.time)),
        ).toISOString(),
        tradeWindowEnd: new Date(
          Math.max(...trades.map((trade) => trade.time)),
        ).toISOString(),
      };
    if (entries.length || intervals.length) {
      const latest = await readHip4Policy(pool);
      if (!latest.policy.enabled || latest.revision !== revision) return;
      await persistHip4Market(pool, {
        market: ageHip4Market(market, now, policy),
        raw: stored.raw,
        trades,
        intervals,
        advanceCursor: false,
      });
    }
    // Re-read committed state even if the previous publish was lost. An idle
    // flush also repairs Redis; cached Redis data never becomes DB authority.
    const snapshot = await readHip4StoredMarket(
      pool,
      policy.environment,
      outcome,
    );
    if (snapshot) await publish(ageHip4Market(snapshot.market, now, policy));
  }
}

export function selectHip4HotOutcomes(
  policy: Hip4ReadPolicy,
  tokens: string[],
  settled: readonly number[] = [],
) {
  const eligible = policy.outcomeAllowlist.filter(
    (id) => !settled.includes(id),
  );
  const ordered = eligible.filter((id) =>
    hip4Identity(policy.environment, id).sides.some((side) =>
      tokens.includes(side.tokenId),
    ),
  );
  return [...new Set([...ordered, ...eligible])].slice(
    0,
    policy.maxLiveOutcomes,
  );
}
