export const FUNDING_ACTION_FAILURE_CODES = [
  "client_execution_failed",
  "solana_signing_failed",
  "solana_signed_transaction_invalid",
  "embedded_evm_submission_unknown",
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

type FundingActionReport = Readonly<{
  failureCode: FundingActionFailureCode | null;
  outcome: "submitted" | "ambiguous" | "failed" | "cancelled";
  transactionReference: string | null;
}>;

/** A generic client catch is not evidence that a started action never sent. */
export function normalizeFundingActionReport(
  input: FundingActionReport,
): FundingActionReport {
  return input.failureCode === "client_execution_failed" &&
    input.outcome === "failed"
    ? { ...input, outcome: "ambiguous" }
    : input;
}

function hasUnknownSubmission(code: FundingActionFailureCode | null): boolean {
  return (
    code === "client_execution_failed" ||
    code === "embedded_evm_submission_unknown" ||
    code === "external_handoff_submission_unknown" ||
    code === "external_handoff_provider_response_invalid"
  );
}

export function isUnreferencedFundingActionAmbiguity(
  input: FundingActionReport,
): boolean {
  return (
    input.outcome === "ambiguous" &&
    input.transactionReference === null &&
    hasUnknownSubmission(input.failureCode)
  );
}

/**
 * The server derives the irreversible-boundary meaning from this pair rather
 * than trusting an arbitrary client outcome for a known diagnostic code.
 */
export function isFundingActionFailureReportConsistent(
  input: FundingActionReport,
): boolean {
  if (input.failureCode === null) return true;
  if (input.transactionReference !== null) return false;
  if (hasUnknownSubmission(input.failureCode)) {
    return normalizeFundingActionReport(input).outcome === "ambiguous";
  }
  // Sign-only failures have not crossed the send boundary. A wallet rejection
  // may retain its cancellation outcome without losing the diagnostic stage.
  if (input.failureCode === "solana_signing_failed")
    return input.outcome === "failed" || input.outcome === "cancelled";
  return input.outcome === "failed";
}
