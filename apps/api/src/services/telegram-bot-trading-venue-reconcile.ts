import type { DbQuery } from "../db.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchEmbeddedEthereumPrivyTransaction,
  fetchEmbeddedEthereumPrivyTransactionByReference,
  fetchEmbeddedEthereumTransactionReceipt,
} from "./embedded-ethereum.js";
import { resolveKalshiExecutionSettlementStatus } from "./kalshi-executions.js";
import { LIMITLESS_CLOB_CHAIN_ID } from "./limitless-trading-service.js";
import { inspectPolymarketSubmittedOrder } from "./polymarket-trading-execution-service.js";
import type { ApiBotTradingExecutor } from "./api-trading-service.js";
import { isDefinitiveSubmitRejection } from "./telegram-bot-trading-submit-error.js";
import type {
  PreparedTradeAuthorizationMode,
  PreparedTrade,
  SubmitResult,
  TradeIntent,
} from "./trading-types.js";

type VenueReconcileIntentRow = {
  id: string;
  telegram_user_id: string;
  user_id: string | null;
  authorization_id: string | null;
  venue: "kalshi" | "limitless" | "polymarket";
  market_id: string;
  event_id: string | null;
  side: "NO" | "YES" | null;
  amount_usd: string | null;
  status: string;
  prepared_snapshot: Record<string, unknown> | null;
  quote_snapshot: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  venue_order_id: string | null;
  tx_signature: string | null;
  wallet_address: string | null;
  wallet_chain: "ethereum" | "solana" | null;
  privy_user_id: string | null;
  privy_wallet_id: string | null;
  limits: Record<string, unknown> | null;
  venue_market_id: string | null;
  market_title: string | null;
  market_status: string | null;
  outcomes: string | null;
  market_metadata: unknown;
  updated_at: Date;
};

type TransactionClient = DbQuery & { release: () => void };
type TransactionalDbQuery = DbQuery & {
  connect?: () => Promise<TransactionClient>;
};

export type TelegramVenueReconcileAuditItem = {
  ageMs: number | null;
  intentId: string;
  localExecutionId: string | null;
  localOrderId: string | null;
  preparedKeys: Record<string, unknown> | null;
  refs: {
    txSignature: string | null;
    venueOrderId: string | null;
  };
  result: "failed" | "pending" | "recovered" | "skipped" | "verified";
  venue: "kalshi" | "limitless" | "polymarket";
  venueState: string;
};

export type TelegramVenueReconcileSummary = {
  busy: boolean;
  dryRun: boolean;
  inspected: number;
  oldestAgeMs: number | null;
  recovered: number;
  failedVerified: number;
  pending: number;
  skipped: number;
  items: TelegramVenueReconcileAuditItem[];
};

const RECONCILE_LOCK_KEY = "telegram-bot-trading:venue-reconcile:v1";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function preparedKeys(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return snapshot && isRecord(snapshot.reconcileKeys)
    ? snapshot.reconcileKeys
    : null;
}

function recoveryPayload(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return snapshot && isRecord(snapshot.recoveryPayload)
    ? snapshot.recoveryPayload
    : null;
}

function reconstructTradeIntent(
  row: VenueReconcileIntentRow,
): TradeIntent | null {
  if (
    !row.user_id ||
    !row.authorization_id ||
    !row.side ||
    !row.amount_usd ||
    !row.wallet_address ||
    !row.wallet_chain
  ) {
    return null;
  }
  return {
    id: row.id,
    actor: {
      kind: "telegram_bot",
      userId: row.user_id,
      telegramUserId: row.telegram_user_id,
      authorizationId: row.authorization_id,
      source: "signal_bot",
    },
    venue: row.venue,
    target: {
      venue: row.venue,
      marketId: row.market_id,
      venueMarketId: row.venue_market_id,
      eventId: row.event_id,
      tokenId: null,
      outcome: row.side,
      title: row.market_title,
      raw: {
        metadata: row.market_metadata,
        outcomes: row.outcomes,
        status: row.market_status,
      },
    },
    executionAuthorization: {
      privyUserId: row.privy_user_id,
      privyWalletId: row.privy_wallet_id,
      kalshiEligibility:
        row.venue === "kalshi" && isRecord(row.limits?.kalshiEligibility)
          ? (row.limits?.kalshiEligibility as never)
          : null,
    },
    walletAddress: row.wallet_address,
    walletChain: row.wallet_chain,
    action: "BUY",
    outcome: row.side,
    amount: { type: "usd", value: row.amount_usd },
    orderType: "FOK",
    idempotencyKey: `telegram-bot:${row.id}`,
    raw: { recovered: true },
  };
}

function reconstructPreparedTrade(
  row: VenueReconcileIntentRow,
  intent: TradeIntent,
): PreparedTrade | null {
  const snapshot = row.prepared_snapshot;
  const payload = recoveryPayload(snapshot);
  if (!snapshot || !payload) return null;
  const preparedId = readString(snapshot.preparedId);
  const authorizationMode = readString(snapshot.authorizationMode);
  const reconcileKeys = preparedKeys(snapshot);
  if (!preparedId || !authorizationMode || !reconcileKeys) return null;
  const expiresAtRaw = readString(snapshot.expiresAt);
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  return {
    preparedId,
    venue: row.venue,
    intent,
    quote: null,
    authorizationMode: authorizationMode as PreparedTradeAuthorizationMode,
    authorizationRequests: [],
    reconcileKeys,
    venuePayload: payload,
    expiresAt:
      expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
  };
}

function limitlessTxHash(row: VenueReconcileIntentRow): string | null {
  const direct = readString(row.tx_signature);
  if (direct) return direct;
  const venueOrderId = readString(row.venue_order_id);
  return venueOrderId?.match(/^amm:(0x[0-9a-f]{64}):/i)?.[1] ?? null;
}

function fundingRouterReference(row: VenueReconcileIntentRow): {
  referenceId: string | null;
  transactionId: string | null;
  txHash: string | null;
} | null {
  const transactions = row.result?.setupTransactions;
  if (!Array.isArray(transactions)) return null;
  for (const transaction of transactions) {
    if (!isRecord(transaction) || transaction.kind !== "funding_router") {
      continue;
    }
    const txHash = readString(transaction.txHash);
    const transactionId = readString(transaction.transactionId);
    const referenceId = readString(transaction.referenceId);
    if (
      /^0x[0-9a-f]{64}$/i.test(txHash ?? "") ||
      transactionId ||
      referenceId
    ) {
      return {
        referenceId,
        transactionId,
        txHash: /^0x[0-9a-f]{64}$/i.test(txHash ?? "") ? txHash : null,
      };
    }
  }
  return null;
}

async function inspectVenueSubmit(
  row: VenueReconcileIntentRow,
): Promise<{ state: string; submitResult: SubmitResult | null }> {
  const keys = preparedKeys(row.prepared_snapshot);
  if (row.venue === "polymarket") {
    const orderHash = readString(keys?.orderHash);
    const fundingReference = fundingRouterReference(row);
    if (!orderHash && fundingReference) {
      let fundingTxHash = fundingReference.txHash;
      if (!fundingTxHash) {
        const privyTransaction = fundingReference.transactionId
          ? await fetchEmbeddedEthereumPrivyTransaction({
              transactionId: fundingReference.transactionId,
            })
          : fundingReference.referenceId
            ? await fetchEmbeddedEthereumPrivyTransactionByReference({
                referenceId: fundingReference.referenceId,
              })
            : null;
        if (!privyTransaction) {
          return { state: "funding_pending", submitResult: null };
        }
        if (
          privyTransaction.status === "execution_reverted" ||
          privyTransaction.status === "failed" ||
          privyTransaction.status === "provider_error" ||
          privyTransaction.status === "replaced"
        ) {
          return { state: "funding_reverted", submitResult: null };
        }
        fundingTxHash = privyTransaction.transactionHash;
      }
      if (!fundingTxHash) {
        return { state: "funding_pending", submitResult: null };
      }
      const receipt = await fetchEmbeddedEthereumTransactionReceipt({
        chainId: 137,
        txHash: fundingTxHash,
      });
      if (!receipt) return { state: "funding_pending", submitResult: null };
      return {
        state: receipt.succeeded ? "funding_confirmed" : "funding_reverted",
        submitResult: null,
      };
    }
    if (!orderHash || !row.user_id || !row.wallet_address) {
      return { state: "missing_order_hash", submitResult: null };
    }
    const inspected = await inspectPolymarketSubmittedOrder({
      orderHash,
      signer: row.wallet_address,
      userId: row.user_id,
    });
    return {
      state: inspected.state,
      submitResult: inspected.submitResult,
    };
  }
  if (row.venue === "limitless") {
    if (readString(keys?.tradeType) !== "amm") {
      return { state: "unsupported_limitless_clob", submitResult: null };
    }
    const txHash = limitlessTxHash(row);
    if (!txHash) return { state: "missing_tx_hash", submitResult: null };
    const receipt = await fetchEmbeddedEthereumTransactionReceipt({
      chainId: LIMITLESS_CLOB_CHAIN_ID,
      txHash,
    });
    if (!receipt) return { state: "pending_receipt", submitResult: null };
    const payload = recoveryPayload(row.prepared_snapshot);
    const tokenId = readString(payload?.tokenId);
    const price = Number(payload?.price);
    const size = Number(payload?.size);
    return {
      state: receipt.succeeded ? "confirmed" : "reverted",
      submitResult: {
        venue: "limitless",
        status: receipt.succeeded ? "filled" : "failed",
        venueOrderId:
          row.venue_order_id ??
          (tokenId ? `amm:${txHash}:${tokenId}` : `amm:${txHash}`),
        orderHash: txHash,
        txSignature: txHash,
        price: Number.isFinite(price) ? price : null,
        size: Number.isFinite(size) ? size : null,
        raw: { receipt, recovered: true },
      },
    };
  }
  const txSignature = readString(row.tx_signature);
  if (!txSignature) {
    return { state: "missing_tx_signature", submitResult: null };
  }
  const settlement = await resolveKalshiExecutionSettlementStatus({
    executionMode: null,
    txSignature,
  });
  if (!settlement) return { state: "pending_settlement", submitResult: null };
  const status: SubmitResult["status"] =
    settlement.status === "fulfilled"
      ? "filled"
      : settlement.status === "no_fill"
        ? "no_fill"
        : settlement.status === "failed"
          ? "failed"
          : settlement.status === "open"
            ? "open"
            : "submitted";
  return {
    state: settlement.status,
    submitResult: {
      venue: "kalshi",
      status,
      venueOrderId: row.venue_order_id,
      orderHash: null,
      txSignature,
      price: null,
      size: null,
      raw: { recovered: true, settlement: settlement.settlementRaw },
    },
  };
}

type TelegramVenueReconcileDependencies = {
  inspectVenueSubmit: typeof inspectVenueSubmit;
};

const telegramVenueReconcileDependencies: TelegramVenueReconcileDependencies = {
  inspectVenueSubmit,
};

async function recordAuditOnly(input: {
  db: DbQuery;
  intentId: string;
  state: string;
  submitResult?: SubmitResult | null;
}): Promise<void> {
  await input.db.query(
    `UPDATE telegram_trade_intents
        SET result = coalesce(result, '{}'::jsonb) || $2::jsonb,
            venue_order_id = coalesce(venue_order_id, $3),
            tx_signature = coalesce(tx_signature, $4),
            updated_at = now()
      WHERE id = $1`,
    [
      input.intentId,
      JSON.stringify({
        venueReconcile: {
          checkedAt: new Date().toISOString(),
          state: input.state,
        },
      }),
      input.submitResult?.venueOrderId ?? null,
      input.submitResult?.txSignature ?? null,
    ],
  );
}

function storedSubmitError(
  row: VenueReconcileIntentRow,
): Record<string, unknown> | null {
  return row.result && isRecord(row.result.error) ? row.result.error : null;
}

function isDefinitiveRejectedNotFound(
  row: VenueReconcileIntentRow,
  venueState: string,
): boolean {
  return (
    row.venue === "polymarket" &&
    row.status === "reconcile_required" &&
    venueState === "not_found" &&
    !row.venue_order_id &&
    !row.tx_signature &&
    isDefinitiveSubmitRejection(storedSubmitError(row))
  );
}

async function finalizeDefinitiveRejectedIntent(input: {
  db: DbQuery;
  intentId: string;
  state: string;
}): Promise<void> {
  await input.db.query(
    `UPDATE telegram_trade_intents
        SET status = 'failed',
            error_code = 'venue_submit_rejected',
            error_message = 'Venue rejected the order before acceptance. Nothing was submitted.',
            result = coalesce(result, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status = 'reconcile_required'
        AND venue_order_id IS NULL
        AND tx_signature IS NULL
        AND order_id IS NULL
        AND execution_id IS NULL
        AND result->'error'->>'code' = 'trade_submission_failed'
        AND result->'error'->>'statusCode' = '400'`,
    [
      input.intentId,
      JSON.stringify({
        venueReconcile: {
          checkedAt: new Date().toISOString(),
          state: input.state,
          terminal: true,
        },
      }),
    ],
  );
}

async function finalizeFundingOnlyIntent(input: {
  db: DbQuery;
  intentId: string;
  state: "funding_confirmed" | "funding_reverted";
}): Promise<void> {
  const confirmed = input.state === "funding_confirmed";
  await input.db.query(
    `UPDATE telegram_trade_intents
        SET status = 'failed',
            error_code = $2,
            error_message = $3,
            result = coalesce(result, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status = ANY($5::text[])
        AND order_id IS NULL
        AND execution_id IS NULL
        AND venue_order_id IS NULL
        AND tx_signature IS NULL`,
    [
      input.intentId,
      confirmed ? "funding_confirmed_order_not_submitted" : "funding_reverted",
      confirmed
        ? "Funding confirmed; no CLOB order was submitted. A fresh retry is safe."
        : "Funding transaction reverted; no CLOB order was submitted.",
      JSON.stringify({
        venueReconcile: {
          checkedAt: new Date().toISOString(),
          state: input.state,
          terminal: true,
        },
      }),
      ["executing", "reconcile_required"],
    ],
  );
}

async function finalizeRecoveredIntent(input: {
  db: DbQuery;
  intentId: string;
  persisted: Awaited<ReturnType<ApiBotTradingExecutor["persistTrade"]>>;
  state: string;
  submitResult: SubmitResult;
}): Promise<void> {
  const failed = ["failed", "no_fill", "cancelled"].includes(
    input.submitResult.status,
  );
  const filled = input.submitResult.status === "filled";
  await input.db.query(
    `UPDATE telegram_trade_intents
        SET status = $2,
            error_code = $3,
            error_message = $4,
            order_id = coalesce(order_id, $5::uuid),
            execution_id = coalesce(execution_id, $6::uuid),
            venue_order_id = coalesce(venue_order_id, $7),
            tx_signature = coalesce(tx_signature, $8),
            submitted_at = coalesce(submitted_at, now()),
            result = coalesce(result, '{}'::jsonb) || $9::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status = ANY($10::text[])`,
    [
      input.intentId,
      filled ? "filled" : failed ? "failed" : "submitted",
      failed ? `venue_${input.submitResult.status}` : null,
      failed ? "Venue reconciliation confirmed a terminal non-fill." : null,
      input.persisted.orderId,
      input.persisted.executionId,
      input.persisted.venueOrderId ?? input.submitResult.venueOrderId,
      input.submitResult.txSignature,
      JSON.stringify({
        venueReconcile: {
          checkedAt: new Date().toISOString(),
          persisted: input.persisted,
          state: input.state,
          submitResult: input.submitResult,
        },
      }),
      ["executing", "reconcile_required", "submitted"],
    ],
  );
}

async function loadCandidates(
  db: DbQuery,
  input: {
    intentId?: string | null;
    limit: number;
    telegramUserId?: string | null;
  },
): Promise<VenueReconcileIntentRow[]> {
  const result = await db.query<VenueReconcileIntentRow>(
    `SELECT
       ti.id,
       ti.telegram_user_id,
       ti.user_id,
       ti.authorization_id,
       ti.venue,
       ti.market_id,
       ti.event_id,
       ti.side,
       ti.amount_usd,
       ti.status,
       ti.prepared_snapshot,
       ti.quote_snapshot,
       ti.result,
       ti.venue_order_id,
       ti.tx_signature,
       a.wallet_address,
       a.wallet_chain,
       a.privy_user_id,
       a.privy_wallet_id,
       a.limits,
       m.venue_market_id,
       m.title AS market_title,
       m.status::text AS market_status,
       m.outcomes,
       m.metadata AS market_metadata,
       ti.updated_at
     FROM telegram_trade_intents ti
     LEFT JOIN telegram_bot_trading_authorizations a
       ON a.id = ti.authorization_id
     JOIN unified_markets m ON m.id = ti.market_id
     WHERE ti.status = ANY($1::text[])
       AND ($2::text IS NULL OR ti.telegram_user_id = $2)
       AND ($4::uuid IS NULL OR ti.id = $4::uuid)
     ORDER BY ti.updated_at ASC, ti.id ASC
     LIMIT $3`,
    [
      ["executing", "reconcile_required", "submitted"],
      input.telegramUserId ?? null,
      input.limit,
      input.intentId ?? null,
    ],
  );
  return result.rows;
}

export async function isTelegramVenueReconcileSchemaReady(
  db: DbQuery,
): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    `SELECT
       to_regclass('public.telegram_trade_intents') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'telegram_trade_intents'
            AND column_name = 'prepared_snapshot'
       ) AS ready`,
  );
  return result.rows[0]?.ready === true;
}

export async function reconcileTelegramVenueIntents(
  db: DbQuery,
  trading: ApiBotTradingExecutor,
  input: {
    dryRun?: boolean;
    intentId?: string | null;
    limit?: number;
    telegramUserId?: string | number | null;
  } = {},
  dependencies: TelegramVenueReconcileDependencies = telegramVenueReconcileDependencies,
): Promise<TelegramVenueReconcileSummary> {
  const summary: TelegramVenueReconcileSummary = {
    busy: false,
    dryRun: input.dryRun !== false,
    inspected: 0,
    oldestAgeMs: null,
    recovered: 0,
    failedVerified: 0,
    pending: 0,
    skipped: 0,
    items: [],
  };
  if (!(await isTelegramVenueReconcileSchemaReady(db))) {
    summary.skipped = 1;
    return summary;
  }
  const transactional = db as TransactionalDbQuery;
  if (!transactional.connect) {
    summary.skipped = 1;
    return summary;
  }
  const client = await transactional.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
      [RECONCILE_LOCK_KEY],
    );
    if (lock.rows[0]?.locked !== true) {
      summary.busy = true;
      await client.query("ROLLBACK");
      return summary;
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 25);
    const rows = await loadCandidates(client, {
      intentId: input.intentId ?? null,
      limit,
      telegramUserId:
        input.telegramUserId == null ? null : String(input.telegramUserId),
    });
    for (const row of rows) {
      summary.inspected += 1;
      let inspection: Awaited<ReturnType<typeof inspectVenueSubmit>>;
      try {
        inspection = await dependencies.inspectVenueSubmit(row);
      } catch (error) {
        inspection = {
          state: error instanceof Error ? error.message : "inspection_failed",
          submitResult: null,
        };
      }
      const item: TelegramVenueReconcileAuditItem = {
        ageMs:
          row.updated_at instanceof Date &&
          Number.isFinite(row.updated_at.getTime())
            ? Math.max(0, Date.now() - row.updated_at.getTime())
            : null,
        intentId: row.id,
        localExecutionId: null,
        localOrderId: null,
        preparedKeys: preparedKeys(row.prepared_snapshot),
        refs: {
          txSignature: inspection.submitResult?.txSignature ?? row.tx_signature,
          venueOrderId:
            inspection.submitResult?.venueOrderId ?? row.venue_order_id,
        },
        result: "pending",
        venue: row.venue,
        venueState: inspection.state,
      };
      if (item.ageMs != null) {
        summary.oldestAgeMs = Math.max(summary.oldestAgeMs ?? 0, item.ageMs);
      }
      const submitResult = inspection.submitResult;
      if (!submitResult) {
        if (
          inspection.state === "funding_confirmed" ||
          inspection.state === "funding_reverted"
        ) {
          item.result = "failed";
          summary.failedVerified += 1;
          summary.items.push(item);
          if (!summary.dryRun) {
            await finalizeFundingOnlyIntent({
              db: client,
              intentId: row.id,
              state: inspection.state,
            });
          }
          continue;
        }
        if (isDefinitiveRejectedNotFound(row, inspection.state)) {
          item.result = "failed";
          summary.failedVerified += 1;
          summary.items.push(item);
          if (!summary.dryRun) {
            await finalizeDefinitiveRejectedIntent({
              db: client,
              intentId: row.id,
              state: inspection.state,
            });
          }
          continue;
        }
        item.result = inspection.state.startsWith("missing_")
          ? "skipped"
          : "pending";
        if (item.result === "skipped") summary.skipped += 1;
        else summary.pending += 1;
        summary.items.push(item);
        if (!summary.dryRun) {
          await recordAuditOnly({
            db: client,
            intentId: row.id,
            state: inspection.state,
          });
        }
        continue;
      }
      item.result = "verified";
      if (summary.dryRun) {
        summary.items.push(item);
        continue;
      }
      if (submitResult.status === "failed") {
        await client.query(
          `UPDATE telegram_trade_intents
              SET status = 'failed',
                  error_code = 'venue_submit_failed',
                  error_message = 'Venue reconciliation confirmed a failed submit.',
                  tx_signature = coalesce(tx_signature, $2),
                  venue_order_id = coalesce(venue_order_id, $3),
                  result = coalesce(result, '{}'::jsonb) || $4::jsonb,
                  updated_at = now()
            WHERE id = $1
              AND status = ANY($5::text[])`,
          [
            row.id,
            submitResult.txSignature,
            submitResult.venueOrderId,
            JSON.stringify({
              venueReconcile: {
                checkedAt: new Date().toISOString(),
                state: inspection.state,
                submitResult,
              },
            }),
            ["executing", "reconcile_required", "submitted"],
          ],
        );
        summary.failedVerified += 1;
        item.result = "failed";
        summary.items.push(item);
        continue;
      }
      const intent = reconstructTradeIntent(row);
      const prepared = intent ? reconstructPreparedTrade(row, intent) : null;
      if (!intent || !prepared) {
        await recordAuditOnly({
          db: client,
          intentId: row.id,
          state: `${inspection.state}:prepared_payload_missing`,
          submitResult,
        });
        summary.skipped += 1;
        item.result = "skipped";
        item.venueState = `${inspection.state}:prepared_payload_missing`;
        summary.items.push(item);
        continue;
      }
      try {
        const persisted = await trading.persistTrade({
          intent,
          prepared,
          submitResult,
        });
        await trading.applyTradeEffects({ intent, persisted, submitResult });
        await finalizeRecoveredIntent({
          db: client,
          intentId: row.id,
          persisted,
          state: inspection.state,
          submitResult,
        });
        item.localExecutionId = persisted.executionId;
        item.localOrderId = persisted.orderId;
        item.result = "recovered";
        summary.recovered += 1;
      } catch (error) {
        await recordAuditOnly({
          db: client,
          intentId: row.id,
          state: `${inspection.state}:persistence_failed:${
            error instanceof Error ? error.message : "unknown"
          }`,
          submitResult,
        });
        item.result = "skipped";
        summary.skipped += 1;
      }
      summary.items.push(item);
    }
    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
