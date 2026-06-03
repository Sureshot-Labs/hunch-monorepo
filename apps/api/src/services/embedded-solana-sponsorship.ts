import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  type AccountMeta,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

import { env } from "../env.js";
import { getRedis } from "../redis.js";
import {
  DFLOW_PREDICTION_PROGRAM_ID,
  DFLOW_PROGRAM_ID,
  SOLANA_ACROSS_SPONSORSHIP_ALLOWED_PROGRAMS,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_COMPUTE_BUDGET_PROGRAM_ID,
  SOLANA_DEBRIDGE_BASE_SPONSORSHIP_ALLOWED_PROGRAMS,
  SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS,
  SOLANA_DIRECT_TRANSFER_SPONSORSHIP_ALLOWED_PROGRAMS,
  SOLANA_LEGACY_MEMO_PROGRAM_ID,
  SOLANA_MEMO_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
} from "./solana-sponsorship-primitives.js";

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

export type EmbeddedSolanaActualSponsorshipDecision = {
  policyAllows: boolean;
  actualSponsorAllowed: boolean;
  reasons: string[];
};

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

type CachedEmbeddedSolanaSponsorshipRequest = {
  id: string;
  input: { body: unknown };
  solanaSponsorship?: {
    sponsorshipIntentId: string | null;
    flow: string | null;
    transactionDigest: string | null;
    actualSponsor: boolean;
  };
};

export type EmbeddedSolanaSponsorshipRepairTokenPayload = {
  v: 1;
  userId: string;
  signer: string;
  requestId: string;
  transactionId: string | null;
  sponsorshipIntentId: string;
  signature: string;
  transactionDigest: string;
  expiresAt: number;
};

const INTENT_TTL_SEC = 5 * 60;
const REPAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
const SOLANA_TX_FEE_LAMPORTS = BigInt(5_000);
const TOKEN_SYNC_NATIVE_INSTRUCTION = 17;
const ASSOCIATED_TOKEN_PROGRAM_ID_BASE58 = SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID;
const TOKEN_PROGRAM_ID_BASE58 = SOLANA_TOKEN_PROGRAM_ID;
const TOKEN_2022_PROGRAM_ID_BASE58 = SOLANA_TOKEN_2022_PROGRAM_ID;
const COMPUTE_BUDGET_PROGRAM_ID = SOLANA_COMPUTE_BUDGET_PROGRAM_ID;
const MEMO_PROGRAM_ID = SOLANA_MEMO_PROGRAM_ID;
const LEGACY_MEMO_PROGRAM_ID = SOLANA_LEGACY_MEMO_PROGRAM_ID;

const FLOW_ALLOWED_PROGRAMS: Record<
  EmbeddedSolanaSponsorshipFlow,
  Set<string>
> = {
  dflow: new Set(SOLANA_DFLOW_SPONSORSHIP_ALLOWED_PROGRAMS),
  across: new Set(SOLANA_ACROSS_SPONSORSHIP_ALLOWED_PROGRAMS),
  directTransfer: new Set(SOLANA_DIRECT_TRANSFER_SPONSORSHIP_ALLOWED_PROGRAMS),
  debridge: new Set(SOLANA_DEBRIDGE_BASE_SPONSORSHIP_ALLOWED_PROGRAMS),
};

const sponsorshipIntentMemory = new Map<
  string,
  EmbeddedSolanaSponsorshipIntent
>();
const sponsorshipBudgetMemory = new Map<
  string,
  { count: number; lamports: bigint; expiresAt: number }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEmbeddedSolanaSponsorshipFlow(
  value: string | null | undefined,
): value is EmbeddedSolanaSponsorshipFlow {
  return (
    value === "dflow" ||
    value === "across" ||
    value === "directTransfer" ||
    value === "debridge"
  );
}

function normalizeOptionalTokenString(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function encodeBase64Url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function signRepairTokenPayload(payload: string): string {
  return encodeBase64Url(
    createHmac("sha256", env.jwtSecret).update(payload).digest(),
  );
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBytes = decodeBase64Url(actual);
  const expectedBytes = decodeBase64Url(expected);
  if (
    !actualBytes ||
    !expectedBytes ||
    actualBytes.length !== expectedBytes.length
  ) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function resolveEmbeddedSolanaActualSponsorshipDecision(inputs: {
  embeddedSolanaSponsorship: boolean;
  flow: EmbeddedSolanaSponsorshipFlow;
  flowEnabled: boolean;
  mode: EmbeddedSolanaSponsorshipMode;
  observeCanSponsor: boolean;
}): EmbeddedSolanaActualSponsorshipDecision {
  const reasons: string[] = [];
  if (!inputs.embeddedSolanaSponsorship) reasons.push("sponsorship_disabled");
  if (!inputs.flowEnabled) reasons.push(`flow_${inputs.flow}_disabled`);
  if (inputs.mode === "observe" && !inputs.observeCanSponsor) {
    reasons.push("observe_mode_log_only");
  }
  const policyAllows =
    inputs.embeddedSolanaSponsorship === true && inputs.flowEnabled === true;
  return {
    policyAllows,
    actualSponsorAllowed:
      policyAllows &&
      (inputs.mode === "enforce" || inputs.observeCanSponsor === true),
    reasons,
  };
}

export type EmbeddedSolanaSponsorshipBudgetReservation = {
  hourKey: string;
  dayKey: string;
  estimatedLamports: string;
};

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

const RELEASE_SPONSORSHIP_BUDGET_SCRIPT = `
local function decode(raw)
  if not raw then
    return { count = 0, lamports = 0 }
  end
  local ok, parsed = pcall(cjson.decode, raw)
  if not ok or type(parsed) ~= "table" then
    return { count = 0, lamports = 0 }
  end
  return {
    count = tonumber(parsed.count) or 0,
    lamports = tonumber(parsed.lamports) or 0
  }
end

local estimated = tonumber(ARGV[1]) or 0
local hour = decode(redis.call("GET", KEYS[1]))
local day = decode(redis.call("GET", KEYS[2]))
local hour_ttl = redis.call("TTL", KEYS[1])
local day_ttl = redis.call("TTL", KEYS[2])

hour.count = math.max(hour.count - 1, 0)
hour.lamports = math.max(hour.lamports - estimated, 0)
day.count = math.max(day.count - 1, 0)
day.lamports = math.max(day.lamports - estimated, 0)

local next_hour = cjson.encode({ count = hour.count, lamports = tostring(hour.lamports) })
local next_day = cjson.encode({ count = day.count, lamports = tostring(day.lamports) })
if hour_ttl and hour_ttl > 0 then
  redis.call("SET", KEYS[1], next_hour, "EX", hour_ttl)
else
  redis.call("SET", KEYS[1], next_hour)
end
if day_ttl and day_ttl > 0 then
  redis.call("SET", KEYS[2], next_day, "EX", day_ttl)
else
  redis.call("SET", KEYS[2], next_day)
end
return { "1" }
`;

function normalizeSolanaAddress(value: string): string {
  return value.trim();
}

function parseSolanaPublicKey(
  value: string | null | undefined,
): PublicKey | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
}

function decodeBase64SolanaTransaction(payload: string): Buffer | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("0x")) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  if (trimmed.length % 4 === 1) return null;
  try {
    const raw = Buffer.from(trimmed, "base64");
    if (!raw.length) return null;
    const expected = trimmed.replace(/=+$/, "");
    const actual = raw.toString("base64").replace(/=+$/, "");
    return expected === actual ? raw : null;
  } catch {
    return null;
  }
}

export function computeEmbeddedSolanaTransactionDigest(
  transaction: string,
): string | null {
  const raw = decodeBase64SolanaTransaction(transaction);
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

export function createEmbeddedSolanaSponsorshipRepairToken(inputs: {
  userId: string;
  signer: string;
  requestId: string;
  transactionId?: string | null;
  sponsorshipIntentId: string;
  signature: string;
  transactionDigest: string;
  nowMs?: number;
  ttlMs?: number;
}): string {
  const nowMs = Math.trunc(inputs.nowMs ?? Date.now());
  const ttlMs = Math.max(
    1_000,
    Math.trunc(inputs.ttlMs ?? REPAIR_TOKEN_TTL_MS),
  );
  const payload: EmbeddedSolanaSponsorshipRepairTokenPayload = {
    v: 1,
    userId: inputs.userId.trim(),
    signer: normalizeSolanaAddress(inputs.signer),
    requestId: inputs.requestId.trim(),
    transactionId: normalizeOptionalTokenString(inputs.transactionId),
    sponsorshipIntentId: inputs.sponsorshipIntentId.trim(),
    signature: inputs.signature.trim(),
    transactionDigest: inputs.transactionDigest.trim(),
    expiresAt: nowMs + ttlMs,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${signRepairTokenPayload(encodedPayload)}`;
}

export function verifyEmbeddedSolanaSponsorshipRepairToken(inputs: {
  repairToken: string;
  userId: string;
  signer: string;
  requestId: string;
  transactionId?: string | null;
  sponsorshipIntentId: string;
  signature: string;
  nowMs?: number;
}): EmbeddedSolanaSponsorshipRepairTokenPayload | null {
  const [encodedPayload, signature, ...extra] = inputs.repairToken
    .trim()
    .split(".");
  if (!encodedPayload || !signature || extra.length > 0) return null;
  const expectedSignature = signRepairTokenPayload(encodedPayload);
  if (!signaturesMatch(signature, expectedSignature)) return null;

  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!payloadBytes) return null;
  let payload: EmbeddedSolanaSponsorshipRepairTokenPayload | null;
  try {
    payload = JSON.parse(
      payloadBytes.toString("utf8"),
    ) as EmbeddedSolanaSponsorshipRepairTokenPayload | null;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (
    typeof payload.userId !== "string" ||
    typeof payload.signer !== "string" ||
    typeof payload.requestId !== "string" ||
    !(
      typeof payload.transactionId === "string" ||
      payload.transactionId === null
    ) ||
    typeof payload.sponsorshipIntentId !== "string" ||
    typeof payload.signature !== "string" ||
    typeof payload.transactionDigest !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(payload.expiresAt)) return null;
  if (Math.trunc(inputs.nowMs ?? Date.now()) > payload.expiresAt) return null;

  const expectedTransactionId = normalizeOptionalTokenString(
    inputs.transactionId,
  );
  if (payload.userId !== inputs.userId.trim()) return null;
  if (payload.signer !== normalizeSolanaAddress(inputs.signer)) return null;
  if (payload.requestId !== inputs.requestId.trim()) return null;
  if (payload.transactionId !== expectedTransactionId) return null;
  if (payload.sponsorshipIntentId !== inputs.sponsorshipIntentId.trim()) {
    return null;
  }
  if (payload.signature !== inputs.signature.trim()) return null;
  if (!payload.transactionDigest.trim()) return null;
  return payload;
}

function deserializeEmbeddedSolanaTransaction(
  transaction: string,
): { raw: Buffer; tx: VersionedTransaction } | null {
  const raw = decodeBase64SolanaTransaction(transaction);
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
  if (!txInstruction?.programId.equals(SystemProgram.programId))
    return BigInt(0);
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

function parseIntent(
  raw: string | null,
): EmbeddedSolanaSponsorshipIntent | null {
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
  requireDurable?: boolean;
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
      return intent;
    }
    if (inputs.requireDurable) {
      sponsorshipIntentMemory.delete(intent.id);
      return null;
    }
  } catch {
    if (inputs.requireDurable) {
      sponsorshipIntentMemory.delete(intent.id);
      return null;
    }
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

function getCachedPrivySolanaTransactionDigest(
  request: CachedEmbeddedSolanaSponsorshipRequest,
): string | null {
  const body = isRecord(request.input.body) ? request.input.body : null;
  const params = isRecord(body?.params) ? body.params : null;
  const transaction = params?.transaction;
  return typeof transaction === "string"
    ? computeEmbeddedSolanaTransactionDigest(transaction)
    : null;
}

export async function assertEmbeddedSolanaSponsoredCachedRequestValid(inputs: {
  request: CachedEmbeddedSolanaSponsorshipRequest;
  userId: string;
  signer: string;
  policy: {
    embeddedSolanaSponsorship: boolean;
    embeddedSolanaSponsorshipMode: EmbeddedSolanaSponsorshipMode;
    embeddedSolanaSponsorshipFlows: EmbeddedSolanaSponsorshipFlows;
    observeCanSponsor?: boolean;
  };
}): Promise<void> {
  const sponsorship = inputs.request.solanaSponsorship;
  const flow = sponsorship?.flow ?? null;
  const observeCanSponsor =
    inputs.policy.embeddedSolanaSponsorshipMode === "enforce" ||
    inputs.policy.observeCanSponsor === true;
  if (
    !sponsorship?.actualSponsor ||
    !inputs.policy.embeddedSolanaSponsorship ||
    !observeCanSponsor ||
    !isEmbeddedSolanaSponsorshipFlow(flow) ||
    inputs.policy.embeddedSolanaSponsorshipFlows[flow] !== true
  ) {
    throw new Error(
      "Solana sponsorship is disabled. Refresh quote and try again.",
    );
  }

  const intentId = sponsorship.sponsorshipIntentId?.trim() ?? "";
  if (!intentId) {
    throw new Error(
      "Prepared Solana sponsorship is missing an intent. Refresh quote and try again.",
    );
  }
  const intent = await readEmbeddedSolanaSponsorshipIntent(intentId);
  if (!intent) {
    throw new Error(
      "Prepared Solana sponsorship expired. Refresh quote and try again.",
    );
  }
  const expiresAt = new Date(intent.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error(
      "Prepared Solana sponsorship expired. Refresh quote and try again.",
    );
  }
  const signer = normalizeSolanaAddress(inputs.signer);
  if (
    intent.userId !== inputs.userId.trim() ||
    normalizeSolanaAddress(intent.signer) !== signer ||
    intent.flow !== flow
  ) {
    throw new Error(
      "Prepared Solana sponsorship no longer matches this request. Refresh quote and try again.",
    );
  }

  const transactionDigest = getCachedPrivySolanaTransactionDigest(
    inputs.request,
  );
  if (
    !transactionDigest ||
    !sponsorship.transactionDigest ||
    transactionDigest !== sponsorship.transactionDigest ||
    transactionDigest !== intent.transactionDigest
  ) {
    throw new Error(
      "Prepared Solana sponsorship transaction changed. Refresh quote and try again.",
    );
  }
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
  if (
    inputs.limit.maxPerHour <= 0 ||
    hour.count + 1 > inputs.limit.maxPerHour
  ) {
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
}): Promise<{
  ok: boolean;
  reasons: string[];
  reservation?: EmbeddedSolanaSponsorshipBudgetReservation;
}> {
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
          ? {
              ok: true,
              reasons: [],
              reservation: {
                hourKey,
                dayKey,
                estimatedLamports: estimatedLamports.toString(),
              },
            }
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

  const result = reserveMemorySponsorshipBudget({
    hourKey,
    dayKey,
    estimatedLamports,
    limit,
  });
  return result.ok
    ? {
        ...result,
        reservation: {
          hourKey,
          dayKey,
          estimatedLamports: estimatedLamports.toString(),
        },
      }
    : result;
}

function releaseMemorySponsorshipBudget(
  reservation: EmbeddedSolanaSponsorshipBudgetReservation,
): void {
  const estimatedLamports = BigInt(reservation.estimatedLamports);
  const now = Date.now();
  for (const key of [reservation.hourKey, reservation.dayKey]) {
    const current = sponsorshipBudgetMemory.get(key);
    if (!current || current.expiresAt <= now) continue;
    sponsorshipBudgetMemory.set(key, {
      count: Math.max(0, current.count - 1),
      lamports:
        current.lamports > estimatedLamports
          ? current.lamports - estimatedLamports
          : BigInt(0),
      expiresAt: current.expiresAt,
    });
  }
}

export async function releaseEmbeddedSolanaSponsorshipBudget(
  reservation: EmbeddedSolanaSponsorshipBudgetReservation | null | undefined,
): Promise<void> {
  if (!reservation) return;
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.eval(RELEASE_SPONSORSHIP_BUDGET_SCRIPT, {
        keys: [reservation.hourKey, reservation.dayKey],
        arguments: [reservation.estimatedLamports],
      });
      return;
    }
  } catch {
    // Memory fallback still keeps local QA budget state coherent.
  }
  releaseMemorySponsorshipBudget(reservation);
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

function getDirectTransferDestinationTokenAccount(inputs: {
  analysis: EmbeddedSolanaTransactionAnalysis;
  signer: string;
}): string | null {
  const instruction = getDirectUsdcTransferInstruction(inputs);
  return instruction?.accountAddresses[2] ?? null;
}

function getExpectedDirectTransferRecipientTokenAccount(inputs: {
  recipientAddress: string;
  tokenProgramId: string | null | undefined;
}): string | null {
  const recipient = parseSolanaPublicKey(inputs.recipientAddress);
  const mint = parseSolanaPublicKey(env.solanaUsdcMint);
  if (!recipient || !mint) return null;
  const tokenProgram =
    inputs.tokenProgramId === TOKEN_2022_PROGRAM_ID_BASE58
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  try {
    return getAssociatedTokenAddressSync(
      mint,
      recipient,
      false,
      tokenProgram,
    ).toBase58();
  } catch {
    return null;
  }
}

export function getEmbeddedSolanaDirectTransferRecipientTokenAccount(inputs: {
  analysis: EmbeddedSolanaTransactionAnalysis;
  signer: string;
  recipientAddress: string;
}): string | null {
  const instruction = getDirectUsdcTransferInstruction(inputs);
  if (!instruction) return null;
  return getExpectedDirectTransferRecipientTokenAccount({
    recipientAddress: inputs.recipientAddress,
    tokenProgramId: instruction.programId,
  });
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

export function shouldRequireEmbeddedSolanaSponsorshipRedis(inputs: {
  mode: EmbeddedSolanaSponsorshipMode;
  observeCanSponsor?: boolean;
}): boolean {
  return inputs.mode === "enforce" || inputs.observeCanSponsor === true;
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
    return {
      status: "expired",
      flow: intent.flow,
      reasons: ["expired_intent"],
    };
  }
  if (intent.userId !== inputs.userId) reasons.push("intent_user_mismatch");
  if (
    normalizeSolanaAddress(intent.signer) !==
    normalizeSolanaAddress(inputs.signer)
  ) {
    reasons.push("intent_signer_mismatch");
  }
  if (
    !inputs.analysis.digest ||
    intent.transactionDigest !== inputs.analysis.digest
  ) {
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
      getBooleanMetadata(
        inputs.intent?.metadata,
        "directTransferSponsorshipEligible",
      ) !== true
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
    const expectedRecipientAddress =
      typeof inputs.intent?.metadata?.recipientAddress === "string"
        ? inputs.intent.metadata.recipientAddress.trim()
        : "";
    if (expectedRecipientAddress) {
      const instruction = getDirectUsdcTransferInstruction({
        analysis: inputs.analysis,
        signer: inputs.signer,
      });
      const actualDestination = getDirectTransferDestinationTokenAccount({
        analysis: inputs.analysis,
        signer: inputs.signer,
      });
      const expectedDestination = instruction
        ? getExpectedDirectTransferRecipientTokenAccount({
            recipientAddress: expectedRecipientAddress,
            tokenProgramId: instruction.programId,
          })
        : null;
      if (!expectedDestination) {
        reasons.push("direct_transfer_recipient_invalid");
      } else if (actualDestination !== expectedDestination) {
        reasons.push("direct_transfer_recipient_mismatch");
      }
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
    getBooleanMetadata(
      inputs.intent?.metadata,
      "debridgeSponsorshipEligible",
    ) !== true
  ) {
    reasons.push("debridge_not_eligible");
  }
  if (
    flow === "debridge" &&
    getStringArrayMetadata(inputs.intent?.metadata, "allowedProgramIds")
      .length === 0
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
  observeCanSponsor: boolean;
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

  const canActuallySponsor =
    inputs.enabled && inputs.legacyWouldSponsor && enforce.allowed;
  const enforceWouldSponsor = canActuallySponsor;
  const hasHardDeny = enforce.reasons.some(
    isEmbeddedSolanaSponsorshipHardDenyReason,
  );
  const actualSponsor =
    inputs.enabled && !hasHardDeny
      ? inputs.mode === "observe"
        ? inputs.observeCanSponsor && canActuallySponsor
        : canActuallySponsor
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
      inputs.mode === "observe"
        ? "observe"
        : enforce.allowed
          ? "allow"
          : "deny",
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
