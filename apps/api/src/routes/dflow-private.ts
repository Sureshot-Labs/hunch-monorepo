import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { publishMarketState } from "@hunch/infra";
import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createAdminMiddleware, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import {
  buildGeoFenceResponse,
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";
import { storeExecution } from "../repos/executions-repo.js";
import {
  dflowRequest,
  extractDflowErrorCode,
  extractDflowErrorMessage,
  formatDflowUserMessage,
} from "../services/dflow-client.js";
import {
  fetchKalshiNormalizedOrderStatus,
  finalizeKalshiExecutionEffects,
  mergeKalshiExecutionRaw,
  normalizeKalshiExecutionStatus,
} from "../services/kalshi-executions.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaLatestBlockhash,
  fetchSolanaSignatureStatus,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
  sendSolanaRawTransaction,
  waitForSolanaSignatureConfirmation,
} from "../services/solana-rpc.js";
import {
  analyzeEmbeddedSolanaTransaction,
  computeEmbeddedSolanaMessageDigest,
  computeEmbeddedSolanaTransactionDigest,
  createEmbeddedSolanaSponsorshipIntent,
  readEmbeddedSolanaSponsorshipIntent,
} from "../services/embedded-solana-sponsorship.js";
import { resolveAuthAccessPolicy } from "../services/runtime-policies.js";
import {
  dflowExecutionBodySchema,
  dflowOrderQuerySchema,
  dflowOrderStatusQuerySchema,
  dflowPredictionMarketInitBodySchema,
  dflowQuoteQuerySchema,
  dflowSponsoredSubmitBodySchema,
  dflowSubmitBodySchema,
  dflowSwapBodySchema,
} from "../schemas/dflow.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";

const SOL_DECIMALS = 9;

type RedisMulti = {
  set: (key: string, value: string, options?: { EX?: number }) => RedisMulti;
  publish: (channel: string, message: string) => RedisMulti;
  exec: () => Promise<unknown>;
};

type PriceRedis = {
  multi: () => RedisMulti;
};

type MintPair = {
  inputMint: string;
  outputMint: string;
};

type DflowSponsorshipMarketState = {
  marketIds: string[];
  marketInitialized: boolean;
};

const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LEGACY_MEMO_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const DFLOW_PROGRAM_ID = "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH";
const DFLOW_PREDICTION_PROGRAM_ID =
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
const DFLOW_SPONSORED_ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  LEGACY_MEMO_PROGRAM_ID,
  DFLOW_PROGRAM_ID,
  DFLOW_PREDICTION_PROGRAM_ID,
]);
const SOLANA_TX_FEE_LAMPORTS = BigInt(5_000);
const DFLOW_SPONSORED_MAX_RETRIES = 2;
const DFLOW_SPONSORED_ATA_RENT_LAMPORTS = BigInt(2_100_000);

function normalizeKalshiMarketIdForStorage(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.includes(":") ? trimmed : `kalshi:${trimmed}`;
}

type DflowSponsorConfig = {
  enabled: boolean;
  sponsorKeypair: Keypair | null;
  sponsorAddress: string | null;
};

type DflowSponsoredValidationResult = {
  valid: boolean;
  reasons: string[];
  estimatedSponsorLamports: bigint;
  systemCreateLamports: bigint;
};

function isSolanaWallet(address: string): boolean {
  return !address.startsWith("0x");
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

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

function resolveDflowSponsorKeypair(): Keypair | null {
  if (!env.hunchSolanaSponsorSecretKey) return null;
  const keypair = loadSolanaKeypairFromSecret(env.hunchSolanaSponsorSecretKey);
  const derivedAddress = keypair.publicKey.toBase58();
  if (
    env.hunchSolanaSponsorAddress &&
    derivedAddress !== env.hunchSolanaSponsorAddress
  ) {
    throw new Error(
      "HUNCH_SOLANA_SPONSOR_ADDRESS does not match HUNCH_SOLANA_SPONSOR_SECRET_KEY",
    );
  }
  return keypair;
}

async function resolveDflowSponsorConfig(): Promise<DflowSponsorConfig> {
  const policy = await resolveAuthAccessPolicy(pool);
  const enabled =
    policy.effective.embeddedSolanaSponsorship === true &&
    policy.effective.embeddedSolanaSponsorshipFlows.dflow === true;
  if (!enabled) {
    return { enabled: false, sponsorKeypair: null, sponsorAddress: null };
  }

  const sponsorKeypair = resolveDflowSponsorKeypair();
  if (!sponsorKeypair) {
    throw new Error("DFlow sponsorship is enabled but sponsor key is missing");
  }
  return {
    enabled: true,
    sponsorKeypair,
    sponsorAddress: sponsorKeypair.publicKey.toBase58(),
  };
}

function getIntentMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getIntentMetadataBoolean(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const value = metadata?.[key];
  return value === true;
}

function getIntentMetadataBigInt(
  metadata: Record<string, unknown> | undefined,
  key: string,
): bigint | null {
  const value = metadata?.[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function getIntentMetadataNonNegativeInt(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function getMaxSponsorLamports(): bigint {
  return BigInt(env.hunchSolanaSponsorMaxTxLamports);
}

function getDflowSponsoredFeeParams(inputs: {
  inputMint: string;
  outputMint: string;
}): Record<string, string | number> {
  const feeAccount = env.dflowFeeAccount?.trim() || "";
  if (!feeAccount) return {};

  const feeScale = env.feeScaleKalshi;
  if (Number.isFinite(feeScale) && feeScale > 0) {
    return { platformFeeScale: feeScale, feeAccount };
  }

  const feeBps = env.feeBpsKalshi;
  if (!Number.isFinite(feeBps) || feeBps <= 0) return {};
  const platformFeeMode =
    inputs.inputMint === env.solanaUsdcMint
      ? "inputMint"
      : inputs.outputMint === env.solanaUsdcMint
        ? "outputMint"
        : null;
  if (!platformFeeMode) return {};
  return { platformFeeBps: feeBps, platformFeeMode, feeAccount };
}

function validateDflowSponsoredAnalysis(inputs: {
  analysis: ReturnType<typeof analyzeEmbeddedSolanaTransaction>;
  userWalletAddress: string;
  sponsorAddress: string;
  metadata: Record<string, unknown> | undefined;
  requireUserSignatureSlot: boolean;
  requireOutcomeMint?: string | null;
  allowPredictionInit?: boolean;
}): DflowSponsoredValidationResult {
  const reasons: string[] = [];
  const analysis = inputs.analysis;
  const systemCreateLamports = BigInt(analysis.systemCreateLamports);
  const maxSponsorLamports = getMaxSponsorLamports();
  const ataRentLamports =
    BigInt(analysis.ataCreateCount) * DFLOW_SPONSORED_ATA_RENT_LAMPORTS;
  const estimatedSponsorLamports =
    SOLANA_TX_FEE_LAMPORTS + systemCreateLamports + ataRentLamports;

  if (!analysis.ok) reasons.push("malformed_transaction");
  if (analysis.usesAddressLookupTables) reasons.push("address_lookup_tables");
  if (analysis.hasNativeSolTransfer) reasons.push("native_sol_transfer");
  if (analysis.hasSyncNative) reasons.push("wrapped_sol_sync");
  if (analysis.feePayer !== inputs.sponsorAddress) {
    reasons.push("fee_payer_mismatch");
  }

  const expectedSigners = inputs.requireUserSignatureSlot
    ? new Set([inputs.sponsorAddress, inputs.userWalletAddress])
    : new Set([inputs.sponsorAddress]);
  if (
    analysis.signerAddresses.length !== expectedSigners.size ||
    analysis.signerAddresses.some((signer) => !expectedSigners.has(signer))
  ) {
    reasons.push("signer_mismatch");
  }

  const unknownProgramIds = analysis.programIds.filter(
    (programId) => !DFLOW_SPONSORED_ALLOWED_PROGRAMS.has(programId),
  );
  if (unknownProgramIds.length) reasons.push("unknown_program");

  const hasDflowInstruction = analysis.instructions.some(
    (instruction) =>
      instruction.programId === DFLOW_PROGRAM_ID ||
      instruction.programId === DFLOW_PREDICTION_PROGRAM_ID,
  );
  if (!hasDflowInstruction) reasons.push("missing_dflow_instruction");

  if (inputs.allowPredictionInit === true) {
    const hasPredictionInstruction = analysis.instructions.some(
      (instruction) => instruction.programId === DFLOW_PREDICTION_PROGRAM_ID,
    );
    if (!hasPredictionInstruction) reasons.push("missing_prediction_init");
    if (
      inputs.requireOutcomeMint &&
      !analysis.instructions.some((instruction) =>
        instruction.accountAddresses.includes(inputs.requireOutcomeMint ?? ""),
      )
    ) {
      reasons.push("outcome_mint_mismatch");
    }
  }

  const maxSystemCreateLamports = getIntentMetadataBigInt(
    inputs.metadata,
    "maxSystemCreateLamports",
  );
  if (
    systemCreateLamports > BigInt(0) &&
    (maxSystemCreateLamports == null ||
      systemCreateLamports > maxSystemCreateLamports)
  ) {
    reasons.push("unpriced_system_rent");
  }

  const maxAtaCreateCount = getIntentMetadataNonNegativeInt(
    inputs.metadata,
    "maxAtaCreateCount",
  );
  const allowAtaCreation =
    getIntentMetadataBoolean(inputs.metadata, "allowAtaCreation") === true;
  if (
    analysis.ataCreateCount > 0 &&
    (!allowAtaCreation ||
      maxAtaCreateCount == null ||
      analysis.ataCreateCount > maxAtaCreateCount)
  ) {
    reasons.push("unpriced_ata_creation");
  }

  if (estimatedSponsorLamports > maxSponsorLamports) {
    reasons.push("sponsor_cost_exceeds_cap");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    estimatedSponsorLamports,
    systemCreateLamports,
  };
}

function getSignedTransactionSignerAddresses(tx: VersionedTransaction): string[] {
  return tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
}

function signerHasNonZeroSignature(
  tx: VersionedTransaction,
  signerAddress: string,
): boolean {
  const signerIndex = getSignedTransactionSignerAddresses(tx).indexOf(
    signerAddress,
  );
  if (signerIndex < 0) return false;
  const signature = tx.signatures[signerIndex];
  return Boolean(signature?.some((byte) => byte !== 0));
}

function hasAnyNonZeroSignature(tx: VersionedTransaction): boolean {
  return tx.signatures.some((signature) =>
    signature.some((byte) => byte !== 0),
  );
}

async function refreshUnsignedSolanaTransactionBlockhash(
  transaction: string,
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  if (hasAnyNonZeroSignature(tx)) {
    throw new Error("Cannot refresh blockhash on a pre-signed transaction");
  }
  const latestBlockhash = await fetchSolanaLatestBlockhash({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
  if (!latestBlockhash) {
    throw new Error("Solana RPC did not return latest blockhash");
  }
  tx.message.recentBlockhash = latestBlockhash.blockhash;
  return encodeBase64(tx.serialize());
}

async function upsertSolanaSponsorshipLedger(inputs: {
  userId: string;
  walletAddress: string;
  sponsorAddress: string;
  intentId: string;
  status: string;
  inputMint?: string | null;
  outputMint?: string | null;
  amountRaw?: string | null;
  marketId?: string | null;
  messageDigest?: string | null;
  transactionDigest?: string | null;
  txSignature?: string | null;
  estimatedSponsorLamports?: string | null;
  rentLamports?: string | null;
  rentStatus?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      insert into solana_sponsorship_ledger (
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
        estimated_sponsor_lamports,
        rent_lamports,
        rent_status,
        error,
        metadata
      )
      values (
        $1, 'kalshi', 'dflow', $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17
      )
      on conflict (intent_id) where intent_id is not null
      do update set
        updated_at = now(),
        status = case
          when coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'failed', 'submitted', 'confirmed'],
              excluded.status
            ),
            0
          ) >= coalesce(
            array_position(
              array['created', 'intent_created', 'user_signed', 'failed', 'submitted', 'confirmed'],
              solana_sponsorship_ledger.status
            ),
            0
          )
            then excluded.status
          else solana_sponsorship_ledger.status
        end,
        tx_signature = coalesce(excluded.tx_signature, solana_sponsorship_ledger.tx_signature),
        transaction_digest = coalesce(excluded.transaction_digest, solana_sponsorship_ledger.transaction_digest),
        estimated_sponsor_lamports = greatest(
          solana_sponsorship_ledger.estimated_sponsor_lamports,
          excluded.estimated_sponsor_lamports
        ),
        rent_lamports = coalesce(excluded.rent_lamports, solana_sponsorship_ledger.rent_lamports),
        rent_status = coalesce(excluded.rent_status, solana_sponsorship_ledger.rent_status),
        error = case
          when solana_sponsorship_ledger.status in ('submitted', 'confirmed')
            and excluded.status = 'failed'
            then solana_sponsorship_ledger.error
          else coalesce(excluded.error, solana_sponsorship_ledger.error)
        end,
        metadata = solana_sponsorship_ledger.metadata || excluded.metadata
    `,
    [
      inputs.userId,
      inputs.status,
      inputs.intentId,
      inputs.walletAddress,
      inputs.sponsorAddress,
      inputs.marketId ?? null,
      inputs.inputMint ?? null,
      inputs.outputMint ?? null,
      inputs.amountRaw ?? null,
      inputs.messageDigest ?? null,
      inputs.transactionDigest ?? null,
      inputs.txSignature ?? null,
      inputs.estimatedSponsorLamports ?? "0",
      inputs.rentLamports ?? null,
      inputs.rentStatus ?? null,
      inputs.error ?? null,
      JSON.stringify(inputs.metadata ?? {}),
    ],
  );
}

async function signAndBroadcastSponsoredDflowTransaction(inputs: {
  userId: string;
  walletAddress: string;
  sponsorshipIntentId: string;
  signedTransaction: string;
  maxRetries?: number;
}): Promise<{ signature: string; sponsoredTransaction: string }> {
  const sponsorConfig = await resolveDflowSponsorConfig();
  if (
    !sponsorConfig.enabled ||
    !sponsorConfig.sponsorKeypair ||
    !sponsorConfig.sponsorAddress
  ) {
    throw new Error("DFlow sponsorship is disabled");
  }

  const intent = await readEmbeddedSolanaSponsorshipIntent(
    inputs.sponsorshipIntentId,
  );
  if (!intent) throw new Error("Missing or expired DFlow sponsorship intent");
  if (intent.flow !== "dflow") throw new Error("Invalid sponsorship flow");
  if (intent.userId !== inputs.userId) {
    throw new Error("DFlow sponsorship intent user mismatch");
  }
  if (intent.signer !== inputs.walletAddress) {
    throw new Error("DFlow sponsorship intent wallet mismatch");
  }
  if (
    getIntentMetadataBoolean(intent.metadata, "marketInitialized") !== true
  ) {
    throw new Error(
      "Market is not initialized for gasless DFlow trading yet.",
    );
  }

  const sponsorKeypair = sponsorConfig.sponsorKeypair;
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();
  const intentSponsorAddress = getIntentMetadataString(
    intent.metadata,
    "sponsorAddress",
  );
  if (intentSponsorAddress && intentSponsorAddress !== sponsorAddress) {
    throw new Error("DFlow sponsorship intent sponsor mismatch");
  }

  const txBytes = Buffer.from(inputs.signedTransaction.trim(), "base64");
  const tx = VersionedTransaction.deserialize(txBytes);
  const messageDigest = computeEmbeddedSolanaMessageDigest(
    inputs.signedTransaction,
  );
  const intentMessageDigest = getIntentMetadataString(
    intent.metadata,
    "messageDigest",
  );
  if (!messageDigest || messageDigest !== intentMessageDigest) {
    throw new Error("DFlow sponsorship transaction mismatch");
  }

  const signerAddresses = getSignedTransactionSignerAddresses(tx);
  if (
    signerAddresses.length !== 2 ||
    !signerAddresses.includes(inputs.walletAddress) ||
    !signerAddresses.includes(sponsorAddress)
  ) {
    throw new Error("DFlow sponsored transaction signer mismatch");
  }
  if (!signerHasNonZeroSignature(tx, inputs.walletAddress)) {
    throw new Error("DFlow sponsored transaction is not user-signed");
  }

  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: inputs.walletAddress,
    transaction: inputs.signedTransaction,
    includeRaw: false,
  });
  if (!analysis.ok) {
    throw new Error(analysis.malformedReason ?? "Malformed Solana transaction");
  }
  const validation = validateDflowSponsoredAnalysis({
    analysis,
    userWalletAddress: inputs.walletAddress,
    sponsorAddress,
    metadata: intent.metadata,
    requireUserSignatureSlot: true,
  });
  if (!validation.valid) {
    throw new Error(
      `DFlow sponsored transaction rejected: ${validation.reasons[0]}`,
    );
  }
  const transactionDigest = computeEmbeddedSolanaTransactionDigest(
    inputs.signedTransaction,
  );
  const inputMint = getIntentMetadataString(intent.metadata, "inputMint");
  const outputMint = getIntentMetadataString(intent.metadata, "outputMint");
  const amountRaw = getIntentMetadataString(intent.metadata, "amount");
  const marketId =
    Array.isArray(intent.metadata?.marketIds) &&
    typeof intent.metadata.marketIds[0] === "string"
      ? intent.metadata.marketIds[0]
      : null;
  const systemCreateLamports = validation.systemCreateLamports;
  const estimatedSponsorLamports =
    validation.estimatedSponsorLamports.toString();

  await upsertSolanaSponsorshipLedger({
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    sponsorAddress,
    intentId: intent.id,
    status: "user_signed",
    inputMint,
    outputMint,
    amountRaw,
    marketId,
    messageDigest,
    transactionDigest,
    estimatedSponsorLamports,
    rentLamports:
      systemCreateLamports > BigInt(0) ? systemCreateLamports.toString() : null,
    rentStatus: systemCreateLamports > BigInt(0) ? "locked" : "unknown",
    metadata: {
      signerAddresses,
      programIds: analysis.programIds,
      ataCreateCount: analysis.ataCreateCount,
      systemCreateLamports: analysis.systemCreateLamports,
    },
  });

  tx.sign([sponsorKeypair]);
  const sponsoredTransaction = encodeBase64(tx.serialize());
  let signature: string;
  try {
    signature = await sendSolanaRawTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      signedTransaction: sponsoredTransaction,
      skipPreflight: false,
      maxRetries: Math.min(
        Math.max(Math.trunc(inputs.maxRetries ?? DFLOW_SPONSORED_MAX_RETRIES), 0),
        DFLOW_SPONSORED_MAX_RETRIES,
      ),
    });
  } catch (error) {
    await upsertSolanaSponsorshipLedger({
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      sponsorAddress,
      intentId: intent.id,
      status: "failed",
      inputMint,
      outputMint,
      amountRaw,
      marketId,
      messageDigest,
      transactionDigest: computeEmbeddedSolanaTransactionDigest(
        sponsoredTransaction,
      ),
      estimatedSponsorLamports,
      rentLamports:
        systemCreateLamports > BigInt(0)
          ? systemCreateLamports.toString()
          : null,
      rentStatus: "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await upsertSolanaSponsorshipLedger({
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    sponsorAddress,
    intentId: intent.id,
    status: "submitted",
    inputMint,
    outputMint,
    amountRaw,
    marketId,
    messageDigest,
    transactionDigest: computeEmbeddedSolanaTransactionDigest(
      sponsoredTransaction,
    ),
    txSignature: signature,
    estimatedSponsorLamports,
    rentLamports:
      systemCreateLamports > BigInt(0) ? systemCreateLamports.toString() : null,
    rentStatus: systemCreateLamports > BigInt(0) ? "locked" : "unknown",
    metadata: { submittedAt: new Date().toISOString() },
  });

  return { signature, sponsoredTransaction };
}

async function markDflowMarketInitializedByMint(inputs: {
  outcomeMint: string;
  signature: string;
}): Promise<number> {
  const prefixedMint = `sol:${inputs.outcomeMint}`;
  const result = await pool.query(
    `
      update unified_markets
      set
        is_initialized = true,
        updated_at = now(),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'dflowPreinitializedAt', now(),
          'dflowPreinitSignature', $3
        )
      where venue = 'kalshi'
        and (
          token_yes = $1
          or token_no = $1
          or token_yes = $2
          or token_no = $2
        )
    `,
    [prefixedMint, inputs.outcomeMint, inputs.signature],
  );
  return result.rowCount ?? 0;
}

async function initializeDflowPredictionMarket(inputs: {
  outcomeMint: string;
  maxRetries?: number;
}): Promise<{
  signature: string;
  status: "submitted" | "fulfilled" | "failed";
  marketRowsUpdated: number;
}> {
  const sponsorKeypair = resolveDflowSponsorKeypair();
  if (!sponsorKeypair) {
    throw new Error("DFlow sponsorship is not configured");
  }
  const sponsorAddress = sponsorKeypair.publicKey.toBase58();
  const upstream = await dflowRequest({
    baseUrl: env.dflowQuoteBase,
    timeoutMs: 15_000,
    method: "GET",
    requestPath: "/prediction-market-init",
    apiKey: env.dflowApiKey,
    query: {
      payer: sponsorAddress,
      outcomeMint: inputs.outcomeMint,
    },
  });

  if (!upstream.ok) {
    throw new Error(
      extractDflowErrorMessage(upstream.payload) ??
        "DFlow prediction market init failed",
    );
  }
  const payload =
    upstream.payload &&
    typeof upstream.payload === "object" &&
    !Array.isArray(upstream.payload)
      ? (upstream.payload as Record<string, unknown>)
      : null;
  const transaction = payload
    ? extractStringFromRecord(payload, [
        "transaction",
        "swapTransaction",
        "swap_transaction",
      ])
    : null;
  if (!transaction) {
    throw new Error("DFlow prediction market init response missing transaction");
  }

  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: sponsorAddress,
    transaction,
    includeRaw: false,
  });
  const validation = validateDflowSponsoredAnalysis({
    analysis,
    userWalletAddress: sponsorAddress,
    sponsorAddress,
    metadata: {
      maxSystemCreateLamports: env.hunchSolanaSponsorMaxTxLamports.toString(),
      allowAtaCreation: false,
      maxAtaCreateCount: 0,
    },
    requireUserSignatureSlot: false,
    requireOutcomeMint: inputs.outcomeMint,
    allowPredictionInit: true,
  });
  if (!validation.valid) {
    throw new Error(
      `DFlow prediction market init rejected: ${validation.reasons[0]}`,
    );
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  const signerAddresses = getSignedTransactionSignerAddresses(tx);
  if (signerAddresses.length !== 1 || !signerAddresses.includes(sponsorAddress)) {
    throw new Error("DFlow prediction market init missing sponsor signer");
  }
  tx.sign([sponsorKeypair]);
  const signedTransaction = encodeBase64(tx.serialize());
  const signature = await sendSolanaRawTransaction({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
    signedTransaction,
    skipPreflight: false,
    maxRetries: Math.min(
      Math.max(Math.trunc(inputs.maxRetries ?? DFLOW_SPONSORED_MAX_RETRIES), 0),
      DFLOW_SPONSORED_MAX_RETRIES,
    ),
  });
  const confirmation = await waitForSolanaSignatureConfirmation({
    rpcUrls: env.solanaRpcUrls,
    signature,
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
    commitment: "confirmed",
  });
  const marketRowsUpdated =
    confirmation.status === "fulfilled"
      ? await markDflowMarketInitializedByMint({
          outcomeMint: inputs.outcomeMint,
          signature,
        })
      : 0;
  return { signature, status: confirmation.status, marketRowsUpdated };
}

function ensureDflowReady(reply: {
  code: (status: number) => void;
  send: (payload: unknown) => void;
}): boolean {
  if (!env.dflowRequireApiKey) return true;
  if (env.dflowApiKey && env.dflowApiKey.trim().length > 0) return true;
  reply.code(400);
  reply.send({ error: "Missing DFLOW_API_KEY" });
  return false;
}

function isBuyIntent(inputMint: string | null | undefined): boolean {
  return Boolean(inputMint && inputMint === env.solanaUsdcMint);
}

function toDflowOutcomeTokenId(mint: string): string | null {
  const trimmed = mint.trim();
  if (!trimmed) return null;
  if (trimmed === env.solanaUsdcMint) return null;
  return trimmed.startsWith("sol:") ? trimmed : `sol:${trimmed}`;
}

async function resolveDflowSponsorshipMarketState(
  inputMint: string,
  outputMint: string,
): Promise<DflowSponsorshipMarketState | null> {
  const tokenIds = Array.from(
    new Set(
      [inputMint, outputMint]
        .map(toDflowOutcomeTokenId)
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (!tokenIds.length) return null;

  const { rows } = await pool.query<{
    market_id: string;
    is_initialized: boolean | null;
  }>(
    `
      select distinct
        m.id as market_id,
        m.is_initialized
      from unified_market_tokens t
      join unified_markets m on m.id = t.market_id
      where t.token_id = any($1::text[])
        and m.venue = 'kalshi'
    `,
    [tokenIds],
  );
  if (!rows.length) return null;

  return {
    marketIds: rows.map((row) => row.market_id),
    marketInitialized: rows.every((row) => row.is_initialized === true),
  };
}

function isDflowRouteNotFound(payload: unknown): boolean {
  const code = extractDflowErrorCode(payload);
  if (code === "route_not_found") return true;
  const message = extractDflowErrorMessage(payload)?.toLowerCase() ?? "";
  return message.includes("route not found");
}

function buildClearedTopTick(tokenId: string, tsMs: number): string {
  return JSON.stringify({
    token_id: tokenId,
    best_bid: null,
    best_ask: null,
    mid: null,
    spread: null,
    ts: tsMs,
  });
}

async function markDflowRouteUnavailable(mints: string[]): Promise<void> {
  const tokenIds = Array.from(
    new Set(
      mints
        .map((mint) => mint.trim())
        .filter((mint) => mint && mint !== env.solanaUsdcMint)
        .map((mint) => `sol:${mint}`),
    ),
  );
  if (!tokenIds.length) return;

  const { rows: marketRows } = await pool.query<{
    market_id: string;
    venue_market_id: string | null;
    status: string | null;
    condition_id: string | null;
    resolved_outcome: string | null;
  }>(
    `
      with affected as (
        select distinct market_id
        from unified_market_tokens
        where token_id = any($1::text[])
      )
      update unified_markets m
      set
        metadata = jsonb_set(
          coalesce(m.metadata, '{}'::jsonb),
          '{dflowNativeAcceptingOrders}',
          'false'::jsonb,
          true
        ),
        best_bid = null,
        best_ask = null,
        last_price = null,
        updated_at_db = now()
      from affected a
      where m.id = a.market_id
        and m.venue = 'kalshi'
      returning
        m.id as market_id,
        m.venue_market_id,
        m.status::text as status,
        m.condition_id,
        m.resolved_outcome
    `,
    [tokenIds],
  );
  if (!marketRows.length) return;

  const marketIds = marketRows.map((row) => row.market_id);
  const { rows: tokenRows } = await pool.query<{
    token_id: string;
    market_id: string;
  }>(
    `
      select token_id, market_id
      from unified_market_tokens
      where market_id = any($1::text[])
    `,
    [marketIds],
  );
  if (!tokenRows.length) return;

  const allTokenIds = tokenRows.map((row) => row.token_id);
  await pool.query(
    `
      update unified_token_top_latest
      set
        best_bid = null,
        best_ask = null,
        mid = null,
        spread = null,
        ts = now(),
        updated_at = now()
      where token_id = any($1::text[])
    `,
    [allTokenIds],
  );

  const redis = (await getRedis()) as PriceRedis | null;
  if (!redis) return;

  const tsMs = Date.now();
  const marketById = new Map(marketRows.map((row) => [row.market_id, row]));
  await Promise.all(
    tokenRows.map(async (row) => {
      const market = marketById.get(row.market_id);
      const tickJson = buildClearedTopTick(row.token_id, tsMs);
      const multi = redis.multi();
      multi.set(
        `book:${row.token_id}`,
        JSON.stringify({
          token_id: row.token_id,
          bids: [],
          asks: [],
          timestamp: String(tsMs),
        }),
        { EX: 5 },
      );
      multi.set(`top:${row.token_id}`, tickJson, { EX: 60 });
      multi.publish(`prices:${row.token_id}`, tickJson);
      await Promise.all([
        multi.exec(),
        publishMarketState({
          redis,
          venue: "kalshi",
          tokenId: row.token_id,
          market: market?.condition_id ?? market?.venue_market_id ?? null,
          conditionId: market?.condition_id ?? null,
          status: market?.status ?? null,
          acceptingOrders: false,
          resolvedOutcome: market?.resolved_outcome ?? null,
          tsMs,
        }),
      ]);
    }),
  );
}

function isProofBypassed(user: { kalshiProofBypass: boolean }): boolean {
  return user.kalshiProofBypass;
}

function sendProofRequired(
  reply: {
    code: (status: number) => void;
    send: (payload: unknown) => void;
  },
  walletAddress: string,
) {
  reply.code(403);
  reply.send({
    error: "Kalshi buy requires identity verification",
    code: "proof_required",
    venue: "kalshi",
    wallet: walletAddress,
    proofUrl: "https://dflow.net/proof",
  });
}

function sendProofUnavailable(reply: {
  code: (status: number) => void;
  send: (payload: unknown) => void;
}) {
  reply.code(503);
  reply.send({
    error: "Verification service unavailable",
    code: "proof_check_unavailable",
    venue: "kalshi",
  });
}

function readMintPairFromRecord(
  record: Record<string, unknown>,
): MintPair | null {
  const inputRaw = record.inputMint ?? record.input_mint;
  const outputRaw = record.outputMint ?? record.output_mint;
  if (typeof inputRaw !== "string" || typeof outputRaw !== "string") {
    return null;
  }
  const inputMint = inputRaw.trim();
  const outputMint = outputRaw.trim();
  if (!inputMint || !outputMint) return null;
  return { inputMint, outputMint };
}

function findMintPair(value: unknown, depth = 0): MintPair | null {
  if (depth > 8) return null;
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findMintPair(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = readMintPairFromRecord(record);
  if (direct) return direct;

  const preferredKeys = [
    "quoteResponse",
    "route",
    "quote",
    "order",
    "swap",
    "result",
    "data",
  ];
  for (const key of preferredKeys) {
    if (!(key in record)) continue;
    const nested = findMintPair(record[key], depth + 1);
    if (nested) return nested;
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findMintPair(nestedValue, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function extractStringFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractNonNegativeLamportsFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  const raw = extractStringFromRecord(record, keys);
  if (raw && /^\d+$/.test(raw)) return raw;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value).toString();
    }
  }
  return null;
}

async function enforceKalshiProof(args: {
  user: { id: string; kalshiProofBypass: boolean };
  walletAddress: string;
  inputMint: string | null;
  outputMint: string | null;
  hasDeterministicIntent: boolean;
  app: {
    log: {
      warn: (obj: unknown, msg: string) => void;
    };
  };
  reply: {
    code: (status: number) => void;
    send: (payload: unknown) => void;
  };
}): Promise<boolean> {
  if (!env.kalshiProofEnabled) return true;
  if (isProofBypassed(args.user)) return true;

  if (!args.hasDeterministicIntent || !args.inputMint || !args.outputMint) {
    args.app.log.warn(
      {
        userId: args.user.id,
        walletAddress: args.walletAddress,
      },
      "Kalshi proof gate denied request: unable to derive buy/sell intent",
    );
    sendProofUnavailable(args.reply);
    return false;
  }

  if (!isBuyIntent(args.inputMint)) return true;

  const proofCheck = await verifyProofAddress({
    address: args.walletAddress,
  });

  if (proofCheck.ok) {
    if (proofCheck.verified) return true;
    sendProofRequired(args.reply, args.walletAddress);
    return false;
  }

  args.app.log.warn(
    {
      userId: args.user.id,
      walletAddress: args.walletAddress,
      error: proofCheck.error,
      status: proofCheck.status,
    },
    "Kalshi proof gate verification unavailable",
  );
  sendProofUnavailable(args.reply);
  return false;
}

// Mounted under /trade/kalshi and /trade/dflow (alias).
export const dflowPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const geoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
    proxySecret: env.proxySecret,
  };

  app.addHook("preHandler", async (request, reply) => {
    const decision = evaluateGeoFence(request, geoFenceConfig);
    if (decision.allowed) return;
    app.log.warn(
      {
        country: decision.country,
        reason: decision.reason,
        path: request.url,
      },
      "Kalshi geofence blocked request",
    );
    reply.code(403);
    return reply.send(buildGeoFenceResponse({ venue: "kalshi", decision }));
  });

  /**
   * GET /account
   * Returns a wallet-scoped Kalshi/DFlow account snapshot (Solana on-chain reads).
   */
  z.get(
    "/account",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "Kalshi account snapshot requires a Solana wallet address",
        });
      }

      try {
        const [solLamports, usdc] = await Promise.all([
          fetchSolanaBalanceLamports({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner: walletAddress,
          }),
          fetchSolanaTokenBalanceByOwnerAndMint({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner: walletAddress,
            mint: env.solanaUsdcMint,
          }),
        ]);

        const usdcDecimals = usdc?.decimals ?? 6;
        const usdcAmount = usdc?.amount ?? 0n;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "kalshi",
          walletAddress,
          rpcUrl: env.solanaRpcUrl,
          sol: {
            decimals: SOL_DECIMALS,
            balance: formatUiAmount(solLamports, SOL_DECIMALS),
            balanceRaw: solLamports.toString(),
          },
          usdc: {
            mint: env.solanaUsdcMint,
            decimals: usdcDecimals,
            balance: formatUiAmount(usdcAmount, usdcDecimals),
            balanceRaw: usdcAmount.toString(),
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch Kalshi account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Kalshi account snapshot",
        });
      }
    },
  );

  /**
   * GET /order
   * Proxy order requests to DFlow (returns unsigned transaction + quote).
   */
  z.get(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow order requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const query = request.query;
      const userPublicKey = query.userPublicKey?.trim() || walletAddress.trim();
      if (userPublicKey !== walletAddress.trim()) {
        reply.code(400);
        return reply.send({
          error: "userPublicKey must match the selected wallet",
        });
      }

      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: query.inputMint,
        outputMint: query.outputMint,
        hasDeterministicIntent: true,
        app,
        reply,
      });
      if (!proofAllowed) return;

      const hotTokenIds = [query.inputMint, query.outputMint]
        .filter(
          (mint): mint is string =>
            Boolean(mint) && mint !== env.solanaUsdcMint,
        )
        .map((mint) => `sol:${mint}`);
      if (hotTokenIds.length) {
        void markHotTokens({ tokenIds: hotTokenIds, venue: "dflow" });
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
      }

      let sponsorshipMarketState: DflowSponsorshipMarketState | null = null;
      let dflowSponsoredOrder = false;
      let dflowSponsorAddress: string | null = null;
      try {
        sponsorshipMarketState = await resolveDflowSponsorshipMarketState(
          query.inputMint,
          query.outputMint,
        );
        const sponsorshipConfig = await resolveDflowSponsorConfig();
        dflowSponsoredOrder =
          sponsorshipConfig.enabled &&
          sponsorshipMarketState?.marketInitialized === true;
        dflowSponsorAddress = dflowSponsoredOrder
          ? sponsorshipConfig.sponsorAddress
          : null;
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to resolve DFlow sponsorship configuration",
        );
        reply.code(500);
        return reply.send({ error: "DFlow sponsorship is misconfigured" });
      }

      const feeParams = dflowSponsoredOrder
        ? getDflowSponsoredFeeParams({
            inputMint: query.inputMint,
            outputMint: query.outputMint,
          })
        : {
            ...(query.platformFeeBps != null
              ? { platformFeeBps: query.platformFeeBps }
              : {}),
            ...(query.platformFeeScale != null
              ? { platformFeeScale: query.platformFeeScale }
              : {}),
            ...(query.platformFeeMode
              ? { platformFeeMode: query.platformFeeMode }
              : {}),
            ...(query.feeAccount ? { feeAccount: query.feeAccount } : {}),
          };

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 15_000,
        method: "GET",
        requestPath: "/order",
        apiKey: env.dflowApiKey,
        query: {
          inputMint: query.inputMint,
          outputMint: query.outputMint,
          amount: query.amount,
          userPublicKey,
          ...(query.slippageBps != null
            ? { slippageBps: query.slippageBps }
            : {}),
          ...feeParams,
          ...(dflowSponsoredOrder && dflowSponsorAddress
            ? {
                sponsor: dflowSponsorAddress,
                outcomeAccountRentRecipient: dflowSponsorAddress,
                ...(query.outputMint !== env.solanaUsdcMint
                  ? { outputCloseAuthority: dflowSponsorAddress }
                  : {}),
              }
            : {}),
        },
      });

      if (!upstream.ok) {
        if (isDflowRouteNotFound(upstream.payload)) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
            app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
        const userMessage = formatDflowUserMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: userMessage ?? "DFlow order failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      const payloadRecord =
        upstream.payload &&
        typeof upstream.payload === "object" &&
        !Array.isArray(upstream.payload)
          ? ({ ...(upstream.payload as Record<string, unknown>) } as Record<
              string,
              unknown
            >)
          : null;
      if (payloadRecord) {
        const transactionKey = [
          "transaction",
          "swapTransaction",
          "swap_transaction",
        ].find((key) => typeof payloadRecord[key] === "string");
        let transaction = transactionKey
          ? String(payloadRecord[transactionKey])
          : null;
        if (transaction) {
          try {
            if (dflowSponsoredOrder && dflowSponsorAddress) {
              transaction =
                await refreshUnsignedSolanaTransactionBlockhash(transaction);
              payloadRecord[transactionKey ?? "transaction"] = transaction;
            }
            const maxSystemCreateLamports =
              extractNonNegativeLamportsFromRecord(payloadRecord, [
                "initPredictionMarketCost",
                "init_prediction_market_cost",
                "initPredictionMarketCostLamports",
              ]) ?? "0";
            const messageDigest =
              computeEmbeddedSolanaMessageDigest(transaction);
            const expectedAtaCreateCount =
              query.outputMint !== env.solanaUsdcMint ? 1 : 0;
            const sponsorshipMetadata = {
              inputMint: query.inputMint,
              outputMint: query.outputMint,
              amount: query.amount,
              marketIds: sponsorshipMarketState?.marketIds ?? [],
              marketInitialized: true,
              maxSystemCreateLamports: "0",
              allowAtaCreation: expectedAtaCreateCount > 0,
              maxAtaCreateCount: expectedAtaCreateCount,
              messageDigest,
              sponsorAddress: dflowSponsorAddress,
              hunchSponsoredDflow: true,
            };
            const analysis = analyzeEmbeddedSolanaTransaction({
              signer: userPublicKey,
              transaction,
              includeRaw: false,
            });
            const validation =
              dflowSponsorAddress && messageDigest
                ? validateDflowSponsoredAnalysis({
                    analysis,
                    userWalletAddress: userPublicKey,
                    sponsorAddress: dflowSponsorAddress,
                    metadata: sponsorshipMetadata,
                    requireUserSignatureSlot: true,
                  })
                : null;
            if (
              dflowSponsoredOrder &&
              dflowSponsorAddress &&
              sponsorshipMarketState?.marketInitialized === true &&
              messageDigest &&
              maxSystemCreateLamports === "0" &&
              validation?.valid === true
            ) {
              const intent = await createEmbeddedSolanaSponsorshipIntent({
                flow: "dflow",
                userId: user.id,
                signer: userPublicKey,
                transaction,
                metadata: sponsorshipMetadata,
              });
              if (intent) {
                payloadRecord.hunchSponsorshipIntentId = intent.id;
                payloadRecord.hunchSponsoredDflow = true;
                payloadRecord.hunchSponsorAddress = dflowSponsorAddress;
                await upsertSolanaSponsorshipLedger({
                  userId: user.id,
                  walletAddress,
                  sponsorAddress: dflowSponsorAddress,
                  intentId: intent.id,
                  status: "intent_created",
                  inputMint: query.inputMint,
                  outputMint: query.outputMint,
                  amountRaw: query.amount,
                  marketId: sponsorshipMarketState.marketIds[0] ?? null,
                  messageDigest,
                  transactionDigest: intent.transactionDigest,
                  estimatedSponsorLamports:
                    validation.estimatedSponsorLamports.toString(),
                  rentLamports:
                    validation.systemCreateLamports > BigInt(0)
                      ? validation.systemCreateLamports.toString()
                      : null,
                  rentStatus:
                    validation.systemCreateLamports > BigInt(0)
                      ? "locked"
                      : "unknown",
                  metadata: {
                    marketIds: sponsorshipMarketState.marketIds,
                    maxSystemCreateLamports: "0",
                    maxAtaCreateCount: expectedAtaCreateCount,
                    blockhashRefreshed: true,
                  },
                });
              }
            } else if (dflowSponsoredOrder) {
              app.log.warn(
                {
                  userId: user.id,
                  walletAddress,
                  validationReasons: validation?.reasons ?? [],
                  maxSystemCreateLamports,
                },
                "DFlow order response was not eligible for sponsorship",
              );
            }
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, walletAddress },
              "Failed to create DFlow Solana sponsorship intent",
            );
          }
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(payloadRecord ?? upstream.payload);
    },
  );

  z.get(
    "/order-status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!ensureDflowReady(reply)) return;
      try {
        const orderStatus = await fetchKalshiNormalizedOrderStatus({
          signature: request.query.signature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(orderStatus.raw);
      } catch (error) {
        app.log.error(
          { error, signature: request.query.signature },
          "Failed to fetch DFlow order status",
        );
        reply.code(502);
        return reply.send({
          error: "DFlow order status failed",
        });
      }
    },
  );

  z.get(
    "/tx-status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowOrderStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const status = await fetchSolanaSignatureStatus({
          rpcUrls: env.solanaRpcUrls,
          signature: request.query.signature,
          timeoutMs: env.solanaRpcTimeoutMs,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          status: status?.status ?? "submitted",
        });
      } catch (error) {
        app.log.error(
          { error, signature: request.query.signature },
          "Failed to fetch Kalshi tx status",
        );
        reply.code(502);
        return reply.send({ error: "Failed to fetch Kalshi tx status" });
      }
    },
  );

  /**
   * GET /quote
   * Proxy quote requests to DFlow (no signing).
   */
  z.get(
    "/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: dflowQuoteQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow quote requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const query = request.query;

      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: query.inputMint,
        outputMint: query.outputMint,
        hasDeterministicIntent: true,
        app,
        reply,
      });
      if (!proofAllowed) return;

      const hotTokenIds = [query.inputMint, query.outputMint]
        .filter(
          (mint): mint is string =>
            Boolean(mint) && mint !== env.solanaUsdcMint,
        )
        .map((mint) => `sol:${mint}`);
      if (hotTokenIds.length) {
        void markHotTokens({ tokenIds: hotTokenIds, venue: "dflow" });
        void requestPriceRefreshForTokens({
          tokenIds: hotTokenIds,
          venue: "dflow",
        });
      }

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 10_000,
        method: "GET",
        requestPath: "/quote",
        apiKey: env.dflowApiKey,
        query: {
          inputMint: query.inputMint,
          outputMint: query.outputMint,
          amount: query.amount,
          ...(query.slippageBps != null
            ? { slippageBps: query.slippageBps }
            : {}),
          ...(query.platformFeeBps != null
            ? { platformFeeBps: query.platformFeeBps }
            : {}),
          ...(query.platformFeeScale != null
            ? { platformFeeScale: query.platformFeeScale }
            : {}),
          ...(query.platformFeeMode
            ? { platformFeeMode: query.platformFeeMode }
            : {}),
          ...(query.feeAccount ? { feeAccount: query.feeAccount } : {}),
        },
      });

      if (!upstream.ok) {
        if (isDflowRouteNotFound(upstream.payload)) {
          void markDflowRouteUnavailable([
            query.inputMint,
            query.outputMint,
          ]).catch((error) =>
            app.log.warn({ error }, "Failed to mark DFlow route unavailable"),
          );
        }
        const userMessage = formatDflowUserMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: userMessage ?? "DFlow quote failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
    },
  );

  /**
   * POST /swap
   * Returns an unsigned swap transaction from DFlow.
   */
  z.post(
    "/swap",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSwapBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow swap requires a Solana wallet address",
        });
      }

      if (!ensureDflowReady(reply)) return;

      const body = request.body;
      if (body.userPublicKey !== walletAddress) {
        reply.code(400);
        return reply.send({
          error: "userPublicKey must match the selected wallet",
        });
      }

      const mintPair = findMintPair(body.quoteResponse);
      const proofAllowed = await enforceKalshiProof({
        user,
        walletAddress,
        inputMint: mintPair?.inputMint ?? null,
        outputMint: mintPair?.outputMint ?? null,
        hasDeterministicIntent: Boolean(mintPair),
        app,
        reply,
      });
      if (!proofAllowed) return;

      const upstream = await dflowRequest({
        baseUrl: env.dflowQuoteBase,
        timeoutMs: 15_000,
        method: "POST",
        requestPath: "/swap",
        apiKey: env.dflowApiKey,
        body: {
          userPublicKey: body.userPublicKey,
          quoteResponse: body.quoteResponse,
          ...(body.dynamicComputeUnitLimit !== undefined
            ? { dynamicComputeUnitLimit: body.dynamicComputeUnitLimit }
            : {}),
          ...(body.prioritizationFeeLamports !== undefined
            ? { prioritizationFeeLamports: body.prioritizationFeeLamports }
            : {}),
        },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "DFlow swap failed",
          status: upstream.status,
          message: extractDflowErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
    },
  );

  /**
   * POST /admin/prediction-market-init
   * Admin-only utility to initialize a DFlow prediction market ahead of the
   * user trade path, paid by the dedicated Solana sponsor wallet.
   */
  z.post(
    "/admin/prediction-market-init",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:write",
      }),
      schema: { body: dflowPredictionMarketInitBodySchema },
    },
    async (request, reply) => {
      if (!ensureDflowReady(reply)) return;
      try {
        const result = await initializeDflowPredictionMarket({
          outcomeMint: request.body.outcomeMint,
          maxRetries: request.body.maxRetries,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          ...result,
        });
      } catch (error) {
        app.log.error(
          { error, outcomeMint: request.body.outcomeMint },
          "DFlow prediction market init failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "DFlow prediction market init failed",
        });
      }
    },
  );

  /**
   * POST /submit
   * Broadcast a signed Solana transaction and return the signature.
   */
  z.post(
    "/submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow submit requires a Solana wallet address",
        });
      }

      try {
        const signature = await sendSolanaRawTransaction({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: env.solanaRpcTimeoutMs,
          signedTransaction: request.body.signedTransaction,
          skipPreflight: request.body.skipPreflight,
          maxRetries: request.body.maxRetries,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signature,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "DFlow submit failed",
        );
        reply.code(502);
        return reply.send({
          error: "DFlow submit failed",
        });
      }
    },
  );

  /**
   * POST /sponsored-submit
   * Add the Hunch sponsor signature to a user-signed DFlow transaction and
   * broadcast it. This path is only for backend-created DFlow sponsorship
   * intents; generic Privy Solana sponsorship stays disabled for DFlow.
   */
  z.post(
    "/sponsored-submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowSponsoredSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isSolanaWallet(walletAddress)) {
        reply.code(400);
        return reply.send({
          error: "DFlow submit requires a Solana wallet address",
        });
      }

      try {
        const result = await signAndBroadcastSponsoredDflowTransaction({
          userId: user.id,
          walletAddress,
          sponsorshipIntentId: request.body.sponsorshipIntentId,
          signedTransaction: request.body.signedTransaction,
          maxRetries: request.body.maxRetries,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          sponsored: true,
          signature: result.signature,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "DFlow sponsored submit failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "DFlow sponsored submit failed",
        });
      }
    },
  );

  /**
   * POST /executions
   * Persist DFlow execution metadata for the selected wallet.
   */
  z.post(
    "/executions",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: dflowExecutionBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const requestedWalletAddress =
        body.walletAddress?.trim() || walletAddress;
      const resolvedWalletAddresses = await resolveRequestedWalletAddresses(
        user.id,
        walletAddress,
        requestedWalletAddress ? [requestedWalletAddress] : undefined,
      );
      const executionWalletAddress = resolvedWalletAddresses[0] ?? null;
      if (!executionWalletAddress || !isSolanaWallet(executionWalletAddress)) {
        reply.code(400);
        return reply.send({
          error:
            "DFlow execution tracking requires a linked Solana wallet address",
        });
      }
      const executionStatus = normalizeKalshiExecutionStatus(body.status);
      const executionPurpose = body.purpose ?? "trade";
      const executionRaw = mergeKalshiExecutionRaw(body.raw, {
        purpose: executionPurpose,
      });

      try {
        const execution = await storeExecution(pool, {
          userId: user.id,
          walletAddress: executionWalletAddress,
          venue: "kalshi",
          unifiedMarketId: normalizeKalshiMarketIdForStorage(body.marketId),
          side: body.side ?? null,
          inputMint: body.inputMint ?? null,
          outputMint: body.outputMint ?? null,
          amountIn: body.amountIn ?? null,
          amountOut: body.amountOut ?? null,
          inputDecimals: body.inputDecimals ?? null,
          outputDecimals: body.outputDecimals ?? null,
          quoteId: body.quoteId ?? null,
          venueOrderId: body.venueOrderId ?? null,
          txSignature: body.txSignature ?? null,
          status: executionStatus ?? null,
          raw: executionRaw,
        });
        const effects = await finalizeKalshiExecutionEffects(pool, {
          execution,
          purpose: executionPurpose,
          logger: app.log,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          referralFirstTrade: effects.referralFirstTrade ?? undefined,
          execution: {
            id: execution.id,
            venue: execution.venue,
            unifiedMarketId: execution.unified_market_id,
            side: execution.side,
            outcome: execution.outcome,
            inputMint: execution.input_mint,
            outputMint: execution.output_mint,
            amountIn:
              execution.amount_in != null ? Number(execution.amount_in) : null,
            amountOut:
              execution.amount_out != null
                ? Number(execution.amount_out)
                : null,
            inputDecimals: execution.input_decimals ?? null,
            outputDecimals: execution.output_decimals ?? null,
            quoteId: execution.quote_id,
            txSignature: execution.tx_signature,
            venueOrderId: execution.venue_order_id,
            status: execution.status,
            raw: execution.raw ?? null,
            createdAt: execution.created_at,
            updatedAt: execution.updated_at,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, body },
          "Failed to store DFlow execution",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to store DFlow execution",
        });
      }
    },
  );
};
