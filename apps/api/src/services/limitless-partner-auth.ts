import { createHmac } from "node:crypto";

export function buildLimitlessPartnerHmacHeaders(
  input: Readonly<{
    bodyString?: string;
    hmacSecret: string;
    hmacTokenId: string;
    method: "GET" | "POST" | "DELETE";
    requestPath: string;
    timestamp?: string;
  }>,
): Record<string, string> {
  if (!input.hmacTokenId.trim() || !input.hmacSecret.trim()) {
    throw new Error("Limitless partner HMAC is not configured.");
  }
  const timestamp = input.timestamp ?? new Date().toISOString();
  const canonical = `${timestamp}\n${input.method}\n${input.requestPath}\n${input.bodyString ?? ""}`;
  const signature = createHmac(
    "sha256",
    Buffer.from(input.hmacSecret, "base64"),
  )
    .update(canonical)
    .digest("base64");
  return {
    "lmts-api-key": input.hmacTokenId,
    "lmts-signature": signature,
    "lmts-timestamp": timestamp,
  };
}
