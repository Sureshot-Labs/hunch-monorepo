// Pure worker scheduling only: no API env, provider, signer or database import.
export type Hip4ObserverCadence = {
  nextIntervalSeconds: number;
  nextAccountIntervalSeconds: number;
  accountPolicyRevision: string;
  accountReadEnabled: boolean;
  accountReadEnvironment: string | null;
};

export function createHip4ObserverRunner<Result>(dependencies: {
  readCadence: () => Promise<Hip4ObserverCadence>;
  runPass: (
    accountFirst: boolean,
    options: { skipAccounts: boolean },
  ) => Promise<Result>;
  now?: () => number;
}) {
  let lastAccountPassCompletedAt: number | null = null;
  let previousAccountScope: string | null = null;
  let previousAccountPolicyRevision: string | null = null;
  let accountFirstNext = true;
  let running: Promise<Result> | null = null;
  const now = dependencies.now ?? Date.now;

  const run = () => {
    running ??= (async () => {
      const cadence = await dependencies.readCadence();
      const startedAt = now();
      const accountScope = cadence.accountReadEnabled
        ? (cadence.accountReadEnvironment ?? "unknown")
        : null;
      const scopeChanged = accountScope !== previousAccountScope;
      const policyChanged =
        cadence.accountPolicyRevision !== previousAccountPolicyRevision;
      const skipAccounts =
        accountScope === null ||
        (!scopeChanged &&
          !policyChanged &&
          lastAccountPassCompletedAt !== null &&
          startedAt >= lastAccountPassCompletedAt &&
          startedAt - lastAccountPassCompletedAt <
            cadence.nextAccountIntervalSeconds * 1000);
      previousAccountScope = accountScope;
      previousAccountPolicyRevision = cadence.accountPolicyRevision;
      const accountFirst = accountFirstNext;
      if (!skipAccounts) {
        // Rotate only when both phases run. Hot-only cycles must not change
        // fairness between the full account batch and exact order reads.
        accountFirstNext = !accountFirstNext;
      }
      try {
        return await dependencies.runPass(accountFirst, { skipAccounts });
      } finally {
        // Preserve the old completion-based account batch spacing. Order-first
        // passes can have variable runtimes; a pass-start clock could otherwise
        // run successive aggregate account batches less than one interval apart.
        if (!skipAccounts) lastAccountPassCompletedAt = now();
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    run,
    // Scheduler timeout is not cancellation. Keep the same promise and its
    // phase decisions until the real provider work has completely settled.
    waitForIdle: async () => {
      await running?.catch(() => undefined);
    },
  };
}
