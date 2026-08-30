import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { isAbortError } from "@hunch/shared";
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
import {
  PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
  PYTH_SOL_USD_PRICE_POLICY_ID,
} from "./valuation-service.js";

export const PYTH_SOL_USD_ACCOUNT =
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOLANA_RECEIVER_PROGRAM_ID =
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PYTH_SOL_USD_MAX_PUBLISH_AGE_MS = 60_000;
const PYTH_SAFE_EXPONENT_ABS = 18;
const PYTH_UNAVAILABLE_DIAGNOSTIC_THROTTLE_MS = 20_000;
const receiverAccountCoder = new BorshAccountsCoder(PYTH_SOLANA_RECEIVER_IDL);

export type PythSolUsdPriceRecord = Readonly<{
  unitPriceUsd: string;
  asOf: string;
  confidence: UsdEstimate["confidence"];
}>;

export type PythSolUsdCacheFence = Readonly<{
  generation: string;
  state: "empty" | "price" | "quarantine";
  barrierSeconds: string | null;
  price: PythSolUsdPriceRecord | null;
}>;

export type PythSolUsdCacheWriteResult =
  | "accepted"
  | "rejected"
  | "unavailable";

export type PythSolUsdLastKnownStore = Readonly<{
  readFence: () => Promise<PythSolUsdCacheFence | null>;
  commitPrice: (input: {
    expectedGeneration: string;
    price: PythSolUsdPriceRecord;
  }) => Promise<PythSolUsdCacheWriteResult>;
  quarantine: (input: {
    reason: PythSolUsdUnavailableCode;
    trustedPublishBarrierSeconds: string;
  }) => Promise<PythSolUsdCacheWriteResult>;
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
  if (isAbortError(error)) return "rpc_unavailable";
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

const TEMPORARY_PYTH_UNAVAILABLE_CODES = new Set<PythSolUsdUnavailableCode>([
  "account_unavailable",
  "price_stale",
  "rpc_unavailable",
]);

function publishTimeSeconds(asOf: string): string {
  return Math.floor(Date.parse(asOf) / 1_000).toString();
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
}): PythSolUsdPriceRecord {
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
  readonly #lastKnownStore: PythSolUsdLastKnownStore | undefined;
  readonly #now: () => Date;
  readonly #onUnavailable:
    | ((input: Readonly<{ code: PythSolUsdUnavailableCode }>) => void)
    | undefined;
  #lastUnavailableNotice: Readonly<{
    atMs: number;
    code: PythSolUsdUnavailableCode;
  }> | null = null;
  #lastKnownPrice: PythSolUsdPriceRecord | null = null;
  #lastKnownQuarantined = false;
  #sharedQuarantineEstablished = false;
  #unsafeValidationGeneration: string | null = null;
  #quarantineAttemptEpoch = 0;
  #pendingSharedQuarantine: Readonly<{
    reason: PythSolUsdUnavailableCode;
    trustedPublishBarrierSeconds: string;
  }> | null = null;

  constructor(
    input?: Readonly<{
      cacheKey?: string;
      lastKnownStore?: PythSolUsdLastKnownStore;
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
    this.#lastKnownStore = input?.lastKnownStore;
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
    let fence: PythSolUsdCacheFence | null = null;
    if (this.#lastKnownStore) {
      try {
        fence = await this.#lastKnownStore.readFence();
      } catch {
        fence = null;
      }
    }
    // A shared last-known store is the cross-process safety fence. When it is
    // configured but unavailable, do not publish or remember a price that was
    // never accepted by that fence.
    if (this.#lastKnownStore && !fence) {
      // Quarantine uses an independent Redis lane. A stalled primary
      // read/price lane must not prevent an already-known unsafe observation
      // from advancing the shared quarantine generation.
      if (this.#lastKnownQuarantined && !this.#sharedQuarantineEstablished) {
        await this.#retrySharedQuarantine();
      }
      return null;
    }
    if (this.#lastKnownQuarantined && !this.#sharedQuarantineEstablished) {
      if (
        fence?.state !== "quarantine" ||
        fence.generation === this.#unsafeValidationGeneration
      ) {
        await this.#retrySharedQuarantine();
        return null;
      }
      this.#sharedQuarantineEstablished = true;
      this.#pendingSharedQuarantine = null;
    }
    const validationEpoch = this.#quarantineAttemptEpoch;
    try {
      const price = await rpcReadCoordinator.singleFlight(
        `${this.#cacheKey}:${fence?.generation ?? "local"}`,
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
      if (this.#lastKnownStore && fence) {
        const committed = await this.#lastKnownStore.commitPrice({
          expectedGeneration: fence.generation,
          price,
        });
        if (committed !== "accepted") return null;
      }
      if (validationEpoch !== this.#quarantineAttemptEpoch) return null;
      this.#rememberLastKnownPrice(price);
      const nowMs = this.#now().getTime();
      const asOfMs = new Date(price.asOf).getTime();
      if (
        !Number.isFinite(nowMs) ||
        !Number.isFinite(asOfMs) ||
        asOfMs > nowMs ||
        nowMs - asOfMs > PYTH_SOL_USD_MAX_PUBLISH_AGE_MS
      ) {
        return this.#lastKnownEstimate(input, this.#quarantineAttemptEpoch);
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
      if (TEMPORARY_PYTH_UNAVAILABLE_CODES.has(code)) {
        return this.#lastKnownEstimate(input, validationEpoch);
      }
      await this.#quarantineLastKnownPrice(code, fence?.generation ?? null);
      return null;
    }
  }

  async freshValue(
    input: Parameters<PriceAdapter["value"]>[0],
  ): Promise<UsdEstimate | null> {
    const estimate = await this.value(input);
    return estimate?.priceSource === PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE
      ? null
      : estimate;
  }

  #rememberLastKnownPrice(price: PythSolUsdPriceRecord): void {
    if (this.#lastKnownQuarantined) {
      this.#quarantineAttemptEpoch += 1;
    }
    this.#lastKnownQuarantined = false;
    this.#sharedQuarantineEstablished = false;
    this.#unsafeValidationGeneration = null;
    this.#pendingSharedQuarantine = null;
    this.#lastKnownPrice = price;
  }

  async #quarantineLastKnownPrice(
    reason: PythSolUsdUnavailableCode,
    unsafeValidationGeneration: string | null,
  ): Promise<void> {
    const attemptEpoch = this.#quarantineAttemptEpoch + 1;
    this.#quarantineAttemptEpoch = attemptEpoch;
    const trustedPublishBarrierSeconds = this.#lastKnownPrice
      ? publishTimeSeconds(this.#lastKnownPrice.asOf)
      : "0";
    this.#lastKnownPrice = null;
    this.#lastKnownQuarantined = true;
    this.#sharedQuarantineEstablished = false;
    this.#unsafeValidationGeneration = unsafeValidationGeneration;
    const pendingSharedQuarantine = {
      reason,
      trustedPublishBarrierSeconds,
    };
    this.#pendingSharedQuarantine = pendingSharedQuarantine;
    await this.#publishSharedQuarantine(pendingSharedQuarantine, attemptEpoch);
  }

  async #retrySharedQuarantine(): Promise<void> {
    const pendingSharedQuarantine = this.#pendingSharedQuarantine;
    if (!this.#lastKnownStore || !pendingSharedQuarantine) return;
    const attemptEpoch = this.#quarantineAttemptEpoch + 1;
    this.#quarantineAttemptEpoch = attemptEpoch;
    await this.#publishSharedQuarantine(pendingSharedQuarantine, attemptEpoch);
  }

  async #publishSharedQuarantine(
    pendingSharedQuarantine: Readonly<{
      reason: PythSolUsdUnavailableCode;
      trustedPublishBarrierSeconds: string;
    }>,
    attemptEpoch: number,
  ): Promise<void> {
    if (!this.#lastKnownStore) return;
    try {
      const result = await this.#lastKnownStore.quarantine({
        reason: pendingSharedQuarantine.reason,
        trustedPublishBarrierSeconds:
          pendingSharedQuarantine.trustedPublishBarrierSeconds,
      });
      if (
        attemptEpoch === this.#quarantineAttemptEpoch &&
        this.#pendingSharedQuarantine === pendingSharedQuarantine
      ) {
        this.#sharedQuarantineEstablished = result === "accepted";
        if (result === "accepted") {
          this.#pendingSharedQuarantine = null;
        }
      }
    } catch {
      // The in-process quarantine remains authoritative even if the shared
      // display cache is unavailable.
    }
  }

  async #lastKnownEstimate(
    input: Parameters<PriceAdapter["value"]>[0],
    expectedQuarantineEpoch: number,
  ): Promise<UsdEstimate | null> {
    if (expectedQuarantineEpoch !== this.#quarantineAttemptEpoch) return null;
    if (
      this.#lastKnownQuarantined &&
      (!this.#lastKnownStore || !this.#sharedQuarantineEstablished)
    ) {
      return null;
    }
    let price = this.#lastKnownPrice;
    if (this.#lastKnownStore) {
      try {
        const fence = await this.#lastKnownStore.readFence();
        if (expectedQuarantineEpoch !== this.#quarantineAttemptEpoch) {
          return null;
        }
        if (!fence) return null;
        if (fence.state === "quarantine") {
          this.#lastKnownQuarantined = true;
          this.#sharedQuarantineEstablished = true;
          this.#lastKnownPrice = null;
          return null;
        }
        price = fence.state === "price" ? fence.price : null;
        if (price) {
          // A price observed after this process successfully established a
          // shared quarantine can only have crossed that generation via a
          // freshly validated publish strictly above the barrier.
          this.#rememberLastKnownPrice(price);
        } else {
          this.#lastKnownPrice = null;
        }
      } catch {
        // Persistent display cache is best-effort and must not become an
        // Account Value availability dependency.
        return null;
      }
    }
    if (!price) return null;
    const nowMs = this.#now().getTime();
    const asOfMs = Date.parse(price.asOf);
    if (!Number.isFinite(nowMs) || !Number.isFinite(asOfMs) || asOfMs > nowMs) {
      return null;
    }
    return {
      value: formatSolUsdValue(input.amount.raw, price.unitPriceUsd),
      asOf: price.asOf,
      priceSource: PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
      confidence: price.confidence,
      policyId: input.policyId,
    };
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
