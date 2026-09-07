/** Durable, authoritative no-execution evidence shared by projection/admission. */
export function fundingAttemptHasSafeRetryEvidence(
  input: Readonly<{
    retryableAfterReorg?: boolean;
    receipt: Readonly<{
      status: string;
      canonical: boolean;
      failureFinalized: boolean;
    }> | null;
  }>,
): boolean {
  return (
    (input.receipt?.status === "failed" &&
      input.receipt.canonical &&
      input.receipt.failureFinalized) ||
    (input.retryableAfterReorg === true &&
      input.receipt?.status === "reorged" &&
      !input.receipt.canonical)
  );
}
