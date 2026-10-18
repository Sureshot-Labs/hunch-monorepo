const stages = [
  "fanout",
  "digest",
  "big_moves",
  "statistics",
  "rankings",
  "seed",
  "retention",
  "delivery",
] as const;

type NativeOnboardingStage = (typeof stages)[number];
type NativeOnboardingTasks = Record<
  Exclude<NativeOnboardingStage, "delivery" | "statistics" | "seed">,
  () => Promise<unknown>
> &
  Partial<Record<"delivery" | "statistics" | "seed", () => Promise<unknown>>>;

/** A failed source or housekeeping task must not prevent other topics or delivery. */
export async function runNativeOnboardingCycle(tasks: NativeOnboardingTasks) {
  const failures: NativeOnboardingStage[] = [];
  for (const stage of stages) {
    try {
      await tasks[stage]?.();
    } catch {
      failures.push(stage);
    }
  }
  return failures;
}
