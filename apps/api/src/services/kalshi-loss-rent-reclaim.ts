import { createHash } from "node:crypto";

import type { Pool } from "@hunch/infra";
import bs58 from "bs58";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { pool as dbPool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { resolveAuthAccessPolicy } from "./runtime-policies.js";
import {
  fetchSolanaLatestBlockhash,
  fetchSolanaTokenAccountByOwnerAndMint,
  sendSolanaRawTransaction,
} from "./solana-rpc.js";
import {
  createEmbeddedSolanaSponsorshipIntent,
  readEmbeddedSolanaSponsorshipIntent,
  releaseEmbeddedSolanaSponsorshipBudget,
  reserveEmbeddedSolanaSponsorshipBudget,
  shouldRequireEmbeddedSolanaSponsorshipRedis,
} from "./embedded-solana-sponsorship.js";
import {
  normalizeSolanaPublicKey,
  resolveHunchSolanaSponsorKeypair,
} from "./solana-sponsorship-primitives.js";
import { upsertSolanaSponsorshipLedger } from "./solana-sponsorship-ledger.js";

export type KalshiLossRentReclaimPrepareResult =
  | {
      eligible: true;
      transaction: string;
      sponsorshipIntentId: string;
    }
  | {
      eligible: false;
      reason: string;
    };

export type KalshiLossRentReclaimSubmitResult = {
  ok: true;
  signature: string;
};

export class KalshiLossReclaimLedgerDurabilityError extends Error {
  cause: unknown;
  signature: string;
  sponsorshipIntentId: string;

  constructor(inputs: {
    cause: unknown;
    signature: string;
    sponsorshipIntentId: string;
  }) {
    super("Kalshi loss reclaim submitted but ledger update failed.");
    this.name = "KalshiLossReclaimLedgerDurabilityError";
    this.cause = inputs.cause;
    this.signature = inputs.signature;
    this.sponsorshipIntentId = inputs.sponsorshipIntentId;
  }
}

type KalshiLossPositionRow = {
  market_id: string;
  token_id: string;
  wallet_address: string | null;
  size: string | null;
  outcome_side: string | null;
  status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
};

type TokenAccountInfo = {
  exists: boolean;
  lamports: bigint;
  tokenProgramId: string | null;
  mint: string | null;
  owner: string | null;
  closeAuthority: string | null;
  amount: bigint | null;
};

const LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS = "5000";
const TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function normalizeOutcome(
  value: string | null | undefined,
): "YES" | "NO" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "YES" || normalized === "NO" ? normalized : null;
}

function mintFromTokenId(tokenId: string): string {
  const trimmed = tokenId.trim();
  return trimmed.startsWith("sol:") ? trimmed.slice(4) : trimmed;
}

function computeLegacySolanaMessageDigest(tx: Transaction): string {
  return createHash("sha256").update(tx.serializeMessage()).digest("hex");
}

function computeRawTransactionDigest(transaction: string): string {
  return createHash("sha256")
    .update(Buffer.from(transaction, "base64"))
    .digest("hex");
}

function encodeLegacyTransaction(tx: Transaction): string {
  return Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString("base64");
}

function parseBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return BigInt(Math.trunc(Number(value.trim())));
  }
  return null;
}

function isPositiveNumericString(value: string | null | undefined): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function parseParsedTokenAccount(value: unknown): TokenAccountInfo {
  if (!isRecord(value)) {
    return {
      exists: false,
      lamports: 0n,
      tokenProgramId: null,
      mint: null,
      owner: null,
      closeAuthority: null,
      amount: null,
    };
  }
  const ownerProgram =
    "owner" in value && value.owner instanceof PublicKey
      ? value.owner.toBase58()
      : null;
  const lamports = parseBigIntLike(value.lamports) ?? 0n;
  const data = value.data;
  if (!isRecord(data) || !isRecord(data.parsed)) {
    return {
      exists: true,
      lamports,
      tokenProgramId: ownerProgram,
      mint: null,
      owner: null,
      closeAuthority: null,
      amount: null,
    };
  }
  const info = isRecord(data.parsed.info) ? data.parsed.info : null;
  const tokenAmount = isRecord(info?.tokenAmount) ? info.tokenAmount : null;
  const amount = parseBigIntLike(tokenAmount?.amount);
  return {
    exists: true,
    lamports,
    tokenProgramId: ownerProgram,
    mint: typeof info?.mint === "string" ? info.mint : null,
    owner: typeof info?.owner === "string" ? info.owner : null,
    closeAuthority:
      typeof info?.closeAuthority === "string" ? info.closeAuthority : null,
    amount,
  };
}

async function fetchTokenAccountInfo(
  account: string,
): Promise<TokenAccountInfo> {
  const rpcUrl = env.solanaRpcUrls[0];
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not configured");
  const connection = new Connection(rpcUrl, "confirmed");
  const value = (
    await connection.getParsedAccountInfo(new PublicKey(account), "confirmed")
  ).value;
  return parseParsedTokenAccount(value);
}

async function fetchKalshiLossPosition(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; tokenId: string },
): Promise<KalshiLossPositionRow | null> {
  const rawMint = mintFromTokenId(inputs.tokenId);
  const prefixedMint = `sol:${rawMint}`;
  const { rows } = await pool.query<KalshiLossPositionRow>(
    `
      select
        m.id as market_id,
        p.token_id,
        p.wallet_address,
        p.size::text as size,
        coalesce(
          t.outcome_side,
          case
            when m.token_yes = any($4::text[]) then 'YES'
            when m.token_no = any($4::text[]) then 'NO'
            else null
          end
        ) as outcome_side,
        m.status::text as status,
        m.resolved_outcome,
        m.resolved_outcome_pct::text as resolved_outcome_pct
      from positions p
      left join unified_market_tokens t
        on t.venue = p.venue
       and t.token_id = p.token_id
      join unified_markets m
        on m.venue = p.venue
       and (
          m.id = t.market_id
          or m.token_yes = any($4::text[])
          or m.token_no = any($4::text[])
       )
      where p.user_id = $1
        and p.venue = 'kalshi'
        and lower(p.wallet_address) = lower($2)
        and p.token_id = $3
      limit 1
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.tokenId,
      [inputs.tokenId, rawMint, prefixedMint],
    ],
  );
  return rows[0] ?? null;
}

async function hasPriorSponsorshipEvidence(
  pool: Pool,
  inputs: {
    walletAddress: string;
    marketId: string;
    tokenId: string;
    mint: string;
  },
): Promise<boolean> {
  const tokenIds = [inputs.tokenId, inputs.mint, `sol:${inputs.mint}`];
  const { rows } = await pool.query<{ id: string }>(
    `
      select id
      from solana_sponsorship_ledger
      where venue = 'kalshi'
        and flow = 'dflow'
        and lower(wallet_address) = lower($1)
        and (
          market_id = $2
          or input_mint = any($3::text[])
          or output_mint = any($3::text[])
          or metadata->>'inputMint' = any($3::text[])
          or metadata->>'outputMint' = any($3::text[])
        )
        and (
          rent_lamports is not null
          or rent_status in ('locked', 'lost', 'returned')
          or metadata->>'hunchSponsoredDflow' = 'true'
        )
      order by updated_at desc
      limit 1
    `,
    [inputs.walletAddress, inputs.marketId, tokenIds],
  );
  return rows.length > 0;
}

async function hasExactPriorSponsorshipEvidence(
  pool: Pool,
  inputs: {
    walletAddress: string;
    marketId: string;
    tokenId: string;
    mint: string;
    tokenAccount: string;
  },
): Promise<boolean> {
  const tokenIds = [inputs.tokenId, inputs.mint, `sol:${inputs.mint}`];
  const { rows } = await pool.query<{ id: string }>(
    `
      select id
      from solana_sponsorship_ledger
      where venue = 'kalshi'
        and flow = 'dflow'
        and lower(wallet_address) = lower($1)
        and (
          market_id = $2
          or input_mint = any($3::text[])
          or output_mint = any($3::text[])
          or metadata->>'inputMint' = any($3::text[])
          or metadata->>'outputMint' = any($3::text[])
        )
        and (
          metadata->>'tokenAccount' = $4
          or metadata #>> '{lossRentReclaim,tokenAccount}' = $4
          or metadata::text like '%' || $4 || '%'
        )
      order by updated_at desc
      limit 1
    `,
    [inputs.walletAddress, inputs.marketId, tokenIds, inputs.tokenAccount],
  );
  return rows.length > 0;
}

async function resolveLossReclaimPolicy(pool: Pool) {
  const policy = await resolveAuthAccessPolicy(pool);
  const requireDurable = shouldRequireEmbeddedSolanaSponsorshipRedis({
    mode: policy.effective.embeddedSolanaSponsorshipMode,
    observeCanSponsor:
      policy.effective.embeddedSolanaSponsorshipObserveCanSponsor,
  });
  const enabled =
    policy.effective.embeddedSolanaSponsorship === true &&
    policy.effective.embeddedSolanaSponsorshipFlows.dflow === true &&
    (policy.effective.embeddedSolanaSponsorshipMode === "enforce" ||
      policy.effective.embeddedSolanaSponsorshipObserveCanSponsor === true);
  return {
    enabled,
    requireDurable,
    limits: policy.effective.embeddedSolanaSponsorshipLimits,
  };
}

export async function prepareKalshiLossRentReclaim(inputs: {
  pool: Pool;
  userId: string;
  walletAddress: string;
  tokenId: string;
  tokenAccount?: string | null;
}): Promise<KalshiLossRentReclaimPrepareResult> {
  const walletAddress = normalizeSolanaPublicKey(inputs.walletAddress);
  if (!walletAddress) return { eligible: false, reason: "invalid_wallet" };

  const sponsorKeypair = resolveHunchSolanaSponsorKeypair();
  if (!sponsorKeypair) {
    return { eligible: false, reason: "sponsor_not_configured" };
  }
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();
  const policy = await resolveLossReclaimPolicy(inputs.pool);
  if (!policy.enabled)
    return { eligible: false, reason: "sponsorship_disabled" };

  const position = await fetchKalshiLossPosition(inputs.pool, {
    userId: inputs.userId,
    walletAddress,
    tokenId: inputs.tokenId,
  });
  if (!position) return { eligible: false, reason: "position_not_found" };
  if (!isPositiveNumericString(position.size)) {
    return { eligible: false, reason: "zero_position" };
  }

  const outcomeSide = normalizeOutcome(position.outcome_side);
  const resolvedOutcome = normalizeOutcome(position.resolved_outcome);
  if (!outcomeSide) return { eligible: false, reason: "unknown_outcome_side" };
  if (!resolvedOutcome) return { eligible: false, reason: "market_unresolved" };
  if (!["CLOSED", "SETTLED", "ARCHIVED"].includes(position.status ?? "")) {
    return { eligible: false, reason: "market_not_finalized" };
  }
  if (resolvedOutcome === outcomeSide) {
    return { eligible: false, reason: "position_is_winner" };
  }

  const mint = mintFromTokenId(position.token_id);
  if (
    !(await hasPriorSponsorshipEvidence(inputs.pool, {
      walletAddress,
      marketId: position.market_id,
      tokenId: position.token_id,
      mint,
    }))
  ) {
    return { eligible: false, reason: "missing_sponsorship_evidence" };
  }

  const requestedTokenAccount = inputs.tokenAccount?.trim() ?? "";
  const normalizedRequestedTokenAccount = requestedTokenAccount
    ? normalizeSolanaPublicKey(requestedTokenAccount)
    : null;
  if (requestedTokenAccount && !normalizedRequestedTokenAccount) {
    return { eligible: false, reason: "invalid_token_account" };
  }
  const tokenAccount =
    normalizedRequestedTokenAccount ??
    (await fetchSolanaTokenAccountByOwnerAndMint({
      rpcUrls: env.solanaRpcUrls,
      owner: walletAddress,
      mint,
      timeoutMs: env.solanaRpcTimeoutMs,
    }));
  if (!tokenAccount) {
    return { eligible: false, reason: "token_account_not_found" };
  }

  const accountInfo = await fetchTokenAccountInfo(tokenAccount);
  if (!accountInfo.exists) {
    return { eligible: false, reason: "token_account_not_found" };
  }
  if (
    !accountInfo.tokenProgramId ||
    !TOKEN_PROGRAM_IDS.has(accountInfo.tokenProgramId)
  ) {
    return { eligible: false, reason: "invalid_token_program" };
  }
  if (accountInfo.owner !== walletAddress) {
    return { eligible: false, reason: "wrong_owner" };
  }
  if (accountInfo.mint !== mint) {
    return { eligible: false, reason: "wrong_mint" };
  }
  if (accountInfo.amount == null || accountInfo.amount <= 0n) {
    return { eligible: false, reason: "zero_balance" };
  }
  const closeAuthority = accountInfo.closeAuthority ?? accountInfo.owner;
  if (closeAuthority !== walletAddress && closeAuthority !== sponsorAddress) {
    return { eligible: false, reason: "wrong_close_authority" };
  }
  const exactSponsorshipEvidence =
    closeAuthority === sponsorAddress ||
    (await hasExactPriorSponsorshipEvidence(inputs.pool, {
      walletAddress,
      marketId: position.market_id,
      tokenId: position.token_id,
      mint,
      tokenAccount,
    }));
  const rentRecipient = exactSponsorshipEvidence
    ? sponsorAddress
    : walletAddress;
  const sponsorRentRecipient = rentRecipient === sponsorAddress;

  const latest = await fetchSolanaLatestBlockhash({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
  if (!latest) return { eligible: false, reason: "blockhash_unavailable" };

  const tx = new Transaction();
  tx.feePayer = sponsorKeypair.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.add(
    createBurnInstruction(
      new PublicKey(tokenAccount),
      new PublicKey(mint),
      new PublicKey(walletAddress),
      accountInfo.amount,
      [],
      new PublicKey(accountInfo.tokenProgramId),
    ),
    createCloseAccountInstruction(
      new PublicKey(tokenAccount),
      new PublicKey(rentRecipient),
      new PublicKey(closeAuthority),
      [],
      new PublicKey(accountInfo.tokenProgramId),
    ),
  );
  const transaction = encodeLegacyTransaction(tx);
  const messageDigest = computeLegacySolanaMessageDigest(tx);

  const budget = await reserveEmbeddedSolanaSponsorshipBudget({
    flow: "dflow",
    walletAddress,
    estimatedLamports: LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS,
    limits: policy.limits,
    requireRedis: policy.requireDurable,
  });
  if (!budget.ok) {
    return { eligible: false, reason: budget.reasons[0] ?? "budget_failed" };
  }

  const intent = await createEmbeddedSolanaSponsorshipIntent({
    flow: "dflow",
    userId: inputs.userId,
    signer: walletAddress,
    transaction,
    requireDurable: policy.requireDurable,
    metadata: {
      purpose: "loss_reclaim",
      lossRentReclaim: true,
      marketId: position.market_id,
      inputMint: mint,
      outputMint: mint,
      amount: accountInfo.amount.toString(),
      tokenAccount,
      outcomeMint: mint,
      outcomeSide,
      resolvedOutcome,
      closeAuthority,
      rentRecipient,
      exactSponsorshipEvidence,
      messageDigest,
      sponsorAddress,
      budgetReserved: true,
    },
  });
  if (!intent) {
    await releaseEmbeddedSolanaSponsorshipBudget(budget.reservation);
    return { eligible: false, reason: "intent_create_failed" };
  }

  try {
    await upsertSolanaSponsorshipLedger({
      userId: inputs.userId,
      venue: "kalshi",
      flow: "dflow",
      status: "intent_created",
      intentId: intent.id,
      walletAddress,
      sponsorAddress,
      marketId: position.market_id,
      inputMint: mint,
      outputMint: mint,
      amountRaw: accountInfo.amount.toString(),
      messageDigest,
      transactionDigest: intent.transactionDigest,
      estimatedSponsorLamports: LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS,
      rentLamports:
        sponsorRentRecipient && accountInfo.lamports > 0n
          ? accountInfo.lamports.toString()
          : null,
      rentStatus:
        sponsorRentRecipient && accountInfo.lamports > 0n
          ? "locked"
          : "unknown",
      metadata: {
        purpose: "loss_reclaim",
        tokenAccount,
        closeAuthority,
        rentRecipient,
        exactSponsorshipEvidence,
      },
    });
  } catch (error) {
    await releaseEmbeddedSolanaSponsorshipBudget(budget.reservation);
    throw error;
  }

  return {
    eligible: true,
    transaction,
    sponsorshipIntentId: intent.id,
  };
}

function getIntentString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function legacyTransactionHasSignature(
  tx: Transaction,
  signer: string,
): boolean {
  return tx.signatures.some(
    (entry) =>
      entry.publicKey.toBase58() === signer &&
      entry.signature != null &&
      !entry.signature.every((byte) => byte === 0),
  );
}

function getLegacyTransactionSignature(tx: Transaction): string | null {
  const signature = tx.signatures[0]?.signature;
  if (!signature || signature.every((byte) => byte === 0)) return null;
  return bs58.encode(signature);
}

export async function submitKalshiLossRentReclaim(inputs: {
  userId: string;
  walletAddress: string;
  sponsorshipIntentId: string;
  signedTransaction: string;
  maxRetries?: number;
}): Promise<KalshiLossRentReclaimSubmitResult> {
  const walletAddress = normalizeSolanaPublicKey(inputs.walletAddress);
  if (!walletAddress) throw new Error("Invalid Solana wallet address");

  const sponsorKeypair = resolveHunchSolanaSponsorKeypair();
  if (!sponsorKeypair) throw new Error("DFlow sponsorship is not configured");
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();

  const intent = await readEmbeddedSolanaSponsorshipIntent(
    inputs.sponsorshipIntentId,
  );
  if (!intent) throw new Error("Missing or expired loss reclaim intent");
  if (intent.flow !== "dflow") throw new Error("Invalid sponsorship flow");
  if (intent.userId !== inputs.userId) throw new Error("Intent user mismatch");
  if (intent.signer !== walletAddress)
    throw new Error("Intent wallet mismatch");
  if (intent.metadata?.lossRentReclaim !== true) {
    throw new Error("Invalid loss reclaim intent");
  }
  if (getIntentString(intent.metadata, "sponsorAddress") !== sponsorAddress) {
    throw new Error("Intent sponsor mismatch");
  }

  const tx = Transaction.from(Buffer.from(inputs.signedTransaction, "base64"));
  const messageDigest = computeLegacySolanaMessageDigest(tx);
  if (messageDigest !== getIntentString(intent.metadata, "messageDigest")) {
    throw new Error("Loss reclaim transaction mismatch");
  }
  if (!legacyTransactionHasSignature(tx, walletAddress)) {
    throw new Error("Loss reclaim transaction is not user-signed");
  }
  const mint = getIntentString(intent.metadata, "outcomeMint");
  const tokenAccount = getIntentString(intent.metadata, "tokenAccount");
  const amount = getIntentString(intent.metadata, "amount");
  const marketId = getIntentString(intent.metadata, "marketId");
  const rentRecipient = getIntentString(intent.metadata, "rentRecipient");
  const policy = await resolveLossReclaimPolicy(dbPool);
  if (!policy.enabled) {
    throw new Error("DFlow sponsorship is disabled");
  }

  tx.partialSign(sponsorKeypair);
  const sponsoredTransaction = Buffer.from(tx.serialize()).toString("base64");
  const sponsoredTransactionDigest =
    computeRawTransactionDigest(sponsoredTransaction);
  const expectedSignature = getLegacyTransactionSignature(tx);
  if (!expectedSignature) {
    throw new Error("Loss reclaim transaction could not be signed");
  }

  await upsertSolanaSponsorshipLedger({
    userId: inputs.userId,
    venue: "kalshi",
    flow: "dflow",
    status: "user_signed",
    intentId: intent.id,
    walletAddress,
    sponsorAddress,
    marketId,
    inputMint: mint,
    outputMint: mint,
    amountRaw: amount,
    messageDigest,
    transactionDigest: sponsoredTransactionDigest,
    txSignature: expectedSignature,
    estimatedSponsorLamports: LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS,
    metadata: {
      purpose: "loss_reclaim",
      tokenAccount,
      rentRecipient,
      userSignedAt: new Date().toISOString(),
      sponsorSignedAt: new Date().toISOString(),
    },
  });
  let signature: string;
  try {
    signature = await sendSolanaRawTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      signedTransaction: sponsoredTransaction,
      skipPreflight: false,
      maxRetries: Math.max(0, Math.trunc(inputs.maxRetries ?? 2)),
    });
  } catch (error) {
    await upsertSolanaSponsorshipLedger({
      userId: inputs.userId,
      venue: "kalshi",
      flow: "dflow",
      status: "failed",
      intentId: intent.id,
      walletAddress,
      sponsorAddress,
      marketId,
      inputMint: mint,
      outputMint: mint,
      amountRaw: amount,
      messageDigest,
      transactionDigest: sponsoredTransactionDigest,
      txSignature: expectedSignature,
      estimatedSponsorLamports: LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        purpose: "loss_reclaim",
        tokenAccount,
        rentRecipient,
        sendFailedAt: new Date().toISOString(),
      },
    });
    throw error;
  }

  try {
    await upsertSolanaSponsorshipLedger({
      userId: inputs.userId,
      venue: "kalshi",
      flow: "dflow",
      status: "submitted",
      intentId: intent.id,
      walletAddress,
      sponsorAddress,
      marketId,
      inputMint: mint,
      outputMint: mint,
      amountRaw: amount,
      messageDigest,
      transactionDigest: sponsoredTransactionDigest,
      txSignature: signature,
      estimatedSponsorLamports: LOSS_RECLAIM_FEE_ESTIMATE_LAMPORTS,
      metadata: {
        purpose: "loss_reclaim",
        tokenAccount,
        rentRecipient,
        submittedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    throw new KalshiLossReclaimLedgerDurabilityError({
      cause: error,
      signature,
      sponsorshipIntentId: intent.id,
    });
  }

  return { ok: true, signature };
}
