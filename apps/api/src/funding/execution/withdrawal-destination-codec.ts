import {
  createProtectedValueCodec,
  type ProtectedValueCodec,
} from "./protected-value-codec.js";

const WITHDRAWAL_DESTINATION_DOMAIN =
  "hunch:funding:withdrawal-destination:v1:";

export type WithdrawalDestinationCodec = ProtectedValueCodec;

export function createWithdrawalDestinationCodec(
  input: Readonly<{
    encryptionKey: Buffer;
    lookupHmacKey: string;
    keyVersion: number;
  }>,
): WithdrawalDestinationCodec {
  return createProtectedValueCodec({
    ...input,
    domain: WITHDRAWAL_DESTINATION_DOMAIN,
    safeLabel: "withdrawal destination",
    minimumLength: 16,
    maximumLength: 256,
  });
}
