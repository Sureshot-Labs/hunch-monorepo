import { setTimeout as delay } from "node:timers/promises";

/** Drain pending authors independently of push delivery. Retain last-known
 * same-policy statistics while refresh catches up; age alone must not drop leaders. */
export async function runSocialTraderStatisticsWorker(input: {
  signal: AbortSignal;
  seed: () => Promise<unknown>;
  refresh: (batchSize: number) => Promise<number>;
  onFailure: (stage: "seed" | "statistics", error?: unknown) => void;
  onIteration?: (result: {
    seedFailed: boolean;
    refreshFailed: boolean;
  }) => void;
  wait?: (milliseconds: number) => Promise<unknown>;
}) {
  const batchSize = 50;
  while (!input.signal.aborted) {
    let count = 0;
    let seedFailed = false,
      refreshFailed = false;
    try {
      await input.seed();
    } catch (error) {
      seedFailed = true;
      input.onFailure("seed", error);
    }
    if (input.signal.aborted) break;
    try {
      count = await input.refresh(batchSize);
    } catch (error) {
      refreshFailed = true;
      input.onFailure("statistics", error);
    }
    input.onIteration?.({ seedFailed, refreshFailed });
    if (input.signal.aborted) break;
    try {
      const milliseconds = count === batchSize ? 25 : 5_000;
      await (input.wait
        ? input.wait(milliseconds)
        : delay(milliseconds, undefined, { signal: input.signal }));
    } catch {
      if (!input.signal.aborted)
        throw new Error("Statistics worker wait failed");
    }
  }
}
