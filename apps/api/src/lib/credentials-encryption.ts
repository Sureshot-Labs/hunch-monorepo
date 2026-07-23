import crypto from "node:crypto";

export function decodeCredentialsEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed.length) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is empty");
  }

  const asBase64 = Buffer.from(trimmed, "base64");
  if (asBase64.length === 32) return asBase64;

  const isHex = /^[a-fA-F0-9]+$/.test(trimmed);
  if (isHex && trimmed.length === 64) {
    const asHex = Buffer.from(trimmed, "hex");
    if (asHex.length === 32) return asHex;
  }

  throw new Error(
    "CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex)",
  );
}

export function getCredentialsEncryptionKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Missing CREDENTIALS_ENCRYPTION_KEY env var");
  }
  return decodeCredentialsEncryptionKey(raw);
}

export function encryptCredentialsString(
  plaintext: string,
  key: Buffer,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptCredentialsString(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64, ...rest] = payload.split(":");
  if (rest.length || version !== "v1") {
    throw new Error("Unsupported encrypted payload format");
  }

  const iv = Buffer.from(ivB64 ?? "", "base64url");
  const tag = Buffer.from(tagB64 ?? "", "base64url");
  const ciphertext = Buffer.from(dataB64 ?? "", "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
