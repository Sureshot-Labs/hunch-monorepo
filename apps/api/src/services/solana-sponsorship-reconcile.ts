import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import type { ExecutionRow } from "../repos/executions-repo.js";
import {
  fetchSolanaFinalizedTransactionBalanceDeltas,
  type SolanaFinalizedTransactionBalanceDeltas,
} from "./solana-rpc.js";
import { upsertSolanaSponsorshipLedger } from "./solana-sponsorship-ledger.js";

type Logger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

type SponsorshipLedgerRow = {
  user_id: string | null;
  venue: "kalshi" | "bridge" | "wallet";
  flow: "dflow" | "across" | "directTransfer" | "debridge";
  status: "intent_created" | "user_signed" | "submitted" | "failed";
  intent_id: string | null;
  wallet_address: string | null;
  sponsor_address: string | null;
  market_id: string | null;
  input_mint: string | null;
  output_mint: string | null;
  amount_raw: string | null;
  message_digest: string | null;
  transaction_digest: string | null;
  tx_signature: string | null;
  estimated_sponsor_lamports: string | null;
  actual_sponsor_lamports: string | null;
  rent_lamports: string | null;
  metadata: unknown;
};

type ReconcileExecutionRow = ExecutionRow;

export type ReconcileSolanaSponsorshipOptions = {
  dryRun: boolean;
  limit: number;
  minAgeSec: number;
  logger?: Logger;
  upsertLedger?: typeof upsertSolanaSponsorshipLedger;
  fetchTransaction?: (
    signature: string,
  ) => Promise<SolanaFinalizedTransactionBalanceDeltas | null>;
};

export type ReconcileSolanaSponsorshipSummary = {
  checked: number;
  confirmed: number;
  skipped: number;
  errors: number;
};

type ReconciliationResult = {
  status: "submitted" | "confirmed" | "failed";
  actualSponsorLamports: string | null;
  rentLamports: string | null;
  rentStatus: "unknown" | "locked" | "returned" | "lost";
  metadata: Record<string, unknown>;
  complete: boolean;
};

function unique(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function bigintMax(value: bigint, floor: bigint): bigint {
  return value > floor ? value : floor;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getBooleanMetadata(metadata: unknown, key: string): boolean {
  if (!isRecord(metadata)) return false;
  return metadata[key] === true;
}

function getRecordValue(
  metadata: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  const nested = metadata[key];
  return isRecord(nested) ? nested : null;
}

function getDurableGenericSponsorshipSignature(
  metadata: unknown,
): string | null {
  if (!isRecord(metadata)) return null;
  return (
    getString(metadata.txSignature) ??
    getString(getRecordValue(metadata, "submission")?.signature) ??
    getString(getRecordValue(metadata, "submitted")?.signature) ??
    getString(getRecordValue(metadata, "privySubmit")?.signature) ??
    getString(
      getRecordValue(metadata, "genericSponsorshipReconciliation")?.signature,
    )
  );
}

function getSettlementRaw(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  return isRecord(raw.settlement) ? raw.settlement : null;
}

function getSettlementStatus(raw: unknown): string | null {
  return getString(getSettlementRaw(raw)?.status);
}

function isTerminalDflowSettlementStatus(status: string | null): boolean {
  return status === "closed" || status === "failed" || status === "no_fill";
}

function collectSettlementSignatures(raw: unknown): string[] {
  const settlement = getSettlementRaw(raw);
  if (!settlement) return [];

  const signatures: string[] = [];
  for (const key of ["fills", "reverts"]) {
    const entries = settlement[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const signature = getString(entry.signature);
      if (signature) signatures.push(signature);
    }
  }
  return signatures;
}

export function collectDflowSponsorshipSignatures(inputs: {
  submitSignature: string;
  executionRaw?: unknown;
}): string[] {
  return unique([
    inputs.submitSignature,
    ...collectSettlementSignatures(inputs.executionRaw),
  ]);
}

function transactionMetadata(inputs: {
  sponsorAddress: string;
  tx: SolanaFinalizedTransactionBalanceDeltas;
}): Record<string, unknown> {
  const sponsorDelta =
    inputs.tx.accountDeltas.find(
      (entry) => entry.account === inputs.sponsorAddress,
    )?.deltaLamports ?? 0n;
  const nonSponsorLamportDeltas = inputs.tx.accountDeltas
    .filter(
      (entry) =>
        entry.account !== inputs.sponsorAddress && entry.deltaLamports !== 0n,
    )
    .map((entry) => ({
      account: entry.account,
      deltaLamports: entry.deltaLamports.toString(),
    }));

  return {
    signature: inputs.tx.signature,
    slot: inputs.tx.slot,
    blockTime: inputs.tx.blockTime,
    err: inputs.tx.err ?? null,
    feePayer: inputs.tx.feePayer,
    feeLamports: inputs.tx.feeLamports.toString(),
    sponsorLamportDelta: sponsorDelta.toString(),
    nonSponsorLamportDeltas,
  };
}

export function calculateDflowSponsorshipReconciliation(inputs: {
  sponsorAddress: string;
  submitSignature: string;
  relatedSignatures: string[];
  settlementClosed: boolean;
  transactions: Map<string, SolanaFinalizedTransactionBalanceDeltas | null>;
}): ReconciliationResult {
  const relatedSignatures = unique([
    inputs.submitSignature,
    ...inputs.relatedSignatures,
  ]);
  const missingSignatures: string[] = [];
  const transactions: SolanaFinalizedTransactionBalanceDeltas[] = [];

  for (const signature of relatedSignatures) {
    const tx = inputs.transactions.get(signature) ?? null;
    if (!tx) {
      missingSignatures.push(signature);
      continue;
    }
    transactions.push(tx);
  }

  const erroredSignatures = transactions
    .filter((tx) => tx.err != null)
    .map((tx) => tx.signature);
  const sponsorDelta = transactions.reduce((sum, tx) => {
    const delta =
      tx.accountDeltas.find((entry) => entry.account === inputs.sponsorAddress)
        ?.deltaLamports ?? 0n;
    return sum + delta;
  }, 0n);
  const sponsorPaidFees = transactions.reduce((sum, tx) => {
    if (tx.feePayer !== inputs.sponsorAddress) return sum;
    return sum + tx.feeLamports;
  }, 0n);
  const currentSponsorCost = bigintMax(-sponsorDelta, 0n);
  const currentNonFeeCost = bigintMax(currentSponsorCost - sponsorPaidFees, 0n);
  const hasObservedTransactions = transactions.length > 0;
  const hasErroredTransactions = erroredSignatures.length > 0;
  const complete =
    missingSignatures.length === 0 &&
    !hasErroredTransactions &&
    inputs.settlementClosed;
  const failed = missingSignatures.length === 0 && hasErroredTransactions;
  const costComplete =
    missingSignatures.length === 0 &&
    hasObservedTransactions &&
    (inputs.settlementClosed || failed);
  const rentStatus =
    missingSignatures.length > 0
      ? "unknown"
      : currentNonFeeCost === 0n
        ? "returned"
        : inputs.settlementClosed && !hasErroredTransactions
          ? "lost"
          : "locked";

  return {
    status: failed ? "failed" : complete ? "confirmed" : "submitted",
    actualSponsorLamports: costComplete ? currentSponsorCost.toString() : null,
    rentLamports:
      missingSignatures.length > 0 ? null : currentNonFeeCost.toString(),
    rentStatus,
    complete,
    metadata: {
      sponsorshipReconciliation: {
        reconciledAt: new Date().toISOString(),
        settlementClosed: inputs.settlementClosed,
        relatedSignatures,
        missingSignatures,
        erroredSignatures,
        sponsorLamportDelta: sponsorDelta.toString(),
        currentSponsorCostLamports: currentSponsorCost.toString(),
        sponsorPaidFeesLamports: sponsorPaidFees.toString(),
        currentNonFeeCostLamports: currentNonFeeCost.toString(),
        transactions: transactions.map((tx) =>
          transactionMetadata({ sponsorAddress: inputs.sponsorAddress, tx }),
        ),
      },
    },
  };
}

async function fetchSubmittedSponsorshipRows(
  pool: Pool,
  inputs: { limit: number; minAgeSec: number },
): Promise<SponsorshipLedgerRow[]> {
  const limit = Math.max(1, Math.trunc(inputs.limit));
  const minAgeSec = Math.max(0, Math.trunc(inputs.minAgeSec));
  const { rows } = await pool.query<SponsorshipLedgerRow>(
    `
      select
        user_id,
        venue,
        flow,
        status,
        intent_id,
        wallet_address,
        sponsor_address,
        market_id,
        input_mint,
        output_mint,
        amount_raw,
        message_digest,
        transaction_digest,
        tx_signature,
        estimated_sponsor_lamports::text as estimated_sponsor_lamports,
        actual_sponsor_lamports::text as actual_sponsor_lamports,
        rent_lamports::text as rent_lamports,
        metadata
      from solana_sponsorship_ledger
      where flow in ('dflow', 'across', 'directTransfer', 'debridge')
        and (
          (
            flow = 'dflow'
            and (
              status in ('user_signed', 'submitted')
              or (
                status = 'failed'
                and tx_signature is not null
                and (
                  actual_sponsor_lamports is null
                  or metadata #> '{sponsorshipReconciliation}' is null
                )
              )
            )
          )
          or (
            flow <> 'dflow'
            and (
              (status = 'submitted' and tx_signature is not null)
              or (
                status = 'failed'
                and tx_signature is not null
                and (
                  actual_sponsor_lamports is null
                  or metadata #> '{genericSponsorshipReconciliation}' is null
                )
              )
              or (
                status = 'intent_created'
                and coalesce(
                  metadata ->> 'txSignature',
                  metadata #>> '{submission,signature}',
                  metadata #>> '{submitted,signature}',
                  metadata #>> '{privySubmit,signature}',
                  metadata #>> '{genericSponsorshipReconciliation,signature}'
                ) is not null
              )
            )
          )
        )
        and updated_at <= now() - ($1::int * interval '1 second')
      order by updated_at asc
      limit $2
    `,
    [minAgeSec, limit],
  );
  return rows;
}

async function fetchExecutionForSponsorshipRow(
  pool: Pool,
  row: SponsorshipLedgerRow,
): Promise<ReconcileExecutionRow | null> {
  const { rows } = await pool.query<ReconcileExecutionRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        venue,
        unified_market_id,
        side,
        outcome,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        quote_id,
        tx_signature,
        venue_order_id,
        status,
        raw,
        created_at,
        updated_at
      from executions
      where venue = 'kalshi'
        and (
          ($1::text is not null and raw #>> '{order,hunchSponsorshipIntentId}' = $1)
          or ($2::text is not null and tx_signature = $2)
        )
      order by
        case when $1::text is not null and raw #>> '{order,hunchSponsorshipIntentId}' = $1 then 0 else 1 end,
        updated_at desc
      limit 1
    `,
    [row.intent_id, row.tx_signature],
  );
  return rows[0] ?? null;
}

function getMetadataString(metadata: unknown, key: string): string | null {
  if (!isRecord(metadata)) return null;
  return getString(metadata[key]);
}

async function reconcileOneLossReclaimSponsorshipRow(
  row: SponsorshipLedgerRow,
  options: ReconcileSolanaSponsorshipOptions,
): Promise<{ confirmed: boolean; skipped: boolean }> {
  const signature = row.tx_signature?.trim();
  const intentId = row.intent_id?.trim();
  const walletAddress = row.wallet_address?.trim();
  const sponsorAddress = row.sponsor_address?.trim();
  if (!signature || !intentId || !walletAddress || !sponsorAddress) {
    return { confirmed: false, skipped: true };
  }

  const fetchTransaction =
    options.fetchTransaction ??
    ((txSignature: string) =>
      fetchSolanaFinalizedTransactionBalanceDeltas({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        signature: txSignature,
      }));
  const tx = await fetchTransaction(signature);
  if (!tx) return { confirmed: false, skipped: true };

  const failed = tx.err != null;
  const sponsorDelta =
    tx.accountDeltas.find((entry) => entry.account === sponsorAddress)
      ?.deltaLamports ?? 0n;
  const sponsorCost = bigintMax(-sponsorDelta, tx.feeLamports);
  const rentRecipient = getMetadataString(row.metadata, "rentRecipient");
  const sponsorRentRecipient = rentRecipient === sponsorAddress;

  if (!options.dryRun) {
    const upsertLedger = options.upsertLedger ?? upsertSolanaSponsorshipLedger;
    await upsertLedger({
      userId: row.user_id,
      venue: "kalshi",
      flow: "dflow",
      status: failed ? "failed" : "confirmed",
      intentId,
      walletAddress,
      sponsorAddress,
      marketId: row.market_id,
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      amountRaw: row.amount_raw,
      messageDigest: row.message_digest,
      transactionDigest: row.transaction_digest,
      txSignature: signature,
      estimatedSponsorLamports: row.estimated_sponsor_lamports ?? "0",
      actualSponsorLamports: sponsorCost.toString(),
      rentLamports: sponsorRentRecipient ? row.rent_lamports : null,
      rentStatus: failed
        ? "locked"
        : sponsorRentRecipient
          ? "returned"
          : "unknown",
      error: failed ? JSON.stringify(tx.err) : null,
      metadata: {
        lossReclaimReconciliation: {
          reconciledAt: new Date().toISOString(),
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          err: tx.err ?? null,
          feePayer: tx.feePayer,
          feeLamports: tx.feeLamports.toString(),
          sponsorLamportDelta: sponsorDelta.toString(),
          actualSponsorLamports: sponsorCost.toString(),
          rentRecipient,
          accountDeltas: tx.accountDeltas.map((entry) => ({
            account: entry.account,
            deltaLamports: entry.deltaLamports.toString(),
          })),
        },
      },
    });
  }

  return { confirmed: !failed, skipped: false };
}

async function reconcileOneSponsorshipRow(
  pool: Pool,
  row: SponsorshipLedgerRow,
  options: ReconcileSolanaSponsorshipOptions,
): Promise<{ confirmed: boolean; skipped: boolean }> {
  if (row.flow !== "dflow") {
    return reconcileOneGenericSponsorshipRow(row, options);
  }
  if (getMetadataString(row.metadata, "purpose") === "loss_reclaim") {
    return reconcileOneLossReclaimSponsorshipRow(row, options);
  }

  const sponsorAddress = row.sponsor_address?.trim();
  const intentId = row.intent_id?.trim();
  const walletAddress = row.wallet_address?.trim();
  if (!sponsorAddress || !intentId || !walletAddress) {
    return { confirmed: false, skipped: true };
  }

  const execution = await fetchExecutionForSponsorshipRow(pool, row);
  const submitSignature =
    row.tx_signature?.trim() || execution?.tx_signature?.trim() || null;
  if (!submitSignature) {
    return { confirmed: false, skipped: true };
  }
  const relatedSignatures = collectDflowSponsorshipSignatures({
    submitSignature,
    executionRaw: execution?.raw,
  });
  const settlementStatus = getSettlementStatus(execution?.raw);
  const settlementClosed =
    getBooleanMetadata(row.metadata, "adminPredictionMarketInit") ||
    isTerminalDflowSettlementStatus(settlementStatus);
  const fetchTransaction =
    options.fetchTransaction ??
    ((signature: string) =>
      fetchSolanaFinalizedTransactionBalanceDeltas({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        signature,
      }));

  const txEntries = await Promise.all(
    relatedSignatures.map(
      async (signature) =>
        [signature, await fetchTransaction(signature)] as const,
    ),
  );
  const result = calculateDflowSponsorshipReconciliation({
    sponsorAddress,
    submitSignature,
    relatedSignatures,
    settlementClosed,
    transactions: new Map(txEntries),
  });

  if (!options.dryRun) {
    const upsertLedger = options.upsertLedger ?? upsertSolanaSponsorshipLedger;
    await upsertLedger({
      userId: row.user_id,
      venue: "kalshi",
      flow: "dflow",
      status: result.status,
      intentId,
      walletAddress,
      sponsorAddress,
      marketId: row.market_id,
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      amountRaw: row.amount_raw,
      messageDigest: row.message_digest,
      transactionDigest: row.transaction_digest,
      txSignature: submitSignature,
      estimatedSponsorLamports: row.estimated_sponsor_lamports ?? "0",
      actualSponsorLamports: result.actualSponsorLamports,
      rentLamports: result.rentLamports,
      rentStatus: result.rentStatus,
      metadata: result.metadata,
    });
  }

  return { confirmed: result.complete, skipped: !result.complete };
}

async function reconcileOneGenericSponsorshipRow(
  row: SponsorshipLedgerRow,
  options: ReconcileSolanaSponsorshipOptions,
): Promise<{ confirmed: boolean; skipped: boolean }> {
  const signature =
    row.tx_signature?.trim() ||
    getDurableGenericSponsorshipSignature(row.metadata);
  const intentId = row.intent_id?.trim();
  const walletAddress = row.wallet_address?.trim();
  if (!signature || !intentId || !walletAddress) {
    return { confirmed: false, skipped: true };
  }

  const fetchTransaction =
    options.fetchTransaction ??
    ((txSignature: string) =>
      fetchSolanaFinalizedTransactionBalanceDeltas({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        signature: txSignature,
      }));
  const tx = await fetchTransaction(signature);
  if (!tx) return { confirmed: false, skipped: true };

  const failed = tx.err != null;
  const sponsorAddress = row.sponsor_address?.trim() || null;
  const sponsorDelta =
    sponsorAddress == null
      ? null
      : (tx.accountDeltas.find((entry) => entry.account === sponsorAddress)
          ?.deltaLamports ?? 0n);
  const sponsorCost =
    sponsorDelta == null
      ? tx.feeLamports
      : bigintMax(-sponsorDelta, tx.feeLamports);
  if (!options.dryRun) {
    const upsertLedger = options.upsertLedger ?? upsertSolanaSponsorshipLedger;
    await upsertLedger({
      userId: row.user_id,
      venue: row.venue,
      flow: row.flow,
      status: failed ? "failed" : "confirmed",
      intentId,
      walletAddress,
      sponsorAddress: row.sponsor_address,
      marketId: row.market_id,
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      amountRaw: row.amount_raw,
      messageDigest: row.message_digest,
      transactionDigest: row.transaction_digest,
      txSignature: signature,
      estimatedSponsorLamports: row.estimated_sponsor_lamports ?? "0",
      actualSponsorLamports: sponsorCost.toString(),
      error: failed ? JSON.stringify(tx.err) : null,
      metadata: {
        genericSponsorshipReconciliation: {
          reconciledAt: new Date().toISOString(),
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          err: tx.err ?? null,
          feePayer: tx.feePayer,
          feeLamports: tx.feeLamports.toString(),
          sponsorLamportDelta: sponsorDelta?.toString() ?? null,
          actualSponsorLamports: sponsorCost.toString(),
          accountDeltas: tx.accountDeltas.map((entry) => ({
            account: entry.account,
            deltaLamports: entry.deltaLamports.toString(),
          })),
        },
      },
    });
  }

  return { confirmed: !failed, skipped: false };
}

export async function reconcileSolanaSponsorshipLedger(
  pool: Pool,
  options: ReconcileSolanaSponsorshipOptions,
): Promise<ReconcileSolanaSponsorshipSummary> {
  const rows = await fetchSubmittedSponsorshipRows(pool, {
    limit: options.limit,
    minAgeSec: options.minAgeSec,
  });
  const summary: ReconcileSolanaSponsorshipSummary = {
    checked: rows.length,
    confirmed: 0,
    skipped: 0,
    errors: 0,
  };

  for (const row of rows) {
    try {
      const result = await reconcileOneSponsorshipRow(pool, row, options);
      if (result.confirmed) {
        summary.confirmed += 1;
      } else if (result.skipped) {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.errors += 1;
      options.logger?.error?.(
        {
          error,
          intentId: row.intent_id,
          txSignature: row.tx_signature,
        },
        "Solana sponsorship reconciliation failed",
      );
    }
  }

  return summary;
}
