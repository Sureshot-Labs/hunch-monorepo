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

export type EmbeddedSolanaSponsorshipFlowLimit = {
  maxPerHour: number;
  maxPerDay: number;
  maxLamportsPerWalletPerDay: number;
  minAmountRaw?: string;
};

export type EmbeddedSolanaSponsorshipLimits = Record<
  EmbeddedSolanaSponsorshipFlow,
  EmbeddedSolanaSponsorshipFlowLimit
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
    directTransfer: new Set([
      COMPUTE_BUDGET_PROGRAM_ID,
      TOKEN_PROGRAM_ID_BASE58,
      TOKEN_2022_PROGRAM_ID_BASE58,
      MEMO_PROGRAM_ID,
      LEGACY_MEMO_PROGRAM_ID,
    ]),
    debridge: new Set([...BASE_ALLOWED_PROGRAMS]),
  };

const sponsorshipIntentMemory = new Map<
  string,
  EmbeddedSolanaSponsorshipIntent
>();
const sponsorshipBudgetMemory = new Map<
  string,
  { count: number; lamports: bigint; expiresAt: number }
>();

const RESERVE_SPONSORSHIP_BUDGET_SCRIPT = `
local function decode(raw)
  if not raw then
    return { count = 0, lamports = 0 }
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return { count = 0, lamports = 0 }
  end
  local count = tonumber(parsed["count"]) or 0
  local lamports = tonumber(parsed["lamports"]) or 0
  if count < 0 then count = 0 end
  if lamports < 0 then lamports = 0 end
  return { count = math.floor(count), lamports = math.floor(lamports) }
end

local hour = decode(redis.call("GET", KEYS[1]))
local day = decode(redis.call("GET", KEYS[2]))
local max_hour = tonumber(ARGV[1]) or 0
local max_day = tonumber(ARGV[2]) or 0
local max_lamports = tonumber(ARGV[3]) or 0
local estimated = tonumber(ARGV[4]) or 0
local hour_ttl = tonumber(ARGV[5]) or 3600
local day_ttl = tonumber(ARGV[6]) or 86400
local reasons = {}

if max_hour <= 0 or hour.count + 1 > max_hour then
  table.insert(reasons, "sponsorship_hour_budget_exceeded")
end
if max_day <= 0 or day.count + 1 > max_day then
  table.insert(reasons, "sponsorship_day_budget_exceeded")
end
if max_lamports <= 0 or day.lamports + estimated > max_lamports then
  table.insert(reasons, "sponsorship_lamport_budget_exceeded")
end

if #reasons > 0 then
  local result = { "0" }
  for _, reason in ipairs(reasons) do
    table.insert(result, reason)
  end
  return result
end

local next_hour = cjson.encode({
  count = hour.count + 1,
  lamports = tostring(hour.lamports + estimated)
})
local next_day = cjson.encode({
  count = day.count + 1,
  lamports = tostring(day.lamports + estimated)
})
redis.call("SET", KEYS[1], next_hour, "EX", hour_ttl)
redis.call("SET", KEYS[2], next_day, "EX", day_ttl)
return { "1" }
`;

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

export function computeEmbeddedSolanaMessageDigest(
  transaction: string,
): string | null {
  const decoded = deserializeEmbeddedSolanaTransaction(transaction);
  if (!decoded) return null;
  return createHash("sha256")
    .update(Buffer.from(decoded.tx.message.serialize()))
    .digest("hex");
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

function pruneExpiredBudgets(now = Date.now()): void {
  for (const [key, value] of sponsorshipBudgetMemory) {
    if (value.expiresAt <= now) sponsorshipBudgetMemory.delete(key);
  }
}

function budgetWindowStart(now: Date, window: "hour" | "day"): string {
  const copy = new Date(now);
  copy.setUTCMinutes(0, 0, 0);
  if (window === "day") copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

function budgetWindowTtlMs(window: "hour" | "day"): number {
  return window === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

function sponsorshipBudgetKey(inputs: {
  flow: EmbeddedSolanaSponsorshipFlow;
  walletAddress: string;
  window: "hour" | "day";
  now: Date;
}): string {
  return [
    "embedded-solana",
    "sponsorship-budget",
    inputs.flow,
    normalizeSolanaAddress(inputs.walletAddress),
    inputs.window,
    budgetWindowStart(inputs.now, inputs.window),
  ].join(":");
}

function reserveMemorySponsorshipBudget(inputs: {
  hourKey: string;
  dayKey: string;
  estimatedLamports: bigint;
  limit: EmbeddedSolanaSponsorshipFlowLimit;
}): { ok: boolean; reasons: string[] } {
  pruneExpiredBudgets();
  const hour = sponsorshipBudgetMemory.get(inputs.hourKey) ?? {
    count: 0,
    lamports: BigInt(0),
    expiresAt: Date.now() + budgetWindowTtlMs("hour"),
  };
  const day = sponsorshipBudgetMemory.get(inputs.dayKey) ?? {
    count: 0,
    lamports: BigInt(0),
    expiresAt: Date.now() + budgetWindowTtlMs("day"),
  };
  const reasons: string[] = [];
  if (inputs.limit.maxPerHour <= 0 || hour.count + 1 > inputs.limit.maxPerHour) {
    reasons.push("sponsorship_hour_budget_exceeded");
  }
  if (inputs.limit.maxPerDay <= 0 || day.count + 1 > inputs.limit.maxPerDay) {
    reasons.push("sponsorship_day_budget_exceeded");
  }
  if (
    inputs.limit.maxLamportsPerWalletPerDay <= 0 ||
    day.lamports + inputs.estimatedLamports >
      BigInt(inputs.limit.maxLamportsPerWalletPerDay)
  ) {
    reasons.push("sponsorship_lamport_budget_exceeded");
  }
  if (reasons.length) return { ok: false, reasons };

  sponsorshipBudgetMemory.set(inputs.hourKey, {
    count: hour.count + 1,
    lamports: hour.lamports + inputs.estimatedLamports,
    expiresAt: hour.expiresAt,
  });
  sponsorshipBudgetMemory.set(inputs.dayKey, {
    count: day.count + 1,
    lamports: day.lamports + inputs.estimatedLamports,
    expiresAt: day.expiresAt,
  });
  return { ok: true, reasons: [] };
}

export async function reserveEmbeddedSolanaSponsorshipBudget(inputs: {
  flow: EmbeddedSolanaSponsorshipFlow;
  walletAddress: string;
  estimatedLamports: string | number | bigint;
  limits: EmbeddedSolanaSponsorshipLimits;
  requireRedis?: boolean;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const limit = inputs.limits[inputs.flow];
  if (!limit) return { ok: false, reasons: ["sponsorship_budget_missing"] };
  const estimatedLamports =
    typeof inputs.estimatedLamports === "bigint"
      ? inputs.estimatedLamports
      : BigInt(String(inputs.estimatedLamports));
  const now = new Date();
  const hourKey = sponsorshipBudgetKey({
    flow: inputs.flow,
    walletAddress: inputs.walletAddress,
    window: "hour",
    now,
  });
  const dayKey = sponsorshipBudgetKey({
    flow: inputs.flow,
    walletAddress: inputs.walletAddress,
    window: "day",
    now,
  });

  try {
    const redis = await getRedis();
    if (redis) {
      const result = await redis.eval(RESERVE_SPONSORSHIP_BUDGET_SCRIPT, {
        keys: [hourKey, dayKey],
        arguments: [
          String(limit.maxPerHour),
          String(limit.maxPerDay),
          String(limit.maxLamportsPerWalletPerDay),
          estimatedLamports.toString(),
          String(Math.ceil(budgetWindowTtlMs("hour") / 1000)),
          String(Math.ceil(budgetWindowTtlMs("day") / 1000)),
        ],
      });
      if (Array.isArray(result)) {
        const [status, ...reasons] = result.map((entry) => String(entry));
        return status === "1"
          ? { ok: true, reasons: [] }
          : { ok: false, reasons };
      }
      return { ok: false, reasons: ["sponsorship_budget_unavailable"] };
    }
  } catch {
    if (inputs.requireRedis) {
      return { ok: false, reasons: ["sponsorship_budget_unavailable"] };
    }
  }

  if (inputs.requireRedis) {
    return { ok: false, reasons: ["sponsorship_budget_unavailable"] };
  }

  return reserveMemorySponsorshipBudget({
    hourKey,
    dayKey,
    estimatedLamports,
    limit,
  });
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

function getBooleanMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): boolean | null {
  const value = metadata?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function getStringArrayMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isDflowTransaction(
  analysis: EmbeddedSolanaTransactionAnalysis,
): boolean {
  return (
    analysis.programIds.includes(DFLOW_PROGRAM_ID) ||
    analysis.programIds.includes(DFLOW_PREDICTION_PROGRAM_ID)
  );
}

function isComputeBudgetOrMemoInstruction(
  instruction: EmbeddedSolanaInstructionSummary,
): boolean {
  return (
    instruction.programId === COMPUTE_BUDGET_PROGRAM_ID ||
    instruction.programId === MEMO_PROGRAM_ID ||
    instruction.programId === LEGACY_MEMO_PROGRAM_ID
  );
}

function isDirectUsdcTransferCheckedInstruction(inputs: {
  instruction: EmbeddedSolanaInstructionSummary;
  signer: string;
}): boolean {
  const instruction = inputs.instruction;
  if (
    instruction.programId !== TOKEN_PROGRAM_ID_BASE58 &&
    instruction.programId !== TOKEN_2022_PROGRAM_ID_BASE58
  ) {
    return false;
  }
  if (
    instruction.dataLength !== 10 ||
    !instruction.dataPrefixHex.toLowerCase().startsWith("0c")
  ) {
    return false;
  }
  return (
    instruction.accountAddresses.length >= 4 &&
    instruction.accountAddresses[1] === env.solanaUsdcMint &&
    instruction.accountAddresses[3] === normalizeSolanaAddress(inputs.signer)
  );
}

function getDirectUsdcTransferCheckedAmountRaw(
  instruction: EmbeddedSolanaInstructionSummary,
): bigint | null {
  if (
    instruction.dataLength !== 10 ||
    !instruction.dataPrefixHex.toLowerCase().startsWith("0c")
  ) {
    return null;
  }
  const data = Buffer.from(instruction.dataPrefixHex, "hex");
  if (data.length < 10) return null;
  try {
    return data.readBigUInt64LE(1);
  } catch {
    return null;
  }
}

function getDirectUsdcTransferInstruction(inputs: {
  analysis: EmbeddedSolanaTransactionAnalysis;
  signer: string;
}): EmbeddedSolanaInstructionSummary | null {
  if (!inputs.analysis.ok) return null;
  const businessInstructions = inputs.analysis.instructions.filter(
    (instruction) => !isComputeBudgetOrMemoInstruction(instruction),
  );
  if (businessInstructions.length !== 1) return null;
  const [instruction] = businessInstructions;
  if (!instruction) return null;
  return isDirectUsdcTransferCheckedInstruction({
    instruction,
    signer: inputs.signer,
  })
    ? instruction
    : null;
}

export function getEmbeddedSolanaDirectTransferAmountRaw(inputs: {
  analysis: EmbeddedSolanaTransactionAnalysis;
  signer: string;
}): string | null {
  const instruction = getDirectUsdcTransferInstruction(inputs);
  if (!instruction) return null;
  return getDirectUsdcTransferCheckedAmountRaw(instruction)?.toString() ?? null;
}

function isDirectUsdcTransferWithoutSetup(inputs: {
  analysis: EmbeddedSolanaTransactionAnalysis;
  signer: string;
}): boolean {
  if (!inputs.analysis.ok) return false;
  if (inputs.analysis.usesAddressLookupTables) return false;
  if (inputs.analysis.hasNativeSolTransfer || inputs.analysis.hasSyncNative) {
    return false;
  }
  if (inputs.analysis.systemCreateLamports !== "0") return false;
  if (inputs.analysis.ataCreateCount !== 0) return false;

  return getDirectUsdcTransferInstruction(inputs) != null;
}

export function isEmbeddedSolanaSponsorshipHardDenyReason(
  reason: string,
): boolean {
  return (
    reason === "dflow_sponsorship_intent_required" ||
    reason === "dflow_market_not_initialized"
  );
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
  const flow: EmbeddedSolanaSponsorshipFlow | null = intentCheck.flow;
  const intentStatus: EmbeddedSolanaSponsorshipEvaluation["intentStatus"] =
    intentCheck.status;
  reasons.push(...intentCheck.reasons);
  if (isDflowTransaction(inputs.analysis) && intentCheck.status !== "matched") {
    reasons.push("dflow_sponsorship_intent_required");
  }
  if (!flow) {
    return {
      allowed: false,
      flow: null,
      intentStatus,
      reasons,
      unknownProgramIds: inputs.analysis.programIds,
    };
  }
  if (!inputs.flows[flow]) reasons.push(`flow_${flow}_disabled`);
  if (flow === "directTransfer") {
    if (
      getBooleanMetadata(inputs.intent?.metadata, "directTransferSponsorshipEligible") !==
      true
    ) {
      reasons.push("direct_transfer_not_eligible");
    }
    if (
      !isDirectUsdcTransferWithoutSetup({
        analysis: inputs.analysis,
        signer: inputs.signer,
      })
    ) {
      reasons.push("direct_transfer_shape_invalid");
    }
    const expectedAmountRaw =
      typeof inputs.intent?.metadata?.amountRaw === "string"
        ? inputs.intent.metadata.amountRaw.trim()
        : "";
    const actualAmountRaw = getEmbeddedSolanaDirectTransferAmountRaw({
      analysis: inputs.analysis,
      signer: inputs.signer,
    });
    if (expectedAmountRaw && actualAmountRaw !== expectedAmountRaw) {
      reasons.push("direct_transfer_amount_mismatch");
    }
  }
  if (
    flow === "dflow" &&
    getBooleanMetadata(inputs.intent?.metadata, "marketInitialized") !== true
  ) {
    reasons.push("dflow_market_not_initialized");
  }
  if (
    flow === "debridge" &&
    getBooleanMetadata(inputs.intent?.metadata, "debridgeSponsorshipEligible") !==
      true
  ) {
    reasons.push("debridge_not_eligible");
  }
  if (
    flow === "debridge" &&
    getStringArrayMetadata(inputs.intent?.metadata, "allowedProgramIds").length ===
      0
  ) {
    reasons.push("debridge_program_allowlist_missing");
  }

  const allowedPrograms = new Set(FLOW_ALLOWED_PROGRAMS[flow]);
  if (flow === "debridge") {
    for (const programId of getStringArrayMetadata(
      inputs.intent?.metadata,
      "allowedProgramIds",
    )) {
      allowedPrograms.add(programId);
    }
  }
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
    intentStatus,
    reasons,
    unknownProgramIds,
  };
}

export function validateEmbeddedSolanaSponsorshipIntentCandidate(inputs: {
  flow: EmbeddedSolanaSponsorshipFlow;
  userId: string;
  signer: string;
  transaction: string;
  metadata?: Record<string, unknown>;
}): {
  ok: boolean;
  reasons: string[];
  analysis: EmbeddedSolanaTransactionAnalysis;
} {
  const analysis = analyzeEmbeddedSolanaTransaction({
    signer: inputs.signer,
    transaction: inputs.transaction,
    includeRaw: false,
  });
  const intent: EmbeddedSolanaSponsorshipIntent | null = analysis.digest
    ? {
        id: "candidate",
        flow: inputs.flow,
        userId: inputs.userId,
        signer: normalizeSolanaAddress(inputs.signer),
        transactionDigest: analysis.digest,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + INTENT_TTL_SEC * 1000).toISOString(),
        ...(inputs.metadata ? { metadata: inputs.metadata } : {}),
      }
    : null;
  const result = evaluateEnforceAllowed({
    userId: inputs.userId,
    signer: inputs.signer,
    analysis,
    intent,
    flows: {
      dflow: true,
      across: true,
      directTransfer: true,
      debridge: true,
    },
  });
  analysis.unknownProgramIds = result.unknownProgramIds;
  return {
    ok: result.allowed,
    reasons: result.reasons,
    analysis,
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
  const hasHardDeny = enforce.reasons.some(
    isEmbeddedSolanaSponsorshipHardDenyReason,
  );
  const observeCanSponsor = env.embeddedSolanaSponsorshipObserveCanSponsor;
  const actualSponsor =
    inputs.enabled && !hasHardDeny
      ? inputs.mode === "observe"
        ? observeCanSponsor && inputs.legacyWouldSponsor
        : enforceWouldSponsor
      : false;

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
