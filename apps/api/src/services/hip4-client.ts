import {
  hip4Identity,
  parseHip4Coin,
  hip4TradeSchema,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import { z } from "zod";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import { hip4AccountFillSchema } from "./hip4-account-contract.js";

export type Hip4InfoAdmissionReceipt = Readonly<{
  reservedWeight: number;
  settle: (actualWeight: number, deadlineMs?: number) => Promise<void>;
}>;
type Hip4InfoAdmission = boolean | Hip4InfoAdmissionReceipt;
export const HIP4_LEDGER_REQUEST_WEIGHT = 45;

export type Hip4AccountInfoRequest =
  | { type: "preTransferCheck"; user: string; source: string }
  | { type: "clearinghouseState"; user: string; dex: "" }
  | { type: "orderStatus"; user: string; oid: number | string }
  | { type: "userFills"; user: string; aggregateByTime: false }
  | {
      type:
        | "userRole"
        | "userAbstraction"
        | "userDexAbstraction"
        | "borrowLendUserState"
        | "spotClearinghouseState"
        | "userFees"
        | "frontendOpenOrders";
      user: string;
    }
  | {
      type: "userFillsByTime";
      user: string;
      startTime: number;
      endTime: number;
      aggregateByTime: false;
    }
  | {
      type: "userNonFundingLedgerUpdates";
      user: string;
      startTime: number;
      endTime: number;
    };

/** Owned account reads only; uses the same IP budget and bounded transport. */
export function createHip4AccountClient(
  policy: Hip4ReadPolicy,
  admit: (weight: number) => Promise<Hip4InfoAdmission>,
  fetcher: typeof fetch = fetch,
  options?: Readonly<{ deadlineMs: number }>,
) {
  return async (request: Hip4AccountInfoRequest) => {
    if (
      ![
        "userRole",
        "preTransferCheck",
        "userAbstraction",
        "userDexAbstraction",
        "borrowLendUserState",
        "spotClearinghouseState",
        "clearinghouseState",
        "userFees",
        "frontendOpenOrders",
        "orderStatus",
        "userFillsByTime",
        "userFills",
        "userNonFundingLedgerUpdates",
      ].includes(request.type)
    )
      throw new Hip4ReadError("invalid_response");
    const user = hip4AccountAddressSchema.parse(request.user);
    const scoped =
      request.type === "preTransferCheck"
        ? {
            ...request,
            user,
            source: hip4AccountAddressSchema.parse(request.source),
          }
        : { ...request, user };
    if (request.type === "clearinghouseState" && request.dex !== "")
      throw new Hip4ReadError("invalid_response");
    if (
      request.type === "orderStatus" &&
      !(typeof request.oid === "number"
        ? Number.isSafeInteger(request.oid) && request.oid >= 0
        : typeof request.oid === "string" &&
          /^0x[0-9a-fA-F]{32}$/u.test(request.oid))
    )
      throw new Hip4ReadError("invalid_response");
    if (
      "startTime" in request &&
      (!Number.isSafeInteger(request.startTime) ||
        request.startTime < 0 ||
        !Number.isSafeInteger(request.endTime) ||
        request.endTime < request.startTime)
    )
      throw new Hip4ReadError("invalid_response");
    if (
      (request.type === "userFillsByTime" || request.type === "userFills") &&
      request.aggregateByTime !== false
    )
      throw new Hip4ReadError("invalid_response");
    const weight =
      request.type === "userRole"
        ? 60
        : request.type === "spotClearinghouseState" ||
            request.type === "clearinghouseState" ||
            request.type === "orderStatus"
          ? 2
          : request.type === "userFillsByTime" || request.type === "userFills"
            ? 120
            : request.type === "userNonFundingLedgerUpdates"
              ? // Official Info pagination documents500 time-range elements;
                // the rates page names nonUserFundingUpdates, not this exact
                // wire type. Reserve the conservative20+ceil(500/20) bound,
                // without claiming an exact small-response fee for this alias.
                HIP4_LEDGER_REQUEST_WEIGHT
              : 20;
    return hip4InfoResponse(
      policy,
      admit,
      fetcher,
      scoped,
      weight,
      options?.deadlineMs,
    );
  };
}

// Transport reservation, deliberately independent of the local processing cap.
// recentTrades has no request limit. Keep a conservative 2000-row envelope.
export const HIP4_RECENT_TRADES_RESPONSE_BOUND = 2000;

export type Hip4InfoRequest =
  | { type: "outcomeMeta" | "spotMeta" | "spotMetaAndAssetCtxs" }
  | { type: "settledOutcome"; outcome: number }
  | { type: "l2Book" | "recentTrades"; coin: string };

export class Hip4ReadError extends Error {
  constructor(
    public readonly reason:
      | "budget_exhausted"
      | "http_error"
      | "timeout"
      | "transport_error"
      | "response_too_large"
      | "invalid_response",
  ) {
    super(reason);
  }
}

export function createHip4ReadClient(
  policy: Hip4ReadPolicy,
  admit: (weight: number) => Promise<Hip4InfoAdmission>,
  fetcher: typeof fetch = fetch,
  options?: Readonly<{ deadlineMs: number }>,
) {
  return async (request: Hip4InfoRequest): Promise<unknown> => {
    if (
      ![
        "outcomeMeta",
        "spotMeta",
        "spotMetaAndAssetCtxs",
        "settledOutcome",
        "l2Book",
        "recentTrades",
      ].includes(request.type)
    )
      throw new Hip4ReadError("invalid_response");
    if (request.type === "settledOutcome")
      hip4Identity(policy.environment, request.outcome);
    if (request.type === "l2Book" || request.type === "recentTrades")
      parseHip4Coin(request.coin);
    // Conservative admission includes payload-dependent recentTrades weight.
    // No caller may route exchange/account actions through this client.
    const weight =
      request.type === "l2Book"
        ? 2
        : request.type === "recentTrades"
          ? 20 + Math.ceil(HIP4_RECENT_TRADES_RESPONSE_BOUND / 20)
          : 20;
    return hip4InfoResponse(
      policy,
      admit,
      fetcher,
      request,
      weight,
      options?.deadlineMs,
    );
  };
}

async function hip4InfoResponse(
  policy: Hip4ReadPolicy,
  admit: (weight: number) => Promise<Hip4InfoAdmission>,
  fetcher: typeof fetch,
  request: Hip4InfoRequest | Hip4AccountInfoRequest,
  weight: number,
  deadlineMs?: number,
): Promise<unknown> {
  const remainingTimeout = () => {
    if (deadlineMs === undefined) return policy.requestTimeoutMs;
    const remaining = Math.ceil(deadlineMs - Date.now());
    if (!Number.isSafeInteger(remaining) || remaining <= 0)
      throw new Hip4ReadError("budget_exhausted");
    return Math.min(policy.requestTimeoutMs, remaining);
  };
  remainingTimeout();
  const admission = await admit(weight);
  if (!admission) throw new Hip4ReadError("budget_exhausted");
  // Admission may wait on the shared DB row. The absolute caller budget must
  // be rechecked AFTER that wait, at the actual transport boundary.
  const timeoutMs = remainingTimeout();
  const transportDeadlineMs = Date.now() + timeoutMs;
  const endpoint =
    policy.environment === "mainnet"
      ? "https://api.hyperliquid.xyz/info"
      : "https://api.hyperliquid-testnet.xyz/info";
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Hip4ReadError("http_error");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Hip4ReadError("invalid_response");
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > policy.responseMaxBytes)
          throw new Hip4ReadError("response_too_large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try {
        const payload: unknown = JSON.parse(text);
        const actualWeight = hip4SuccessfulResponseWeight(request, payload);
        if (
          typeof admission !== "boolean" &&
          actualWeight !== null &&
          actualWeight < admission.reservedWeight &&
          Date.now() < transportDeadlineMs
        ) {
          try {
            await admission.settle(actualWeight, transportDeadlineMs);
          } catch {
            // No accounting failure changes valid provider evidence into an
            // HTTP/financial failure. Keep the complete reserved weight.
          }
        }
        return payload;
      } catch {
        throw new Hip4ReadError("invalid_response");
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof Hip4ReadError) throw error;
    throw new Hip4ReadError(
      error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
        ? "timeout"
        : "transport_error",
    );
  }
}

const generalFillSchema = hip4AccountFillSchema.extend({
  coin: z.string().min(1),
  px: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/u),
});

/** Official REST weights count the FULL returned array, not a local display
 * cap or selected coin. Only understood, uncapped successful wire pages can
 * lower the conservative reservation. Unknown/malformed/capped data cannot. */
export function hip4SuccessfulResponseWeight(
  request: Hip4InfoRequest | Hip4AccountInfoRequest,
  payload: unknown,
): number | null {
  if (!Array.isArray(payload) || payload.length >= 2000) return null;
  if (request.type === "recentTrades") {
    if (
      payload.some((row) => {
        const parsed = hip4TradeSchema.safeParse(row);
        return (
          !parsed.success ||
          parsed.data.coin !== request.coin ||
          parsed.data.time > Date.now()
        );
      })
    )
      return null;
  } else if (
    request.type === "userFills" ||
    request.type === "userFillsByTime"
  ) {
    let previousTime =
      request.type === "userFillsByTime" ? request.startTime : 0;
    for (const row of payload) {
      const parsed = generalFillSchema.safeParse(row);
      if (!parsed.success || parsed.data.time > Date.now()) return null;
      if (
        parsed.data.coin.startsWith("#") &&
        !hip4AccountFillSchema.safeParse(row).success
      )
        return null;
      if (
        request.type === "userFillsByTime" &&
        (parsed.data.time < previousTime || parsed.data.time > request.endTime)
      )
        return null;
      previousTime = parsed.data.time;
    }
  } else return null;
  return 20 + Math.ceil(payload.length / 20);
}
