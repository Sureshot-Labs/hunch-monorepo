import type { BackgroundPositionResult } from "./polymarket-background-positions.js";

export function canContinueWalletDiscovery(
  result: BackgroundPositionResult,
): boolean {
  return (
    result.status === "deferred" &&
    result.checkpointAvailable &&
    result.pagesThisSlice > 0 &&
    (result.reason === "time_budget" || result.reason === "page_budget")
  );
}

/** First pass for everyone, then FIFO rounds of proven checkpoint progress.
 * Unused slice time is shared, not a larger per-page/per-wallet allowance.
 * No provider error, capacity failure or lost checkpoint is retried here.
 */
export async function runWalletIntelDiscoveryQueue<T>(input: {
  targets: readonly T[];
  concurrency: number;
  sliceBudgetMs: number;
  discover: (target: T, budgetMs: number) => Promise<BackgroundPositionResult>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  if (
    !Number.isSafeInteger(input.sliceBudgetMs) ||
    input.sliceBudgetMs <= 0 ||
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency <= 0
  )
    throw new Error("Invalid discovery queue bounds");
  const results = new Map<T, BackgroundPositionResult>();
  const errors = new Set<T>();
  const budgetMs = input.targets.length * input.sliceBudgetMs;
  let remainingMs = budgetMs,
    slices = 0,
    continuations = 0;
  let round = [...input.targets];
  while (round.length && remainingMs > 0) {
    let cursor = 0;
    const next = new Set(round);
    await Promise.all(
      Array.from(
        { length: Math.min(input.concurrency, round.length) },
        async () => {
          while (cursor < round.length) {
            // Reserve before awaiting so concurrent workers cannot overspend.
            const allowance = Math.min(input.sliceBudgetMs, remainingMs);
            if (allowance <= 0) break;
            const target = round[cursor++];
            if (target === undefined)
              throw new Error("Missing discovery target");
            next.delete(target);
            remainingMs -= allowance;
            const startedAt = now();
            const previous = results.get(target);
            slices++;
            if (previous) continuations++;
            try {
              const result = await input.discover(target, allowance);
              results.set(target, result);
              if (
                canContinueWalletDiscovery(result) &&
                result.pages > (previous?.pages ?? 0)
              )
                next.add(target);
            } catch {
              errors.add(target);
            } finally {
              // Checkpoint bookkeeping can finish just beyond its slice. Never
              // mint extra allowance; charge at least 1ms even with fake clocks.
              const spent = Math.min(allowance, Math.max(1, now() - startedAt));
              remainingMs += allowance - spent;
            }
          }
        },
      ),
    );
    round = round.filter((target) => next.has(target));
  }
  return {
    results,
    errors,
    summary: {
      selected: input.targets.length,
      slices,
      continuations,
      budgetMs,
      chargedMs: budgetMs - remainingMs,
      completed: [...results.values()].filter((r) => r.status === "complete")
        .length,
      errors: errors.size,
    },
  };
}
