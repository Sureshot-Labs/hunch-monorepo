import { env } from "../env.js";

export type PolymarketCredentialExchangeResult = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
};

function readCredentialField(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export async function requestPolymarketCredentials(inputs: {
  walletAddress: string;
  signature: string;
  timestamp: string;
  nonce: number;
}): Promise<PolymarketCredentialExchangeResult> {
  const upstream = await fetch(`${env.polymarketClobBase}/auth/api-key`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
      "user-agent": "Hunch-API/1.0",
      POLY_ADDRESS: inputs.walletAddress,
      POLY_SIGNATURE: inputs.signature,
      POLY_TIMESTAMP: inputs.timestamp,
      POLY_NONCE: inputs.nonce.toString(),
    },
    body: JSON.stringify({}),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const message = text.trim().length
      ? text
      : `${upstream.status} ${upstream.statusText}`;
    const error = new Error(message);
    (error as Error & { status?: number }).status = upstream.status;
    throw error;
  }

  const payload = (await upstream.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Unexpected response from Polymarket");
  }

  const record = payload as Record<string, unknown>;
  const apiKey = readCredentialField(record, [
    "apiKey",
    "api_key",
    "key",
    "apiKeyId",
    "api_key_id",
  ]);
  const apiSecret = readCredentialField(record, [
    "secret",
    "apiSecret",
    "api_secret",
  ]);
  const passphrase = readCredentialField(record, [
    "passphrase",
    "apiPassphrase",
  ]);

  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error("Polymarket did not return apiKey/secret/passphrase");
  }

  return { apiKey, apiSecret, passphrase };
}
