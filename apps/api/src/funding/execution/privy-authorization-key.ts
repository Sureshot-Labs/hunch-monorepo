import crypto from "node:crypto";

export function normalizePrivyAuthorizationPublicKey(
  publicKey: string,
): string {
  const trimmed = publicKey.trim().replace(/^wallet-auth:/, "");
  if (!trimmed) return "";
  try {
    const key = trimmed.includes("BEGIN PUBLIC KEY")
      ? crypto.createPublicKey(trimmed)
      : crypto.createPublicKey({
          format: "der",
          key: Buffer.from(trimmed, "base64"),
          type: "spki",
        });
    return key.export({ format: "der", type: "spki" }).toString("base64");
  } catch {
    return trimmed;
  }
}

export function derivePrivyAuthorizationPublicKey(
  authorizationPrivateKey: string,
): string {
  const encoded = authorizationPrivateKey.trim().replace(/^wallet-auth:/, "");
  if (!encoded) throw new Error("Privy authorization private key is empty.");
  const privateKey = crypto.createPrivateKey({
    format: "der",
    key: Buffer.from(encoded, "base64"),
    type: "pkcs8",
  });
  return crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
}

export function privyAuthorizationPrivateKeyIsValid(value: string): boolean {
  try {
    derivePrivyAuthorizationPublicKey(value);
    return true;
  } catch {
    return false;
  }
}
