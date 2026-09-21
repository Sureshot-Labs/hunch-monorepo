import { z } from "zod";

const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const entityCoverage = z.object({
  eligible: count,
  verified: count,
  missing: count,
});

// Operator telemetry is optional during mixed-version rollout. Invalid telemetry
// must never be interpreted as verified coverage or a successful transition.
const statusSchema = z.object({
  updatedAt: timestamp.optional(),
  desiredGeneration: z.string().nullable().optional(),
  activeGeneration: z.string().nullable().optional(),
  state: z.enum(["building", "verifying", "active", "paused", "failed"]),
  reason: z.string().nullable().optional(),
  checkpoint: z
    .object({
      entityType: z.enum(["event", "market"]),
      afterId: z.string().nullable(),
    })
    .nullable()
    .optional(),
  coverage: z
    .object({
      events: entityCoverage,
      markets: entityCoverage,
    })
    .optional(),
  verifiedAt: timestamp.nullable().optional(),
  budget: z
    .object({
      limitUsd: z.number().finite().nonnegative(),
      spentUsd: z.number().finite().nonnegative(),
      reservedUsd: z.number().finite().nonnegative(),
      actualUsd: z.number().finite().nonnegative().nullable().optional(),
      remainingUsd: z.number().finite().nonnegative().optional(),
    })
    .optional(),
  retries: count.optional(),
  circuitUntil: timestamp.nullable().optional(),
  oldestPendingAgeMs: count.nullable().optional(),
  dlqLength: count.nullable().optional(),
  memory: z
    .object({
      redisUsedBytes: count,
      workerAvailableBytes: count,
      projectedBytes: z.number().finite().nonnegative().nullable(),
      workerRssBytes: count.nullable().optional(),
      redisRssBytes: count.nullable().optional(),
      redisPersistenceActive: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export function parseAdminEmbeddingStatus(raw: string | null): {
  status: z.infer<typeof statusSchema> | null;
  error: string | null;
} {
  if (raw == null) return { status: null, error: null };
  try {
    const parsed = statusSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { status: parsed.data, error: null }
      : { status: null, error: "Embedding worker status is invalid" };
  } catch {
    return { status: null, error: "Embedding worker status is invalid" };
  }
}
