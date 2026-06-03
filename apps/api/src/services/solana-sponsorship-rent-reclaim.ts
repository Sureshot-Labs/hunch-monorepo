import { randomUUID } from "node:crypto";

import {
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchSolanaFinalizedTransactionBalanceDeltas,
  waitForSolanaSignatureConfirmation,
} from "./solana-rpc.js";
import { resolveHunchSolanaSponsorKeypair } from "./solana-sponsorship-primitives.js";

type Logger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

type SponsorshipRentReclaimRow = {
  id: string;
  user_id: string;
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
  rent_status:
    | "unknown"
    | "locked"
    | "returned"
    | "lost"
    | "partially_reclaimed"
    | null;
  metadata: unknown;
};

export type DflowSponsorRentAccountInfo = {
  account: string;
  exists: boolean;
  lamports: bigint;
  tokenProgramId: string | null;
  tokenOwner: string | null;
  closeAuthority: string | null;
  tokenAmount: bigint | null;
  mint: string | null;
};

export type DflowSponsorRentCloseTransactions = Array<{
  signature: string;
  accounts: string[];
  feeLamports: string | null;
  status?: "closed" | "submitted" | "failed";
  error?: string | null;
  submittedAt?: string | null;
}>;

export type DflowSponsorRentCloseResult = {
  accountResults: Map<
    string,
    {
      status: "closed" | "submitted" | "failed";
      signature?: string;
      reclaimedLamports?: bigint;
      error?: string;
    }
  >;
  closeTransactions: DflowSponsorRentCloseTransactions;
};

type DflowSponsorRentCloseAccountResult =
  DflowSponsorRentCloseResult["accountResults"] extends Map<
    string,
    infer Result
  >
    ? Result
    : never;

export type ReclaimSolanaSponsorshipRentOptions = {
  dryRun: boolean;
  limit: number;
  minAgeSec: number;
  logger?: Logger;
  fetchAccount?: (account: string) => Promise<DflowSponsorRentAccountInfo>;
  closeAccounts?: (
    accounts: Array<{
      account: string;
      lamports: bigint;
      tokenProgramId: string;
    }>,
  ) => Promise<DflowSponsorRentCloseResult>;
};

export type ReclaimSolanaSponsorshipRentSummary = {
  checked: number;
  closed: number;
  reclaimedLamports: string;
  skipped: number;
  errors: number;
};

const TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);
const SUBMITTED_CLOSE_RETRY_AFTER_MS = 10 * 60 * 1000;

function resolveSponsorKeypair(): Keypair | null {
  return resolveHunchSolanaSponsorKeypair();
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseBigIntString(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

function bigintMin(value: bigint, ceiling: bigint | null): bigint {
  if (ceiling == null) return value;
  return value < ceiling ? value : ceiling;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRentReclaimRecord(metadata: unknown): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  const reclaim = metadata.sponsorshipRentReclaim;
  return isRecord(reclaim) ? reclaim : null;
}

function findExistingSubmittedClose(inputs: {
  metadata: unknown;
  account: string;
  nowMs: number;
}): { signature: string; error: string | null; submittedAtMs: number } | null {
  const reclaim = getRentReclaimRecord(inputs.metadata);
  if (!reclaim || !Array.isArray(reclaim.candidates)) return null;

  let closeSignature: string | null = null;
  let closeError: string | null = null;
  for (const candidate of reclaim.candidates) {
    if (!isRecord(candidate)) continue;
    if (getString(candidate.account) !== inputs.account) continue;
    if (getString(candidate.closeStatus) !== "submitted") continue;
    closeSignature = getString(candidate.closeSignature);
    closeError = getString(candidate.closeError);
    break;
  }
  if (!closeSignature) return null;

  let transactionSubmittedAtMs: number | null = null;
  if (Array.isArray(reclaim.closeTransactions)) {
    for (const tx of reclaim.closeTransactions) {
      if (!isRecord(tx) || getString(tx.signature) !== closeSignature) {
        continue;
      }
      transactionSubmittedAtMs = parseTimeMs(tx.submittedAt);
      closeError = getString(tx.error) ?? closeError;
      break;
    }
  }
  const submittedAtMs =
    transactionSubmittedAtMs ?? parseTimeMs(reclaim.reclaimedAt);
  if (
    submittedAtMs == null ||
    inputs.nowMs - submittedAtMs >= SUBMITTED_CLOSE_RETRY_AFTER_MS
  ) {
    return null;
  }

  return {
    signature: closeSignature,
    error: closeError,
    submittedAtMs,
  };
}

export function extractDflowRentReclaimCandidateAccounts(
  metadata: unknown,
): string[] {
  if (!isRecord(metadata)) return [];
  const reconciliation = metadata.sponsorshipReconciliation;
  if (!isRecord(reconciliation)) return [];
  const transactions = reconciliation.transactions;
  if (!Array.isArray(transactions)) return [];

  const accounts = new Set<string>();
  for (const tx of transactions) {
    if (!isRecord(tx)) continue;
    const deltas = tx.nonSponsorLamportDeltas;
    if (!Array.isArray(deltas)) continue;
    for (const delta of deltas) {
      if (!isRecord(delta)) continue;
      const account = getString(delta.account);
      const deltaLamports = parseBigIntString(delta.deltaLamports);
      if (account && deltaLamports != null && deltaLamports > 0n) {
        accounts.add(account);
      }
    }
  }
  return Array.from(accounts);
}

function evaluateCandidate(inputs: {
  account: string;
  info: DflowSponsorRentAccountInfo;
  sponsorAddress: string;
}):
  | {
      eligible: true;
      account: string;
      lamports: bigint;
      tokenProgramId: string;
      mint: string | null;
      tokenOwner: string | null;
      closeAuthority: string | null;
    }
  | {
      eligible: false;
      account: string;
      reason: string;
      lamports: bigint;
      tokenOwner?: string | null;
      closeAuthority?: string | null;
    } {
  if (!inputs.info.exists) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "account_missing_or_already_closed",
      lamports: 0n,
    };
  }
  if (inputs.info.lamports <= 0n) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "no_lamports",
      lamports: 0n,
      tokenOwner: inputs.info.tokenOwner,
      closeAuthority: inputs.info.closeAuthority,
    };
  }
  if (
    !inputs.info.tokenProgramId ||
    !TOKEN_PROGRAM_IDS.has(inputs.info.tokenProgramId)
  ) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "not_token_account",
      lamports: inputs.info.lamports,
      tokenOwner: inputs.info.tokenOwner,
      closeAuthority: inputs.info.closeAuthority,
    };
  }
  const effectiveCloseAuthority =
    inputs.info.closeAuthority ?? inputs.info.tokenOwner;
  if (effectiveCloseAuthority !== inputs.sponsorAddress) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "close_authority_not_sponsor",
      lamports: inputs.info.lamports,
      tokenOwner: inputs.info.tokenOwner,
      closeAuthority: inputs.info.closeAuthority,
    };
  }
  if (inputs.info.tokenAmount !== 0n) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "token_balance_not_zero",
      lamports: inputs.info.lamports,
      tokenOwner: inputs.info.tokenOwner,
      closeAuthority: inputs.info.closeAuthority,
    };
  }
  return {
    eligible: true,
    account: inputs.account,
    lamports: inputs.info.lamports,
    tokenProgramId: inputs.info.tokenProgramId,
    mint: inputs.info.mint,
    tokenOwner: inputs.info.tokenOwner,
    closeAuthority: inputs.info.closeAuthority,
  };
}

async function fetchReclaimRows(
  pool: Pool,
  inputs: { limit: number; minAgeSec: number },
): Promise<SponsorshipRentReclaimRow[]> {
  const limit = Math.max(1, Math.trunc(inputs.limit));
  const minAgeSec = Math.max(0, Math.trunc(inputs.minAgeSec));
  const { rows } = await pool.query<SponsorshipRentReclaimRow>(
    `
      select
        id,
        user_id,
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
        rent_status,
        metadata
      from solana_sponsorship_ledger
      where flow = 'dflow'
        and status in ('confirmed', 'failed')
        and (
          rent_status in ('lost', 'locked')
          or (
            rent_status = 'returned'
            and metadata #>> '{sponsorshipReconciliation,currentNonFeeCostLamports}' ~ '^[0-9]+$'
            and (metadata #>> '{sponsorshipReconciliation,currentNonFeeCostLamports}')::numeric >
              case
                when metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}' ~ '^[0-9]+$'
                  then (metadata #>> '{sponsorshipRentReclaim,reclaimedLamports}')::numeric
                else 0
              end
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

async function claimReclaimRows(
  pool: Pool,
  rows: SponsorshipRentReclaimRow[],
): Promise<SponsorshipRentReclaimRow[]> {
  if (!rows.length) return rows;
  const claimId = randomUUID();
  const { rows: claimed } = await pool.query<{ id: string }>(
    `
      update solana_sponsorship_ledger
      set
        updated_at = now(),
        metadata = metadata || jsonb_build_object(
          'sponsorshipRentReclaimClaim',
          jsonb_build_object('claimId', $2::text, 'claimedAt', now())
        )
      where id = any($1::uuid[])
        and status in ('confirmed', 'failed')
        and (
          metadata #>> '{sponsorshipRentReclaimClaim,claimId}' is null
          or updated_at <= now() - interval '10 minutes'
        )
      returning id
    `,
    [rows.map((row) => row.id), claimId],
  );
  const claimedIds = new Set(claimed.map((row) => row.id));
  return rows.filter((row) => claimedIds.has(row.id));
}

async function fetchOnchainTokenAccountInfo(
  account: string,
): Promise<DflowSponsorRentAccountInfo> {
  const rpcUrl = env.solanaRpcUrls[0];
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not configured");
  const connection = new Connection(rpcUrl, "confirmed");
  const value = (
    await connection.getParsedAccountInfo(new PublicKey(account), "confirmed")
  ).value;

  if (!value) {
    return {
      account,
      exists: false,
      lamports: 0n,
      tokenProgramId: null,
      tokenOwner: null,
      closeAuthority: null,
      tokenAmount: null,
      mint: null,
    };
  }

  const tokenProgramId = value.owner.toBase58();
  const data = value.data;
  if (!("parsed" in data) || !isRecord(data.parsed)) {
    return {
      account,
      exists: true,
      lamports: BigInt(value.lamports),
      tokenProgramId,
      tokenOwner: null,
      closeAuthority: null,
      tokenAmount: null,
      mint: null,
    };
  }

  const parsed = data.parsed;
  const info = isRecord(parsed.info) ? parsed.info : null;
  const tokenAmount = isRecord(info?.tokenAmount) ? info.tokenAmount : null;
  const amount = parseBigIntString(tokenAmount?.amount);

  return {
    account,
    exists: true,
    lamports: BigInt(value.lamports),
    tokenProgramId,
    tokenOwner: getString(info?.owner),
    closeAuthority: getString(info?.closeAuthority),
    tokenAmount: amount,
    mint: getString(info?.mint),
  };
}

function isBlockhashNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blockhash not found|blockhash expired/i.test(message);
}

async function sendCloseAccountBatch(inputs: {
  sponsorKeypair: Keypair;
  batch: Array<{ account: string; lamports: bigint; tokenProgramId: string }>;
}): Promise<string> {
  const sponsor = inputs.sponsorKeypair.publicKey;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const rpcUrl of env.solanaRpcUrls) {
      const connection = new Connection(rpcUrl, "confirmed");
      try {
        const tx = new Transaction();
        tx.feePayer = sponsor;
        const latest = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = latest.blockhash;

        for (const item of inputs.batch) {
          tx.add(
            createCloseAccountInstruction(
              new PublicKey(item.account),
              sponsor,
              sponsor,
              [],
              new PublicKey(item.tokenProgramId),
            ),
          );
        }

        tx.sign(inputs.sponsorKeypair);
        return await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 2,
        });
      } catch (error) {
        lastError = error;
        if (isBlockhashNotFoundError(error)) {
          continue;
        }
        if (env.solanaRpcUrls.length > 1) {
          continue;
        }
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Solana close account transaction failed");
}

async function closeOnchainTokenAccounts(
  accounts: Array<{
    account: string;
    lamports: bigint;
    tokenProgramId: string;
  }>,
): Promise<DflowSponsorRentCloseResult> {
  const sponsorKeypair = resolveSponsorKeypair();
  if (!sponsorKeypair) {
    throw new Error("HUNCH_SOLANA_SPONSOR_SECRET_KEY is not configured");
  }

  if (env.solanaRpcUrls.length === 0) {
    throw new Error("SOLANA_RPC_URL is not configured");
  }
  const accountResults = new Map<
    string,
    {
      status: "closed" | "submitted" | "failed";
      signature?: string;
      reclaimedLamports?: bigint;
      error?: string;
    }
  >();
  const closeTransactions: DflowSponsorRentCloseTransactions = [];

  for (let i = 0; i < accounts.length; i += 6) {
    const batch = accounts.slice(i, i + 6);
    let signature: string | null = null;
    let submittedAt: string | null = null;

    try {
      signature = await sendCloseAccountBatch({
        sponsorKeypair,
        batch,
      });
      submittedAt = new Date().toISOString();
      const confirmation = await waitForSolanaSignatureConfirmation({
        rpcUrls: env.solanaRpcUrls,
        signature,
        timeoutMs: env.solanaRpcTimeoutMs,
        commitment: "finalized",
      });
      if (confirmation.status === "fulfilled") {
        const metadata = await fetchSolanaFinalizedTransactionBalanceDeltas({
          rpcUrls: env.solanaRpcUrls,
          signature,
          timeoutMs: env.solanaRpcTimeoutMs,
        }).catch(() => null);
        closeTransactions.push({
          signature,
          accounts: batch.map((item) => item.account),
          feeLamports: metadata?.feeLamports.toString() ?? null,
          status: "closed",
          submittedAt,
        });
        for (const item of batch) {
          accountResults.set(item.account, {
            status: "closed",
            signature,
            reclaimedLamports: item.lamports,
          });
        }
        continue;
      }
      const message = `close_account_confirmation_${confirmation.status}`;
      closeTransactions.push({
        signature,
        accounts: batch.map((item) => item.account),
        feeLamports: null,
        status: confirmation.status,
        error: message,
        submittedAt,
      });
      for (const item of batch) {
        accountResults.set(item.account, {
          status: confirmation.status,
          signature,
          error: message,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signature) {
        closeTransactions.push({
          signature,
          accounts: batch.map((item) => item.account),
          feeLamports: null,
          status: "failed",
          error: message,
          submittedAt,
        });
      }
      for (const item of batch) {
        accountResults.set(item.account, {
          status: "failed",
          signature: signature ?? undefined,
          error: message,
        });
      }
    }
  }

  return { accountResults, closeTransactions };
}

function rowReclaimMetadata(inputs: {
  existingMetadata: unknown;
  candidateAccounts: string[];
  evaluations: Map<
    string,
    ReturnType<typeof evaluateCandidate> & { mint?: string | null }
  >;
  closeResults: DflowSponsorRentCloseResult | null;
  dryRun: boolean;
  openCandidateLamports: bigint;
}) {
  const existingReclaim = getRentReclaimRecord(inputs.existingMetadata);
  const previousCandidates = new Map<string, Record<string, unknown>>();
  if (existingReclaim && Array.isArray(existingReclaim.candidates)) {
    for (const candidate of existingReclaim.candidates) {
      if (!isRecord(candidate)) continue;
      const account = getString(candidate.account);
      if (account) previousCandidates.set(account, candidate);
    }
  }
  const closeTransactionsBySignature = new Map<string, unknown>();
  const reclaimedAtFallback =
    parseTimeMs(existingReclaim?.reclaimedAt) != null
      ? getString(existingReclaim?.reclaimedAt)
      : null;
  if (existingReclaim && Array.isArray(existingReclaim.closeTransactions)) {
    for (const tx of existingReclaim.closeTransactions) {
      if (!isRecord(tx)) continue;
      const signature = getString(tx.signature);
      if (!signature) continue;
      const stableTx =
        getString(tx.status) === "submitted" &&
        !getString(tx.submittedAt) &&
        reclaimedAtFallback
          ? { ...tx, submittedAt: reclaimedAtFallback }
          : tx;
      closeTransactionsBySignature.set(signature, stableTx);
    }
  }
  for (const tx of inputs.closeResults?.closeTransactions ?? []) {
    closeTransactionsBySignature.set(tx.signature, tx);
  }

  let cumulativeReclaimedLamports = 0n;
  const candidates = inputs.candidateAccounts.map((account) => {
    const evaluation = inputs.evaluations.get(account);
    const closeResult = inputs.closeResults?.accountResults.get(account);
    const previous = previousCandidates.get(account);
    const previousCloseStatus = getString(previous?.closeStatus);
    const previousCloseSignature = getString(previous?.closeSignature);
    const previousReclaimedLamports = parseBigIntString(
      previous?.reclaimedLamports,
    );
    const inferredSubmittedCloseLanded =
      closeResult == null &&
      evaluation?.eligible === false &&
      evaluation.reason === "account_missing_or_already_closed" &&
      previousCloseStatus === "submitted" &&
      previousCloseSignature != null;
    const reclaimedLamports =
      closeResult?.reclaimedLamports ??
      previousReclaimedLamports ??
      (inferredSubmittedCloseLanded
        ? parseBigIntString(previous?.lamports)
        : null);
    if (reclaimedLamports != null && reclaimedLamports > 0n) {
      cumulativeReclaimedLamports += reclaimedLamports;
    }
    const closeStatus =
      closeResult?.status ??
      (inferredSubmittedCloseLanded ? "closed" : previousCloseStatus) ??
      null;
    if (inferredSubmittedCloseLanded && previousCloseSignature) {
      const previousTransaction = closeTransactionsBySignature.get(
        previousCloseSignature,
      );
      if (isRecord(previousTransaction)) {
        closeTransactionsBySignature.set(previousCloseSignature, {
          ...previousTransaction,
          status: "closed",
          error: null,
        });
      }
    }

    return {
      account,
      eligible: evaluation?.eligible === true,
      reason: evaluation?.eligible === false ? evaluation.reason : null,
      lamports: evaluation?.lamports?.toString?.() ?? "0",
      tokenProgramId:
        evaluation?.eligible === true ? evaluation.tokenProgramId : null,
      mint: evaluation?.eligible === true ? evaluation.mint : null,
      tokenOwner: evaluation?.tokenOwner ?? null,
      closeAuthority: evaluation?.closeAuthority ?? null,
      closeStatus,
      closeSignature: closeResult?.signature ?? previousCloseSignature ?? null,
      closeError:
        closeResult?.error ??
        (inferredSubmittedCloseLanded ? null : getString(previous?.closeError)),
      reclaimedLamports: reclaimedLamports?.toString?.() ?? null,
    };
  });

  return {
    sponsorshipRentReclaim: {
      reclaimedAt: new Date().toISOString(),
      dryRun: inputs.dryRun,
      remainingOpenLamports: inputs.openCandidateLamports.toString(),
      openCandidateLamports: inputs.openCandidateLamports.toString(),
      reclaimedLamports: cumulativeReclaimedLamports.toString(),
      candidates,
      closeTransactions: Array.from(closeTransactionsBySignature.values()),
    },
  };
}

function calculateNetActualSponsorLamportsAfterReclaim(inputs: {
  row: SponsorshipRentReclaimRow;
  metadata: Record<string, unknown>;
}): bigint | null {
  const previousActual = parseBigIntString(inputs.row.actual_sponsor_lamports);
  if (previousActual == null) return null;
  const reclaim = isRecord(inputs.metadata.sponsorshipRentReclaim)
    ? inputs.metadata.sponsorshipRentReclaim
    : null;
  const reclaimedLamports = parseBigIntString(reclaim?.reclaimedLamports) ?? 0n;
  const closeFeeLamports = Array.isArray(reclaim?.closeTransactions)
    ? reclaim.closeTransactions.reduce((sum, entry) => {
        if (!isRecord(entry)) return sum;
        return sum + (parseBigIntString(entry.feeLamports) ?? 0n);
      }, 0n)
    : 0n;
  const net = previousActual - reclaimedLamports + closeFeeLamports;
  return net > 0n ? net : 0n;
}

function getCurrentNonFeeSponsorCostLamports(metadata: unknown): bigint | null {
  if (!isRecord(metadata)) return null;
  const reconciliation = metadata.sponsorshipReconciliation;
  if (!isRecord(reconciliation)) return null;
  return parseBigIntString(reconciliation.currentNonFeeCostLamports);
}

function getRentReclaimReclaimedLamports(
  metadata: Record<string, unknown>,
): bigint {
  const reclaim = isRecord(metadata.sponsorshipRentReclaim)
    ? metadata.sponsorshipRentReclaim
    : null;
  return parseBigIntString(reclaim?.reclaimedLamports) ?? 0n;
}

function calculateRemainingSponsorLossLamports(inputs: {
  row: SponsorshipRentReclaimRow;
  metadata: Record<string, unknown>;
  fallbackOpenLamports: bigint;
}): bigint {
  const grossNonFeeCost =
    getCurrentNonFeeSponsorCostLamports(inputs.row.metadata) ??
    inputs.fallbackOpenLamports;
  const reclaimedLamports = getRentReclaimReclaimedLamports(inputs.metadata);
  const remaining =
    grossNonFeeCost > reclaimedLamports
      ? grossNonFeeCost - reclaimedLamports
      : 0n;
  const actualSponsorLamports = parseBigIntString(
    inputs.row.actual_sponsor_lamports,
  );
  return bigintMin(remaining, actualSponsorLamports);
}

function sumRentReclaimCloseFeeLamports(
  metadata: Record<string, unknown>,
): bigint {
  const reclaim = isRecord(metadata.sponsorshipRentReclaim)
    ? metadata.sponsorshipRentReclaim
    : null;
  return Array.isArray(reclaim?.closeTransactions)
    ? reclaim.closeTransactions.reduce((sum, entry) => {
        if (!isRecord(entry)) return sum;
        return sum + (parseBigIntString(entry.feeLamports) ?? 0n);
      }, 0n)
    : 0n;
}

function attachRentReclaimAccountingMetadata(inputs: {
  row: SponsorshipRentReclaimRow;
  metadata: Record<string, unknown>;
  remainingSponsorLossLamports: bigint;
}): Record<string, unknown> {
  const previousActual = parseBigIntString(inputs.row.actual_sponsor_lamports);
  const netActual = calculateNetActualSponsorLamportsAfterReclaim(inputs);
  if (
    previousActual == null ||
    netActual == null ||
    !isRecord(inputs.metadata.sponsorshipRentReclaim)
  ) {
    return inputs.metadata;
  }
  return {
    ...inputs.metadata,
    sponsorshipRentReclaim: {
      ...inputs.metadata.sponsorshipRentReclaim,
      grossActualSponsorLamports: previousActual.toString(),
      closeFeeLamports: sumRentReclaimCloseFeeLamports(
        inputs.metadata,
      ).toString(),
      netActualSponsorLamports: netActual.toString(),
      remainingOpenLamports: inputs.remainingSponsorLossLamports.toString(),
      remainingSponsorLossLamports:
        inputs.remainingSponsorLossLamports.toString(),
    },
  };
}

function isPendingSponsorRecoverableRent(
  evaluation: ReturnType<typeof evaluateCandidate>,
  closeResult: DflowSponsorRentCloseAccountResult | undefined,
): boolean {
  if (evaluation.eligible) return closeResult?.status !== "closed";
  return evaluation.reason === "token_balance_not_zero";
}

function buildAccountOwnerRows(
  rows: SponsorshipRentReclaimRow[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    for (const account of extractDflowRentReclaimCandidateAccounts(
      row.metadata,
    )) {
      if (!owners.has(account)) owners.set(account, row.id);
    }
  }
  return owners;
}

function filterCloseResultsForRow(inputs: {
  row: SponsorshipRentReclaimRow;
  closeResults: DflowSponsorRentCloseResult | null;
  accountOwnerRows: Map<string, string>;
}): DflowSponsorRentCloseResult | null {
  const closeResults = inputs.closeResults;
  if (!closeResults) return null;

  const accountResults = new Map<string, DflowSponsorRentCloseAccountResult>();
  for (const account of extractDflowRentReclaimCandidateAccounts(
    inputs.row.metadata,
  )) {
    if (inputs.accountOwnerRows.get(account) !== inputs.row.id) continue;
    const result = closeResults.accountResults.get(account);
    if (result) accountResults.set(account, result);
  }

  const closeTransactions: DflowSponsorRentCloseTransactions = [];
  for (const closeTransaction of closeResults.closeTransactions) {
    const ownedAccounts = closeTransaction.accounts.filter(
      (account) => inputs.accountOwnerRows.get(account) === inputs.row.id,
    );
    if (!ownedAccounts.length) continue;
    const firstOwnerRow = closeTransaction.accounts
      .map((account) => inputs.accountOwnerRows.get(account) ?? null)
      .find((rowId): rowId is string => Boolean(rowId));
    closeTransactions.push({
      signature: closeTransaction.signature,
      accounts: ownedAccounts,
      feeLamports:
        firstOwnerRow === inputs.row.id ? closeTransaction.feeLamports : "0",
      status: closeTransaction.status,
      error: closeTransaction.error,
      submittedAt: closeTransaction.submittedAt,
    });
  }

  return { accountResults, closeTransactions };
}

async function updateReclaimRow(
  pool: Pool,
  row: SponsorshipRentReclaimRow,
  inputs: {
    rentLamports: bigint;
    rentStatus: "returned" | "lost" | "locked" | "partially_reclaimed";
    actualSponsorLamports: bigint | null;
    metadata: Record<string, unknown>;
  },
) {
  await pool.query(
    `
      update solana_sponsorship_ledger
      set
        updated_at = now(),
        rent_lamports = $2::numeric,
        rent_status = $3,
        actual_sponsor_lamports = coalesce($4::numeric, actual_sponsor_lamports),
        metadata = metadata || $5::jsonb
      where id = $1
        and status in ('confirmed', 'failed')
        and rent_status in ('locked', 'lost', 'returned', 'partially_reclaimed')
    `,
    [
      row.id,
      inputs.rentLamports.toString(),
      inputs.rentStatus,
      inputs.actualSponsorLamports?.toString() ?? null,
      JSON.stringify(inputs.metadata),
    ],
  );
}

export async function reclaimSolanaSponsorshipRentAccounts(
  pool: Pool,
  options: ReclaimSolanaSponsorshipRentOptions,
): Promise<ReclaimSolanaSponsorshipRentSummary> {
  const fetchedRows = await fetchReclaimRows(pool, {
    limit: options.limit,
    minAgeSec: options.minAgeSec,
  });
  const rows = options.dryRun
    ? fetchedRows
    : await claimReclaimRows(pool, fetchedRows);
  const summary: ReclaimSolanaSponsorshipRentSummary = {
    checked: rows.length,
    closed: 0,
    reclaimedLamports: "0",
    skipped: 0,
    errors: 0,
  };

  const accountToRows = new Map<string, SponsorshipRentReclaimRow[]>();
  for (const row of rows) {
    const accounts = extractDflowRentReclaimCandidateAccounts(row.metadata);
    for (const account of accounts) {
      const existing = accountToRows.get(account);
      if (existing) {
        existing.push(row);
      } else {
        accountToRows.set(account, [row]);
      }
    }
  }
  const accountOwnerRows = buildAccountOwnerRows(rows);
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  const fetchAccount = options.fetchAccount ?? fetchOnchainTokenAccountInfo;
  const evaluations = new Map<string, ReturnType<typeof evaluateCandidate>>();
  for (const [account, accountRows] of accountToRows) {
    const sponsorAddress = accountRows[0]?.sponsor_address?.trim();
    if (!sponsorAddress) {
      evaluations.set(account, {
        eligible: false,
        account,
        reason: "missing_sponsor_address",
        lamports: 0n,
      });
      continue;
    }
    try {
      evaluations.set(
        account,
        evaluateCandidate({
          account,
          info: await fetchAccount(account),
          sponsorAddress,
        }),
      );
    } catch (error) {
      summary.errors += 1;
      evaluations.set(account, {
        eligible: false,
        account,
        reason: "account_fetch_failed",
        lamports: 0n,
      });
      options.logger?.error?.(
        { error, account },
        "Solana sponsorship rent account fetch failed",
      );
    }
  }

  const eligible = Array.from(evaluations.values()).filter(
    (
      evaluation,
    ): evaluation is Extract<
      ReturnType<typeof evaluateCandidate>,
      { eligible: true }
    > => evaluation.eligible,
  );
  const nowMs = Date.now();
  const freshSubmittedCloseResults = new Map<
    string,
    DflowSponsorRentCloseAccountResult
  >();
  for (const entry of eligible) {
    const ownerRowId = accountOwnerRows.get(entry.account);
    const ownerRow = ownerRowId ? rowsById.get(ownerRowId) : null;
    const existingClose = ownerRow
      ? findExistingSubmittedClose({
          metadata: ownerRow.metadata,
          account: entry.account,
          nowMs,
        })
      : null;
    if (!existingClose) continue;
    freshSubmittedCloseResults.set(entry.account, {
      status: "submitted",
      signature: existingClose.signature,
      error: existingClose.error ?? "close_account_confirmation_submitted",
    });
  }
  const eligibleToClose = eligible.filter(
    (entry) => !freshSubmittedCloseResults.has(entry.account),
  );
  const closeAccounts = options.closeAccounts ?? closeOnchainTokenAccounts;
  let closeResults: DflowSponsorRentCloseResult | null =
    freshSubmittedCloseResults.size > 0
      ? {
          accountResults: new Map(freshSubmittedCloseResults),
          closeTransactions: [],
        }
      : null;
  if (eligibleToClose.length > 0 && !options.dryRun) {
    try {
      const submittedCloseResults = await closeAccounts(
        eligibleToClose.map((entry) => ({
          account: entry.account,
          lamports: entry.lamports,
          tokenProgramId: entry.tokenProgramId,
        })),
      );
      if (closeResults) {
        for (const [account, result] of submittedCloseResults.accountResults) {
          closeResults.accountResults.set(account, result);
        }
        closeResults.closeTransactions.push(
          ...submittedCloseResults.closeTransactions,
        );
      } else {
        closeResults = submittedCloseResults;
      }
    } catch (error) {
      summary.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      const failedCloseResults: DflowSponsorRentCloseResult = {
        accountResults: new Map(
          eligibleToClose.map((entry) => [
            entry.account,
            {
              status: "failed" as const,
              error: message,
            },
          ]),
        ),
        closeTransactions: [],
      };
      if (closeResults) {
        for (const [account, result] of failedCloseResults.accountResults) {
          closeResults.accountResults.set(account, result);
        }
      } else {
        closeResults = failedCloseResults;
      }
      options.logger?.error?.(
        { error },
        "Solana sponsorship rent close failed",
      );
    }
  }

  let reclaimedLamports = 0n;
  for (const evaluation of evaluations.values()) {
    if (!evaluation.eligible) {
      summary.skipped += 1;
      continue;
    }
    const closeResult = closeResults?.accountResults.get(evaluation.account);
    if (closeResult?.status === "closed") {
      summary.closed += 1;
      reclaimedLamports += closeResult.reclaimedLamports ?? evaluation.lamports;
    } else {
      summary.skipped += 1;
    }
  }
  summary.reclaimedLamports = reclaimedLamports.toString();

  for (const row of rows) {
    const candidateAccounts = extractDflowRentReclaimCandidateAccounts(
      row.metadata,
    );
    let openCandidateLamports = 0n;
    let hasPendingRecoverableRent = false;
    for (const account of candidateAccounts) {
      const evaluation = evaluations.get(account);
      if (!evaluation) continue;
      const ownerRowId = accountOwnerRows.get(account);
      if (evaluation.eligible && ownerRowId && ownerRowId !== row.id) {
        continue;
      }
      const closeResult = closeResults?.accountResults.get(account);
      if (isPendingSponsorRecoverableRent(evaluation, closeResult)) {
        openCandidateLamports += evaluation.lamports;
        hasPendingRecoverableRent = true;
      }
    }

    if (!options.dryRun) {
      const rowCloseResults = filterCloseResultsForRow({
        row,
        closeResults,
        accountOwnerRows,
      });
      const metadata = rowReclaimMetadata({
        existingMetadata: row.metadata,
        candidateAccounts,
        evaluations,
        closeResults: rowCloseResults,
        dryRun: options.dryRun,
        openCandidateLamports,
      });
      const remainingSponsorLossLamports = calculateRemainingSponsorLossLamports(
        {
          row,
          metadata,
          fallbackOpenLamports: openCandidateLamports,
        },
      );
      const accountingMetadata = attachRentReclaimAccountingMetadata({
        row,
        metadata,
        remainingSponsorLossLamports,
      });
      const reclaimedLamports =
        getRentReclaimReclaimedLamports(accountingMetadata);
      const rentStatus =
        remainingSponsorLossLamports === 0n
          ? "returned"
          : hasPendingRecoverableRent
            ? "locked"
            : reclaimedLamports > 0n
              ? "partially_reclaimed"
              : "lost";
      await updateReclaimRow(pool, row, {
        rentLamports: remainingSponsorLossLamports,
        rentStatus,
        actualSponsorLamports: null,
        metadata: accountingMetadata,
      });
    }
  }

  return summary;
}
