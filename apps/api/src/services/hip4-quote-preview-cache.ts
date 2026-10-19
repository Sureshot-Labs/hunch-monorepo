type PreviewEntry<T> = {
  promise: Promise<T>;
  expiresAt: number | null;
};

/** Read-only preview facts, never prepared actions or financial admission. */
export function createHip4QuotePreviewCache<T>(now = () => Date.now()) {
  const entries = new Map<string, PreviewEntry<T>>();
  const trim = (maximum: number) => {
    while (entries.size > maximum) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    clear() {
      entries.clear();
    },
    read(
      key: string,
      maximum: number,
      load: () => Promise<T>,
      expiresAt: (value: T) => number,
    ): Promise<T> {
      if (maximum === 0) {
        // Disabling reuse also prevents an older pending read from repopulating
        // this cache after the policy has changed.
        entries.clear();
        return load();
      }
      for (const [candidate, entry] of entries)
        if (entry.expiresAt !== null && entry.expiresAt <= now())
          entries.delete(candidate);
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        entries.set(key, existing);
        trim(maximum);
        return existing.promise.then((value) => structuredClone(value));
      }
      trim(maximum - 1);
      const entry: PreviewEntry<T> = {
        expiresAt: null,
        promise: Promise.resolve()
          .then(load)
          .then((value) => {
            const deadline = expiresAt(value);
            if (entries.get(key) === entry) {
              if (Number.isFinite(deadline) && deadline > now())
                entry.expiresAt = deadline;
              else entries.delete(key);
            }
            return structuredClone(value);
          })
          .catch((error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          }),
      };
      entries.set(key, entry);
      // Callers cannot modify facts retained for another preview request.
      return entry.promise.then((value) => structuredClone(value));
    },
  };
}
