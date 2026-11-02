/** node-postgres 8.22 deprecates its implicit query queue. Preserve the existing
 * single-connection semantics explicitly, without serializing HTTP/RPC work.
 * This wrapper is for the refresh's promise-based SQL calls, not query streams
 * or callbacks. The caller must drain before returning the connection to a pool.
 */
export function serialQueryClient<T extends { query: unknown }>(
  target: T,
): {
  client: T;
  drain: () => Promise<void>;
} {
  let pending = Promise.resolve();
  let accepting = true;
  const client = new Proxy(target, {
    get(object, key, receiver) {
      if (key !== "query") return Reflect.get(object, key, receiver);
      return (...args: unknown[]) => {
        if (!accepting)
          return Promise.reject(new Error("Serial SQL client is closed"));
        if (args.some((arg) => typeof arg === "function"))
          return Promise.reject(
            new TypeError("Serial SQL requires promise-based queries"),
          );
        const task = pending.then(() =>
          Reflect.apply(
            object.query as (...values: unknown[]) => unknown,
            object,
            args,
          ),
        );
        pending = task.then(
          () => {},
          () => {},
        );
        return task;
      };
    },
  });
  return {
    client,
    drain: () => {
      accepting = false;
      return pending;
    },
  };
}
