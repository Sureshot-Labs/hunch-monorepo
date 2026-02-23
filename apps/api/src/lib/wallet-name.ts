export const MAX_WALLET_NAME_LENGTH = 20;

export function normalizeWalletNameInput(input: string | null): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_WALLET_NAME_LENGTH) {
    throw new Error(
      `Wallet name is too long (max ${MAX_WALLET_NAME_LENGTH})`,
    );
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 31 || code === 127) {
      throw new Error("Wallet name contains invalid characters");
    }
  }
  return trimmed;
}
