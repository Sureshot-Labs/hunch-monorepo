import { randomUUID } from "node:crypto";

import {
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { Pool } from "@hunch/infra";
import bs58 from "bs58";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchSolanaFinalizedTransactionBalanceDeltas,
  waitForSolanaSignatureConfirmation,
} from "./solana-rpc.js";

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
  rent_status: "unknown" | "locked" | "returned" | "lost" | null;
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
}>;

export type DflowSponsorRentCloseResult = {
  accountResults: Map<
    string,
    {
      status: "closed" | "failed";
      signature?: string;
      reclaimedLamports?: bigint;
      error?: string;
    }
  >;
  closeTransactions: DflowSponsorRentCloseTransactions;
};

type DflowSponsorRentCloseAccountResult =
  DflowSponsorRentCloseResult["accountResults"] extends Map<string, infer Result>
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

function loadSolanaKeypairFromSecret(raw: string): Keypair {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Missing HUNCH_SOLANA_SPONSOR_SECRET_KEY");
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          typeof entry !== "number" ||
          !Number.isInteger(entry) ||
          entry < 0 ||
          entry > 255,
      )
    ) {
      throw new Error("Invalid HUNCH_SOLANA_SPONSOR_SECRET_KEY array");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function resolveSponsorKeypair(): Keypair | null {
  if (!env.hunchSolanaSponsorSecretKey) return null;
  const keypair = loadSolanaKeypairFromSecret(env.hunchSolanaSponsorSecretKey);
  const derivedAddress = keypair.publicKey.toBase58();
  if (
    env.hunchSolanaSponsorAddress &&
    env.hunchSolanaSponsorAddress !== derivedAddress
  ) {
    throw new Error(
      "HUNCH_SOLANA_SPONSOR_ADDRESS does not match HUNCH_SOLANA_SPONSOR_SECRET_KEY",
    );
  }
  return keypair;
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
  if (
    inputs.info.tokenOwner !== inputs.sponsorAddress &&
    inputs.info.closeAuthority !== inputs.sponsorAddress
  ) {
    return {
      eligible: false,
      account: inputs.account,
      reason: "token_owner_or_close_authority_not_sponsor",
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
        and status = 'confirmed'
        and (
          rent_status in ('lost', 'locked')
          or (
          rent_status = 'returned'
          and metadata #>> '{sponsorshipReconciliation,currentNonFeeCostLamports}' ~ '^[0-9]+$'
          and (metadata #>> '{sponsorshipReconciliation,currentNonFeeCostLamports}')::numeric > 0
          and coalesce(metadata #>> '{sponsorshipRentReclaim,remainingOpenLamports}', '') <> '0'
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
        and status = 'confirmed'
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
  accounts: Array<{ account: string; lamports: bigint; tokenProgramId: string }>,
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
      status: "closed" | "failed";
      signature?: string;
      reclaimedLamports?: bigint;
      error?: string;
    }
  >();
  const closeTransactions: DflowSponsorRentCloseTransactions = [];

  for (let i = 0; i < accounts.length; i += 6) {
    const batch = accounts.slice(i, i + 6);

    try {
      const signature = await sendCloseAccountBatch({
        sponsorKeypair,
        batch,
      });
      const confirmation = await waitForSolanaSignatureConfirmation({
        rpcUrls: env.solanaRpcUrls,
        signature,
        timeoutMs: env.solanaRpcTimeoutMs,
        commitment: "finalized",
      });
      if (confirmation.status !== "fulfilled") {
        throw new Error(
          `close_account_confirmation_${confirmation.status}`,
        );
      }
      const metadata = await fetchSolanaFinalizedTransactionBalanceDeltas({
        rpcUrls: env.solanaRpcUrls,
        signature,
        timeoutMs: env.solanaRpcTimeoutMs,
      }).catch(() => null);
      closeTransactions.push({
        signature,
        accounts: batch.map((item) => item.account),
        feeLamports: metadata?.feeLamports.toString() ?? null,
      });
      for (const item of batch) {
        accountResults.set(item.account, {
          status: "closed",
          signature,
          reclaimedLamports: item.lamports,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of batch) {
        accountResults.set(item.account, {
          status: "failed",
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
  remainingOpenLamports: bigint;
}) {
  const existingReclaim = isRecord(inputs.existingMetadata)
    ? inputs.existingMetadata.sponsorshipRentReclaim
    : null;
  const previousCandidates = new Map<string, Record<string, unknown>>();
  if (isRecord(existingReclaim) && Array.isArray(existingReclaim.candidates)) {
    for (const candidate of existingReclaim.candidates) {
      if (!isRecord(candidate)) continue;
      const account = getString(candidate.account);
      if (account) previousCandidates.set(account, candidate);
    }
  }
  const closeTransactionsBySignature = new Map<string, unknown>();
  if (
    isRecord(existingReclaim) &&
    Array.isArray(existingReclaim.closeTransactions)
  ) {
    for (const tx of existingReclaim.closeTransactions) {
      if (!isRecord(tx)) continue;
      const signature = getString(tx.signature);
      if (signature) closeTransactionsBySignature.set(signature, tx);
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
    const reclaimedLamports =
      closeResult?.reclaimedLamports ?? previousReclaimedLamports;
    if (reclaimedLamports != null && reclaimedLamports > 0n) {
      cumulativeReclaimedLamports += reclaimedLamports;
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
      closeStatus: closeResult?.status ?? previousCloseStatus ?? null,
      closeSignature: closeResult?.signature ?? previousCloseSignature ?? null,
      closeError: closeResult?.error ?? getString(previous?.closeError),
      reclaimedLamports: reclaimedLamports?.toString?.() ?? null,
    };
  });

  return {
    sponsorshipRentReclaim: {
      reclaimedAt: new Date().toISOString(),
      dryRun: inputs.dryRun,
      remainingOpenLamports: inputs.remainingOpenLamports.toString(),
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

function sumRentReclaimCloseFeeLamports(metadata: Record<string, unknown>): bigint {
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
      closeFeeLamports: sumRentReclaimCloseFeeLamports(inputs.metadata).toString(),
      netActualSponsorLamports: netActual.toString(),
    },
  };
}

function buildAccountOwnerRows(
  rows: SponsorshipRentReclaimRow[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    for (const account of extractDflowRentReclaimCandidateAccounts(row.metadata)) {
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
  for (const account of extractDflowRentReclaimCandidateAccounts(inputs.row.metadata)) {
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
    });
  }

  return { accountResults, closeTransactions };
}

async function updateReclaimRow(
  pool: Pool,
  row: SponsorshipRentReclaimRow,
  inputs: {
    rentLamports: bigint;
    rentStatus: "returned" | "lost" | "locked";
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
        and status = 'confirmed'
        and rent_status in ('locked', 'lost', 'returned')
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
    ): evaluation is Extract<ReturnType<typeof evaluateCandidate>, { eligible: true }> =>
      evaluation.eligible,
  );
  const closeAccounts = options.closeAccounts ?? closeOnchainTokenAccounts;
  let closeResults: DflowSponsorRentCloseResult | null = null;
  if (eligible.length > 0 && !options.dryRun) {
    try {
      closeResults = await closeAccounts(
        eligible.map((entry) => ({
          account: entry.account,
          lamports: entry.lamports,
          tokenProgramId: entry.tokenProgramId,
        })),
      );
    } catch (error) {
      summary.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      closeResults = {
        accountResults: new Map(
          eligible.map((entry) => [
            entry.account,
            {
              status: "failed" as const,
              error: message,
            },
          ]),
        ),
        closeTransactions: [],
      };
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
    let remainingOpenLamports = 0n;
    for (const account of candidateAccounts) {
      const evaluation = evaluations.get(account);
      if (!evaluation) continue;
      if (evaluation.eligible) {
        const ownerRowId = accountOwnerRows.get(account);
        if (ownerRowId && ownerRowId !== row.id) continue;
        const closeResult = closeResults?.accountResults.get(account);
        if (closeResult?.status !== "closed") {
          remainingOpenLamports += evaluation.lamports;
        }
        continue;
      }
      if (evaluation.lamports > 0n) {
        remainingOpenLamports += evaluation.lamports;
      }
    }
    const rentStatus =
      remainingOpenLamports === 0n
        ? "returned"
        : row.rent_status === "locked"
          ? "locked"
          : "lost";

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
        remainingOpenLamports,
      });
      const accountingMetadata = attachRentReclaimAccountingMetadata({
        row,
        metadata,
      });
      await updateReclaimRow(pool, row, {
        rentLamports: remainingOpenLamports,
        rentStatus,
        actualSponsorLamports: null,
        metadata: accountingMetadata,
      });
    }
  }

  return summary;
}
