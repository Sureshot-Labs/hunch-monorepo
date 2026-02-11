import { z } from "zod";

const zIsoDatetime = z
  .string()
  .min(1)
  .refine(value => !Number.isNaN(Date.parse(value)), {
    message: "Expected ISO datetime string",
  });

const zNullableNumber = z.number().finite().nullable();
const zProb = z.number().min(0).max(1);
const zMetricSource = z.enum([
  "market_volume_24h",
  "trade_rollup_24h",
  "market_volume_total_fallback",
  "event_volume_24h",
  "event_trade_rollup_24h",
  "event_volume_total_fallback",
  "market_liquidity",
  "event_liquidity",
  "open_interest_fallback",
  "missing",
]);

export const synthesisInputEvidenceItemV1Schema = z
  .object({
    evidence_id: z.string().min(1),
    claim: z.string().min(1),
    source_url: z.string().url().nullable(),
    source_domain: z.string().min(1),
    published_at: zIsoDatetime.nullable(),
    author_handle: z.string().min(1).nullable(),
    supports_topic: z.boolean(),
    confidence: zProb,
  })
  .strict();

export const synthesisInputMarketSnapshotV1Schema = z
  .object({
    role: z.enum(["sample", "top_by_volume", "linked"]),
    market_id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    best_bid: zNullableNumber,
    best_ask: zNullableNumber,
    last_price: zNullableNumber,
    volume_24h: zNullableNumber,
    volume_24h_source: zMetricSource.optional(),
    liquidity: zNullableNumber,
    liquidity_source: zMetricSource.optional(),
    implied_mid: zNullableNumber.optional(),
  })
  .strict();

export const synthesisInputV1Schema = z
  .object({
    version: z.literal("synthesis_input_v1"),
    run: z
      .object({
        run_id: z.string().min(1),
        generated_at: zIsoDatetime,
        stage: z.enum(["SynthesisLite", "stage1"]),
        model: z.string().min(1),
        prompt_version: z.string().min(1).optional(),
      })
      .strict(),
    topic: z
      .object({
        topic_key: z.string().min(1),
        tier: z.enum(["A", "B", "C"]),
        category: z.string().min(1),
        entity: z.string().min(1),
        intent_anchor: z.string().min(1),
      })
      .strict(),
    event: z
      .object({
        event_id: z.string().min(1),
        venue: z.string().min(1),
        title: z.string().min(1),
        status: z.string().min(1),
        end_date: zIsoDatetime.nullable(),
        volume_24h: zNullableNumber,
        volume_24h_source: zMetricSource.optional(),
        liquidity: zNullableNumber,
        liquidity_source: zMetricSource.optional(),
        open_interest: zNullableNumber.optional(),
      })
      .strict(),
    markets: z.array(synthesisInputMarketSnapshotV1Schema).min(1),
    freshness: z
      .object({
        is_fresh_tier_a: z.boolean(),
        is_fresh_tier_b: z.boolean().optional(),
        book_age_sec: z.number().min(0).nullable(),
        trade_age_sec: z.number().min(0).nullable(),
        wallet_age_sec: z.number().min(0).nullable().optional(),
        reasons: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    mapping: z
      .object({
        link_confidence: zProb,
        reasons: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    external_evidence: z
      .object({
        status: z.enum(["OK", "PARTIAL", "NO_EVIDENCE"]),
        window_hours: z.number().int().min(1).max(168),
        supports_topic_count: z.number().int().min(0),
        evidence_count: z.number().int().min(0),
        items: z.array(synthesisInputEvidenceItemV1Schema),
      })
      .strict(),
    gate_primitives: z
      .object({
        independent_sources_count: z.number().int().min(0),
        high_trust_source: z.boolean(),
        strong_internal_corroboration: z.boolean(),
        data_completeness_score: zProb,
      })
      .strict(),
    policy: z
      .object({
        min_evidence: z.number().int().min(1),
        min_confidence: zProb,
        min_link_confidence: zProb,
        min_data_completeness: zProb.default(0.55),
        extreme_price_low: zProb.default(0.08),
        extreme_price_high: zProb.default(0.92),
      })
      .strict(),
  })
  .strict();

export const synthesisOutputSignalV1Schema = z
  .object({
    signal_type: z.enum([
      "breakout",
      "mean_revert",
      "flow_shock",
      "news_shock",
      "drift",
      "none",
    ]),
    direction: z.enum(["up", "down", "mixed", "none"]),
    horizon: z.enum(["intraday", "24h", "multi-day"]),
    strength: zProb,
    confidence: zProb,
    evidence_refs: z.array(z.string().min(1)).default([]),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const synthesisOutputV1Schema = z
  .object({
    version: z.literal("synthesis_output_v1"),
    status: z.enum(["OK", "INSUFFICIENT_EVIDENCE", "STALE", "ERROR"]),
    event_id: z.string().min(1),
    topic_key: z.string().min(1),
    summary_short: z.string().min(1).max(280),
    summary_long: z.string().min(1),
    signals: z.array(synthesisOutputSignalV1Schema),
    confidence: zProb,
    quality_score: zProb,
    risk_flags: z.array(z.string().min(1)).default([]),
    evidence_refs: z.array(z.string().min(1)).default([]),
    publish_recommendation: z
      .object({
        decision: z.enum([
          "publish_candidate",
          "publish_context_only",
          "store_weak_signal",
          "skip_external_publish",
        ]),
        reason_codes: z.array(z.string().min(1)).min(1),
        stale_at: zIsoDatetime.nullable(),
      })
      .strict(),
  })
  .strict();

export type SynthesisInputV1 = z.infer<typeof synthesisInputV1Schema>;
export type SynthesisOutputV1 = z.infer<typeof synthesisOutputV1Schema>;

export const SYNTHESIS_OUTPUT_V1_JSON_SCHEMA = z.toJSONSchema(
  synthesisOutputV1Schema,
);

export const SYNTHESIS_INPUT_V1_JSON_SCHEMA = z.toJSONSchema(
  synthesisInputV1Schema,
);

export function buildSynthesisSystemPromptV1(): string {
  return [
    "You are a prediction-market synthesis engine.",
    "Write for end users of Hunch, not for internal operators.",
    "Return exactly one JSON object and nothing else.",
    "Do not output markdown, code fences, or prose before/after JSON.",
    "Use only facts from the provided input payload.",
    "Do not invent prices, timestamps, events, or evidence.",
    "Internal event/market telemetry is primary; external evidence is secondary.",
    "If policy thresholds are not met, return status=INSUFFICIENT_EVIDENCE.",
    "If freshness thresholds fail, return status=STALE.",
    "Style requirements for summary_short and summary_long:",
    "- Plain, user-facing language with clear market context.",
    "- Do NOT mention internal field names, policy names, or source labels (e.g. tier-A, link_confidence, supports_topic_count, fallback_source).",
    "- Do NOT mention evidence_id labels like e1/e2 in summary text.",
    "- Mention stale data in plain words (e.g. 'prices have not updated recently') instead of internal telemetry terminology.",
    "- Keep summary_short concise and readable in one glance.",
    "Output MUST validate against this JSON Schema:",
    JSON.stringify(SYNTHESIS_OUTPUT_V1_JSON_SCHEMA, null, 2),
  ].join("\n");
}

export function buildSynthesisUserPromptV1(input: SynthesisInputV1): string {
  return [
    "Generate synthesis_output_v1 for the payload below.",
    "Requirements:",
    "- Enforce policy thresholds and freshness checks.",
    "- Use evidence_refs to cite evidence_id values from external_evidence.items.",
    "- If market pricing is already extreme (policy.extreme_price_low/high), prefer context-only recommendation.",
    "- Treat fallback metric sources conservatively: if *_source indicates volume_total_fallback or open_interest_fallback, do not describe it as confirmed short-term trading flow.",
    "- Keep summaries user-facing and avoid internal implementation vocabulary.",
    "Input payload:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

export function parseSynthesisInputV1(payload: unknown): SynthesisInputV1 {
  return synthesisInputV1Schema.parse(payload);
}

export function parseSynthesisOutputV1(payload: unknown): SynthesisOutputV1 {
  return synthesisOutputV1Schema.parse(payload);
}
