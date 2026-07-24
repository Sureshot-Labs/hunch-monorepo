import {
  decryptCredentialsString,
  encryptCredentialsString,
} from "../../lib/credentials-encryption.js";
import { lookupHmac } from "../persistence/canonical.js";

export type ProtectedValueCodec = Readonly<{
  keyVersion: number;
  encrypt(value: string): string;
  decrypt(ciphertext: string): string;
  fingerprint(value: string): string;
}>;

export function createProtectedValueCodec(
  input: Readonly<{
    domain: string;
    safeLabel: string;
    minimumLength: number;
    maximumLength: number;
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
  }>,
): ProtectedValueCodec {
  if (
    !input.domain.endsWith(":") ||
    input.safeLabel.trim().length === 0 ||
    !Number.isInteger(input.minimumLength) ||
    !Number.isInteger(input.maximumLength) ||
    input.minimumLength <= 0 ||
    input.maximumLength < input.minimumLength
  ) {
    throw new Error("protected value codec policy is invalid");
  }
  if (input.encryptionKey.byteLength !== 32) {
    throw new Error(`${input.safeLabel} encryption key must contain 32 bytes`);
  }
  if (
    input.lookupHmacKey.trim().length < 32 ||
    !Number.isInteger(input.keyVersion) ||
    input.keyVersion <= 0
  ) {
    throw new Error(`${input.safeLabel} lookup key is invalid`);
  }

  const normalize = (raw: string): string => {
    const value = raw.trim();
    if (
      value.length < input.minimumLength ||
      value.length > input.maximumLength
    ) {
      throw new Error(`${input.safeLabel} length is outside policy`);
    }
    return value;
  };
  const domainValue = (value: string): string =>
    `${input.domain}${normalize(value)}`;

  return {
    keyVersion: input.keyVersion,
    encrypt(value) {
      return encryptCredentialsString(domainValue(value), input.encryptionKey);
    },
    decrypt(ciphertext) {
      const plaintext = decryptCredentialsString(
        ciphertext,
        input.encryptionKey,
      );
      if (!plaintext.startsWith(input.domain)) {
        throw new Error(`${input.safeLabel} encryption domain mismatch`);
      }
      return normalize(plaintext.slice(input.domain.length));
    },
    fingerprint(value) {
      return lookupHmac(domainValue(value), input.lookupHmacKey);
    },
  };
}
