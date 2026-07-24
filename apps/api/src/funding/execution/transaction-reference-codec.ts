import {
  createProtectedValueCodec,
  type ProtectedValueCodec,
} from "./protected-value-codec.js";

const FUNDING_TRANSACTION_REFERENCE_DOMAIN =
  "hunch:funding:transaction-reference:v1:";

export type FundingTransactionReferenceCodec = ProtectedValueCodec;

export function createFundingTransactionReferenceCodec(
  input: Readonly<{
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
  }>,
): FundingTransactionReferenceCodec {
  return createProtectedValueCodec({
    ...input,
    domain: FUNDING_TRANSACTION_REFERENCE_DOMAIN,
    safeLabel: "funding transaction reference",
    minimumLength: 32,
    maximumLength: 256,
  });
}
