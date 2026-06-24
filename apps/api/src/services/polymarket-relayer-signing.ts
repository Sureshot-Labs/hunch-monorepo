import {
  BuilderSigner,
  type BuilderHeaderPayload,
} from "@polymarket/builder-signing-sdk";

export type PolymarketRelayerCredentials = {
  key: string;
  secret: string;
  passphrase: string;
};

export type PolymarketRelayerSignInput = PolymarketRelayerCredentials & {
  method: string;
  path: string;
  body?: unknown;
  timestamp?: number;
};

export function normalizePolymarketRelayerBody(body: unknown): string {
  return typeof body === "string"
    ? body
    : body == null
      ? ""
      : JSON.stringify(body);
}

export function createPolymarketRelayerHeaderPayload(
  input: PolymarketRelayerSignInput,
): BuilderHeaderPayload {
  const signer = new BuilderSigner({
    key: input.key,
    secret: input.secret,
    passphrase: input.passphrase,
  });
  return signer.createBuilderHeaderPayload(
    input.method,
    input.path,
    normalizePolymarketRelayerBody(input.body),
    input.timestamp,
  );
}
