const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isEvmAddress(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value.trim());
}

export function normalizeWalletForStorage(value: string): string {
  const trimmed = value.trim();
  return isEvmAddress(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function normalizeOptionalWalletForStorage(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const normalized = normalizeWalletForStorage(value);
  return normalized.length ? normalized : null;
}
