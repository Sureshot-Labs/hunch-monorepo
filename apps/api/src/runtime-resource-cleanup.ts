type RuntimeResourceCleanup = () => Promise<void>;

const acquiredResources = new Map<string, RuntimeResourceCleanup>();

export function registerRuntimeResourceCleanup(
  name: string,
  cleanup: RuntimeResourceCleanup,
): void {
  acquiredResources.set(name, cleanup);
}

export function unregisterRuntimeResourceCleanup(name: string): void {
  acquiredResources.delete(name);
}

export async function closeAcquiredRuntimeResources(): Promise<void> {
  const resources = [...acquiredResources.entries()].reverse();
  acquiredResources.clear();
  const results = await Promise.allSettled(
    resources.map(([, cleanup]) => cleanup()),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${resources[index]?.[0] ?? "unknown"}: ${String(result.reason)}`]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`runtime resource cleanup failed: ${failures.join("; ")}`);
  }
}
