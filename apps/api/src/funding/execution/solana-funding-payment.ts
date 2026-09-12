/** Server-derived only. Never accept this capability from request JSON. */
export type SolanaFundingPaymentBinding = Readonly<{
  operationId: string;
  stepId: string;
  attemptNumber: number;
  actionFingerprint: string;
  payer: "user" | "privy_sponsor";
}>;

export type VerifiedSolanaFundingPayment = Readonly<{
  binding: SolanaFundingPaymentBinding;
  signer: string;
  transaction: string;
  requiredSignerLamports: bigint;
}>;

export class SolanaFundingPaymentError extends Error {
  constructor(
    readonly code:
      | "funding_payment_unavailable"
      | "funding_payer_changed"
      | "funding_payment_mismatch"
      | "funding_sponsor_limit_reached",
    message: string,
  ) {
    super(message);
    this.name = "SolanaFundingPaymentError";
  }
}

export function assertSolanaFundingPaymentBinding(
  expected: SolanaFundingPaymentBinding,
  actual: SolanaFundingPaymentBinding,
): void {
  if (
    expected.operationId !== actual.operationId ||
    expected.stepId !== actual.stepId ||
    expected.attemptNumber !== actual.attemptNumber ||
    expected.actionFingerprint !== actual.actionFingerprint ||
    expected.payer !== actual.payer
  )
    throw new SolanaFundingPaymentError(
      "funding_payment_mismatch",
      "The prepared funding payment no longer matches its current attempt.",
    );
}
