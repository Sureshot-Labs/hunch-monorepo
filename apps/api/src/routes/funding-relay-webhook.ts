import { Readable } from "node:stream";

import type { Pool } from "@hunch/infra";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { pool } from "../db.js";
import { relayReferenceFingerprint } from "../funding-providers/relay/reference-codec.js";
import { ingestVerifiedRelayWebhook } from "../funding-providers/relay/reconciliation.js";
import { verifyRelayWebhook } from "../funding-providers/relay/webhook.js";
import { resolveFundingPolicy } from "../funding/policies/funding-policy-service.js";

const MAX_RELAY_WEBHOOK_BYTES = 1 * 1024 * 1024;

type RelayWebhookRouteConfig = Readonly<{
  apiKey: string;
  referenceLookupHmacKey: string;
  referenceKeyVersion: number;
}>;

type RelayWebhookDependencies = Readonly<{
  db: Pool;
  config: RelayWebhookRouteConfig | null;
  resolveWebhookGate?: () => Promise<boolean>;
  ingest?: typeof ingestVerifiedRelayWebhook;
}>;

function optionalPositiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function relayWebhookConfigFromEnv(
  env: NodeJS.ProcessEnv,
): RelayWebhookRouteConfig | null {
  const apiKey = env.RELAY_API_KEY?.trim();
  const referenceLookupHmacKey = env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
  const rawVersion = env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION;
  const referenceKeyVersion = rawVersion ? optionalPositiveInt(rawVersion) : 1;
  if (!apiKey || !referenceLookupHmacKey || !referenceKeyVersion) return null;
  return {
    apiKey,
    referenceLookupHmacKey,
    referenceKeyVersion,
  };
}

function webhookHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const one = (name: string): string | undefined => {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    "X-Signature-Timestamp": one("x-signature-timestamp"),
    "X-Signature-SHA256": one("x-signature-sha256"),
  };
}

export async function registerRelayWebhookRoute(
  app: FastifyInstance,
  dependencies: RelayWebhookDependencies,
): Promise<void> {
  const rawBodies = new WeakMap<object, Buffer>();
  app.addHook("preParsing", async (request, reply, payload) => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_RELAY_WEBHOOK_BYTES) {
        reply.code(413);
        throw new Error("Relay webhook body exceeds size limit");
      }
      chunks.push(bytes);
    }
    const rawBody = Buffer.concat(chunks);
    rawBodies.set(request, rawBody);
    return Readable.from(rawBody);
  });

  app.post("/webhooks/relay", async (request, reply) => {
    const config = dependencies.config;
    if (!config) {
      reply.code(503);
      return reply.send({ error: "Relay webhook is not configured" });
    }
    const gateOpen = dependencies.resolveWebhookGate
      ? await dependencies.resolveWebhookGate()
      : (await resolveFundingPolicy(dependencies.db)).policy.gates
          .webhookIngestion;
    if (!gateOpen) {
      reply.code(503);
      return reply.send({ error: "Funding webhook ingestion is disabled" });
    }
    const rawBody = rawBodies.get(request);
    if (!rawBody) {
      reply.code(400);
      return reply.send({ error: "Relay webhook raw body is unavailable" });
    }
    try {
      const webhook = verifyRelayWebhook({
        rawBody,
        headers: webhookHeaders(request.headers),
        apiKey: config.apiKey,
      });
      const codec = {
        keyVersion: config.referenceKeyVersion,
        fingerprint: (requestId: string) =>
          relayReferenceFingerprint(requestId, config.referenceLookupHmacKey),
      };
      const result = await (dependencies.ingest ?? ingestVerifiedRelayWebhook)(
        dependencies.db,
        { webhook, referenceCodec: codec },
      );
      reply.code(202);
      return reply.send({
        accepted: true,
        replayed: result.replayed,
      });
    } catch (error) {
      request.log.warn(
        {
          errorCode:
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "relay_webhook_rejected",
        },
        "Relay webhook rejected",
      );
      reply.code(401);
      return reply.send({ error: "Invalid Relay webhook" });
    }
  });
}

export const fundingRelayWebhookRoutes: FastifyPluginAsync = async (app) => {
  await registerRelayWebhookRoute(app, {
    db: pool,
    config: relayWebhookConfigFromEnv(process.env),
  });
};
