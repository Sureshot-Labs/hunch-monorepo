import { z } from "zod";
import type { OpenRouterModelPricingPerM } from "./ai-pricing.js";

const CACHE_KEY = "ai:openrouter:pricing:v1";
const FRESH_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const price = z
  .union([z.string().trim().min(1), z.number()])
  .transform(Number)
  .pipe(z.number().finite().min(0));
const rowSchema = z.object({
  id: z.string().min(1).max(200),
  pricing: z.object({
    prompt: price,
    completion: price,
    web_search: price.optional(),
    overrides: z
      .array(
        z.object({
          min_prompt_tokens: z.number().int().nonnegative(),
          prompt: price,
          completion: price,
        }),
      )
      .optional(),
  }),
});
const snapshotSchema = z.object({
  fetchedAt: z.number().finite().positive(),
  data: z.array(rowSchema).min(1).max(20000),
});
type Snapshot = z.infer<typeof snapshotSchema>;
export type OpenRouterPricingCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
};

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pricing cache timeout")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// No credentials or API-wide configuration. Fetch once per six hours, with
// shared Redis across cron processes and an in-process fallback for callers.
export function createOpenRouterPricingCatalog(
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  let snapshot: Snapshot | null = null;
  let nextAttemptAt = 0;
  let inFlight: Promise<void> | null = null;
  const usable = (value: Snapshot, age: number) =>
    value.fetchedAt <= now() && now() - value.fetchedAt < age;
  const refresh = async (
    cache?: OpenRouterPricingCache | null,
  ): Promise<void> => {
    if (inFlight) return inFlight;
    if ((snapshot && usable(snapshot, FRESH_MS)) || now() < nextAttemptAt)
      return;
    inFlight = (async () => {
      nextAttemptAt = now() + 5 * 60 * 1000;
      if (cache) {
        try {
          const raw = await bounded(cache.get(CACHE_KEY));
          const parsed = snapshotSchema.safeParse(raw && JSON.parse(raw));
          if (
            parsed.success &&
            usable(parsed.data, STALE_MS) &&
            (!snapshot || parsed.data.fetchedAt > snapshot.fetchedAt)
          )
            snapshot = parsed.data;
          if (snapshot && usable(snapshot, FRESH_MS)) return;
        } catch {
          /* Redis is optional; fall through to the public catalog. */
        }
      }
      try {
        const response = await (options.fetch ?? globalThis.fetch)(
          "https://openrouter.ai/api/v1/models",
          { signal: AbortSignal.timeout(5000) },
        );
        if (!response.ok) return;
        const payload: unknown = await response.json();
        const envelope = z
          .object({ data: z.array(z.unknown()).max(20000) })
          .safeParse(payload);
        if (!envelope.success) return;
        const data = envelope.data.data.flatMap((row) => {
          const parsed = rowSchema.safeParse(row);
          return parsed.success ? [parsed.data] : [];
        });
        if (!data.length) return;
        snapshot = { fetchedAt: now(), data };
        if (cache)
          await bounded(
            cache.set(CACHE_KEY, JSON.stringify(snapshot), {
              EX: STALE_MS / 1000,
            }),
          ).catch(() => undefined);
      } catch {
        /* Keep last known prices, then use the caller's static fallback. */
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return {
    refresh,
    get(model: string, inputTokens = 0): OpenRouterModelPricingPerM | null {
      if (!snapshot || !usable(snapshot, STALE_MS)) return null;
      const row = snapshot.data.find((entry) => entry.id === model);
      if (!row) return null;
      const tier = [...(row.pricing.overrides ?? [])]
        .sort((a, b) => b.min_prompt_tokens - a.min_prompt_tokens)
        .find((entry) => inputTokens > entry.min_prompt_tokens);
      return {
        inputPerM: (tier?.prompt ?? row.pricing.prompt) * 1e6,
        outputPerM: (tier?.completion ?? row.pricing.completion) * 1e6,
        ...(row.pricing.web_search != null
          ? { webSearchPerCallUsd: row.pricing.web_search }
          : {}),
      };
    },
  };
}
