import type {
  HolderResearchPersistDecision,
  HolderResearchPersistStats,
} from "./holder-research.js";

/** A content-duplicate is a completed check; transport/price failures aren't. */
export function holderResearchCacheOutputAfterPersistence(
  decision: Pick<HolderResearchPersistDecision, "output">,
  outcome: HolderResearchPersistStats["outcomesByKey"][string] | undefined,
): Pick<HolderResearchPersistDecision["output"], "status" | "rationale"> {
  if (
    decision.output.status === "PUBLISH" &&
    outcome?.status === "rejected" &&
    [
      "no_meaningful_delta",
      "duplicate_delta",
      "unsupported_update_reason",
    ].includes(outcome.reason ?? "")
  ) {
    return {
      status: "CONTEXT",
      rationale: `Publication update check: ${outcome.reason}; no new publishable update was saved. Model recommendation remains PUBLISH.`,
    };
  }
  return decision.output;
}

/** Publication capacity belongs to committed notes, never model intentions. */
export function createHolderResearchPublicationProgress(input: {
  maxPublishPerRun: number;
  persist:
    | ((
        decision: HolderResearchPersistDecision,
      ) => Promise<HolderResearchPersistStats>)
    | null;
}) {
  const stats: HolderResearchPersistStats | null = input.persist
    ? {
        considered: 0,
        persisted: 0,
        rejected: 0,
        rejectedByReason: {},
        skippedExisting: 0,
        superseded: 0,
        errors: 0,
        outcomesByKey: {},
      }
    : null;
  const publishedDecisions: HolderResearchPersistDecision[] = [];
  let uncertainCommit = false;
  return {
    stats,
    publishedDecisions,
    get stopped() {
      return (
        uncertainCommit ||
        (stats != null && stats.persisted >= input.maxPublishPerRun)
      );
    },
    async record(decision: HolderResearchPersistDecision) {
      if (!stats || !input.persist) return;
      stats.considered += 1;
      if (decision.output.status !== "PUBLISH") return;
      if (this.stopped) return;
      const result = await input.persist(decision);
      for (const key of [
        "persisted",
        "rejected",
        "skippedExisting",
        "superseded",
        "errors",
      ] as const) {
        stats[key] += result[key];
      }
      for (const [reason, count] of Object.entries(result.rejectedByReason)) {
        const key =
          reason as keyof HolderResearchPersistStats["rejectedByReason"];
        stats.rejectedByReason[key] =
          (stats.rejectedByReason[key] ?? 0) + (count ?? 0);
      }
      Object.assign(stats.outcomesByKey, result.outcomesByKey);
      const outcome = result.outcomesByKey[decision.candidate.key];
      if (outcome?.status === "persisted") publishedDecisions.push(decision);
      // A lost COMMIT acknowledgement may already have created a note. Stop
      // this run; the next scheduled run reconciles through the thesis baseline.
      uncertainCommit ||= outcome?.reason === "commit_outcome_unknown";
    },
  };
}
