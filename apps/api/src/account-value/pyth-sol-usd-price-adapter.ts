import { BorshAccountsCoder } from "@coral-xyz/anchor";
// Importing only the official IDL avoids the SDK root's transport/runtime
// dependencies in this API-only valuation path.
import { IDL as PYTH_SOLANA_RECEIVER_IDL } from "@pythnetwork/pyth-solana-receiver/idl/pyth_solana_receiver";

import type { PriceAdapter } from "../funding/domain/contracts.js";
import type { UsdEstimate } from "../funding/domain/types.js";
import { isRawAmount } from "../funding/domain/raw-amount.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchSolanaRawAccountInfo } from "../services/solana-rpc.js";
import { rpcReadCoordinator } from "../services/rpc-read-coordinator.js";
import { formatUnsignedDecimal, multiplyRawByUnitPrice } from "./decimal.js";
import { isKnownNativeSolAsset } from "./known-asset-catalog.js";
import { PYTH_SOL_USD_PRICE_POLICY_ID } from "./valuation-service.js";

export const PYTH_SOL_USD_ACCOUNT =
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOLANA_RECEIVER_PROGRAM_ID =
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PYTH_SOL_USD_CACHE_TTL_MS = 20_000;
const PYTH_SOL_USD_MAX_PUBLISH_AGE_MS = 60_000;
const PYTH_SAFE_EXPONENT_ABS = 18;
const PYTH_UNAVAILABLE_DIAGNOSTIC_THROTTLE_MS = 20_000;
const receiverAccountCoder = new BorshAccountsCoder(PYTH_SOLANA_RECEIVER_IDL);

type DecodedSolUsdPrice = Readonly<{
  unitPriceUsd: string;
  asOf: string;
  confidence: UsdEstimate["confidence"];
}>;

type PythSolUsdAccountLoader = () => Promise<Readonly<{
  data: Buffer;
  owner: string;
}> | null>;

export type PythSolUsdUnavailableCode =
  | "account_unavailable"
  | "confidence_too_wide"
  | "feed_contract_changed"
  | "price_invalid"
  | "price_stale"
  | "rpc_unavailable"
  | "unexpected";

function pythUnavailableCode(error: unknown): PythSolUsdUnavailableCode {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("account is unavailable")) return "account_unavailable";
  if (message.includes("confidence is too wide")) return "confidence_too_wide";
  if (
    message.includes("owner changed") ||
    message.includes("feed id changed") ||
    message.includes("write authority changed") ||
    message.includes("layout is invalid") ||
    message.includes("not fully verified")
  ) {
    return "feed_contract_changed";
  }
  if (message.includes("stale or from the future")) return "price_stale";
  if (
    message.includes("price is not positive") ||
    message.includes("exponent") ||
    message.includes("confidence is not positive") ||
    message.includes("publish time")
  ) {
    return "price_invalid";
  }
  if (
    message.includes("rpc") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("network")
  ) {
    return "rpc_unavailable";
  }
  return "unexpected";
}

function bigintField(value: unknown, field: string): bigint {
  if (typeof value !== "object" || value === null || !("toString" in value)) {
    throw new Error(`Pyth SOL/USD ${field} is invalid`);
  }
  const rendered = String(value);
  let parsed: bigint;
  try {
    parsed = BigInt(rendered);
  } catch {
    throw new Error(`Pyth SOL/USD ${field} is invalid`);
  }
  if (parsed.toString() !== rendered) {
    throw new Error(`Pyth SOL/USD ${field} is not canonical`);
  }
  return parsed;
}

function feedIdHex(value: unknown): string {
  if (
    !Array.isArray(value) ||
    value.length !== 32 ||
    value.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error("Pyth SOL/USD feed ID is invalid");
  }
  return Buffer.from(value).toString("hex");
}

function formatPythPrice(price: bigint, exponent: number): string {
  if (price <= 0n) throw new Error("Pyth SOL/USD price is not positive");
  if (
    !Number.isInteger(exponent) ||
    Math.abs(exponent) > PYTH_SAFE_EXPONENT_ABS
  ) {
    throw new Error("Pyth SOL/USD exponent is unsafe");
  }
  return exponent >= 0
    ? (price * 10n ** BigInt(exponent)).toString()
    : formatUnsignedDecimal(price, -exponent);
}

function confidenceFor(
  price: bigint,
  confidence: bigint,
): UsdEstimate["confidence"] {
  if (confidence <= 0n) {
    throw new Error("Pyth SOL/USD confidence is not positive");
  }
  const scaledConfidence = confidence * 10_000n;
  if (scaledConfidence <= price * 50n) return "high";
  if (scaledConfidence <= price * 200n) return "medium";
  if (scaledConfidence <= price * 500n) return "low";
  throw new Error("Pyth SOL/USD confidence is too wide");
}

export function decodePythSolUsdPrice(input: {
  data: Buffer;
  owner: string;
  now: Date;
}): DecodedSolUsdPrice {
  if (input.owner !== PYTH_SOLANA_RECEIVER_PROGRAM_ID) {
    throw new Error("Pyth SOL/USD account owner changed");
  }
  const decoded = receiverAccountCoder.decode("priceUpdateV2", input.data);
  if (!isRecord(decoded) || !isRecord(decoded.priceMessage)) {
    throw new Error("Pyth SOL/USD account layout is invalid");
  }
  if (
    !isRecord(decoded.verificationLevel) ||
    !isRecord(decoded.verificationLevel.full)
  ) {
    throw new Error("Pyth SOL/USD account is not fully verified");
  }
  if (feedIdHex(decoded.priceMessage.feedId) !== PYTH_SOL_USD_FEED_ID) {
    throw new Error("Pyth SOL/USD feed ID changed");
  }
  if (String(decoded.writeAuthority) !== PYTH_SOL_USD_ACCOUNT) {
    throw new Error("Pyth SOL/USD write authority changed");
  }
  const price = bigintField(decoded.priceMessage.price, "price");
  const confidence = bigintField(decoded.priceMessage.conf, "confidence");
  const exponent = decoded.priceMessage.exponent;
  if (typeof exponent !== "number") {
    throw new Error("Pyth SOL/USD exponent is invalid");
  }
  const publishTime = bigintField(
    decoded.priceMessage.publishTime,
    "publish time",
  );
  if (publishTime <= 0n || publishTime > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Pyth SOL/USD publish time is unsafe");
  }
  const nowSeconds = BigInt(Math.floor(input.now.getTime() / 1_000));
  if (
    publishTime > nowSeconds ||
    (nowSeconds - publishTime) * 1_000n >
      BigInt(PYTH_SOL_USD_MAX_PUBLISH_AGE_MS)
  ) {
    throw new Error("Pyth SOL/USD price is stale or from the future");
  }
  return {
    unitPriceUsd: formatPythPrice(price, exponent),
    asOf: new Date(Number(publishTime) * 1_000).toISOString(),
    confidence: confidenceFor(price, confidence),
  };
}

export class PythSolUsdPriceAdapter implements PriceAdapter {
  readonly adapterId = PYTH_SOL_USD_PRICE_POLICY_ID;
  readonly #cacheKey: string;
  readonly #loadAccount: PythSolUsdAccountLoader;
  readonly #now: () => Date;
  readonly #onUnavailable:
    | ((input: Readonly<{ code: PythSolUsdUnavailableCode }>) => void)
    | undefined;
  #lastUnavailableNotice: Readonly<{
    atMs: number;
    code: PythSolUsdUnavailableCode;
  }> | null = null;

  constructor(
    input?: Readonly<{
      cacheKey?: string;
      loadAccount?: PythSolUsdAccountLoader;
      now?: () => Date;
      onUnavailable?: (
        input: Readonly<{
          code: PythSolUsdUnavailableCode;
        }>,
      ) => void;
    }>,
  ) {
    this.#cacheKey = input?.cacheKey ?? "pyth:sol-usd:v1";
    this.#loadAccount =
      input?.loadAccount ??
      (() =>
        fetchSolanaRawAccountInfo({
          rpcUrls: fundingSidecarRuntimeConfig.solanaRpcUrls,
          timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
          address: PYTH_SOL_USD_ACCOUNT,
        }));
    this.#now = input?.now ?? (() => new Date());
    this.#onUnavailable = input?.onUnavailable;
  }

  async value(
    input: Parameters<PriceAdapter["value"]>[0],
  ): Promise<UsdEstimate | null> {
    if (
      input.policyId !== this.adapterId ||
      !isKnownNativeSolAsset(input.amount.asset)
    ) {
      return null;
    }
    try {
      const price = await rpcReadCoordinator.memo(
        this.#cacheKey,
        { ttlMs: PYTH_SOL_USD_CACHE_TTL_MS },
        async () => {
          const account = await this.#loadAccount();
          if (!account) throw new Error("Pyth SOL/USD account is unavailable");
          return decodePythSolUsdPrice({
            data: account.data,
            owner: account.owner,
            now: this.#now(),
          });
        },
      );
      const nowMs = this.#now().getTime();
      const asOfMs = new Date(price.asOf).getTime();
      if (
        !Number.isFinite(nowMs) ||
        !Number.isFinite(asOfMs) ||
        asOfMs > nowMs ||
        nowMs - asOfMs > PYTH_SOL_USD_MAX_PUBLISH_AGE_MS
      ) {
        return null;
      }
      return {
        value: formatSolUsdValue(input.amount.raw, price.unitPriceUsd),
        asOf: price.asOf,
        priceSource: this.adapterId,
        confidence: price.confidence,
        policyId: input.policyId,
      };
    } catch (error) {
      // Valuation is optional. A Pyth/RPC failure must not hide the owned SOL
      // balance or make Account Value unavailable.
      const code = pythUnavailableCode(error);
      const nowMs = this.#now().getTime();
      const prior = this.#lastUnavailableNotice;
      if (
        this.#onUnavailable &&
        Number.isFinite(nowMs) &&
        (prior == null ||
          prior.code !== code ||
          nowMs - prior.atMs >= PYTH_UNAVAILABLE_DIAGNOSTIC_THROTTLE_MS)
      ) {
        this.#lastUnavailableNotice = { atMs: nowMs, code };
        try {
          this.#onUnavailable({ code });
        } catch {
          // Diagnostics must never become a valuation dependency.
        }
      }
      return null;
    }
  }
}

function formatSolUsdValue(raw: string, unitPriceUsd: string): string {
  if (!isRawAmount(raw)) {
    throw new Error("SOL raw balance is invalid");
  }
  return multiplyRawByUnitPrice({
    raw,
    decimals: 9,
    unitPriceUsd,
  });
}
