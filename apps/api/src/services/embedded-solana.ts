import { createHash } from "node:crypto";
import {
  type AccountMeta,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { User } from "../auth.js";
import { env } from "../env.js";
import {
  type PrivyWalletApiRequestSignatureInput,
  type PrivyWalletProfile,
  PrivyService,
} from "../privy-service.js";
import { fetchSolanaBalanceLamports } from "./solana-rpc.js";

const PRIVY_WALLET_API_BASE_URL = "https://api.privy.io";
const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
const EMBEDDED_SOLANA_SPONSOR_FLOOR_LAMPORTS = BigInt(3_000_000);
const EMBEDDED_SOLANA_TX_FEE_LAMPORTS = BigInt(5_000_000);
const EMBEDDED_SOLANA_USER_TX_FEE_BUFFER_LAMPORTS = BigInt(3_000_000);
const EMBEDDED_SOLANA_BASE_SPONSOR_THRESHOLD_LAMPORTS =
  EMBEDDED_SOLANA_SPONSOR_FLOOR_LAMPORTS + EMBEDDED_SOLANA_TX_FEE_LAMPORTS;
const EMBEDDED_SOLANA_BALANCE_VERIFICATION_ERROR =
  "Unable to verify Solana balance. Retry in a few seconds.";
const EMBEDDED_SOLANA_SOL_REQUIRED_ERROR_PREFIX =
  "Add SOL to this Solana wallet for network fees and account setup, or reduce the amount, then try again.";

type CompiledSolanaInstruction =
  VersionedTransaction["message"]["compiledInstructions"][number];

function buildPrivyIdempotencyKey(inputs: {
  executionKey: string;
  requestId: string;
}): string {
  const digest = createHash("sha256")
    .update(`embedded-solana:${inputs.executionKey}:${inputs.requestId}`)
    .digest("hex")
    .slice(0, 32);
  return `hunch-sol-${digest}`;
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  if (payload.startsWith("0x")) {
    const hex = payload.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function deserializeEmbeddedSolanaTransaction(
  transaction: string,
): VersionedTransaction | null {
  const raw = decodeSerializedSolanaTransaction(transaction.trim());
  if (!raw) return null;

  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return null;
  }
}

function getCompiledInstructionProgramId(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
): PublicKey | null {
  return tx.message.staticAccountKeys[instruction.programIdIndex] ?? null;
}

function buildTransactionInstruction(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
): TransactionInstruction | null {
  const programId = getCompiledInstructionProgramId(tx, instruction);
  if (!programId) return null;

  const keys: AccountMeta[] = [];
  for (const accountIndex of instruction.accountKeyIndexes) {
    const pubkey = tx.message.staticAccountKeys[accountIndex] ?? null;
    if (!pubkey) return null;
    keys.push({
      pubkey,
      isSigner: tx.message.isAccountSigner(accountIndex),
      isWritable: tx.message.isAccountWritable(accountIndex),
    });
  }

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(instruction.data),
  });
}

function instructionSyncsNativeSol(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
): boolean {
  const programId = getCompiledInstructionProgramId(tx, instruction);
  if (!programId) return false;
  const programIdBase58 = programId.toBase58();
  if (
    programIdBase58 !== SPL_TOKEN_PROGRAM_ID &&
    programIdBase58 !== TOKEN_2022_PROGRAM_ID
  ) {
    return false;
  }
  const data = Buffer.from(instruction.data);
  return data.length > 0 && data[0] === TOKEN_SYNC_NATIVE_INSTRUCTION;
}

function instructionTransfersNativeSolFromSignerOrFeePayer(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
  signer: string,
): boolean {
  return (
    instructionTransfersNativeSolLamportsFromSignerOrFeePayer(
      tx,
      instruction,
      signer,
    ) > BigInt(0)
  );
}

function instructionTransfersNativeSolLamportsFromSignerOrFeePayer(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
  signer: string,
): bigint {
  const transactionInstruction = buildTransactionInstruction(tx, instruction);
  if (!transactionInstruction) return BigInt(0);
  if (!transactionInstruction.programId.equals(SystemProgram.programId)) {
    return BigInt(0);
  }

  const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  const blockedSources = new Set([signer, feePayer].filter(Boolean));

  try {
    const instructionType = SystemInstruction.decodeInstructionType(
      transactionInstruction,
    );
    if (instructionType === "Transfer") {
      const decoded = SystemInstruction.decodeTransfer(transactionInstruction);
      const lamports = BigInt(decoded.lamports.toString());
      return lamports > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
        ? lamports
        : BigInt(0);
    }
    if (instructionType === "TransferWithSeed") {
      const decoded = SystemInstruction.decodeTransferWithSeed(
        transactionInstruction,
      );
      const lamports = BigInt(decoded.lamports.toString());
      return lamports > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
        ? lamports
        : BigInt(0);
    }
  } catch {
    return BigInt(0);
  }

  return BigInt(0);
}

function instructionCreatesAccountWithSignerOrFeePayerLamports(
  tx: VersionedTransaction,
  instruction: CompiledSolanaInstruction,
  signer: string,
): bigint {
  const transactionInstruction = buildTransactionInstruction(tx, instruction);
  if (!transactionInstruction) return BigInt(0);
  if (!transactionInstruction.programId.equals(SystemProgram.programId)) {
    return BigInt(0);
  }

  const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  const blockedSources = new Set([signer, feePayer].filter(Boolean));

  try {
    const instructionType = SystemInstruction.decodeInstructionType(
      transactionInstruction,
    );
    if (instructionType === "Create") {
      const decoded = SystemInstruction.decodeCreateAccount(
        transactionInstruction,
      );
      const lamports = BigInt(decoded.lamports.toString());
      return lamports > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
        ? lamports
        : BigInt(0);
    }
    if (instructionType === "CreateWithSeed") {
      const decoded = SystemInstruction.decodeCreateWithSeed(
        transactionInstruction,
      );
      const lamports = BigInt(decoded.lamports.toString());
      return lamports > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
        ? lamports
        : BigInt(0);
    }
  } catch {
    return BigInt(0);
  }

  return BigInt(0);
}

function shouldDisableEmbeddedSolanaSponsorshipForDeserializedTransaction(inputs: {
  signer: string;
  tx: VersionedTransaction;
}): boolean {
  return inputs.tx.message.compiledInstructions.some(
    (instruction) =>
      instructionSyncsNativeSol(inputs.tx, instruction) ||
      instructionTransfersNativeSolFromSignerOrFeePayer(
        inputs.tx,
        instruction,
        inputs.signer,
      ),
  );
}

export function shouldDisableEmbeddedSolanaSponsorshipForTransaction(inputs: {
  signer: string;
  transaction: string;
}): boolean {
  const tx = deserializeEmbeddedSolanaTransaction(inputs.transaction);
  if (!tx) return false;

  return shouldDisableEmbeddedSolanaSponsorshipForDeserializedTransaction({
    signer: inputs.signer,
    tx,
  });
}

function transactionUsesNativeSolSource(inputs: {
  signer: string;
  transaction: string;
}): boolean {
  return shouldDisableEmbeddedSolanaSponsorshipForTransaction(inputs);
}

export function getEmbeddedSolanaSponsorshipRequirementLamports(inputs: {
  signer: string;
  transaction: string;
}): bigint {
  const tx = deserializeEmbeddedSolanaTransaction(inputs.transaction);
  if (!tx) return EMBEDDED_SOLANA_BASE_SPONSOR_THRESHOLD_LAMPORTS;

  let requiredLamports = EMBEDDED_SOLANA_BASE_SPONSOR_THRESHOLD_LAMPORTS;
  for (const instruction of tx.message.compiledInstructions) {
    requiredLamports += instructionCreatesAccountWithSignerOrFeePayerLamports(
      tx,
      instruction,
      inputs.signer,
    );
  }
  return requiredLamports;
}

function getEmbeddedSolanaUserPaidRequirementLamports(inputs: {
  signer: string;
  transaction: string;
}): bigint {
  const tx = deserializeEmbeddedSolanaTransaction(inputs.transaction);
  if (!tx) return EMBEDDED_SOLANA_BASE_SPONSOR_THRESHOLD_LAMPORTS;

  let requiredLamports = EMBEDDED_SOLANA_USER_TX_FEE_BUFFER_LAMPORTS;
  for (const instruction of tx.message.compiledInstructions) {
    requiredLamports +=
      instructionTransfersNativeSolLamportsFromSignerOrFeePayer(
        tx,
        instruction,
        inputs.signer,
      );
    requiredLamports += instructionCreatesAccountWithSignerOrFeePayerLamports(
      tx,
      instruction,
      inputs.signer,
    );
  }
  return requiredLamports;
}

function formatSolLamports(lamports: bigint): string {
  const sign = lamports < BigInt(0) ? "-" : "";
  const absolute = lamports < BigInt(0) ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = absolute % LAMPORTS_PER_SOL;
  const fractionText = fraction
    .toString()
    .padStart(9, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return fractionText
    ? `${sign}${whole.toString()}.${fractionText}`
    : `${sign}${whole.toString()}`;
}

function buildEmbeddedSolanaSolRequiredError(inputs: {
  requiredLamports: bigint;
  currentLamports: bigint | null;
}): Error {
  const currentLabel =
    inputs.currentLamports == null
      ? "unknown"
      : `${formatSolLamports(inputs.currentLamports)} SOL`;
  return new Error(
    `${EMBEDDED_SOLANA_SOL_REQUIRED_ERROR_PREFIX} Needs at least ${formatSolLamports(
      inputs.requiredLamports,
    )} SOL available; current balance is ${currentLabel}.`,
  );
}

function resolveEmbeddedSolanaSponsor(inputs: {
  context: EmbeddedSolanaWalletContext;
  transaction: EmbeddedSolanaTransactionSpec;
  embeddedSolanaSponsorshipEnabled: boolean;
  sponsorBalanceLamports?: bigint | null;
}): boolean {
  if (!inputs.embeddedSolanaSponsorshipEnabled) return false;
  if (inputs.transaction.sponsor === false) return false;
  // The client flag is advisory. Never sponsor transactions that directly
  // spend native SOL or wrap SOL, because sponsorship can otherwise become
  // the SOL source for fee-funded conversion loops.
  if (
    shouldDisableEmbeddedSolanaSponsorshipForTransaction({
      signer: inputs.context.signer,
      transaction: inputs.transaction.transaction,
    })
  ) {
    return false;
  }

  if (inputs.sponsorBalanceLamports != null) {
    const requiredLamports = getEmbeddedSolanaSponsorshipRequirementLamports({
      signer: inputs.context.signer,
      transaction: inputs.transaction.transaction,
    });
    if (inputs.sponsorBalanceLamports >= requiredLamports) return false;
  }

  return true;
}

function isKalshiReduceOrderEscrowInitializationMessage(
  message: string,
): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("invalidaccountowner") &&
      (normalized.includes("inituserreduceorderescrow") ||
        normalized.includes("user_outcome_vault check failed"))) ||
    ((normalized.includes("invalid account owner") ||
      normalized.includes("invalidaccountowner")) &&
      normalized.includes("predictmksnpfkfiz33ndsdbe2dy43kypg4u2dbvhvb"))
  );
}

function isKalshiInsufficientTradeFundsMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("predictmksnpfkfiz33ndsdbe2dy43kypg4u2dbvhvb") &&
    normalized.includes("instruction: transferchecked") &&
    normalized.includes("error: insufficient funds")
  );
}

function isExpiredBlockhashMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("blockhash not found") ||
    normalized.includes("blockhash expired") ||
    normalized.includes("transaction expired") ||
    normalized.includes("block height exceeded")
  );
}

function normalizeEmbeddedSolanaRpcErrorMessage(message: string): string {
  if (isExpiredBlockhashMessage(message)) {
    return "Transaction expired. Refresh quote and try again.";
  }
  if (isKalshiReduceOrderEscrowInitializationMessage(message)) {
    return "Trade could not be prepared yet. Retry the sell in a moment.";
  }
  if (isKalshiInsufficientTradeFundsMessage(message)) {
    return "Selected wallet no longer has enough balance for this trade. Refresh balances or reduce the order size.";
  }
  return message;
}

export type EmbeddedPrivyAuthorizationRequest = {
  id: string;
  label: string;
  input: PrivyWalletApiRequestSignatureInput;
};

export type EmbeddedPrivyAuthorizationSignature = {
  id: string;
  signature: string;
};

export type EmbeddedSolanaTransactionSpec = {
  id: string;
  label: string;
  transaction: string;
  encoding?: "base64";
  sponsor?: boolean;
  caip2?: string | null;
};

export type EmbeddedSolanaWalletContext = {
  signer: string;
  walletProfile: PrivyWalletProfile;
  walletId: string;
};

export type EmbeddedSolanaSponsorBalanceFetcher = (
  context: EmbeddedSolanaWalletContext,
) => Promise<bigint>;

function isSolanaAddress(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    return bs58.decode(trimmed).length === 32;
  } catch {
    return false;
  }
}

function requireSolanaAddress(value: string, message: string): string {
  const trimmed = value.trim();
  if (!isSolanaAddress(trimmed)) {
    throw new Error(message);
  }
  return trimmed;
}

function buildPrivyWalletRpcUrl(walletId: string): string {
  return `${PRIVY_WALLET_API_BASE_URL}/api/v1/wallets/${walletId}/rpc`;
}

function buildPrivyWalletHeaders(
  signatureInput: PrivyWalletApiRequestSignatureInput,
  authorizationSignature: string,
): HeadersInit {
  return {
    Authorization: `Basic ${Buffer.from(
      `${env.privyAppId}:${env.privyAppSecret}`,
    ).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "privy-app-id": signatureInput.headers["privy-app-id"],
    ...(signatureInput.headers["privy-idempotency-key"]
      ? {
          "privy-idempotency-key":
            signatureInput.headers["privy-idempotency-key"],
        }
      : {}),
    "privy-authorization-signature": authorizationSignature,
  };
}

function createPrivyWalletRpcRequest(args: {
  id: string;
  label: string;
  walletId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string | null;
}): EmbeddedPrivyAuthorizationRequest {
  return {
    id: args.id,
    label: args.label,
    input: {
      version: 1,
      method: "POST",
      url: buildPrivyWalletRpcUrl(args.walletId),
      body: args.body,
      headers: {
        "privy-app-id": env.privyAppId,
        ...(args.idempotencyKey
          ? { "privy-idempotency-key": args.idempotencyKey }
          : {}),
      },
    },
  };
}

async function executePreparedPrivyAuthorizationRequest(
  request: EmbeddedPrivyAuthorizationRequest,
  authorizationSignature: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(request.input.url, {
    method: request.input.method,
    headers: buildPrivyWalletHeaders(request.input, authorizationSignature),
    body: JSON.stringify(request.input.body),
  });
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const rawMessage =
      (payload &&
        typeof payload.error === "string" &&
        payload.error.trim().length > 0 &&
        payload.error) ||
      (payload &&
        typeof payload.message === "string" &&
        payload.message.trim().length > 0 &&
        payload.message) ||
      `Privy wallet request failed (${response.status})`;
    throw new Error(normalizeEmbeddedSolanaRpcErrorMessage(rawMessage));
  }
  return payload ?? {};
}

function findAuthorizationSignature(
  signatures: EmbeddedPrivyAuthorizationSignature[],
  requestId: string,
): string {
  const match = signatures.find((entry) => entry.id === requestId)?.signature;
  const trimmed = match?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`Missing Privy authorization signature for ${requestId}.`);
  }
  return trimmed;
}

function parsePrivySolanaSignatureResponse(
  payload: Record<string, unknown>,
): string {
  const data =
    payload && typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : null;
  const signatureCandidates = [
    data?.hash,
    data?.signature,
    payload.hash,
    payload.signature,
  ];
  for (const candidate of signatureCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  throw new Error(
    "Privy wallet response did not include a Solana transaction signature.",
  );
}

export async function resolveEmbeddedSolanaWalletContext(inputs: {
  user: User;
  signer: string;
}): Promise<EmbeddedSolanaWalletContext> {
  if (!inputs.user.privyUserId) {
    throw new Error("Current user is missing a Privy identity.");
  }
  const signer = requireSolanaAddress(
    inputs.signer,
    "Embedded execution requires a Solana signer wallet.",
  );
  const privyUser = await PrivyService.getUserById(inputs.user.privyUserId);
  const walletProfiles = PrivyService.classifyWallets(privyUser);
  const walletProfile =
    walletProfiles.find(
      (profile) =>
        profile.walletType === "solana" && profile.address === signer,
    ) ?? null;
  if (!walletProfile?.isInternalWallet) {
    throw new Error(
      "Embedded execution is only available for internal Trading Wallets.",
    );
  }
  const walletId = walletProfile.walletId?.trim() ?? "";
  if (!walletId) {
    throw new Error(
      "Embedded Trading Wallet is missing a Privy wallet id. Refresh your session and try again.",
    );
  }
  return {
    signer,
    walletProfile,
    walletId,
  };
}

export function buildEmbeddedSolanaSignAndSendRequest(inputs: {
  context: EmbeddedSolanaWalletContext;
  transaction: EmbeddedSolanaTransactionSpec;
  executionKey?: string | null;
  embeddedSolanaSponsorshipEnabled?: boolean;
  sponsorBalanceLamports?: bigint | null;
}): EmbeddedPrivyAuthorizationRequest {
  const transaction = inputs.transaction.transaction.trim();
  if (!transaction) {
    throw new Error(
      `${inputs.transaction.label} is missing a serialized Solana transaction.`,
    );
  }

  return createPrivyWalletRpcRequest({
    id: inputs.transaction.id,
    label: inputs.transaction.label,
    walletId: inputs.context.walletId,
    idempotencyKey: inputs.executionKey
      ? buildPrivyIdempotencyKey({
          executionKey: inputs.executionKey,
          requestId: inputs.transaction.id,
        })
      : null,
    body: {
      chain_type: "solana",
      method: "signAndSendTransaction",
      sponsor: resolveEmbeddedSolanaSponsor({
        context: inputs.context,
        transaction: inputs.transaction,
        embeddedSolanaSponsorshipEnabled:
          inputs.embeddedSolanaSponsorshipEnabled === true,
        sponsorBalanceLamports: inputs.sponsorBalanceLamports,
      }),
      params: {
        transaction,
        encoding: inputs.transaction.encoding ?? "base64",
      },
      caip2: inputs.transaction.caip2?.trim() || SOLANA_MAINNET_CAIP2,
    },
  });
}

async function fetchEmbeddedSolanaSponsorBalanceLamports(
  context: EmbeddedSolanaWalletContext,
): Promise<bigint> {
  return fetchSolanaBalanceLamports({
    rpcUrls: env.solanaRpcUrls,
    owner: context.signer,
    timeoutMs: env.solanaRpcTimeoutMs,
  });
}

function shouldFetchEmbeddedSolanaSponsorBalance(inputs: {
  context: EmbeddedSolanaWalletContext;
  transactions: EmbeddedSolanaTransactionSpec[];
}): boolean {
  return inputs.transactions.some(
    (transaction) =>
      transaction.sponsor !== false &&
      !transactionUsesNativeSolSource({
        signer: inputs.context.signer,
        transaction: transaction.transaction,
      }),
  );
}

function hasEmbeddedSolanaNativeSourceTransaction(inputs: {
  context: EmbeddedSolanaWalletContext;
  transactions: EmbeddedSolanaTransactionSpec[];
}): boolean {
  return inputs.transactions.some((transaction) =>
    transactionUsesNativeSolSource({
      signer: inputs.context.signer,
      transaction: transaction.transaction,
    }),
  );
}

function getEmbeddedSolanaRequiredSignerLamports(inputs: {
  context: EmbeddedSolanaWalletContext;
  transactions: EmbeddedSolanaTransactionSpec[];
}): bigint {
  let requiredLamports = BigInt(0);
  for (const transaction of inputs.transactions) {
    const transactionRequirement = getEmbeddedSolanaUserPaidRequirementLamports(
      {
        signer: inputs.context.signer,
        transaction: transaction.transaction,
      },
    );
    requiredLamports += transactionRequirement;
  }
  return requiredLamports;
}

export async function prepareEmbeddedSolanaTransactionRequests(inputs: {
  context: EmbeddedSolanaWalletContext;
  transactions: EmbeddedSolanaTransactionSpec[];
  executionKey?: string | null;
  embeddedSolanaSponsorshipEnabled?: boolean;
  fetchSponsorBalanceLamports?: EmbeddedSolanaSponsorBalanceFetcher;
  onSponsorBalanceFetchError?: (error: unknown) => void;
}): Promise<EmbeddedPrivyAuthorizationRequest[]> {
  const embeddedSolanaSponsorshipEnabled =
    inputs.embeddedSolanaSponsorshipEnabled === true;
  const hasNativeSolSourceTransaction =
    hasEmbeddedSolanaNativeSourceTransaction({
      context: inputs.context,
      transactions: inputs.transactions,
    });
  const shouldFetchSponsorBalance = shouldFetchEmbeddedSolanaSponsorBalance({
    context: inputs.context,
    transactions: inputs.transactions,
  });
  let sponsorBalanceLamports: bigint | null = null;
  if (
    !embeddedSolanaSponsorshipEnabled ||
    hasNativeSolSourceTransaction ||
    shouldFetchSponsorBalance
  ) {
    try {
      sponsorBalanceLamports = await (
        inputs.fetchSponsorBalanceLamports ??
        fetchEmbeddedSolanaSponsorBalanceLamports
      )(inputs.context);
    } catch (error) {
      inputs.onSponsorBalanceFetchError?.(error);
      if (!embeddedSolanaSponsorshipEnabled || hasNativeSolSourceTransaction) {
        throw new Error(EMBEDDED_SOLANA_BALANCE_VERIFICATION_ERROR);
      }
      sponsorBalanceLamports = null;
    }
  }

  if (!embeddedSolanaSponsorshipEnabled) {
    const requiredLamports = getEmbeddedSolanaRequiredSignerLamports({
      context: inputs.context,
      transactions: inputs.transactions,
    });
    if (
      sponsorBalanceLamports == null ||
      sponsorBalanceLamports < requiredLamports
    ) {
      throw buildEmbeddedSolanaSolRequiredError({
        requiredLamports,
        currentLamports: sponsorBalanceLamports,
      });
    }
  }

  if (embeddedSolanaSponsorshipEnabled && hasNativeSolSourceTransaction) {
    const requiredLamports = getEmbeddedSolanaRequiredSignerLamports({
      context: inputs.context,
      transactions: inputs.transactions,
    });
    if (
      sponsorBalanceLamports == null ||
      sponsorBalanceLamports < requiredLamports
    ) {
      throw buildEmbeddedSolanaSolRequiredError({
        requiredLamports,
        currentLamports: sponsorBalanceLamports,
      });
    }
  }

  return inputs.transactions.map((transaction) =>
    buildEmbeddedSolanaSignAndSendRequest({
      context: inputs.context,
      transaction,
      executionKey: inputs.executionKey,
      embeddedSolanaSponsorshipEnabled,
      sponsorBalanceLamports,
    }),
  );
}

export async function executeEmbeddedSolanaTransactionRequests(inputs: {
  requests: EmbeddedPrivyAuthorizationRequest[];
  signatures: EmbeddedPrivyAuthorizationSignature[];
}): Promise<string[]> {
  const transactionSignatures: string[] = [];
  for (const request of inputs.requests) {
    const authorizationSignature = findAuthorizationSignature(
      inputs.signatures,
      request.id,
    );
    const payload = await executePreparedPrivyAuthorizationRequest(
      request,
      authorizationSignature,
    );
    transactionSignatures.push(parsePrivySolanaSignatureResponse(payload));
  }
  return transactionSignatures;
}
