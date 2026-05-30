import { randomUUID, createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  type AccountMeta,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

import { env } from "../env.js";
import { getRedis } from "../redis.js";

export type EmbeddedSolanaSponsorshipFlow =
  | "dflow"
  | "across"
  | "directTransfer"
  | "debridge";

export type EmbeddedSolanaSponsorshipMode = "observe" | "enforce";

export type EmbeddedSolanaSponsorshipFlows = Record<
  EmbeddedSolanaSponsorshipFlow,
  boolean
>;

export type EmbeddedSolanaSponsorshipIntent = {
  id: string;
  flow: EmbeddedSolanaSponsorshipFlow;
  userId: string;
  signer: string;
  transactionDigest: string;
  createdAt: string;
  expiresAt: string;
  metadata?: Record<string, unknown>;
};

export type EmbeddedSolanaInstructionSummary = {
  index: number;
  programId: string | null;
  accountIndexes: number[];
  accountAddresses: string[];
  dataLength: number;
  dataPrefixHex: string;
};

export type EmbeddedSolanaTransactionAnalysis = {
  ok: boolean;
  digest: string | null;
  version: "legacy" | number | null;
  feePayer: string | null;
  signerAddresses: string[];
  signatureCount: number;
  staticAccountCount: number;
  addressTableLookupCount: number;
  usesAddressLookupTables: boolean;
  programIds: string[];
  unknownProgramIds: string[];
  instructions: EmbeddedSolanaInstructionSummary[];
  hasNativeSolTransfer: boolean;
  hasSyncNative: boolean;
  systemCreateLamports: string;
  ataCreateCount: number;
  estimatedSponsorLamports: string;
  malformedReason: string | null;
  rawTransaction?: string;
};

export type EmbeddedSolanaSponsorshipEvaluation = {
  mode: EmbeddedSolanaSponsorshipMode;
  enabled: boolean;
  requestedSponsor: boolean;
  legacyWouldSponsor: boolean;
  enforceWouldSponsor: boolean;
  actualSponsor: boolean;
  flow: EmbeddedSolanaSponsorshipFlow | null;
  intentId: string | null;
  intentStatus:
    | "missing"
    | "not_found"
    | "expired"
    | "matched"
    | "mismatch"
    | "not_required";
  verdict: "allow" | "deny" | "observe";
  reasons: string[];
  analysis: EmbeddedSolanaTransactionAnalysis;
};

const INTENT_TTL_SEC = 5 * 60;
const SOLANA_TX_FEE_LAMPORTS = BigInt(5_000);
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;
const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const ASSOCIATED_TOKEN_PROGRAM_ID_BASE58 =
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const TOKEN_PROGRAM_ID_BASE58 = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM_ID_BASE58 = TOKEN_2022_PROGRAM_ID.toBase58();
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LEGACY_MEMO_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const DFLOW_PROGRAM_ID = "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH";
const DFLOW_PREDICTION_PROGRAM_ID =
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";
export const ACROSS_SOLANA_SPOKE_POOL_PROGRAM_ID =
  "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru";

const BASE_ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID_BASE58,
  TOKEN_2022_PROGRAM_ID_BASE58,
  ASSOCIATED_TOKEN_PROGRAM_ID_BASE58,
  MEMO_PROGRAM_ID,
  LEGACY_MEMO_PROGRAM_ID,
]);

const FLOW_ALLOWED_PROGRAMS: Record<EmbeddedSolanaSponsorshipFlow, Set<string>> =
  {
    dflow: new Set([
      ...BASE_ALLOWED_PROGRAMS,
      DFLOW_PROGRAM_ID,
      DFLOW_PREDICTION_PROGRAM_ID,
    ]),
    across: new Set([
      ...BASE_ALLOWED_PROGRAMS,
      ACROSS_SOLANA_SPOKE_POOL_PROGRAM_ID,
    ]),
    directTransfer: new Set([...BASE_ALLOWED_PROGRAMS]),
    debridge: new Set([...BASE_ALLOWED_PROGRAMS]),
  };

const sponsorshipIntentMemory = new Map<
  string,
  EmbeddedSolanaSponsorshipIntent
>();

function normalizeSolanaAddress(value: string): string {
  return value.trim();
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("0x")) {
    const hex = trimmed.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
}

export function computeEmbeddedSolanaTransactionDigest(
  transaction: string,
): string | null {
  const raw = decodeSerializedSolanaTransaction(transaction);
  if (!raw) return null;
  return createHash("sha256").update(raw).digest("hex");
}

function deserializeEmbeddedSolanaTransaction(
  transaction: string,
): { raw: Buffer; tx: VersionedTransaction } | null {
  const raw = decodeSerializedSolanaTransaction(transaction);
  if (!raw) return null;
  try {
    return { raw, tx: VersionedTransaction.deserialize(raw) };
  } catch {
    return null;
  }
}

function getAddressTableLookupCount(tx: VersionedTransaction): number {
  const message = tx.message as VersionedTransaction["message"] & {
    addressTableLookups?: unknown[];
  };
  return Array.isArray(message.addressTableLookups)
    ? message.addressTableLookups.length
    : 0;
}

function getSignerAddresses(tx: VersionedTransaction): string[] {
  const requiredSignatures = tx.message.header.numRequiredSignatures;
  return tx.message.staticAccountKeys
    .slice(0, requiredSignatures)
    .map((key) => key.toBase58());
}

function buildTransactionInstruction(
  tx: VersionedTransaction,
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
): TransactionInstruction | null {
  const programId = tx.message.staticAccountKeys[instruction.programIdIndex];
  if (!programId) return null;

  const keys: AccountMeta[] = [];
  for (const accountIndex of instruction.accountKeyIndexes) {
    const pubkey = tx.message.staticAccountKeys[accountIndex];
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

function getSystemCreateLamports(
  tx: VersionedTransaction,
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
  signer: string,
): bigint {
  const txInstruction = buildTransactionInstruction(tx, instruction);
  if (!txInstruction?.programId.equals(SystemProgram.programId)) return BigInt(0);
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  const blockedSources = new Set([signer, feePayer].filter(Boolean));

  try {
    const instructionType =
      SystemInstruction.decodeInstructionType(txInstruction);
    if (instructionType === "Create") {
      const decoded = SystemInstruction.decodeCreateAccount(txInstruction);
      const lamports = BigInt(decoded.lamports.toString());
      return lamports > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
        ? lamports
        : BigInt(0);
    }
    if (instructionType === "CreateWithSeed") {
      const decoded = SystemInstruction.decodeCreateWithSeed(txInstruction);
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

function instructionTransfersNativeSol(
  tx: VersionedTransaction,
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
  signer: string,
): boolean {
  const txInstruction = buildTransactionInstruction(tx, instruction);
  if (!txInstruction?.programId.equals(SystemProgram.programId)) return false;
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? null;
  const blockedSources = new Set([signer, feePayer].filter(Boolean));

  try {
    const instructionType =
      SystemInstruction.decodeInstructionType(txInstruction);
    if (instructionType === "Transfer") {
      const decoded = SystemInstruction.decodeTransfer(txInstruction);
      return (
        BigInt(decoded.lamports.toString()) > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
      );
    }
    if (instructionType === "TransferWithSeed") {
      const decoded = SystemInstruction.decodeTransferWithSeed(txInstruction);
      return (
        BigInt(decoded.lamports.toString()) > BigInt(0) &&
        blockedSources.has(decoded.fromPubkey.toBase58())
      );
    }
  } catch {
    return false;
  }

  return false;
}

function instructionSyncsNativeSol(
  tx: VersionedTransaction,
  instruction: VersionedTransaction["message"]["compiledInstructions"][number],
): boolean {
  const programId =
    tx.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() ?? "";
  if (
    programId !== TOKEN_PROGRAM_ID_BASE58 &&
    programId !== TOKEN_2022_PROGRAM_ID_BASE58
  ) {
    return false;
  }
  const data = Buffer.from(instruction.data);
  return data.length > 0 && data[0] === TOKEN_SYNC_NATIVE_INSTRUCTION;
}

export function analyzeEmbeddedSolanaTransaction(inputs: {
  signer: string;
  transaction: string;
  includeRaw?: boolean;
}): EmbeddedSolanaTransactionAnalysis {
  const decoded = deserializeEmbeddedSolanaTransaction(inputs.transaction);
  if (!decoded) {
    return {
      ok: false,
      digest: computeEmbeddedSolanaTransactionDigest(inputs.transaction),
      version: null,
      feePayer: null,
      signerAddresses: [],
      signatureCount: 0,
      staticAccountCount: 0,
      addressTableLookupCount: 0,
      usesAddressLookupTables: false,
      programIds: [],
      unknownProgramIds: [],
      instructions: [],
      hasNativeSolTransfer: false,
      hasSyncNative: false,
      systemCreateLamports: "0",
      ataCreateCount: 0,
      estimatedSponsorLamports: "0",
      malformedReason: "deserialize_failed",
      ...(inputs.includeRaw ? { rawTransaction: inputs.transaction } : {}),
    };
  }

  const { raw, tx } = decoded;
  const signer = normalizeSolanaAddress(inputs.signer);
  const instructions: EmbeddedSolanaInstructionSummary[] = [];
  const programIds = new Set<string>();
  let malformedReason: string | null = null;
  let hasNativeSolTransfer = false;
  let hasSyncNative = false;
  let systemCreateLamports = BigInt(0);
  let ataCreateCount = 0;

  tx.message.compiledInstructions.forEach((instruction, index) => {
    const programId =
      tx.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() ??
      null;
    if (!programId) malformedReason ??= "missing_program_id";
    if (programId) {
      programIds.add(programId);
      if (programId === ASSOCIATED_TOKEN_PROGRAM_ID_BASE58) {
        ataCreateCount += 1;
      }
    }

    const accountAddresses: string[] = [];
    for (const accountIndex of instruction.accountKeyIndexes) {
      const account = tx.message.staticAccountKeys[accountIndex];
      if (!account) {
        malformedReason ??= "missing_instruction_account";
        continue;
      }
      accountAddresses.push(account.toBase58());
    }

    hasNativeSolTransfer ||= instructionTransfersNativeSol(
      tx,
      instruction,
      signer,
    );
    hasSyncNative ||= instructionSyncsNativeSol(tx, instruction);
    systemCreateLamports += getSystemCreateLamports(tx, instruction, signer);

    const data = Buffer.from(instruction.data);
    instructions.push({
      index,
      programId,
      accountIndexes: Array.from(instruction.accountKeyIndexes),
      accountAddresses,
      dataLength: data.length,
      dataPrefixHex: data.subarray(0, 12).toString("hex"),
    });
  });

  const signatureCount = tx.signatures.length;
  const estimatedSponsorLamports =
    SOLANA_TX_FEE_LAMPORTS * BigInt(Math.max(signatureCount, 1)) +
    systemCreateLamports;

  return {
    ok: malformedReason == null,
    digest: createHash("sha256").update(raw).digest("hex"),
    version: tx.version,
    feePayer: tx.message.staticAccountKeys[0]?.toBase58() ?? null,
    signerAddresses: getSignerAddresses(tx),
    signatureCount,
    staticAccountCount: tx.message.staticAccountKeys.length,
    addressTableLookupCount: getAddressTableLookupCount(tx),
    usesAddressLookupTables: getAddressTableLookupCount(tx) > 0,
    programIds: Array.from(programIds).sort(),
    unknownProgramIds: [],
    instructions,
    hasNativeSolTransfer,
    hasSyncNative,
    systemCreateLamports: systemCreateLamports.toString(),
    ataCreateCount,
    estimatedSponsorLamports: estimatedSponsorLamports.toString(),
    malformedReason,
    ...(inputs.includeRaw ? { rawTransaction: inputs.transaction } : {}),
  };
}

function getIntentRedisKey(intentId: string): string {
  return `embedded-solana:sponsorship-intent:${intentId}`;
}

function pruneExpiredIntents(now = Date.now()): void {
  for (const [id, intent] of sponsorshipIntentMemory) {
    if (new Date(intent.expiresAt).getTime() <= now) {
      sponsorshipIntentMemory.delete(id);
    }
  }
}

function parseIntent(raw: string | null): EmbeddedSolanaSponsorshipIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EmbeddedSolanaSponsorshipIntent;
    if (!parsed?.id || !parsed.flow || !parsed.userId || !parsed.signer) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function createEmbeddedSolanaSponsorshipIntent(inputs: {
  flow: EmbeddedSolanaSponsorshipFlow;
  userId: string;
  signer: string;
  transaction: string;
  metadata?: Record<string, unknown>;
  ttlSec?: number;
}): Promise<EmbeddedSolanaSponsorshipIntent | null> {
  const digest = computeEmbeddedSolanaTransactionDigest(inputs.transaction);
  if (!digest) return null;

  const ttlSec = Math.max(30, Math.trunc(inputs.ttlSec ?? INTENT_TTL_SEC));
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSec * 1000);
  const intent: EmbeddedSolanaSponsorshipIntent = {
    id: `solsp_${randomUUID()}`,
    flow: inputs.flow,
    userId: inputs.userId,
    signer: normalizeSolanaAddress(inputs.signer),
    transactionDigest: digest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(inputs.metadata ? { metadata: inputs.metadata } : {}),
  };

  pruneExpiredIntents();
  sponsorshipIntentMemory.set(intent.id, intent);

  try {
    const redis = await getRedis();
    if (redis) {
      await redis.set(getIntentRedisKey(intent.id), JSON.stringify(intent), {
        EX: ttlSec,
      });
    }
  } catch {
    // Memory fallback is enough for same-process local testing. In prod, a Redis
    // outage makes intents best-effort and enforce mode will fail closed later.
  }

  return intent;
}

export async function readEmbeddedSolanaSponsorshipIntent(
  intentId: string | null | undefined,
): Promise<EmbeddedSolanaSponsorshipIntent | null> {
  const trimmed = intentId?.trim() ?? "";
  if (!trimmed) return null;

  try {
    const redis = await getRedis();
    if (redis) {
      const intent = parseIntent(await redis.get(getIntentRedisKey(trimmed)));
      if (intent) return intent;
    }
  } catch {
    // Memory fallback below keeps local testing usable if Redis is unavailable.
  }

  pruneExpiredIntents();
  return sponsorshipIntentMemory.get(trimmed) ?? null;
}

function getBigIntMetadata(
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

function validateIntent(inputs: {
  userId: string;
  signer: string;
  analysis: EmbeddedSolanaTransactionAnalysis;
  intent: EmbeddedSolanaSponsorshipIntent | null;
}): {
  status: EmbeddedSolanaSponsorshipEvaluation["intentStatus"];
  flow: EmbeddedSolanaSponsorshipFlow | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  const intent = inputs.intent;
  if (!intent) {
    return { status: "missing", flow: null, reasons: ["missing_intent"] };
  }

  const expiresAt = new Date(intent.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { status: "expired", flow: intent.flow, reasons: ["expired_intent"] };
  }
  if (intent.userId !== inputs.userId) reasons.push("intent_user_mismatch");
  if (normalizeSolanaAddress(intent.signer) !== normalizeSolanaAddress(inputs.signer)) {
    reasons.push("intent_signer_mismatch");
  }
  if (!inputs.analysis.digest || intent.transactionDigest !== inputs.analysis.digest) {
    reasons.push("intent_digest_mismatch");
  }

  return {
    status: reasons.length ? "mismatch" : "matched",
    flow: intent.flow,
    reasons,
  };
}

function evaluateEnforceAllowed(inputs: {
  userId: string;
  signer: string;
  analysis: EmbeddedSolanaTransactionAnalysis;
  intent: EmbeddedSolanaSponsorshipIntent | null;
  flows: EmbeddedSolanaSponsorshipFlows;
}): {
  allowed: boolean;
  flow: EmbeddedSolanaSponsorshipFlow | null;
  intentStatus: EmbeddedSolanaSponsorshipEvaluation["intentStatus"];
  reasons: string[];
  unknownProgramIds: string[];
} {
  const reasons: string[] = [];
  if (!inputs.analysis.ok) {
    reasons.push(inputs.analysis.malformedReason ?? "malformed_transaction");
  }
  if (inputs.analysis.usesAddressLookupTables) {
    reasons.push("address_lookup_tables_not_allowed");
  }
  if (inputs.analysis.hasNativeSolTransfer) {
    reasons.push("native_sol_transfer_not_allowed");
  }
  if (inputs.analysis.hasSyncNative) {
    reasons.push("wrapped_sol_sync_not_allowed");
  }
  if (
    inputs.analysis.signerAddresses.length !== 1 ||
    inputs.analysis.signerAddresses[0] !== normalizeSolanaAddress(inputs.signer)
  ) {
    reasons.push("signer_mismatch");
  }
  if (inputs.analysis.feePayer !== normalizeSolanaAddress(inputs.signer)) {
    reasons.push("fee_payer_mismatch");
  }

  const intentCheck = validateIntent({
    userId: inputs.userId,
    signer: inputs.signer,
    analysis: inputs.analysis,
    intent: inputs.intent,
  });
  reasons.push(...intentCheck.reasons);
  const flow = intentCheck.flow;
  if (!flow) {
    return {
      allowed: false,
      flow: null,
      intentStatus: intentCheck.status,
      reasons,
      unknownProgramIds: inputs.analysis.programIds,
    };
  }
  if (!inputs.flows[flow]) reasons.push(`flow_${flow}_disabled`);

  const allowedPrograms = FLOW_ALLOWED_PROGRAMS[flow];
  const unknownProgramIds = inputs.analysis.programIds.filter(
    (programId) => !allowedPrograms.has(programId),
  );
  if (unknownProgramIds.length) reasons.push("unknown_program");

  const systemCreateLamports = BigInt(inputs.analysis.systemCreateLamports);
  const maxSystemCreateLamports = getBigIntMetadata(
    inputs.intent?.metadata,
    "maxSystemCreateLamports",
  );
  if (
    systemCreateLamports > BigInt(0) &&
    (maxSystemCreateLamports == null ||
      systemCreateLamports > maxSystemCreateLamports)
  ) {
    reasons.push("unpriced_system_rent");
  }

  const allowAtaCreation = inputs.intent?.metadata?.allowAtaCreation === true;
  if (inputs.analysis.ataCreateCount > 0 && !allowAtaCreation) {
    reasons.push("unpriced_ata_creation");
  }

  return {
    allowed: reasons.length === 0,
    flow,
    intentStatus: intentCheck.status,
    reasons,
    unknownProgramIds,
  };
}

export async function resolveEmbeddedSolanaSponsorshipEvaluation(inputs: {
  userId: string;
  signer: string;
  transaction: string;
  sponsorshipIntentId?: string | null;
  requestedSponsor: boolean;
  legacyWouldSponsor: boolean;
  enabled: boolean;
  mode: EmbeddedSolanaSponsorshipMode;
  flows: EmbeddedSolanaSponsorshipFlows;
}): Promise<EmbeddedSolanaSponsorshipEvaluation> {
  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: inputs.signer,
    transaction: inputs.transaction,
    includeRaw: env.embeddedSolanaSponsorshipAuditIncludeRaw,
  });
  const intent = await readEmbeddedSolanaSponsorshipIntent(
    inputs.sponsorshipIntentId,
  );
  const enforce = evaluateEnforceAllowed({
    userId: inputs.userId,
    signer: inputs.signer,
    analysis,
    intent,
    flows: inputs.flows,
  });
  analysis.unknownProgramIds = enforce.unknownProgramIds;

  const enforceWouldSponsor =
    inputs.enabled && inputs.legacyWouldSponsor && enforce.allowed;
  const actualSponsor =
    inputs.enabled && inputs.mode === "observe"
      ? inputs.legacyWouldSponsor
      : enforceWouldSponsor;

  return {
    mode: inputs.mode,
    enabled: inputs.enabled,
    requestedSponsor: inputs.requestedSponsor,
    legacyWouldSponsor: inputs.legacyWouldSponsor,
    enforceWouldSponsor,
    actualSponsor,
    flow: enforce.flow,
    intentId: inputs.sponsorshipIntentId?.trim() || null,
    intentStatus: inputs.sponsorshipIntentId?.trim()
      ? enforce.intentStatus
      : inputs.legacyWouldSponsor
        ? "missing"
        : "not_required",
    verdict:
      inputs.mode === "observe" ? "observe" : enforce.allowed ? "allow" : "deny",
    reasons: enforce.reasons,
    analysis,
  };
}

export async function writeEmbeddedSolanaSponsorshipAudit(inputs: {
  event: EmbeddedSolanaSponsorshipEvaluation & {
    userId: string;
    signer: string;
    transactionId?: string | null;
  };
}): Promise<void> {
  const path = env.embeddedSolanaSponsorshipAuditLogPath;
  if (!path) return;
  const event = {
    ts: new Date().toISOString(),
    ...inputs.event,
    analysis: {
      ...inputs.event.analysis,
      ...(env.embeddedSolanaSponsorshipAuditIncludeRaw
        ? {}
        : { rawTransaction: undefined }),
    },
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}
