import type { Pool } from "@hunch/infra";

import { RelayClient } from "../../funding-providers/relay/client.js";
import {
  createRelayDepositAddressCodec,
  createRelayReferenceCodec,
} from "../../funding-providers/relay/reference-codec.js";
import { RelayReconciliationDriver } from "../../funding-providers/relay/reconciliation.js";
import { createRelayReceiveReceiptDispositionResolver } from "../../funding-providers/relay/receive-operation.js";
import { decodeCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import {
  runFundingReconciliationBatch,
  type FundingReconciliationBatchOptions,
  type FundingReconciliationBatchResult,
} from "../reconciliation/funding-reducer.js";
import { FundingStepReceiptReconciliationDriver } from "../execution/step-receipt-reconciler.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { PolymarketFundingPostconditionDriver } from "../preparation/polymarket-funding-reconciler.js";
import { observePolymarketFundingRuntimeSidecar } from "../preparation/polymarket-funding-observer.js";
import { createPolymarketReceiptOperationPreparer } from "../preparation/polymarket-receipt-operation.js";
import { pollFundingPostconditions } from "../preparation/postcondition-driver.js";
import { DirectIngressDestinationObserver } from "../reconciliation/direct-ingress-observer.js";
import { OwnedRouteDestinationObserver } from "../reconciliation/owned-route-destination-observer.js";
import { RelayOwnedRefundObserver } from "../reconciliation/relay-owned-refund-observer.js";
import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import {
  FundingReceiveReceiptRouter,
  type FundingReceiveReceiptDispositionResolver,
} from "../receive/receive-receipt-router.js";
import { runTelegramFundingProgressProjectionBatch } from "../../services/telegram-funding-progress-projector.js";
import {
  createPolymarketWrapDelegatedFundingProfile,
  DelegatedFundingExecutor,
} from "../execution/delegated-funding-executor.js";
import type { PolymarketWrapExecutionConfiguration } from "../execution/delegated-funding-config.js";
import { loadRelayEvmExecutionConfiguration } from "../execution/delegated-funding-config.js";
import { createPrivyDelegatedFundingDriver } from "../execution/privy-delegated-funding-driver.js";
import { createRelayEvmDelegatedFundingProfile } from "../execution/relay-evm-delegated-executor-profile.js";
import {
  resolveTelegramFundingReceiptDisposition,
  TELEGRAM_POLYMARKET_FUNDING_ADAPTER_KEY,
  type TelegramFundingReceiptOperationPreparer,
} from "../../services/telegram-funding-route.js";

// Channel composition belongs at the worker edge. The receipt router itself
// only executes a provider-neutral disposition, so a new Telegram venue is a
// route-adapter registration rather than another branch in the funding core.
function receiptDispositionResolver(
  operationPreparers: ReadonlyMap<
    string,
    TelegramFundingReceiptOperationPreparer
  >,
  relayDisposition: FundingReceiveReceiptDispositionResolver | null,
): FundingReceiveReceiptDispositionResolver {
  return (target) => {
    if (target.ownerChannel === "telegram") {
      const telegram = resolveTelegramFundingReceiptDisposition(
        target,
        operationPreparers,
      );
      if (
        telegram.kind !== "automatic_execution" ||
        !telegram.execution ||
        telegram.execution.prepareOperation ||
        !relayDisposition
      )
        return telegram;
      const relay = relayDisposition(target);
      if (
        relay.kind !== "automatic_execution" ||
        !relay.execution?.prepareOperation
      )
        return telegram;
      const prepareRelay = relay.execution.prepareOperation;
      const decision = telegram.execution.decision;
      return {
        ...telegram,
        execution: {
          ...telegram.execution,
          prepareOperation: async (db, receiptTarget, now) => {
            const prepared = await prepareRelay(db, receiptTarget, now);
            if (!prepared || "kind" in prepared) return prepared;
            return {
              ...prepared,
              verify: async (client) => {
                const authority = await decision(client, receiptTarget);
                if (authority.kind !== "allowed") {
                  throw new Error(
                    "Relay Telegram authority changed before commit",
                  );
                }
                await prepared.verify(client);
              },
            };
          },
        },
      };
    }
    if (target.receipt.handling === "direct") return { kind: "direct" };
    return relayDisposition
      ? relayDisposition(target)
      : {
          kind: "hard_invalid",
          reasonCode: "receipt_disposition_unavailable",
        };
  };
}

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
        and to_regclass(
              'public.telegram_funding_authorization_reservations'
            ) is not null
        and to_regclass('public.telegram_funding_mutations') is not null
        and to_regclass('public.telegram_bot_action_outbox') is not null
        and exists (
          select 1
          from pg_attribute
          where attrelid = to_regclass('public.funding_receive_sessions')
            and attname = 'owner_channel'
            and not attisdropped
        )
        and exists (
          select 1
          from pg_attribute
          where attrelid =
                  to_regclass('public.telegram_funding_authorizations')
            and attname = 'max_source_raw'
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
        and exists (
          select 1
          from pg_constraint constraint_row
          where constraint_row.conrelid =
                  to_regclass('public.telegram_bot_action_outbox')
            and constraint_row.conname =
                  'telegram_bot_action_outbox_address_egress_check'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%funding_replacement%'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%receiveaddress%'
        )
        and exists (
          select 1
          from pg_attribute
          where attrelid = to_regclass('public.telegram_funding_sessions')
            and attname in (
              'address_disclosure_attempt_revision',
              'address_disclosure_message_id',
              'address_delivered_revision',
              'address_redacted_revision'
            )
            and not attisdropped
          group by attrelid
          having count(*) = 4
        )
        and exists (
          select 1
          from pg_constraint constraint_row
          where constraint_row.conrelid =
                  to_regclass('public.telegram_funding_sessions')
            and constraint_row.conname =
                  'telegram_funding_sessions_address_delivery_check'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%address_delivered_revision%'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%address_disclosure_attempt_revision%'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%address_delivered_revision <= address_disclosure_attempt_revision%'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%address_redacted_revision%'
            and lower(pg_get_constraintdef(constraint_row.oid))
                  like '%address_disclosure_message_id%'
        )
        and not exists (
          select required.constraint_name
          from (values
            ('telegram_bot_action_outbox_action_check'),
            ('telegram_bot_action_outbox_shape_check'),
            ('telegram_bot_action_outbox_delivery_attempt_check'),
            ('telegram_bot_action_outbox_delivery_unknown_check')
          ) as required(constraint_name)
          where not exists (
            select 1
            from pg_constraint constraint_row
            where constraint_row.conrelid =
                    to_regclass('public.telegram_bot_action_outbox')
              and constraint_row.conname = required.constraint_name
              and lower(pg_get_constraintdef(constraint_row.oid))
                    like '%funding_qr%'
          )
        )
        and exists (
          select 1
          from pg_index index_row
          join pg_class index_relation
            on index_relation.oid = index_row.indexrelid
          join pg_namespace namespace
            on namespace.oid = index_relation.relnamespace
          where namespace.nspname = 'public'
            and index_relation.relname =
                  'telegram_bot_action_outbox_funding_qr_unique'
            and index_row.indisunique
            and lower(pg_get_expr(
                  index_row.indpred,
                  index_row.indrelid
                )) like '%funding_qr%'
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
  const relayEvmConfiguration = loadRelayEvmExecutionConfiguration();
  const delegatedDriver = options.delegatedExecution
    ? createPrivyDelegatedFundingDriver({
        ...options.delegatedExecution.privy,
        configuration: {
          ...options.delegatedExecution.configuration,
          relayAllowedDepositors: relayEvmConfiguration.allowedDepositors,
          relayMaxSourceRaw: relayEvmConfiguration.maxSourceRaw,
        },
      })
    : null;
  const polymarketWrapProfile =
    options.delegatedExecution && delegatedDriver
      ? createPolymarketWrapDelegatedFundingProfile({
          configuration: options.delegatedExecution.configuration,
          driver: delegatedDriver,
        })
      : null;
  const relayEvmProfile =
    options.delegatedExecution && delegatedDriver
      ? createRelayEvmDelegatedFundingProfile({
          configuration: relayEvmConfiguration,
          driver: delegatedDriver,
        })
      : null;
  const operationPreparers = new Map<
    string,
    TelegramFundingReceiptOperationPreparer
  >();
  if (referenceProtection) {
    operationPreparers.set(
      TELEGRAM_POLYMARKET_FUNDING_ADAPTER_KEY,
      createPolymarketReceiptOperationPreparer({
        subjectLookupHmacKey: referenceProtection.referenceLookupHmacKey,
        subjectLookupKeyVersion: referenceProtection.referenceKeyVersion,
      }),
    );
  }
  const relayReceiptDisposition =
    relay && referenceProtection && codecConfig
      ? createRelayReceiveReceiptDispositionResolver({
          client: {
            apiKey: relay.apiKey,
            ...(relay.timeoutMs === undefined
              ? {}
              : { timeoutMs: relay.timeoutMs }),
          },
          referenceCodec: createRelayReferenceCodec(codecConfig),
          subjectLookupHmacKey: referenceProtection.referenceLookupHmacKey,
          subjectLookupKeyVersion: referenceProtection.referenceKeyVersion,
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
    const receiveRouting = await new FundingReceiveReceiptRouter(
      pool,
      undefined,
      receiptDispositionResolver(operationPreparers, relayReceiptDisposition),
    ).runBatch({
      limit: options.limit ?? 25,
      now: options.now,
    });
    const delegatedFundingExecution =
      (polymarketWrapProfile || relayEvmProfile) && transactionCodec
        ? await new DelegatedFundingExecutor(pool, {
            profiles: [polymarketWrapProfile, relayEvmProfile].filter(
              (profile): profile is NonNullable<typeof profile> =>
                profile != null,
            ),
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
  const relayRefundObserver = codecConfig
    ? new RelayOwnedRefundObserver(createRelayReferenceCodec(codecConfig))
    : null;
  const receiptDriver = transactionCodec
    ? new FundingStepReceiptReconciliationDriver(transactionCodec)
    : null;
  const polymarketPostconditionDriver =
    transactionCodec && codecConfig
      ? new PolymarketFundingPostconditionDriver(transactionCodec, {
          observe: (input) =>
            observePolymarketFundingRuntimeSidecar({
              db: pool,
              encryptionKey: codecConfig.encryptionKey,
              ...input,
            }),
        })
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
    const [direct, ownedRoute, refund] = await Promise.all([
      directIngressObserver.pollOperation(pool, operationId, now),
      ownedRouteObserver.pollOperation(pool, operationId, now),
      relayRefundObserver?.pollOperation(pool, operationId, now) ??
        Promise.resolve({ refundsPolled: 0, refundSatisfied: false }),
    ]);
    return {
      destinationsPolled:
        direct.destinationsPolled +
        ownedRoute.destinationsPolled +
        refund.refundsPolled,
      destinationSatisfied:
        direct.destinationSatisfied ||
        ownedRoute.destinationSatisfied ||
        refund.refundSatisfied,
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
