export const FUNDING_ACTION_FAILURE_CODES = [
  "client_execution_failed",
  "external_handoff_provider_rejected",
  "external_handoff_provider_response_invalid",
  "external_handoff_submission_unknown",
] as const;

export type FundingActionFailureCode =
  (typeof FUNDING_ACTION_FAILURE_CODES)[number];

const fundingActionFailureCodeSet = new Set<string>(
  FUNDING_ACTION_FAILURE_CODES,
);

export function isFundingActionFailureCode(
  value: unknown,
): value is FundingActionFailureCode {
  return typeof value === "string" && fundingActionFailureCodeSet.has(value);
}

export function isExternalHandoffFailureCode(
  value: FundingActionFailureCode | null,
): boolean {
  return value?.startsWith("external_handoff_") ?? false;
}

export function isUnreferencedFundingActionAmbiguity(input: {
  failureCode: FundingActionFailureCode | null;
  outcome: "submitted" | "ambiguous" | "failed" | "cancelled";
  transactionReference: string | null;
}): boolean {
  return (
    input.outcome === "ambiguous" &&
    input.transactionReference === null &&
    (input.failureCode === "external_handoff_submission_unknown" ||
      input.failureCode === "external_handoff_provider_response_invalid")
  );
}

/**
 * The server derives the irreversible-boundary meaning from this pair rather
 * than trusting an arbitrary client outcome for a known diagnostic code.
 */
export function isFundingActionFailureReportConsistent(input: {
  failureCode: FundingActionFailureCode | null;
  outcome: "submitted" | "ambiguous" | "failed" | "cancelled";
  transactionReference: string | null;
}): boolean {
  if (input.failureCode === null) return true;
  if (input.transactionReference !== null) return false;
  if (
    input.failureCode === "external_handoff_submission_unknown" ||
    input.failureCode === "external_handoff_provider_response_invalid"
  ) {
    return input.outcome === "ambiguous";
  }
  return input.outcome === "failed";
}
