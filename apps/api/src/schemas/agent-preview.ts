import { z } from "zod";
import { agentAuthorSettingsSchema } from "../services/agent-theses-policy.js";
import { thesisSourceSchema } from "./social-trade.js";

export const agentPreviewInputSchema = z
  .object({
    requestId: z.string().uuid(),
    settings: agentAuthorSettingsSchema,
  })
  .strict();
export const agentPreviewBudgetSchema = z.object({
  limitUsd: z.number(),
  actualUsd: z.number(),
  reservedUsd: z.number(),
  remainingUsd: z.number(),
});
export const agentPreviewMarketSchema = z.object({
  marketId: z.string(),
  title: z.string(),
  eventTitle: z.string(),
  condition: z.string(),
});
export const agentPreviewResultSchema = z.object({
  market: agentPreviewMarketSchema,
  outcome: z.enum(["YES", "NO"]),
  outcomeLabel: z.string(),
  body: z.string(),
  counterargument: z.string(),
  changeReason: z.string().nullable(),
  maxEntryPrice: z.string(),
  sources: z.array(thesisSourceSchema),
  observedAsk: z.string(),
  quoteAsOf: z.string(),
  simulation: z
    .object({
      amountUsd: z.string(),
      shares: z.string(),
      entryPrice: z.string(),
      quoteAsOf: z.string(),
    })
    .nullable(),
  validationReason: z.string().nullable(),
});
export const agentPreviewCallSchema = z.object({
  callId: z.string(),
  stage: z.string(),
  model: z.string().nullable(),
  actualUsd: z.number().nullable(),
  reservedUsd: z.number(),
});
export const agentPreviewSchema = z.object({
  runId: z.string(),
  userId: z.string().uuid(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(["running", "complete", "failed", "interrupted"]),
  stage: z.enum(["loading", "selection", "writing", "validation", "finished"]),
  reason: z.string().nullable(),
  reasonDetail: z.string().max(1200).nullable().optional(),
  writerCandidates: z
    .array(z.object({ marketId: z.string(), title: z.string() }))
    .max(3)
    .optional(),
  diagnostics: z.array(z.string()),
  models: z.object({ jev: z.string(), writer: z.string() }),
  candidateCount: z.number(),
  shortlistCount: z.number(),
  // Optional for recovery of previews created by an older API image.
  retrieval: z
    .object({
      poolCount: z.number(),
      semanticPoolCount: z.number(),
      cacheHits: z.number(),
      generated: z.number(),
      durationMs: z.number(),
    })
    .optional(),
  shortlist: z
    .array(
      z.object({
        marketId: z.string(),
        title: z.string(),
        eventTitle: z.string(),
        category: z.string(),
        semanticRank: z.number().int().positive().nullable(),
      }),
    )
    .max(24)
    .optional(),
  selection: agentPreviewMarketSchema.nullable(),
  angle: z.string().nullable(),
  draftText: z.string().max(120000).nullable(),
  result: agentPreviewResultSchema.nullable(),
  calls: z.array(agentPreviewCallSchema),
  cost: z.object({ actualUsd: z.number(), reservedUsd: z.number() }),
  budget: agentPreviewBudgetSchema,
});
export type AgentPreviewInput = z.infer<typeof agentPreviewInputSchema>;
export type AgentPreview = z.infer<typeof agentPreviewSchema>;
