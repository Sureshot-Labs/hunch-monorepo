export function isWithdrawalPurpose(purpose: string): boolean {
  return purpose === "withdrawal";
}

export function operationPurposeForExternalRecipient(
  externalRecipientId: string | null,
): "add_funds" | "withdrawal" {
  return externalRecipientId ? "withdrawal" : "add_funds";
}

export function withdrawalBindingMatches(
  purpose: string,
  externalRecipientId: string | null,
): boolean {
  return isWithdrawalPurpose(purpose) === Boolean(externalRecipientId);
}
