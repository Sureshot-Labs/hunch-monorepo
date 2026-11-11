/** Per route instance, no response cache or extra freshness window. Failure
 * removes the flight so the next request can recover. Different normalized
 * keys never share a result; overload bypasses coalescing, not the request. */
export function createFeedSingleflight<T>(maxKeys = 128) {
  const running = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const existing = running.get(key);
    if (existing) return existing;
    if (running.size >= maxKeys) return load();
    const result = Promise.resolve()
      .then(load)
      .finally(() => {
        if (running.get(key) === result) running.delete(key);
      });
    running.set(key, result);
    return result;
  };
}
