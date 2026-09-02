import type { Pool } from "@hunch/infra";

import { normalizeLimitlessScopedTokenId } from "../../lib/limitless-token.js";
import { storeOrder, type StoreOrderInput } from "../../repos/orders-repo.js";
import {
  extractLimitlessExecutionFill,
  isLimitlessTerminalRejectedStatus,
  parseLimitlessOrderResult,
} from "../../services/limitless-order-result.js";
import { buildLimitlessPartnerHmacHeaders } from "../../services/limitless-partner-auth.js";
import {
  interpretLimitlessExactClientOrderStatuses,
  isLimitlessExactStatusAbsenceMature,
  type LimitlessExactClientOrderStatus,
} from "../../services/limitless-order-status-parser.js";
import {
  releaseFundingReservationForProvenAbsentLimitlessTrade,
  releaseFundingReservationForProvenLimitlessFokNoFill,
  releaseFundingReservationForProvenLimitlessTerminalRejection,
} from "../persistence/funding-evidence-repository.js";
import {
  claimAmbiguousLimitlessTradeAttemptsForReconciliation,
  FundingTradeAttemptError,
  type FundingTradeAttempt,
} from "../persistence/funding-trade-attempt-repository.js";

const STATUS_PATH = "/orders/status/batch";
const STATUS_BATCH_MAX_ITEMS = 50;
const MAX_STATUS_RESPONSE_BYTES = 256 * 1_024;
export const LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS = 5 * 60_000;

export type LimitlessFundingReconciliationConfig = Readonly<{
  apiBase: string;
  apiVersion?: string;
  hmacSecret: string;
  hmacTokenId: string;
  timeoutMs?: number;
}>;

export type LimitlessTradeAttemptReconciliationResult = Readonly<{
  claimed: number;
  found: number;
  provenAbsent: number;
  requeued: number;
  failed: number;
}>;

type ExactStatusLookup = (
  clientOrderIds: readonly string[],
) => Promise<Map<string, LimitlessExactClientOrderStatus>>;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_STATUS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Limitless exact status response exceeded size limit");
    }
    chunks.push(next.value);
  }
  const text = new TextDecoder().decode(
    chunks.length === 1
      ? chunks[0]
      : Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
  );
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createLimitlessExactStatusLookup(
  config: LimitlessFundingReconciliationConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): ExactStatusLookup {
  return async (clientOrderIds) => {
    if (
      clientOrderIds.length < 1 ||
      clientOrderIds.length > STATUS_BATCH_MAX_ITEMS
    ) {
      throw new Error("Limitless exact status batch must contain 1-50 items");
    }
    const items = clientOrderIds.map((clientOrderId) => ({ clientOrderId }));
    const body = JSON.stringify({ items });
    const authHeaders = buildLimitlessPartnerHmacHeaders({
      bodyString: body,
      hmacSecret: config.hmacSecret,
      hmacTokenId: config.hmacTokenId,
      method: "POST",
      requestPath: STATUS_PATH,
    });
    const response = await fetchImpl(
      `${normalizeBaseUrl(config.apiBase)}${STATUS_PATH}`,
      {
        method: "POST",
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
          ...authHeaders,
          ...(config.apiVersion ? { "x-api-version": config.apiVersion } : {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      },
    );
    const payload = await readBoundedResponse(response);
    if (!response.ok) {
      throw new Error(
        `Limitless exact status lookup failed (${response.status})`,
      );
    }
    return interpretLimitlessExactClientOrderStatuses(payload, clientOrderIds);
  };
}

function readAddress(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      const nested = readAddress(entry, keys, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (
      typeof candidate === "string" &&
      /^0x[0-9a-f]{40}$/iu.test(candidate.trim())
    ) {
      return candidate.trim();
    }
  }
  for (const key of ["data", "order", "payload", "submitted"]) {
    const nested = readAddress(record[key], keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function resolveLimitlessReconciledSigner(
  providerPayload: unknown,
): string | null {
  return readAddress(providerPayload, [
    "maker",
    "makerAddress",
    "maker_address",
    "signer",
    "signerAddress",
    "signer_address",
  ]);
}

async function consumeFoundStatus(
  pool: Pool,
  attempt: FundingTradeAttempt,
  status: Extract<LimitlessExactClientOrderStatus, { kind: "found" }>,
  now: Date,
): Promise<"accepted" | "definitive_failure" | "no_fill" | "unknown"> {
  const parsed = parseLimitlessOrderResult(status.item.payload);
  if (parsed.explicitNoFill) {
    await releaseFundingReservationForProvenLimitlessFokNoFill(pool, {
      clientOrderId: status.item.clientOrderId,
      expectedClaimToken: attempt.claimToken,
      link: {
        operationId: attempt.operationId,
        reservationId: attempt.reservationId,
      },
      tradeAttemptId: attempt.id,
      userId: attempt.userId,
      now,
    });
    return "no_fill";
  }
  if (isLimitlessTerminalRejectedStatus(parsed.status)) {
    await releaseFundingReservationForProvenLimitlessTerminalRejection(pool, {
      clientOrderId: status.item.clientOrderId,
      errorCode: `limitless_exact_status_${parsed.status}`,
      expectedClaimToken: attempt.claimToken,
      link: {
        operationId: attempt.operationId,
        reservationId: attempt.reservationId,
      },
      tradeAttemptId: attempt.id,
      userId: attempt.userId,
      now,
    });
    return "definitive_failure";
  }
  const storeInput = buildLimitlessReconciledOrderStoreInput(
    attempt,
    status,
    now,
  );
  if (!storeInput) return "unknown";
  await storeOrder(pool, storeInput);
  return "accepted";
}

export function buildLimitlessReconciledOrderStoreInput(
  attempt: Pick<
    FundingTradeAttempt,
    | "claimToken"
    | "consumerIntent"
    | "id"
    | "operationId"
    | "reservationId"
    | "userId"
  >,
  status: Extract<LimitlessExactClientOrderStatus, { kind: "found" }>,
  now: Date,
): StoreOrderInput | null {
  const parsed = parseLimitlessOrderResult(status.item.payload);
  if (
    parsed.explicitNoFill ||
    isLimitlessTerminalRejectedStatus(parsed.status)
  ) {
    return null;
  }
  // Historical attempts do not contain an immutable signer binding. Never
  // guess from the user's current primary wallet: it may differ from the
  // wallet that signed this exact order. A provider hit without maker/signer
  // remains ambiguous for manual reconciliation.
  const walletAddress = resolveLimitlessReconciledSigner(status.item.payload);
  if (!walletAddress) return null;
  const signerAddress = readAddress(status.item.payload, [
    "signer",
    "signerAddress",
    "signer_address",
  ]);
  const tokenId = normalizeLimitlessScopedTokenId(
    attempt.consumerIntent.marketContextId,
  );
  if (!tokenId) return null;
  const fill = parsed.terminalFill
    ? extractLimitlessExecutionFill(status.item.payload)
    : null;
  return {
    userId: attempt.userId,
    walletAddress,
    signerAddress,
    venue: "limitless",
    venueOrderId: status.item.providerOrderId,
    tokenId,
    side: "BUY",
    orderType: "FOK",
    price: fill?.averagePrice ?? null,
    size: fill?.shares ?? null,
    status: parsed.status ?? "submitted",
    errorMessage: null,
    rawError: null,
    orderHash: parsed.txHash,
    orderPayload: {
      clientOrderId: status.item.clientOrderId,
      _hunchUpstream: status.item.payload,
    },
    fundingReservation: {
      operationId: attempt.operationId,
      reservationId: attempt.reservationId,
    },
    fundingTradeAttemptId: attempt.id,
    fundingTradeReconciliationClaimToken: attempt.claimToken,
    lastUpdate: now,
    ...(parsed.terminalFill ? { filledAt: now } : {}),
  };
}

export async function runLimitlessTradeAttemptReconciliationBatch(
  pool: Pool,
  input: Readonly<{
    batchSize: number;
    config: LimitlessFundingReconciliationConfig;
    leaseSeconds: number;
    lookup?: ExactStatusLookup;
    minimumAbsenceAgeMs?: number;
    now?: Date;
  }>,
): Promise<LimitlessTradeAttemptReconciliationResult> {
  const now = input.now ?? new Date();
  const attempts = await claimAmbiguousLimitlessTradeAttemptsForReconciliation(
    pool,
    {
      batchSize: input.batchSize,
      leaseSeconds: input.leaseSeconds,
      now,
    },
  );
  if (!attempts.length) {
    return { claimed: 0, found: 0, provenAbsent: 0, requeued: 0, failed: 0 };
  }
  const lookup = input.lookup ?? createLimitlessExactStatusLookup(input.config);
  let statuses: Map<string, LimitlessExactClientOrderStatus>;
  try {
    statuses = await lookup(
      attempts.map((attempt) => attempt.externalReference as string),
    );
  } catch {
    return {
      claimed: attempts.length,
      found: 0,
      provenAbsent: 0,
      requeued: attempts.length,
      failed: 0,
    };
  }
  let found = 0;
  let provenAbsent = 0;
  let requeued = 0;
  let failed = 0;
  for (const attempt of attempts) {
    const clientOrderId = attempt.externalReference as string;
    const status = statuses.get(clientOrderId);
    try {
      if (!status || status.kind === "unknown") {
        requeued += 1;
        continue;
      }
      if (status.kind === "found") {
        const consumed = await consumeFoundStatus(pool, attempt, status, now);
        if (consumed === "unknown") requeued += 1;
        else found += 1;
        continue;
      }
      const minimumAgeMs =
        input.minimumAbsenceAgeMs ?? LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS;
      if (
        !isLimitlessExactStatusAbsenceMature({
          ambiguousAt: attempt.resolvedAt,
          minimumAgeMs,
          now,
        })
      ) {
        requeued += 1;
        continue;
      }
      await releaseFundingReservationForProvenAbsentLimitlessTrade(pool, {
        clientOrderId,
        expectedClaimToken: attempt.claimToken,
        link: {
          operationId: attempt.operationId,
          reservationId: attempt.reservationId,
        },
        minimumAgeMs,
        operationSupportMetadataPatch: {
          limitlessTradeAbsenceProof: {
            version: 1,
            checkedAt: now.toISOString(),
            clientOrderId,
            minimumAgeMs,
            providerStatus: "not_found",
          },
        },
        tradeAttemptId: attempt.id,
        userId: attempt.userId,
        now,
      });
      provenAbsent += 1;
    } catch (error) {
      if (
        error instanceof FundingTradeAttemptError &&
        ["attempt_not_found", "invalid_state"].includes(error.code)
      ) {
        // A newer lease holder or foreground consumer won the race. This
        // worker must not turn its stale provider result into another write.
        requeued += 1;
      } else {
        failed += 1;
      }
    }
  }
  return { claimed: attempts.length, found, provenAbsent, requeued, failed };
}
