import type { Pool } from "@hunch/infra";

import { RelayClient } from "../../funding-providers/relay/client.js";
import {
  createRelayDepositAddressCodec,
  createRelayReferenceCodec,
} from "../../funding-providers/relay/reference-codec.js";
import { RelayReconciliationDriver } from "../../funding-providers/relay/reconciliation.js";
import { decodeCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import {
  runFundingReconciliationBatch,
  type FundingReconciliationBatchOptions,
  type FundingReconciliationBatchResult,
} from "../reconciliation/funding-reducer.js";
import { FundingStepReceiptReconciliationDriver } from "../execution/step-receipt-reconciler.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { PolymarketFundingPostconditionDriver } from "../preparation/polymarket-funding-reconciler.js";
import { pollFundingPostconditions } from "../preparation/postcondition-driver.js";

export type RelayFundingWorkerConfig = Readonly<{
  apiKey: string;
  credentialsEncryptionKey: string;
  referenceLookupHmacKey: string;
  referenceKeyVersion: number;
  timeoutMs?: number;
}>;

export type FundingReconciliationJobOptions =
  FundingReconciliationBatchOptions &
    Readonly<{
      relay?: RelayFundingWorkerConfig;
    }>;

export type FundingReconciliationJobResult =
  | FundingReconciliationBatchResult
  | Readonly<{
      skipped: true;
      skipReason: "funding_schema_not_ready";
      claimed: 0;
      completed: 0;
      requeued: 0;
      failed: 0;
      deadLettered: 0;
      operationIds: readonly [];
    }>;

export async function isFundingReconciliationSchemaReady(
  pool: Pick<Pool, "query">,
): Promise<boolean> {
  const { rows } = await pool.query<{ ready: boolean }>(
    `
      select
        to_regclass('public.funding_operations') is not null
        and to_regclass('public.funding_observations') is not null
        and to_regclass('public.funding_reconciliation_jobs') is not null
        as ready
    `,
  );
  return rows[0]?.ready === true;
}

export async function runFundingReconciliationJob(
  pool: Pool,
  options: FundingReconciliationJobOptions,
): Promise<FundingReconciliationJobResult> {
  if (!(await isFundingReconciliationSchemaReady(pool))) {
    return {
      skipped: true,
      skipReason: "funding_schema_not_ready",
      claimed: 0,
      completed: 0,
      requeued: 0,
      failed: 0,
      deadLettered: 0,
      operationIds: [],
    };
  }
  const relay = options.relay;
  if (!relay) return runFundingReconciliationBatch(pool, options);
  const encryptionKey = decodeCredentialsEncryptionKey(
    relay.credentialsEncryptionKey,
  );
  const codecConfig = {
    encryptionKey,
    lookupHmacKey: relay.referenceLookupHmacKey,
    keyVersion: relay.referenceKeyVersion,
  };
  const driver = new RelayReconciliationDriver(
    new RelayClient({
      apiKey: relay.apiKey,
      timeoutMs: relay.timeoutMs,
    }),
    createRelayReferenceCodec(codecConfig),
    createRelayDepositAddressCodec(codecConfig),
  );
  const transactionCodec = createFundingTransactionReferenceCodec(codecConfig);
  const receiptDriver = new FundingStepReceiptReconciliationDriver(
    transactionCodec,
  );
  const polymarketPostconditionDriver =
    new PolymarketFundingPostconditionDriver(transactionCodec);
  return runFundingReconciliationBatch(pool, {
    ...options,
    providerPoll: (operationId, now) =>
      driver.pollOperation(pool, operationId, now),
    receiptPoll: (operationId, now) =>
      receiptDriver.pollOperation(pool, operationId, now),
    postconditionPoll: (operationId, now) =>
      pollFundingPostconditions(
        [polymarketPostconditionDriver],
        pool,
        operationId,
        now,
      ),
  });
}

export type {
  FundingReconciliationBatchOptions,
  FundingReconciliationBatchResult,
};
