import crypto from "node:crypto";

import { fetchActiveRuntimePolicy } from "@hunch/db";
import { z } from "zod";

import type { DbQuery } from "../db.js";

export const signalPostCopyPolicySchema = z
  .object({
    version: z.literal(1),
    materialNetFlowUsd: z.number().finite().min(0).max(100_000_000),
    materialSingleWalletUsd: z.number().finite().min(0).max(100_000_000),
    minimumPriceMoveCents: z.number().finite().min(0).max(100),
    strongPriceMoveCents: z.number().finite().min(0).max(100),
    headlineMaxGraphemes: z.number().int().min(32).max(240),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.strongPriceMoveCents < policy.minimumPriceMoveCents) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strongPriceMoveCents"],
        message: "Strong price move must be at least the minimum price move.",
      });
    }
  });

export type SignalPostCopyPolicyV1 = z.infer<typeof signalPostCopyPolicySchema>;

export const DEFAULT_SIGNAL_POST_COPY_POLICY: SignalPostCopyPolicyV1 =
  Object.freeze({
    version: 1,
    materialNetFlowUsd: 10_000,
    materialSingleWalletUsd: 1_000,
    minimumPriceMoveCents: 2,
    strongPriceMoveCents: 5,
    headlineMaxGraphemes: 80,
  });

export type ResolvedSignalPostCopyPolicy = {
  effectiveAt: string | null;
  invalidOverride: boolean;
  policy: SignalPostCopyPolicyV1;
  revision: string;
  source: "db" | "default";
};

const CACHE_TTL_MS = 15_000;
let cache = new WeakMap<
  object,
  { expiresAt: number; result: ResolvedSignalPostCopyPolicy }
>();

export function buildSignalPostCopyPolicyRevision(
  policy: SignalPostCopyPolicyV1,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex")
    .slice(0, 16);
}

export function clearSignalPostCopyPolicyCache(db?: DbQuery): void {
  if (db && typeof db === "object") {
    cache.delete(db as object);
    return;
  }
  cache = new WeakMap();
}

export async function resolveSignalPostCopyPolicy(
  db: DbQuery,
): Promise<ResolvedSignalPostCopyPolicy> {
  const key = db as object;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  let result: ResolvedSignalPostCopyPolicy;
  try {
    const row = await fetchActiveRuntimePolicy(db, "signal_post_copy");
    const parsed = row
      ? signalPostCopyPolicySchema.safeParse(row.payload)
      : null;
    const policy = parsed?.success
      ? parsed.data
      : DEFAULT_SIGNAL_POST_COPY_POLICY;
    result = {
      effectiveAt:
        parsed?.success && row
          ? new Date(row.effective_at).toISOString()
          : null,
      invalidOverride: row != null && !parsed?.success,
      policy,
      revision: buildSignalPostCopyPolicyRevision(policy),
      source: parsed?.success ? "db" : "default",
    };
  } catch {
    result = {
      effectiveAt: null,
      invalidOverride: true,
      policy: DEFAULT_SIGNAL_POST_COPY_POLICY,
      revision: buildSignalPostCopyPolicyRevision(
        DEFAULT_SIGNAL_POST_COPY_POLICY,
      ),
      source: "default",
    };
  }

  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}
