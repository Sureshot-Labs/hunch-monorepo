import {
  createBurnInstruction,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Pool } from "pg";

import {
  fetchSolanaLatestBlockhash,
  fetchSolanaTokenAccountBalance,
  fetchSolanaTokenAccountByOwnerAndMint,
  fetchSolanaTokenAccountInfo,
} from "./solana-rpc.js";

export const KALSHI_LOSS_CLOSE_TRANSACTION_ID_PREFIX = "kalshi-loss-close:";

const KALSHI_LOSS_CLOSE_LABEL = "Close resolved Kalshi token account";
const TOKEN_BURN_INSTRUCTION = 8;
const TOKEN_CLOSE_ACCOUNT_INSTRUCTION = 9;

type KalshiLossCloseSkipReason =
  | "not_solana_kalshi_token"
  | "position_not_hidden"
  | "not_resolved_loss"
  | "token_account_missing"
  | "token_account_mint_mismatch"
  | "token_account_owner_mismatch"
  | "close_authority_mismatch"
  | "unsupported_token_program"
  | "token_balance_missing"
  | "blockhash_unavailable";

export type KalshiLossCloseTransaction = {
  id: string;
  label: string;
  transaction: string;
  encoding: "base64";
  mint: string;
  tokenAccount: string;
  amountRaw: string;
};

export type KalshiLossClosePrepareResult =
  | { transaction: KalshiLossCloseTransaction; skippedReason?: never }
  | { transaction: null; skippedReason: KalshiLossCloseSkipReason };

type KalshiTokenResolutionRow = {
  side: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
};

function normalizePublicKey(value: string): string | null {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return null;
  }
}

export function normalizeKalshiSolanaPositionMint(
  tokenId: string,
): string | null {
  const trimmed = tokenId.trim();
  if (!trimmed.startsWith("sol:")) return null;
  return normalizePublicKey(trimmed.slice(4));
}

export function buildKalshiLossCloseTransactionId(tokenId: string): string {
  return `${KALSHI_LOSS_CLOSE_TRANSACTION_ID_PREFIX}${tokenId.trim()}`;
}

export function parseKalshiLossCloseTransactionTokenId(
  requestId: string,
): string | null {
  if (!requestId.startsWith(KALSHI_LOSS_CLOSE_TRANSACTION_ID_PREFIX)) {
    return null;
  }
  const tokenId = requestId.slice(KALSHI_LOSS_CLOSE_TRANSACTION_ID_PREFIX.length);
  return tokenId.trim().length > 0 ? tokenId : null;
}

function parseResolvedOutcomePct(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveYesProbability(row: KalshiTokenResolutionRow): number | null {
  const resolvedOutcome = row.resolved_outcome?.trim().toUpperCase() ?? null;
  if (resolvedOutcome === "YES") return 1;
  if (resolvedOutcome === "NO") return 0;
  const pct = parseResolvedOutcomePct(row.resolved_outcome_pct);
  if (pct == null) return null;
  return Math.max(0, Math.min(1, pct / 10_000));
}

function isResolvedLosingToken(row: KalshiTokenResolutionRow): boolean {
  const side = row.side?.trim().toUpperCase();
  if (side !== "YES" && side !== "NO") return false;
  const yesProbability = resolveYesProbability(row);
  if (yesProbability == null) return false;
  const sideProbability = side === "YES" ? yesProbability : 1 - yesProbability;
  return sideProbability <= 0;
}

async function fetchKalshiLossProof(inputs: {
  pool: Pool;
  tokenId: string;
}): Promise<boolean> {
  const { rows } = await inputs.pool.query<KalshiTokenResolutionRow>(
    `
      with matches as (
        select ut.side, m.resolved_outcome, m.resolved_outcome_pct
        from unified_tokens ut
        join unified_markets m on m.id = ut.market_id
        where ut.venue = 'kalshi'
          and ut.token_id = $1
        union all
        select umt.outcome_side as side, m.resolved_outcome, m.resolved_outcome_pct
        from unified_market_tokens umt
        join unified_markets m on m.id = umt.market_id
        where umt.venue = 'kalshi'
          and umt.token_id = $1
        union all
        select 'YES'::text as side, m.resolved_outcome, m.resolved_outcome_pct
        from unified_markets m
        where m.venue = 'kalshi'
          and m.token_yes = $1
        union all
        select 'NO'::text as side, m.resolved_outcome, m.resolved_outcome_pct
        from unified_markets m
        where m.venue = 'kalshi'
          and m.token_no = $1
      )
      select side, resolved_outcome, resolved_outcome_pct
      from matches
      limit 4
    `,
    [inputs.tokenId],
  );

  return rows.some((row) => isResolvedLosingToken(row));
}

async function hasHiddenOwnKalshiPosition(inputs: {
  pool: Pool;
  userId: string;
  walletAddress: string;
  tokenId: string;
}): Promise<boolean> {
  const { rows } = await inputs.pool.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from positions
        where user_id = $1
          and venue = 'kalshi'
          and wallet_address = $2
          and token_id = $3
          and position_scope = 'own'
          and is_hidden = true
      ) as exists
    `,
    [inputs.userId, inputs.walletAddress, inputs.tokenId],
  );
  return rows[0]?.exists === true;
}

function resolveTokenProgram(programId: string): PublicKey | null {
  if (programId === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (programId === TOKEN_2022_PROGRAM_ID.toBase58())
    return TOKEN_2022_PROGRAM_ID;
  return null;
}

async function resolveCloseCandidate(inputs: {
  pool: Pool;
  userId: string;
  walletAddress: string;
  tokenId: string;
  rpcUrls: string[];
  timeoutMs: number;
}): Promise<
  | {
      wallet: PublicKey;
      mint: PublicKey;
      tokenAccount: PublicKey;
      tokenProgram: PublicKey;
      amount: bigint;
    }
  | { skippedReason: KalshiLossCloseSkipReason }
> {
  const mintAddress = normalizeKalshiSolanaPositionMint(inputs.tokenId);
  if (!mintAddress) return { skippedReason: "not_solana_kalshi_token" };

  const walletAddress = normalizePublicKey(inputs.walletAddress);
  if (!walletAddress) return { skippedReason: "token_account_owner_mismatch" };

  const hasHiddenPosition = await hasHiddenOwnKalshiPosition({
    pool: inputs.pool,
    userId: inputs.userId,
    walletAddress,
    tokenId: inputs.tokenId,
  });
  if (!hasHiddenPosition) return { skippedReason: "position_not_hidden" };

  const isLoss = await fetchKalshiLossProof({
    pool: inputs.pool,
    tokenId: inputs.tokenId,
  });
  if (!isLoss) return { skippedReason: "not_resolved_loss" };

  const account = await fetchSolanaTokenAccountByOwnerAndMint({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    owner: walletAddress,
    mint: mintAddress,
  });
  if (!account) return { skippedReason: "token_account_missing" };

  const accountInfo = await fetchSolanaTokenAccountInfo({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    account,
  });
  if (!accountInfo) return { skippedReason: "token_account_missing" };
  if (accountInfo.mint !== mintAddress) {
    return { skippedReason: "token_account_mint_mismatch" };
  }
  if (accountInfo.owner !== walletAddress) {
    return { skippedReason: "token_account_owner_mismatch" };
  }
  if (
    accountInfo.closeAuthority != null &&
    accountInfo.closeAuthority !== walletAddress
  ) {
    return { skippedReason: "close_authority_mismatch" };
  }

  const tokenProgram = resolveTokenProgram(accountInfo.programId);
  if (!tokenProgram) return { skippedReason: "unsupported_token_program" };

  const balance = await fetchSolanaTokenAccountBalance({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
    account,
  });
  if (!balance) return { skippedReason: "token_balance_missing" };

  return {
    wallet: new PublicKey(walletAddress),
    mint: new PublicKey(mintAddress),
    tokenAccount: new PublicKey(account),
    tokenProgram,
    amount: balance.amount,
  };
}

export async function buildKalshiLossCloseTransaction(inputs: {
  pool: Pool;
  userId: string;
  walletAddress: string;
  tokenId: string;
  rpcUrls: string[];
  timeoutMs: number;
}): Promise<KalshiLossClosePrepareResult> {
  const candidate = await resolveCloseCandidate(inputs);
  if ("skippedReason" in candidate) {
    return { transaction: null, skippedReason: candidate.skippedReason };
  }

  const blockhash = await fetchSolanaLatestBlockhash({
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
  });
  if (!blockhash) {
    return { transaction: null, skippedReason: "blockhash_unavailable" };
  }

  const instructions = [];
  if (candidate.amount > 0n) {
    instructions.push(
      createBurnInstruction(
        candidate.tokenAccount,
        candidate.mint,
        candidate.wallet,
        candidate.amount,
        [],
        candidate.tokenProgram,
      ),
    );
  }
  instructions.push(
    createCloseAccountInstruction(
      candidate.tokenAccount,
      candidate.wallet,
      candidate.wallet,
      [],
      candidate.tokenProgram,
    ),
  );

  const message = new TransactionMessage({
    payerKey: candidate.wallet,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const transactionBase64 = Buffer.from(transaction.serialize()).toString(
    "base64",
  );

  return {
    transaction: {
      id: buildKalshiLossCloseTransactionId(inputs.tokenId),
      label: KALSHI_LOSS_CLOSE_LABEL,
      transaction: transactionBase64,
      encoding: "base64",
      mint: candidate.mint.toBase58(),
      tokenAccount: candidate.tokenAccount.toBase58(),
      amountRaw: candidate.amount.toString(),
    },
  };
}

function deserializeTransaction(payload: string): VersionedTransaction | null {
  try {
    return VersionedTransaction.deserialize(Buffer.from(payload, "base64"));
  } catch {
    return null;
  }
}

function getRequiredSigners(transaction: VersionedTransaction): string[] {
  return transaction.message.staticAccountKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
}

function getStaticAccount(
  transaction: VersionedTransaction,
  index: number,
): PublicKey | null {
  return transaction.message.staticAccountKeys[index] ?? null;
}

function readTokenAmount(data: Uint8Array): bigint | null {
  if (data.length !== 9) return null;
  try {
    return Buffer.from(data).readBigUInt64LE(1);
  } catch {
    return null;
  }
}

export async function validateKalshiLossCloseSponsoredTransaction(inputs: {
  pool: Pool;
  userId: string;
  walletAddress: string;
  requestId: string;
  transaction: string;
  rpcUrls: string[];
  timeoutMs: number;
}): Promise<void> {
  const tokenId = parseKalshiLossCloseTransactionTokenId(inputs.requestId);
  if (!tokenId) {
    throw new Error("Unsupported sponsored Solana transaction.");
  }

  const candidate = await resolveCloseCandidate({
    pool: inputs.pool,
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    tokenId,
    rpcUrls: inputs.rpcUrls,
    timeoutMs: inputs.timeoutMs,
  });
  if ("skippedReason" in candidate) {
    throw new Error(
      `Kalshi loss close transaction is not sponsorable: ${candidate.skippedReason}.`,
    );
  }

  const transaction = deserializeTransaction(inputs.transaction.trim());
  if (!transaction) {
    throw new Error("Kalshi loss close transaction is malformed.");
  }

  if (
    "addressTableLookups" in transaction.message &&
    transaction.message.addressTableLookups.length > 0
  ) {
    throw new Error("Kalshi loss close transaction cannot use address tables.");
  }

  const walletAddress = candidate.wallet.toBase58();
  const requiredSigners = getRequiredSigners(transaction);
  if (requiredSigners.length !== 1 || requiredSigners[0] !== walletAddress) {
    throw new Error("Kalshi loss close signer does not match selected wallet.");
  }

  const feePayer = transaction.message.staticAccountKeys[0]?.toBase58() ?? null;
  if (feePayer !== walletAddress) {
    throw new Error("Kalshi loss close fee payer does not match selected wallet.");
  }

  const expectedProgram = candidate.tokenProgram.toBase58();
  const expectedTokenAccount = candidate.tokenAccount.toBase58();
  const expectedMint = candidate.mint.toBase58();
  let burnAmount: bigint | null = null;
  let sawClose = false;

  for (const instruction of transaction.message.compiledInstructions) {
    const programId = getStaticAccount(
      transaction,
      instruction.programIdIndex,
    )?.toBase58();
    if (programId !== expectedProgram) {
      throw new Error("Kalshi loss close transaction has unsupported program.");
    }

    const data = instruction.data;
    const tag = data[0];
    const accounts = instruction.accountKeyIndexes.map((index) =>
      getStaticAccount(transaction, index)?.toBase58(),
    );

    if (tag === TOKEN_BURN_INSTRUCTION) {
      if (burnAmount != null) {
        throw new Error("Kalshi loss close transaction has duplicate burn.");
      }
      if (
        accounts[0] !== expectedTokenAccount ||
        accounts[1] !== expectedMint ||
        accounts[2] !== walletAddress
      ) {
        throw new Error("Kalshi loss close burn accounts do not match.");
      }
      burnAmount = readTokenAmount(data);
      if (burnAmount == null || burnAmount <= 0n) {
        throw new Error("Kalshi loss close burn amount is invalid.");
      }
      continue;
    }

    if (tag === TOKEN_CLOSE_ACCOUNT_INSTRUCTION) {
      if (sawClose) {
        throw new Error("Kalshi loss close transaction has duplicate close.");
      }
      if (
        accounts[0] !== expectedTokenAccount ||
        accounts[1] !== walletAddress ||
        accounts[2] !== walletAddress
      ) {
        throw new Error("Kalshi loss close destination does not match wallet.");
      }
      sawClose = true;
      continue;
    }

    throw new Error("Kalshi loss close transaction has unsupported instruction.");
  }

  if (!sawClose) {
    throw new Error("Kalshi loss close transaction is missing close account.");
  }

  if (candidate.amount > 0n) {
    if (burnAmount !== candidate.amount) {
      throw new Error("Kalshi loss close burn amount does not match balance.");
    }
  } else if (burnAmount != null) {
    throw new Error("Kalshi loss close burn is not needed for empty account.");
  }
}
