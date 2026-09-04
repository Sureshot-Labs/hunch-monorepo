const PRIVY_TRANSACTION_REFERENCE_PREFIX = "privy-transaction-v1:";
const PRIVY_USER_OPERATION_REFERENCE_PREFIX = "privy-user-operation-v1:";
const PRIVY_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/u;
const EVM_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

export type PrivyFundingTransactionReference =
  | Readonly<{ kind: "transaction_id"; value: string }>
  | Readonly<{ kind: "user_operation"; value: string }>;

export function encodePrivyTransactionIdReference(
  transactionId: string,
): string {
  const normalized = transactionId.trim();
  if (!PRIVY_TRANSACTION_ID_PATTERN.test(normalized)) {
    throw new Error("Privy transaction id is invalid");
  }
  return `${PRIVY_TRANSACTION_REFERENCE_PREFIX}${normalized}`;
}

export function encodePrivyUserOperationReference(
  userOperationHash: string,
): string {
  const normalized = userOperationHash.trim().toLowerCase();
  if (!EVM_HASH_PATTERN.test(normalized)) {
    throw new Error("Privy user operation hash is invalid");
  }
  return `${PRIVY_USER_OPERATION_REFERENCE_PREFIX}${normalized}`;
}

export function parsePrivyFundingTransactionReference(
  reference: string,
): PrivyFundingTransactionReference | null {
  const normalized = reference.trim();
  if (normalized.startsWith(PRIVY_TRANSACTION_REFERENCE_PREFIX)) {
    const value = normalized.slice(PRIVY_TRANSACTION_REFERENCE_PREFIX.length);
    return PRIVY_TRANSACTION_ID_PATTERN.test(value)
      ? { kind: "transaction_id", value }
      : null;
  }
  if (normalized.startsWith(PRIVY_USER_OPERATION_REFERENCE_PREFIX)) {
    const value = normalized
      .slice(PRIVY_USER_OPERATION_REFERENCE_PREFIX.length)
      .toLowerCase();
    return EVM_HASH_PATTERN.test(value)
      ? { kind: "user_operation", value }
      : null;
  }
  return null;
}
