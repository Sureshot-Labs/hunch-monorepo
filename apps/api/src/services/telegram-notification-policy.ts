import { fetchActiveRuntimePolicy } from "@hunch/db";
import { z } from "zod";

import type { DbQuery } from "../db.js";

export const telegramNotificationsPolicySchema = z
  .object({
    version: z.literal(1),
    positionResolutionProducerEnabled: z.boolean().default(false),
    activityEnqueueEnabled: z.boolean(),
    positionSignalEnqueueEnabled: z.boolean(),
    deliveryEnabled: z.boolean(),
  })
  .strict();

export type TelegramNotificationsPolicyV1 = z.infer<
  typeof telegramNotificationsPolicySchema
>;

export const DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY: TelegramNotificationsPolicyV1 =
  Object.freeze({
    version: 1,
    positionResolutionProducerEnabled: false,
    activityEnqueueEnabled: false,
    positionSignalEnqueueEnabled: false,
    deliveryEnabled: false,
  });

export type ResolvedTelegramNotificationsPolicy = {
  effectiveAt: string | null;
  invalidOverride: boolean;
  policy: TelegramNotificationsPolicyV1;
  source: "db" | "default";
};

const CACHE_TTL_MS = 15_000;
let cache = new WeakMap<
  object,
  { expiresAt: number; result: ResolvedTelegramNotificationsPolicy }
>();

export function clearTelegramNotificationsPolicyCache(db?: DbQuery): void {
  if (db && typeof db === "object") {
    cache.delete(db as object);
    return;
  }
  cache = new WeakMap();
}

export async function resolveTelegramNotificationsPolicy(
  db: DbQuery,
): Promise<ResolvedTelegramNotificationsPolicy> {
  const key = db as object;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  let result: ResolvedTelegramNotificationsPolicy;
  try {
    const row = await fetchActiveRuntimePolicy(db, "telegram_notifications");
    const parsed = row
      ? telegramNotificationsPolicySchema.safeParse(row.payload)
      : null;
    result = parsed?.success
      ? {
          effectiveAt: row ? new Date(row.effective_at).toISOString() : null,
          invalidOverride: false,
          policy: parsed.data,
          source: "db",
        }
      : {
          effectiveAt: null,
          invalidOverride: row != null,
          policy: DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY,
          source: "default",
        };
  } catch {
    result = {
      effectiveAt: null,
      invalidOverride: true,
      policy: DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY,
      source: "default",
    };
  }

  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}
