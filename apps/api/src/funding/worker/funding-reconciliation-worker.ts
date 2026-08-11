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
import { DirectIngressDestinationObserver } from "../reconciliation/direct-ingress-observer.js";
import { OwnedRouteDestinationObserver } from "../reconciliation/owned-route-destination-observer.js";
import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import { FundingReceiveReceiptRouter } from "../receive/receive-receipt-router.js";
import { runTelegramFundingProgressProjectionBatch } from "../../services/telegram-funding-progress-projector.js";
import {
  createPolymarketWrapDelegatedFundingProfile,
  DelegatedFundingExecutor,
} from "../execution/delegated-funding-executor.js";
import type { PolymarketWrapExecutionConfiguration } from "../execution/delegated-funding-config.js";
import { createPrivyDelegatedFundingDriver } from "../execution/privy-delegated-funding-driver.js";

export type FundingReferenceProtectionConfig = Readonly<{
  credentialsEncryptionKey: string;
  referenceLookupHmacKey: string;
  referenceKeyVersion: number;
}>;

export type RelayFundingWorkerConfig = Readonly<{
  apiKey: string;
  timeoutMs?: number;
}>;

export type FundingReconciliationJobOptions =
  FundingReconciliationBatchOptions &
    Readonly<{
      referenceProtection?: FundingReferenceProtectionConfig;
      relay?: RelayFundingWorkerConfig;
      receivePollDelayMs?: number;
      delegatedExecution?: Readonly<{
        configuration: PolymarketWrapExecutionConfiguration;
        privy: Readonly<{
          appId: string;
          appSecret: string;
          authorizationPrivateKey: string;
        }>;
      }>;
    }>;

export type FundingReconciliationJobResult =
  | (FundingReconciliationBatchResult &
      Readonly<{
        receiveObservation: Awaited<
          ReturnType<FundingReceiveSessionObserver["pollBatch"]>
        >;
        receiveRouting: Awaited<
          ReturnType<FundingReceiveReceiptRouter["runBatch"]>
        >;
        delegatedFundingExecution: Awaited<
          ReturnType<DelegatedFundingExecutor["runBatch"]>
        > | null;
        telegramFundingProgress: Awaited<
          ReturnType<typeof runTelegramFundingProgressProjectionBatch>
        >;
      }>)
  | Readonly<{
      skipped: true;
      skipReason: "funding_schema_not_ready";
      claimed: 0;
      completed: 0;
      requeued: 0;
      failed: 0;
      deadLettered: 0;
      operationIds: readonly [];
      receiveObservation: null;
      receiveRouting: null;
      delegatedFundingExecution: null;
      telegramFundingProgress: null;
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
        and to_regclass('public.funding_receive_sessions') is not null
        and to_regclass('public.telegram_funding_sessions') is not null
        and to_regclass('public.telegram_funding_consents') is not null
        and to_regclass('public.telegram_funding_authorizations') is not null
        and to_regclass('public.telegram_funding_mutations') is not null
        and to_regclass('public.telegram_bot_action_outbox') is not null
        and exists (
          select 1
          from pg_attribute
          where attrelid = to_regclass('public.funding_receive_sessions')
            and attname = 'owner_channel'
            and not attisdropped
        )
        and not exists (
          select required.column_name
          from (values
            ('funding_session_id'),
            ('state_revision'),
            ('delivery_attempt_id')
          ) as required(column_name)
          where not exists (
            select 1
            from pg_attribute attribute
            where attribute.attrelid = to_regclass('public.telegram_bot_action_outbox')
              and attribute.attname = required.column_name
              and not attribute.attisdropped
          )
        )
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
      receiveObservation: null,
      receiveRouting: null,
      delegatedFundingExecution: null,
      telegramFundingProgress: null,
    };
  }
  const relay = options.relay;
  const referenceProtection = options.referenceProtection;
  const codecConfig = referenceProtection
    ? {
        encryptionKey: decodeCredentialsEncryptionKey(
          referenceProtection.credentialsEncryptionKey,
        ),
        lookupHmacKey: referenceProtection.referenceLookupHmacKey,
        keyVersion: referenceProtection.referenceKeyVersion,
      }
    : null;
  const transactionCodec = codecConfig
    ? createFundingTransactionReferenceCodec(codecConfig)
    : null;
  if (options.delegatedExecution && !transactionCodec) {
    throw new Error(
      "delegated funding execution requires transaction reference protection",
    );
  }
  const delegatedDriver = options.delegatedExecution
    ? createPrivyDelegatedFundingDriver({
        ...options.delegatedExecution.privy,
        configuration: options.delegatedExecution.configuration,
      })
    : null;
  const polymarketWrapProfile =
    options.delegatedExecution && delegatedDriver
      ? createPolymarketWrapDelegatedFundingProfile({
          configuration: options.delegatedExecution.configuration,
          driver: delegatedDriver,
        })
      : null;
  const runReceiveBeforeReconciliation = async () => {
    const receiveObservation = await new FundingReceiveSessionObserver(
      transactionCodec
        ? {
            transactionReferenceCodec: transactionCodec,
          }
        : {},
    ).pollBatch(pool, {
      limit: options.limit ?? 25,
      minimumPollIntervalMs: options.receivePollDelayMs ?? 10_000,
      now: options.now,
    });
    const receiveRouting = await new FundingReceiveReceiptRouter(pool).runBatch(
      {
        limit: options.limit ?? 25,
        now: options.now,
      },
    );
    const delegatedFundingExecution =
      polymarketWrapProfile && transactionCodec
        ? await new DelegatedFundingExecutor(pool, {
            profiles: [polymarketWrapProfile],
            referenceCodec: transactionCodec,
          }).runBatch({ limit: options.limit ?? 25, now: options.now })
        : null;
    return {
      receiveObservation,
      receiveRouting,
      delegatedFundingExecution,
    };
  };
  const directIngressObserver = new DirectIngressDestinationObserver();
  const ownedRouteObserver = new OwnedRouteDestinationObserver();
  const receiptDriver = transactionCodec
    ? new FundingStepReceiptReconciliationDriver(transactionCodec)
    : null;
  const polymarketPostconditionDriver = transactionCodec
    ? new PolymarketFundingPostconditionDriver(transactionCodec)
    : null;
  const evidencePollers =
    receiptDriver && polymarketPostconditionDriver
      ? {
          receiptPoll: (operationId: string, now: Date) =>
            receiptDriver.pollOperation(pool, operationId, now),
          postconditionPoll: (operationId: string, now: Date) =>
            pollFundingPostconditions(
              [polymarketPostconditionDriver],
              pool,
              operationId,
              now,
            ),
        }
      : {};
  const pollDestination = async (operationId: string, now: Date) => {
    const [direct, ownedRoute] = await Promise.all([
      directIngressObserver.pollOperation(pool, operationId, now),
      ownedRouteObserver.pollOperation(pool, operationId, now),
    ]);
    return {
      destinationsPolled:
        direct.destinationsPolled + ownedRoute.destinationsPolled,
      destinationSatisfied:
        direct.destinationSatisfied || ownedRoute.destinationSatisfied,
    };
  };
  const receive = await runReceiveBeforeReconciliation();
  let result: FundingReconciliationBatchResult;
  if (!relay) {
    result = await runFundingReconciliationBatch(pool, {
      ...options,
      ...evidencePollers,
      destinationPoll: pollDestination,
    });
  } else {
    if (!codecConfig || !transactionCodec) {
      throw new Error("funding transaction codec configuration is unavailable");
    }
    const driver = new RelayReconciliationDriver(
      new RelayClient({
        apiKey: relay.apiKey,
        timeoutMs: relay.timeoutMs,
      }),
      createRelayReferenceCodec(codecConfig),
      createRelayDepositAddressCodec(codecConfig),
    );
    result = await runFundingReconciliationBatch(pool, {
      ...options,
      ...evidencePollers,
      providerPoll: (operationId, now) =>
        driver.pollOperation(pool, operationId, now),
      destinationPoll: pollDestination,
    });
  }
  const telegramFundingProgress =
    await runTelegramFundingProgressProjectionBatch(pool, {
      limit: options.limit ?? 25,
      now: options.now,
    });
  return { ...result, ...receive, telegramFundingProgress };
}

export type {
  FundingReconciliationBatchOptions,
  FundingReconciliationBatchResult,
};
