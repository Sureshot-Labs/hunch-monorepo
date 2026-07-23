import crypto from "node:crypto";

import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import {
  relayWebhookPayloadSchema,
  type RelayWebhookPayload,
} from "./schemas.js";

export type VerifiedRelayWebhook = Readonly<{
  payload: RelayWebhookPayload;
  deliveryFingerprint: string;
  receivedAt: Date;
}>;

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return entry?.[1];
}

function decodeSignature(value: string): Buffer {
  const normalized = value.startsWith("sha256=")
    ? value.slice("sha256=".length)
    : value;
  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    throw new Error("Relay webhook signature format is invalid");
  }
  return Buffer.from(normalized, "hex");
}

export function verifyRelayWebhook(
  input: Readonly<{
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    apiKey: string;
    now?: Date;
    replayWindowMs?: number;
  }>,
): VerifiedRelayWebhook {
  if (!input.apiKey) throw new Error("Relay webhook API key is missing");
  const timestampHeader = header(input.headers, "X-Signature-Timestamp");
  const signatureHeader = header(input.headers, "X-Signature-SHA256");
  if (!timestampHeader || !/^\d+$/u.test(timestampHeader)) {
    throw new Error("Relay webhook timestamp is missing or invalid");
  }
  if (!signatureHeader) throw new Error("Relay webhook signature is missing");
  const timestamp = Number(timestampHeader);
  const now = input.now ?? new Date();
  const replayWindowMs = input.replayWindowMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs <= 0) {
    throw new Error("Relay webhook replay window is invalid");
  }
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now.getTime() - timestamp) > replayWindowMs
  ) {
    throw new Error("Relay webhook timestamp is outside replay window");
  }
  const expected = crypto
    .createHmac("sha256", input.apiKey)
    .update(timestampHeader)
    .update(".")
    .update(input.rawBody)
    .digest();
  const actual = decodeSignature(signatureHeader);
  if (
    actual.byteLength !== expected.byteLength ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw new Error("Relay webhook signature mismatch");
  }
  const parsed = relayWebhookPayloadSchema.safeParse(
    JSON.parse(input.rawBody.toString("utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new Error("Relay webhook payload failed the pinned schema");
  }
  const payload = parsed.data;
  if (payload.timestamp !== timestamp) {
    throw new Error("Relay webhook body and header timestamps differ");
  }
  return {
    payload,
    deliveryFingerprint: canonicalJsonHash({
      timestamp: timestampHeader,
      signature: signatureHeader.toLowerCase(),
    }),
    receivedAt: now,
  };
}
