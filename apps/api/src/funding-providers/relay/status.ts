export type RelayStatusDecision = Readonly<{
  rawStatus: string;
  category:
    | "awaiting_source"
    | "in_progress"
    | "provider_success"
    | "provider_failure"
    | "refund_in_progress"
    | "unknown";
  terminalForFunding: false;
  requiredEvidence:
    | "none"
    | "owned_destination"
    | "owned_refund"
    | "failure_or_refund";
}>;

/**
 * A Relay status is never terminal for a Funding Operation. Success/refund are
 * provider hints until the shared observer has canonical owned-destination or
 * owned-refund evidence.
 */
export function classifyRelayStatus(rawStatus: string): RelayStatusDecision {
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === "waiting" || normalized === "depositing") {
    return {
      rawStatus,
      category: "awaiting_source",
      terminalForFunding: false,
      requiredEvidence: "none",
    };
  }
  if (normalized === "pending" || normalized === "submitted") {
    return {
      rawStatus,
      category: "in_progress",
      terminalForFunding: false,
      requiredEvidence: "none",
    };
  }
  if (normalized === "success") {
    return {
      rawStatus,
      category: "provider_success",
      terminalForFunding: false,
      requiredEvidence: "owned_destination",
    };
  }
  if (normalized === "failure") {
    return {
      rawStatus,
      category: "provider_failure",
      terminalForFunding: false,
      requiredEvidence: "failure_or_refund",
    };
  }
  if (normalized === "refund") {
    return {
      rawStatus,
      category: "refund_in_progress",
      terminalForFunding: false,
      requiredEvidence: "owned_refund",
    };
  }
  return {
    rawStatus,
    category: "unknown",
    terminalForFunding: false,
    requiredEvidence: "none",
  };
}
