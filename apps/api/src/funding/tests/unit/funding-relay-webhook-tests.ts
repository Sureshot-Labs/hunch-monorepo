#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { Pool } from "@hunch/infra";
import Fastify from "fastify";

import {
  registerRelayWebhookRoute,
  relayWebhookConfigFromEnv,
} from "../../../routes/funding-relay-webhook.js";

const apiKey = "relay-webhook-route-secret";
const lookupKey = "relay-webhook-lookup-key".repeat(2);
const requestId = "relay-webhook-route-request-001";

function signedPayload(status = "success") {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    event: "request.status.updated",
    timestamp,
    data: { status, requestId },
  });
  const signature = crypto
    .createHmac("sha256", apiKey)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return { payload, signature, timestamp };
}

{
  assert.equal(relayWebhookConfigFromEnv({}), null);
  assert.equal(relayWebhookConfigFromEnv({ RELAY_API_KEY: apiKey }), null);
  assert.equal(
    relayWebhookConfigFromEnv({
      RELAY_API_KEY: apiKey,
      FUNDING_REFERENCE_LOOKUP_HMAC_KEY: lookupKey,
      FUNDING_REFERENCE_LOOKUP_KEY_VERSION: "invalid",
    }),
    null,
  );
  assert.deepEqual(
    relayWebhookConfigFromEnv({
      RELAY_API_KEY: apiKey,
      FUNDING_REFERENCE_LOOKUP_HMAC_KEY: lookupKey,
      FUNDING_REFERENCE_LOOKUP_KEY_VERSION: "7",
    }),
    {
      apiKey,
      referenceLookupHmacKey: lookupKey,
      referenceKeyVersion: 7,
    },
  );
}

{
  const app = Fastify();
  let ingested = 0;
  await registerRelayWebhookRoute(app, {
    db: {} as Pool,
    config: {
      apiKey,
      referenceLookupHmacKey: lookupKey,
      referenceKeyVersion: 1,
    },
    resolveWebhookGate: async () => true,
    ingest: async (_db, input) => {
      ingested += 1;
      assert.equal(input.webhook.payload.data.requestId, requestId);
      assert.equal(input.referenceCodec.keyVersion, 1);
      assert.match(
        input.referenceCodec.fingerprint(requestId),
        /^[0-9a-f]{64}$/u,
      );
      return { replayed: false, stale: false, operationId: "operation-1" };
    },
  });
  const signed = signedPayload();
  const accepted = await app.inject({
    method: "POST",
    url: "/webhooks/relay",
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": String(signed.timestamp),
      "x-signature-sha256": signed.signature,
    },
    payload: signed.payload,
  });
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), { accepted: true, replayed: false });
  assert.equal(ingested, 1);

  const tampered = await app.inject({
    method: "POST",
    url: "/webhooks/relay",
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": String(signed.timestamp),
      "x-signature-sha256": signed.signature,
    },
    payload: signed.payload.replace("success", "failure"),
  });
  assert.equal(tampered.statusCode, 401);
  assert.equal(ingested, 1);
  await app.close();
}

{
  const app = Fastify();
  await registerRelayWebhookRoute(app, {
    db: {} as Pool,
    config: null,
    resolveWebhookGate: async () => true,
  });
  const signed = signedPayload();
  const result = await app.inject({
    method: "POST",
    url: "/webhooks/relay",
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": String(signed.timestamp),
      "x-signature-sha256": signed.signature,
    },
    payload: signed.payload,
  });
  assert.equal(result.statusCode, 503);
  await app.close();
}

{
  const app = Fastify();
  await registerRelayWebhookRoute(app, {
    db: {} as Pool,
    config: {
      apiKey,
      referenceLookupHmacKey: lookupKey,
      referenceKeyVersion: 1,
    },
    resolveWebhookGate: async () => false,
  });
  const signed = signedPayload();
  const result = await app.inject({
    method: "POST",
    url: "/webhooks/relay",
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": String(signed.timestamp),
      "x-signature-sha256": signed.signature,
    },
    payload: signed.payload,
  });
  assert.equal(result.statusCode, 503);
  await app.close();
}

console.log(
  "[funding-relay-webhook-tests] raw-body HMAC, gate, config, and rejection paths ok",
);
