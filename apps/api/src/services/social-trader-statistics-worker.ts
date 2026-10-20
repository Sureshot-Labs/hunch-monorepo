import { setTimeout as delay } from "node:timers/promises";

/** Drain pending authors independently of push delivery. Retain last-known
 * same-policy statistics while refresh catches up; age alone must not drop leaders. */
export async function runSocialTraderStatisticsWorker(input: {
  signal: AbortSignal;
  seed: () => Promise<unknown>;
  refresh: (batchSize: number) => Promise<number>;
  onFailure: (stage: "seed" | "statistics") => void;
  wait?: (milliseconds: number) => Promise<unknown>;
}) {
  const batchSize = 50;
  while (!input.signal.aborted) {
    let count = 0;
    try {
      await input.seed();
    } catch {
      input.onFailure("seed");
    }
    if (input.signal.aborted) break;
    try {
      count = await input.refresh(batchSize);
    } catch {
      input.onFailure("statistics");
    }
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
