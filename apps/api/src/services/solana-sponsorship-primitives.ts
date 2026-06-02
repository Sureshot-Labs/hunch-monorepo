import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";

export const SOLANA_COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
export const SOLANA_SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
export const SOLANA_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID.toBase58();
export const SOLANA_TOKEN_2022_PROGRAM_ID = TOKEN_2022_PROGRAM_ID.toBase58();
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID =
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
export const SOLANA_MEMO_PROGRAM_ID =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SOLANA_LEGACY_MEMO_PROGRAM_ID =
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const DFLOW_PROGRAM_ID = "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH";
export const DFLOW_PREDICTION_PROGRAM_ID =
  "pReDicTmksnPfkfiz33ndSdbe2dY43KYPg4U2dbvHvb";

export const SOLANA_BASE_SPONSORSHIP_ALLOWED_PROGRAMS = [
  SOLANA_COMPUTE_BUDGET_PROGRAM_ID,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_MEMO_PROGRAM_ID,
  SOLANA_LEGACY_MEMO_PROGRAM_ID,
] as const;

const FEE_FIELD_RE =
  /(^|_|\b)(fixfee|protocolfee|fee|fees|gasfee|transactionfee|networkfee|servicefee|priorityfee|computeunitprice)(_|$|\b)/i;
const FEE_CONTAINER_RE = /(^|_|\b)(fees|fee|estimation|estimates)(_|$|\b)/i;

export function normalizeSolanaPublicKey(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

export function requireSolanaPublicKey(value: string, label: string): string {
  const normalized = normalizeSolanaPublicKey(value);
  if (!normalized) throw new Error(`${label} must be a valid Solana address`);
  return normalized;
}

export function parseSolanaPublicKeyList(
  values: readonly string[] | string | null | undefined,
): string[] {
  const parts = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values
          .split(",")
          .map((entry: string) => entry.trim())
          .filter(Boolean)
      : [];
  const normalized = new Set<string>();
  for (const value of parts) {
    normalized.add(requireSolanaPublicKey(value, "Solana program id"));
  }
  return Array.from(normalized).sort();
}

export function loadSolanaKeypairFromSecret(
  raw: string,
  envName = "HUNCH_SOLANA_SPONSOR_SECRET_KEY",
): Keypair {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Missing ${envName}`);
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
      throw new Error(`Invalid ${envName} array`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function resolveHunchSolanaSponsorKeypair(): Keypair | null {
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

export function isPositiveIntegerLike(value: unknown): boolean {
  if (typeof value === "bigint") return value > BigInt(0);
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  return (
    typeof value === "string" &&
    /^\d+$/.test(value.trim()) &&
    BigInt(value.trim()) > BigInt(0)
  );
}

function hasPositiveFeeValue(
  value: unknown,
  depth: number,
  inspectAllFields: boolean,
): boolean {
  if (depth > 5) return false;
  if (isPositiveIntegerLike(value)) return true;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasPositiveFeeValue(entry, depth + 1, inspectAllFields),
    );
  }
  if (!isRecord(value)) return false;

  for (const [key, entry] of Object.entries(value)) {
    const keyIsFee = FEE_FIELD_RE.test(key);
    const keyIsFeeContainer = FEE_CONTAINER_RE.test(key);
    if (keyIsFee && isPositiveIntegerLike(entry)) return true;
    if (
      (inspectAllFields || keyIsFee || keyIsFeeContainer) &&
      hasPositiveFeeValue(entry, depth + 1, keyIsFee || keyIsFeeContainer)
    ) {
      return true;
    }
  }
  return false;
}

export function hasPositiveSponsorFeeLike(payload: unknown): boolean {
  return hasPositiveFeeValue(payload, 0, false);
}
