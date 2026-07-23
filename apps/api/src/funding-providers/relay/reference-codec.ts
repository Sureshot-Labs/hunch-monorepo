import {
  decryptCredentialsString,
  encryptCredentialsString,
} from "../../lib/credentials-encryption.js";
import { lookupHmac } from "../../funding/persistence/canonical.js";

const RELAY_REFERENCE_DOMAIN = "hunch:funding:relay-request:v1:";
const RELAY_DEPOSIT_ADDRESS_DOMAIN = "hunch:funding:relay-deposit-address:v1:";

type EncryptedLookupCodec = Readonly<{
  keyVersion: number;
  encrypt(value: string): string;
  decrypt(ciphertext: string): string;
  fingerprint(value: string): string;
}>;

export type RelayReferenceCodec = EncryptedLookupCodec;
export type RelayDepositAddressCodec = EncryptedLookupCodec;

export function relayReferenceFingerprint(
  requestId: string,
  lookupHmacKey: string,
): string {
  const normalized = requestId.trim();
  if (normalized.length < 8 || normalized.length > 512) {
    throw new Error("Relay request ID length is outside policy");
  }
  return lookupHmac(`${RELAY_REFERENCE_DOMAIN}${normalized}`, lookupHmacKey);
}

function createCodec(
  input: Readonly<{
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
    domain: string;
    label: string;
    minimumLength: number;
  }>,
): EncryptedLookupCodec {
  if (input.encryptionKey.byteLength !== 32) {
    throw new Error(
      `Relay ${input.label} encryption key must contain 32 bytes`,
    );
  }
  if (!Number.isInteger(input.keyVersion) || input.keyVersion <= 0) {
    throw new Error(`Relay ${input.label} key version must be positive`);
  }
  const normalize = (raw: string): string => {
    const value = raw.trim();
    if (value.length < input.minimumLength || value.length > 512) {
      throw new Error(`Relay ${input.label} length is outside policy`);
    }
    return value;
  };
  return {
    keyVersion: input.keyVersion,
    encrypt(value) {
      return encryptCredentialsString(
        `${input.domain}${normalize(value)}`,
        input.encryptionKey,
      );
    },
    decrypt(ciphertext) {
      const plaintext = decryptCredentialsString(
        ciphertext,
        input.encryptionKey,
      );
      if (!plaintext.startsWith(input.domain)) {
        throw new Error(`Relay ${input.label} encryption domain mismatch`);
      }
      return normalize(plaintext.slice(input.domain.length));
    },
    fingerprint(value) {
      return input.domain === RELAY_REFERENCE_DOMAIN
        ? relayReferenceFingerprint(normalize(value), input.lookupHmacKey)
        : lookupHmac(`${input.domain}${normalize(value)}`, input.lookupHmacKey);
    },
  };
}

export function createRelayReferenceCodec(
  input: Readonly<{
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
  }>,
): RelayReferenceCodec {
  return createCodec({
    ...input,
    domain: RELAY_REFERENCE_DOMAIN,
    label: "request ID",
    minimumLength: 8,
  });
}

export function createRelayDepositAddressCodec(
  input: Readonly<{
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
  }>,
): RelayDepositAddressCodec {
  return createCodec({
    ...input,
    domain: RELAY_DEPOSIT_ADDRESS_DOMAIN,
    label: "deposit address",
    minimumLength: 16,
  });
}
