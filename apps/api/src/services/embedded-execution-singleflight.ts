const DEFAULT_EMBEDDED_EXECUTION_SETTLED_TTL_MS = 30_000;

type EmbeddedExecutionSettledEntry = {
  expiresAt: number;
  value: unknown;
};

const embeddedExecutionInFlight = new Map<string, Promise<unknown>>();
const embeddedExecutionSettled = new Map<
  string,
  EmbeddedExecutionSettledEntry
>();

function pruneExpiredEmbeddedExecutionSettledEntries(now = Date.now()) {
  for (const [key, entry] of embeddedExecutionSettled.entries()) {
    if (entry.expiresAt <= now) {
      embeddedExecutionSettled.delete(key);
    }
  }
}

export function buildEmbeddedExecutionSingleFlightKey(
  ...parts: Array<string | number | null | undefined>
): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("|");
}

export function getEmbeddedExecutionSingleFlightPromise<T>(
  key: string,
): Promise<T> | null {
  return (embeddedExecutionInFlight.get(key) as Promise<T> | undefined) ?? null;
}

export async function runEmbeddedExecutionSingleFlight<T>(inputs: {
  key: string;
  run: () => Promise<T>;
  settledTtlMs?: number;
}): Promise<T> {
  const now = Date.now();
  pruneExpiredEmbeddedExecutionSettledEntries(now);

  const settled = embeddedExecutionSettled.get(inputs.key);
  if (settled && settled.expiresAt > now) {
    return settled.value as T;
  }

  const existing = embeddedExecutionInFlight.get(inputs.key) as
    | Promise<T>
    | undefined;
  if (existing) {
    return existing;
  }

  const executionPromise = (async () => {
    const result = await inputs.run();
    embeddedExecutionSettled.set(inputs.key, {
      value: result,
      expiresAt:
        Date.now() +
        (inputs.settledTtlMs ?? DEFAULT_EMBEDDED_EXECUTION_SETTLED_TTL_MS),
    });
    return result;
  })();

  embeddedExecutionInFlight.set(inputs.key, executionPromise);

  try {
    return await executionPromise;
  } finally {
    if (embeddedExecutionInFlight.get(inputs.key) === executionPromise) {
      embeddedExecutionInFlight.delete(inputs.key);
    }
  }
}

export function clearEmbeddedExecutionSingleFlightState() {
  embeddedExecutionInFlight.clear();
  embeddedExecutionSettled.clear();
}

// TODO: Move embedded execute single-flight state to Redis when the API runs on multiple instances.
