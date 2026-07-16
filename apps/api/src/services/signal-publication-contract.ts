export const HOLDER_RESEARCH_PUBLICATION_DECISION_V1 = {
  authority: "holder_research_quality_gate",
  status: "PUBLISH",
  version: 1,
} as const;

export type HolderResearchPublicationDecisionV1 =
  typeof HOLDER_RESEARCH_PUBLICATION_DECISION_V1;

export const HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON =
  JSON.stringify({
    publicationDecisionV1: HOLDER_RESEARCH_PUBLICATION_DECISION_V1,
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function hasHolderResearchPublicationDecisionV1(
  metrics: unknown,
): boolean {
  const decision = asRecord(asRecord(metrics)?.publicationDecisionV1);
  return (
    decision?.version === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.version &&
    decision.status === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.status &&
    decision.authority === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.authority
  );
}
