#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../db.js";
import type {
  FundingCommitInput,
  FundingCommitPlan,
  FundingQuoteInsert,
} from "../../funding/persistence/funding-operation-repository.js";
import {
  commitFundingOperation,
  createFundingQuote,
} from "../../funding/persistence/funding-operation-repository.js";
import { reduceFundingOperation } from "../../funding/reconciliation/funding-reducer.js";
import { RelayClient } from "./client.js";
import { RELAY_ROUTE_SPECS } from "./mappings.js";
import {
  createRelayDepositAddressCodec,
  createRelayReferenceCodec,
} from "./reference-codec.js";
import {
  ingestVerifiedRelayWebhook,
  RelayReconciliationDriver,
} from "./reconciliation.js";
import { verifyRelayWebhook } from "./webhook.js";

const route = RELAY_ROUTE_SPECS["polygon-pol-to-base-eth"];
if (!route) throw new Error("Relay integration route missing");
const initialRequestId = `relay-initial-${crypto.randomUUID()}`;
const childRequestId = `relay-child-${crypto.randomUUID()}`;
const depositAddress = "0x6666666666666666666666666666666666666666";
const encryptionKey = Buffer.alloc(32, 11);
const codecConfig = {
  encryptionKey,
  lookupHmacKey: "relay-integration-lookup-key".repeat(2),
  keyVersion: 1,
};
const referenceCodec = createRelayReferenceCodec(codecConfig);
const depositCodec = createRelayDepositAddressCodec(codecConfig);

function opaque(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function hash(character: string): string {
  return character.repeat(64);
}

function buildPlan(): FundingCommitPlan {
  const sourceSnapshot = {
    componentId: opaque("relay-source-component"),
    locationId: opaque("relay-source-location"),
    networkId: route.source.networkId,
    assetId: route.source.assetId,
  };
  const destinationSnapshot = {
    componentId: opaque("relay-destination-component"),
    locationId: opaque("relay-destination-location"),
    preparation: "none",
    networkId: route.destination.networkId,
    assetId: route.destination.assetId,
  };
  return {
    operation: {
      purpose: "add_funds",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "prepare_first",
      planKind: "relay_deposit_address",
      sourceSnapshot,
      destinationTargetSnapshot: destinationSnapshot,
      externalRecipientId: null,
      venueId: null,
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: null,
      placementSnapshot: {},
      requestedSourceAmount: { asset: route.source, raw: "1000000" },
      requestedDestinationAmount: {
        asset: route.destination,
        raw: "900000",
      },
      supportMetadata: { test: "relay-wp4" },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: "relay_strict_deposit_address_v1",
        adapterVersion: 1,
        segmentKind: "deposit_address",
        status: "awaiting_source",
        sourceSnapshot,
        destinationTargetSnapshot: destinationSnapshot,
        quotedInput: { asset: route.source, raw: "1000000" },
        quotedExpectedOutput: {
          asset: route.destination,
          raw: "950000",
        },
        quotedMinOutput: { asset: route.destination, raw: "900000" },
        providerQuoteRefCiphertext: referenceCodec.encrypt(initialRequestId),
        providerQuoteRefLookupHmac:
          referenceCodec.fingerprint(initialRequestId),
        depositAddressCiphertext: depositCodec.encrypt(depositAddress),
        depositAddressLookupHmac: depositCodec.fingerprint(depositAddress),
        lookupKeyVersion: 1,
        refundLocationSnapshot: sourceSnapshot,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        supportMetadata: { depositAddressMode: "strict" },
      },
    ],
    steps: [],
    reservations: [],
  };
}

let userId: string | null = null;
let quoteId: string | null = null;
let operationId: string | null = null;

try {
  const userResult = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`relay-wp4-${crypto.randomUUID()}@example.com`],
  );
  userId = userResult.rows[0]?.id ?? null;
  assert.ok(userId);

  const plan = buildPlan();
  const consentToken = opaque("relay-consent");
  const quoteInput: FundingQuoteInsert = {
    userId,
    discoveryProjectionId: opaque("relay-projection"),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot ?? {},
    marketContextSnapshot: null,
    destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "relay-wp4-integration",
    canonicalRequest: {
      source: plan.operation.sourceSnapshot,
      destination: plan.operation.destinationTargetSnapshot,
      amount: plan.operation.requestedSourceAmount,
    },
    consentToken,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const quote = await createFundingQuote(pool, quoteInput);
  quoteId = quote.id;
  const commitInput: FundingCommitInput = {
    userId,
    quoteId,
    consentToken,
    idempotencyKey: opaque("relay-idempotency"),
    plan,
    subjectLookupHmac: hash("c"),
    subjectLookupKeyVersion: 1,
  };
  const committed = await commitFundingOperation(pool, commitInput);
  const committedOperationId = committed.operation.id;
  operationId = committedOperationId;
  const segmentResult = await pool.query<{ id: string }>(
    `
      select id
      from funding_operation_segments
      where operation_id = $1 and provider_id = 'relay'
    `,
    [operationId],
  );
  const segmentId = segmentResult.rows[0]?.id;
  assert.ok(segmentId);

  const client = new RelayClient({
    apiKey: "relay-integration-api-key",
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/requests/v2") {
        assert.equal(url.searchParams.get("includeChildRequests"), "true");
        return new Response(
          JSON.stringify({
            requests: [
              {
                id: initialRequestId,
                status: "pending",
                updatedAt: "2026-07-23T10:00:00.000Z",
              },
              {
                id: childRequestId,
                status: "refund",
                updatedAt: "2026-07-23T10:00:01.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      assert.equal(url.pathname, "/intents/status/v3");
      const requested = url.searchParams.get("requestId");
      return new Response(
        JSON.stringify({
          requestId: requested,
          status: requested === initialRequestId ? "success" : "refund",
          inTxHashes: ["origin-reference-not-persisted"],
          txHashes: ["destination-reference-not-persisted"],
          updatedAt: Date.parse("2026-07-23T10:00:02.000Z"),
        }),
        { status: 200 },
      );
    },
  });
  const driver = new RelayReconciliationDriver(
    client,
    referenceCodec,
    depositCodec,
  );
  const firstPoll = await driver.pollOperation(pool, operationId);
  assert.deepEqual(firstPoll, {
    requestsPolled: 2,
    childrenDiscovered: 1,
  });
  const secondPoll = await driver.pollOperation(pool, operationId);
  assert.equal(secondPoll.childrenDiscovered, 0);

  const requests = await pool.query<{
    request_kind: string;
    raw_status: string;
    support_metadata: Record<string, unknown>;
  }>(
    `
      select request_kind, raw_status, support_metadata
      from funding_provider_requests
      where segment_id = $1
      order by request_kind, first_seen_at
    `,
    [segmentId],
  );
  assert.equal(requests.rows.length, 2);
  assert.deepEqual(
    requests.rows.map(({ request_kind }) => request_kind).sort(),
    ["child", "initial"],
  );
  for (const request of requests.rows) {
    assert.equal(
      Object.hasOwn(
        request.support_metadata,
        "destinationTransactionReferences",
      ),
      false,
    );
    assert.equal(
      request.support_metadata.destinationTransactionReferenceCount,
      1,
    );
  }

  const reduction = await reduceFundingOperation(pool, { operationId });
  assert.deepEqual(reduction.finalState, {
    status: "in_progress",
    stage: "committed",
  });

  const webhookTimestamp = Date.now();
  const webhookBody = Buffer.from(
    JSON.stringify({
      event: "request.status.updated",
      timestamp: webhookTimestamp,
      data: {
        status: "success",
        requestId: childRequestId,
        updatedAt: webhookTimestamp,
      },
    }),
  );
  const apiKey = "relay-integration-api-key";
  const signature = crypto
    .createHmac("sha256", apiKey)
    .update(`${webhookTimestamp}.`)
    .update(webhookBody)
    .digest("hex");
  const webhook = verifyRelayWebhook({
    rawBody: webhookBody,
    headers: {
      "X-Signature-Timestamp": String(webhookTimestamp),
      "X-Signature-SHA256": signature,
    },
    apiKey,
    now: new Date(webhookTimestamp),
  });
  const firstWebhook = await ingestVerifiedRelayWebhook(pool, {
    webhook,
    referenceCodec,
  });
  const replayWebhook = await ingestVerifiedRelayWebhook(pool, {
    webhook,
    referenceCodec,
  });
  assert.equal(firstWebhook.replayed, false);
  assert.equal(replayWebhook.replayed, true);

  const staleTimestamp = webhookTimestamp + 1;
  const staleBody = Buffer.from(
    JSON.stringify({
      event: "request.status.updated",
      timestamp: staleTimestamp,
      data: {
        status: "failure",
        requestId: childRequestId,
        updatedAt: webhookTimestamp - 1,
      },
    }),
  );
  const staleSignature = crypto
    .createHmac("sha256", apiKey)
    .update(`${staleTimestamp}.`)
    .update(staleBody)
    .digest("hex");
  const staleWebhook = verifyRelayWebhook({
    rawBody: staleBody,
    headers: {
      "X-Signature-Timestamp": String(staleTimestamp),
      "X-Signature-SHA256": staleSignature,
    },
    apiKey,
    now: new Date(staleTimestamp),
  });
  const staleResult = await ingestVerifiedRelayWebhook(pool, {
    webhook: staleWebhook,
    referenceCodec,
  });
  assert.equal(staleResult.replayed, false);
  assert.equal(staleResult.stale, true);
  const afterStale = await pool.query<{
    raw_status: string;
    support_metadata: Record<string, unknown>;
  }>(
    `
      select raw_status, support_metadata
      from funding_provider_requests
      where segment_id = $1
        and request_ref_lookup_hmac = $2
    `,
    [segmentId, referenceCodec.fingerprint(childRequestId)],
  );
  assert.equal(afterStale.rows[0]?.raw_status, "success");
  assert.equal(
    (afterStale.rows[0]?.support_metadata.relayWebhookFingerprints as unknown[])
      ?.length,
    2,
  );

  const afterWebhook = await reduceFundingOperation(pool, { operationId });
  assert.deepEqual(afterWebhook.finalState, {
    status: "in_progress",
    stage: "committed",
  });
  console.log(
    "[relay-reconciliation-integration-tests] child discovery, encrypted correlation, replay/stale webhook suppression, and observation-only terminality ok",
  );
} finally {
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query("begin");
    if (operationId) {
      await cleanupClient.query(
        "delete from funding_reconciliation_jobs where operation_id = $1",
        [operationId],
      );
      await cleanupClient.query(
        `
          delete from funding_provider_requests
          where segment_id in (
            select id
            from funding_operation_segments
            where operation_id = $1
          )
        `,
        [operationId],
      );
      await cleanupClient.query(
        "delete from funding_operation_steps where operation_id = $1",
        [operationId],
      );
      await cleanupClient.query(
        "delete from balance_reservations where operation_id = $1",
        [operationId],
      );
      await cleanupClient.query(
        "delete from funding_operation_segments where operation_id = $1",
        [operationId],
      );
      await cleanupClient.query(
        "delete from funding_operations where id = $1",
        [operationId],
      );
    }
    if (quoteId) {
      await cleanupClient.query("delete from funding_quotes where id = $1", [
        quoteId,
      ]);
    }
    if (userId) {
      await cleanupClient.query("delete from users where id = $1", [userId]);
    }
    await cleanupClient.query("commit");
  } catch (error) {
    await cleanupClient.query("rollback");
    console.error(
      "[relay-reconciliation-integration-tests] cleanup failed",
      error,
    );
    process.exitCode = 1;
  } finally {
    cleanupClient.release();
  }
}
