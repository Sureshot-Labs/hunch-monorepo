// Pure, sidecar-safe account-read policy. This grants no financial actions.
import { z } from "zod";

export const hip4AccountPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    // Legacy stored-field compatibility; runtime access uses venue_lifecycle.
    enabled: z.boolean().default(false),
    // Base refresh costs up to 262 info weight, plus 120 per repair page.
    // Extra history work can defer under the shared IP budget; it must never
    // erase independently valid balance facts or lose its saved cursor.
    snapshotMaxAgeMs: z.number().int().min(1000).max(3_600_000).default(60_000),
    historyLookbackMs: z
      .number()
      .int()
      .min(60_000)
      .max(2_592_000_000)
      .default(604_800_000),
    // Additional range reads after the live tail. Zero pauses repair only;
    // already captured fills and the current account snapshot remain readable.
    historyRepairPagesPerRefresh: z.number().int().min(0).max(4).default(1),
    ledgerRepairPagesPerRefresh: z.number().int().min(0).max(4).default(1),
    historyRepairMaxGapDetails: z.number().int().min(1).max(100).default(32),
    workerIntervalMs: z.number().int().min(1000).max(3_600_000).default(60_000),
    workerBatchSize: z.number().int().min(0).max(20).default(2),
    // Completed exact full-fill receipts are cold rechecks, not hot work on
    // every tick. One hot slot is always preserved inside workerBatchSize.
    completedOrderRecheckIntervalMs: z
      .number()
      .int()
      .min(60_000)
      .max(604_800_000)
      .default(3_600_000),
    completedOrderBatchSize: z.number().int().min(0).max(20).default(1),
    // Bound derived basis reconstruction; a sentinel yields unknown basis,
    // never a truncated financial calculation or a failed balance refresh.
    accountingMaxRows: z.number().int().min(100).max(100_000).default(20_000),
    pageSize: z.number().int().min(1).max(100).default(30),
    leaseMs: z.number().int().min(60_000).max(600_000).default(120_000),
  })
  .strict();
export type Hip4AccountPolicy = z.infer<typeof hip4AccountPolicySchema>;
export const DEFAULT_HIP4_ACCOUNT_POLICY = hip4AccountPolicySchema.parse({});
