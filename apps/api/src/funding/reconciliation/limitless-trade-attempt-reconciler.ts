import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";

import { normalizeLimitlessScopedTokenId } from "../../lib/limitless-token.js";
import {
  readLimitlessObservedLocator,
  type LimitlessHistoryObservation,
  type LimitlessHistoryScan,
} from "../../repos/limitless-observed-locator.js";
import {
  extractHistoryMarketSlug,
  isLimitlessNonOrderHistoryEntry,
  normalizeHistorySide,
} from "../../lib/limitless-history-identity.js";
import {
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
  readRetainedLimitlessClobSubmission,
  withoutLimitlessRecoverySignatures,
} from "../../services/limitless-clob-evidence-identity.js";
import {
  noteLimitlessDirectOrderLocator,
  promoteLimitlessDirectOrderJournal,
  storeOrderInTransaction,
  updateOrderFromHistory,
  type StoreOrderInput,
} from "../../repos/orders-repo.js";
import {
  fetchLimitlessHistoryReceiptLocators,
  limitlessFrozenCollateralSql,
  limitlessHistoryClientIdSql,
} from "../../repos/limitless-history-receipt-locators.js";
import {
  canonicalLimitlessTransactionHash,
  classifyFrozenLimitlessFokResult,
  isLimitlessFokNegativeCandidate,
  extractLimitlessExecutionFill,
  isLimitlessTerminalRejectedStatus,
  parseLimitlessOrderResult,
} from "../../services/limitless-order-result.js";
import { buildLimitlessPartnerHmacHeaders } from "../../services/limitless-partner-auth.js";
import {
  createLimitlessHistoryReceiptReader,
  observeLimitlessCollateralHistoryFill,
} from "../../services/limitless-collateral-history-proof.js";
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
  fetchFundingLimitlessClobSubmission,
  noteFundingLimitlessClobLocator,
  yieldLimitlessHistoryObservationLease,
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
  submission: unknown,
  negativeCheckedHashes: readonly string[],
): Promise<"accepted" | "definitive_failure" | "no_fill" | "unknown"> {
  const parsed = parseLimitlessOrderResult(status.item.payload);
  if (parsed.explicitNoFill) {
    await releaseFundingReservationForProvenLimitlessFokNoFill(pool, {
      clientOrderId: status.item.clientOrderId,
      providerOrderId: status.item.providerOrderId,
      negativeCheckedHashes,
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
      providerOrderId: status.item.providerOrderId,
      negativeCheckedHashes,
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
    submission,
  );
  if (!storeInput) return "unknown";
  await tx(pool, (client) =>
    persistLimitlessReconciledOrderInTransaction(client, storeInput),
  );
  return "accepted";
}

export async function persistLimitlessReconciledOrderInTransaction(
  client: PoolClient,
  input: StoreOrderInput,
) {
  const stored = await storeOrderInTransaction(client, input);
  if (stored.kind === "exists" && input.status === "filled")
    await updateOrderFromHistory(client, {
      id: stored.order.id,
      status: input.status,
      price: input.price,
      size: input.size,
      filledAt: input.filledAt ?? null,
      lastUpdate: input.lastUpdate ?? null,
      orderHash: input.orderHash ?? null,
      orderPayload: input.orderPayload,
    });
  return stored;
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
  frozenSubmission?: unknown,
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
  const providerWallet = resolveLimitlessReconciledSigner(status.item.payload);
  const frozenMaker =
    isRecord(frozenSubmission) && isRecord(frozenSubmission.order)
      ? frozenSubmission.order.maker
      : null;
  const walletAddress =
    typeof frozenMaker === "string" ? frozenMaker : providerWallet;
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
  const retained = readRetainedLimitlessClobSubmission(frozenSubmission, {
    walletAddress,
    tokenId,
    side: "BUY",
  });
  if (
    frozenSubmission !== undefined &&
    (!retained ||
      (providerWallet &&
        providerWallet.toLowerCase() !== retained.order.maker.toLowerCase()) ||
      (signerAddress &&
        signerAddress.toLowerCase() !== retained.order.signer.toLowerCase()))
  )
    return null;
  const fill = parsed.terminalFill
    ? extractLimitlessExecutionFill(status.item.payload)
    : null;
  return {
    userId: attempt.userId,
    walletAddress,
    signerAddress: retained?.order.signer ?? signerAddress,
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
      ...(retained ? { order: retained.order } : {}),
      clientOrderId: status.item.clientOrderId,
      _hunchUpstream: retained
        ? withoutLimitlessRecoverySignatures(status.item.payload)
        : status.item.payload,
    },
    limitlessClobSubmissionContext: retained?.context,
    limitlessReceiptLocatorHashes: readLimitlessObservedLocator(
      isRecord(frozenSubmission) ? frozenSubmission.locator : null,
    ).hashes,
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
    readHistoryReceipt?: Parameters<
      typeof observeLimitlessCollateralHistoryFill
    >[0]["readReceipt"];
    readFreshHistory?: (
      input: DirectHistoryScope,
    ) => Promise<DirectHistoryPage | null>;
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
    statuses = new Map();
  }
  const readHistoryReceipt =
    input.readHistoryReceipt ?? createLimitlessHistoryReceiptReader();
  let fundedHistoryRequestsLeft = 2;
  let found = 0;
  let provenAbsent = 0;
  let requeued = 0;
  let failed = 0;
  for (const attempt of attempts) {
    const clientOrderId = attempt.externalReference as string;
    const status = statuses.get(clientOrderId);
    try {
      const observedStatus =
        status?.kind === "found"
          ? parseLimitlessOrderResult(status.item.payload)
          : null;
      const submission = await fetchFundingLimitlessClobSubmission(
        pool,
        attempt,
      );
      const savedLocator = readLimitlessObservedLocator(
        isRecord(submission) ? submission.locator : null,
      );
      const exactProviderId =
        status?.kind === "found" ? status.item.providerOrderId : null;
      const observedMaker =
        status?.kind === "found"
          ? resolveLimitlessReconciledSigner(status.item.payload)
          : null;
      const frozenOrder =
        isRecord(submission) && isRecord(submission.order)
          ? submission.order
          : null;
      const conflictingStatus =
        (savedLocator.providerOrderId !== null &&
          exactProviderId !== null &&
          savedLocator.providerOrderId !== exactProviderId) ||
        (observedMaker !== null &&
          typeof frozenOrder?.maker === "string" &&
          observedMaker.toLowerCase() !== frozenOrder.maker.toLowerCase());
      const exactHash = conflictingStatus
        ? null
        : canonicalLimitlessTransactionHash(observedStatus?.txHash);
      const exactOutcome = observedStatus
        ? classifyFrozenLimitlessFokResult(observedStatus)
        : null;
      let negativeCheckedHashes: readonly string[] = [];
      const statusIsOpen =
        submission !== undefined &&
        observedStatus !== null &&
        (conflictingStatus ||
          (exactOutcome === "pending" &&
            !observedStatus.explicitNoFill &&
            !isLimitlessTerminalRejectedStatus(observedStatus.status)));
      const knownProviderId =
        savedLocator.providerOrderId ??
        (conflictingStatus ? null : exactProviderId);
      // Journal exact positive or uncertain evidence before any fallible
      // order writes or finalization in a separate transaction.
      if (
        submission !== undefined &&
        !conflictingStatus &&
        ((exactHash && !savedLocator.hashes.includes(exactHash)) ||
          ((statusIsOpen || exactOutcome === "settled") &&
            !savedLocator.providerOrderId &&
            exactProviderId))
      ) {
        await noteFundingLimitlessClobLocator(pool, {
          ...attempt,
          attemptId: attempt.id,
          clientOrderId,
          providerOrderId: exactProviderId,
          txHash: exactHash,
        });
      }
      if (
        !observedStatus ||
        statusIsOpen ||
        observedStatus.explicitNoFill ||
        isLimitlessTerminalRejectedStatus(observedStatus.status)
      ) {
        const locatorAssessments = new Map<string, "matched" | "unmatched">();
        const knownHashes = [
          ...new Set(
            [...savedLocator.hashes, exactHash].filter((hash): hash is string =>
              Boolean(hash),
            ),
          ),
        ];
        const tokenId = attempt.consumerIntent.marketContextId;
        const proofInput = tokenId
          ? {
              db: pool,
              readReceipt: readHistoryReceipt,
              userId: attempt.userId,
              clientOrderId,
              tokenId,
              side: "BUY" as const,
              submission,
              providerOrderId: knownProviderId,
              observeUnboundLocators:
                knownHashes.length > 0 && !knownProviderId,
              extraLocators: knownHashes.map((tx_hash) => ({
                tx_hash,
                provider_order_id: knownProviderId,
              })),
              onLocatorResult: (
                hash: string,
                result: "matched" | "unmatched",
              ) => locatorAssessments.set(hash, result),
            }
          : null;
        let proof = proofInput
          ? await observeLimitlessCollateralHistoryFill(proofInput)
          : null;
        const freshRequired =
          submission !== undefined &&
          (status?.kind === "not_found" ||
            observedStatus?.explicitNoFill ||
            (observedStatus &&
              isLimitlessTerminalRejectedStatus(observedStatus.status)));
        let negativeEvidenceCleared = !freshRequired;
        if (
          !proof &&
          (freshRequired || statusIsOpen || submission !== undefined) &&
          proofInput &&
          isRecord(submission) &&
          typeof submission.providerOwnerId === "number" &&
          Number.isSafeInteger(submission.providerOwnerId) &&
          submission.providerOwnerId > 0 &&
          isLimitlessExactStatusAbsenceMature({
            ambiguousAt: attempt.resolvedAt,
            minimumAgeMs:
              input.minimumAbsenceAgeMs ?? LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS,
            now,
          })
        ) {
          if (fundedHistoryRequestsLeft <= 0) {
            await yieldLimitlessHistoryObservationLease(pool, attempt, now);
            requeued++;
            continue;
          }
          fundedHistoryRequestsLeft--;
          const investigation = await inspectLimitlessFreshCollateralHistory({
            proofInput,
            scope: {
              ownerId: submission.providerOwnerId,
              clientOrderId,
              postedAt: attempt.claimedAt,
              providerOrderId: knownProviderId,
              historyScan: savedLocator.historyScan,
              tokenId: proofInput.tokenId,
              side: proofInput.side,
              marketSlug:
                typeof submission.providerMarketSlug === "string"
                  ? submission.providerMarketSlug
                  : undefined,
            },
            readHistoryPage:
              input.readFreshHistory ??
              ((scope) => readDirectLimitlessHistory(input.config, scope)),
            retain: (history) =>
              noteFundingLimitlessClobLocator(pool, {
                ...attempt,
                attemptId: attempt.id,
                clientOrderId,
                providerOrderId: null,
                txHash: null,
                history,
              }),
          });
          proof = investigation.proof;
          negativeEvidenceCleared =
            investigation.absenceClear &&
            !conflictingStatus &&
            !savedLocator.overflow &&
            !(
              status?.kind === "not_found" &&
              savedLocator.providerOrderId &&
              knownHashes.length === 0
            ) &&
            (!observedStatus ||
              isLimitlessFokNegativeCandidate(observedStatus)) &&
            knownHashes.every(
              (hash) => locatorAssessments.get(hash) === "unmatched",
            );
          if (negativeEvidenceCleared) negativeCheckedHashes = knownHashes;
        }
        if (proof) {
          // History without an exact client binding only becomes a durable
          // locator after the finalized log proves the frozen signed order.
          await noteFundingLimitlessClobLocator(pool, {
            ...attempt,
            attemptId: attempt.id,
            clientOrderId,
            providerOrderId: proof.providerOrderId,
            txHash: proof.txHash,
          });
          const recovered = buildLimitlessReconciledOrderStoreInput(
            attempt,
            {
              kind: "found",
              item: {
                orderId: proof.providerOrderId,
                providerOrderId: proof.providerOrderId,
                clientOrderId,
                payload: { recoveredFromFinalizedHistory: true },
              },
            },
            now,
            submission,
          );
          if (recovered) {
            await tx(pool, (client) =>
              persistLimitlessReconciledOrderInTransaction(client, {
                ...recovered,
                status: "filled",
                orderHash: proof.txHash,
                filledAt: proof.settledAt,
                price: proof.price,
                size: proof.size,
              }),
            );
            found++;
            continue;
          }
        }
        if (statusIsOpen || !negativeEvidenceCleared) {
          requeued++;
          continue;
        }
      }
      if (!status || status.kind === "unknown") {
        requeued += 1;
        continue;
      }
      if (status.kind === "found") {
        const consumed = await consumeFoundStatus(
          pool,
          attempt,
          status,
          now,
          submission,
          negativeCheckedHashes,
        );
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
        negativeCheckedHashes,
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
        [
          "attempt_not_found",
          "invalid_state",
          "limitless_history_conflict",
        ].includes(error.code)
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

/** Reconcile ordinary client-signed FOKs with a lost response. This worker
 * has no access to a signature or submit helper and only adopts exact IDs. */
type DirectHistoryPage = {
  exactClientFound: boolean;
  coversSubmission: boolean;
  locators: { tx_hash: string; provider_order_id: string | null }[];
  unboundLocators?: { tx_hash: string; provider_order_id: string | null }[];
  unboundMissingTx?: boolean;
  nextCursor?: string;
  hasLaterPage?: boolean;
  nextScan?: LimitlessHistoryScan | null;
};
type DirectHistoryScope = {
  ownerId: number;
  clientOrderId: string;
  providerOrderId?: string | null;
  postedAt: Date;
  marketSlug?: string;
  tokenId?: string;
  side?: "BUY" | "SELL";
  historyScan?: LimitlessHistoryScan | null;
};
const DIRECT_HISTORY_PAGE_SIZE = 25;

export function parseLimitlessDirectHistoryPage(
  value: unknown,
  input: DirectHistoryScope,
): DirectHistoryPage | null {
  const collection = isRecord(value)
    ? (value.data ?? value.history ?? value.items ?? value.results)
    : value;
  if (
    !Array.isArray(collection) ||
    collection.length > DIRECT_HISTORY_PAGE_SIZE ||
    !collection.every(isRecord)
  )
    return null;
  const cursor = isRecord(value)
    ? (value.nextCursor ?? value.next_cursor)
    : null;
  const totalCount =
    isRecord(value) &&
    typeof value.totalCount === "number" &&
    Number.isSafeInteger(value.totalCount)
      ? value.totalCount
      : null;
  const nextCursor =
    typeof cursor === "string" && cursor.length > 0 && cursor.length <= 512
      ? cursor
      : undefined;
  const pageNumber = input.historyScan?.page ?? 1;
  const result: DirectHistoryPage = {
    exactClientFound: false,
    coversSubmission:
      !cursor &&
      collection.length < DIRECT_HISTORY_PAGE_SIZE &&
      (!isRecord(value) ||
        value.totalCount === undefined ||
        (totalCount !== null && totalCount === collection.length)),
    locators: [],
    nextCursor,
    hasLaterPage:
      Boolean(nextCursor) ||
      (collection.length > 0 &&
        (totalCount === null
          ? collection.length === DIRECT_HISTORY_PAGE_SIZE
          : totalCount > pageNumber * DIRECT_HISTORY_PAGE_SIZE)),
  };
  for (const raw of collection) {
    const entry = { ...(isRecord(raw.details) ? raw.details : {}), ...raw };
    const rawTimestamp =
      entry.blockTimestamp ??
      entry.block_timestamp ??
      entry.timestamp ??
      entry.createdAt;
    const numericTimestamp = Number(rawTimestamp ?? NaN);
    const timestamp = Number.isFinite(numericTimestamp)
      ? numericTimestamp * (numericTimestamp < 1e12 ? 1000 : 1)
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : NaN;
    if (
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= input.postedAt.getTime()
    )
      result.coversSubmission = true;
    const order = isRecord(entry.order) ? entry.order : {};
    const clientId =
      entry.clientOrderId ??
      entry.client_order_id ??
      order.clientOrderId ??
      order.client_order_id;
    const providerId =
      entry.orderId ??
      entry.order_id ??
      entry.venueOrderId ??
      entry.venue_order_id ??
      order.id ??
      order.orderId ??
      order.order_id;
    const hash = entry.transactionHash ?? entry.txHash ?? entry.tx_hash;
    const locator =
      typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash)
        ? {
            tx_hash: hash.toLowerCase(),
            provider_order_id:
              typeof providerId === "string" ? providerId : null,
          }
        : null;
    if (
      clientId !== input.clientOrderId &&
      (!input.providerOrderId || providerId !== input.providerOrderId)
    ) {
      const historySlug = extractHistoryMarketSlug(entry);
      const rawHistoryToken =
        entry.tokenId ?? entry.token_id ?? order.tokenId ?? order.token_id;
      const historyToken =
        typeof rawHistoryToken === "string"
          ? normalizeLimitlessScopedTokenId(rawHistoryToken)
          : null;
      const explicitSide =
        typeof entry.side === "string" ? entry.side.trim().toUpperCase() : null;
      const historySide =
        explicitSide === "BUY" || explicitSide === "SELL"
          ? explicitSide
          : normalizeHistorySide(
              typeof entry.strategy === "string" ? entry.strategy : null,
            );
      if (
        (input.marketSlug &&
          typeof historySlug === "string" &&
          historySlug !== input.marketSlug) ||
        (input.tokenId &&
          historyToken &&
          historyToken !== normalizeLimitlessScopedTokenId(input.tokenId)) ||
        (input.side &&
          (historySide === "BUY" || historySide === "SELL") &&
          historySide !== input.side)
      )
        continue;
      // Older history can omit clientOrderId, particularly when the entire
      // submit response was lost. Its tx can still prove the signed fill.
      if (
        (!input.providerOrderId || providerId == null) &&
        clientId == null &&
        (!Number.isFinite(timestamp) ||
          timestamp >= input.postedAt.getTime() - 60_000) &&
        !isLimitlessNonOrderHistoryEntry(entry)
      ) {
        if (locator) (result.unboundLocators ??= []).push(locator);
        else result.unboundMissingTx = true;
      }
      continue;
    }
    // Either exact identifier blocks an absence claim. Contradictory inputs
    // are not usable locators and require later reconciliation.
    result.exactClientFound = true;
    if (
      (clientId != null && clientId !== input.clientOrderId) ||
      (input.providerOrderId &&
        providerId != null &&
        providerId !== input.providerOrderId)
    )
      continue;
    if (locator) result.locators.push(locator);
  }
  return result;
}

/** Bounded authenticated read of the same wallet portfolio used at submit.
 * The page is only a locator source; it supplies no final fill evidence. */
export async function readDirectLimitlessHistory(
  config: LimitlessFundingReconciliationConfig,
  input: DirectHistoryScope,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DirectHistoryPage | null> {
  const progress = input.historyScan;
  const params = new URLSearchParams({
    limit: String(DIRECT_HISTORY_PAGE_SIZE),
  });
  if (progress?.cursor) params.set("cursor", progress.cursor);
  else params.set("page", String(progress?.page ?? 1));
  const path = `/portfolio/history?${params}`;
  try {
    const response = await fetchImpl(
      `${normalizeBaseUrl(config.apiBase)}${path}`,
      {
        headers: {
          accept: "application/json",
          "x-on-behalf-of": String(input.ownerId),
          ...buildLimitlessPartnerHmacHeaders({
            hmacSecret: config.hmacSecret,
            hmacTokenId: config.hmacTokenId,
            method: "GET",
            requestPath: path,
          }),
          ...(config.apiVersion ? { "x-api-version": config.apiVersion } : {}),
        },
        signal: AbortSignal.timeout(
          Math.min(config.timeoutMs ?? 15_000, 4_000),
        ),
      },
    );
    if (!response.ok) {
      // An expired/invalid cursor restarts at the head on the next turn.
      // This response provides no absence evidence; transient failures retain it.
      if (progress && [400, 404, 410, 422].includes(response.status))
        return {
          exactClientFound: false,
          coversSubmission: false,
          locators: [],
          nextScan: null,
        };
      return null;
    }
    const result = parseLimitlessDirectHistoryPage(
      await readBoundedResponse(response),
      input,
    );
    if (!result) return null;
    const nextPage = (progress?.page ?? 1) + 1;
    result.nextScan =
      result.hasLaterPage &&
      !result.coversSubmission &&
      (!result.nextCursor || result.nextCursor !== progress?.cursor) &&
      Number.isSafeInteger(nextPage)
        ? {
            page: nextPage,
            ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
          }
        : null;
    // Tail pages can recover positive receipts, never establish absence alone.
    if (progress) result.coversSubmission = false;
    return result;
  } catch {
    return null;
  }
}

function describeHistoryObservation(
  page: DirectHistoryPage,
  previous: LimitlessHistoryScan | null,
): LimitlessHistoryObservation | null {
  const hashes = [...new Set(page.locators.map(({ tx_hash }) => tx_hash))];
  const providerIds = [
    ...new Set(
      page.locators.flatMap(({ provider_order_id }) =>
        provider_order_id ? [provider_order_id] : [],
      ),
    ),
  ];
  const scanChanged =
    page.nextScan !== undefined &&
    (page.nextScan?.page !== previous?.page ||
      page.nextScan?.cursor !== previous?.cursor);
  return hashes.length || scanChanged
    ? {
        hashes,
        ...(providerIds.length === 1
          ? { providerOrderId: providerIds[0] }
          : {}),
        ...(scanChanged
          ? { scan: { previous, next: page.nextScan ?? null } }
          : {}),
      }
    : null;
}

export async function inspectLimitlessFreshCollateralHistory(input: {
  proofInput: Parameters<typeof observeLimitlessCollateralHistoryFill>[0];
  scope: DirectHistoryScope;
  readHistoryPage: (
    scope: DirectHistoryScope,
  ) => Promise<DirectHistoryPage | null>;
  retain?: (observation: LimitlessHistoryObservation) => Promise<void>;
}) {
  const page = await input.readHistoryPage(input.scope);
  if (!page) return { proof: null, absenceClear: false };
  const observation = describeHistoryObservation(
    page,
    input.scope.historyScan ?? null,
  );
  // Persist only exact locators before any receipt or subsequent worker retry.
  // Scope-qualified but unbound history remains a per-read positive hint.
  if (observation && input.retain) await input.retain(observation);
  const assessments = new Map<string, "matched" | "unmatched">();
  const unbound = page.unboundLocators ?? [];
  const known = input.proofInput.extraLocators ?? [];
  const locators = [...known, ...page.locators, ...unbound];
  const proof = locators.length
    ? await observeLimitlessCollateralHistoryFill({
        ...input.proofInput,
        providerOrderId:
          input.scope.providerOrderId ?? input.proofInput.providerOrderId,
        extraLocators: locators,
        observeUnboundLocators:
          unbound.length > 0 || input.proofInput.observeUnboundLocators,
        onLocatorResult: (hash, result) => {
          assessments.set(hash, result);
          input.proofInput.onLocatorResult?.(hash, result);
        },
      })
    : null;
  return {
    proof,
    absenceClear:
      page.coversSubmission &&
      !page.exactClientFound &&
      page.locators.length === 0 &&
      !page.unboundMissingTx &&
      [...unbound, ...known].every(
        ({ tx_hash }) => assessments.get(tx_hash) === "unmatched",
      ),
  };
}

export async function reconcileLimitlessDirectOrderJournals(
  pool: Pool,
  input: {
    config: LimitlessFundingReconciliationConfig;
    now?: Date;
    lookup?: ExactStatusLookup;
    readFreshHistory?: (
      input: DirectHistoryScope,
    ) => Promise<DirectHistoryPage | null>;
    readHistoryReceipt?: Parameters<
      typeof observeLimitlessCollateralHistoryFill
    >[0]["readReceipt"];
  },
): Promise<number> {
  const now = input.now ?? new Date();
  // orders.last_update is overwritten by a database trigger (even if
  // explicitly set). Keep observation order independent of that column.
  const observationTime =
    "coalesce((order_payload->>'_hunchLimitlessDirectObservedAt')::timestamptz,last_update)";
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    client_order_id: string;
    token_id: string;
    wallet_address: string;
    side: "BUY" | "SELL";
    order_payload: Record<string, unknown>;
    posted_at: Date;
  }>(
    `select id,user_id,token_id,wallet_address,side,order_payload,posted_at,
             ${limitlessHistoryClientIdSql()} as client_order_id
        from orders
        where venue='limitless' and venue_order_id like 'client:hunch-direct-%'
          and order_type='FOK' and status='submitted' and side in ('BUY','SELL')
          and ${limitlessFrozenCollateralSql()}
          and ${observationTime} <= $1::timestamptz - interval '30 seconds'
        order by ${observationTime},id limit 10`,
    [now],
  );
  if (!rows.length) return 0;
  const lookup = input.lookup ?? createLimitlessExactStatusLookup(input.config);
  const statuses = await lookup(rows.map((row) => row.client_order_id)).catch(
    () => new Map<string, LimitlessExactClientOrderStatus>(),
  );
  const readHistoryReceipt =
    input.readHistoryReceipt ?? createLimitlessHistoryReceiptReader();
  const readFreshHistory =
    input.readFreshHistory ??
    ((request) => readDirectLimitlessHistory(input.config, request));
  let historyRequestsLeft = 2;
  let repaired = 0;
  for (const row of rows) {
    const status = statuses.get(row.client_order_id);
    const parsed =
      status?.kind === "found"
        ? parseLimitlessOrderResult(status.item.payload)
        : null;
    // Leave deferred rows at the front for the next bounded pass. Advancing
    // every due row would keep giving the same sorted IDs the history slots.
    if (
      historyRequestsLeft <= 0 &&
      !(parsed && classifyFrozenLimitlessFokResult(parsed) === "settled")
    )
      continue;
    const identity = {
      userId: row.user_id,
      journalId: row.id,
      clientOrderId: row.client_order_id,
    };
    const rotated = await pool.query(
      `update orders set order_payload=order_payload||jsonb_build_object('_hunchLimitlessDirectObservedAt',$2::text)
         where id=$1 and venue_order_id=concat('client:',$3::text)
         and status='submitted' and ${observationTime} <= $2::timestamptz-interval '30 seconds'`,
      [row.id, now.toISOString(), row.client_order_id],
    );
    if (!rotated.rowCount) continue;
    const submission = {
      context: limitlessClobFrozenContext(row.order_payload),
      order: limitlessClobSubmittedOrder(row.order_payload),
    };
    if (
      !readRetainedLimitlessClobSubmission(submission, {
        walletAddress: row.wallet_address,
        side: row.side,
        tokenId: row.token_id,
      })
    )
      continue;
    const absentOrFailed =
      parsed?.explicitNoFill ||
      (parsed && isLimitlessTerminalRejectedStatus(parsed.status));
    const storedLocator = readLimitlessObservedLocator(
      row.order_payload._hunchLimitlessDirectLocator,
    );
    const initialProviderId = storedLocator.providerOrderId;
    let knownProviderId = initialProviderId;
    const knownHashes = new Set(storedLocator.hashes);
    const maker =
      status?.kind === "found"
        ? resolveLimitlessReconciledSigner(status.item.payload)
        : null;
    const conflictingStatus =
      status?.kind === "found" &&
      ((maker !== null &&
        maker.toLowerCase() !== row.wallet_address.toLowerCase()) ||
        (initialProviderId !== null &&
          initialProviderId !== status.item.providerOrderId));
    if (status?.kind === "found" && parsed && !conflictingStatus) {
      const observedHash = canonicalLimitlessTransactionHash(parsed.txHash);
      if (!absentOrFailed || observedHash) {
        knownProviderId = status.item.providerOrderId;
        if (observedHash) knownHashes.add(observedHash);
      }
      if (
        (!initialProviderId && knownProviderId) ||
        (observedHash && !storedLocator.hashes.includes(observedHash))
      )
        await noteLimitlessDirectOrderLocator(pool, {
          ...identity,
          providerOrderId: knownProviderId,
          txHash: observedHash,
        });
      if (classifyFrozenLimitlessFokResult(parsed) === "settled") {
        const fill = extractLimitlessExecutionFill(status.item.payload);
        if (
          await promoteLimitlessDirectOrderJournal(pool, {
            ...identity,
            providerOrderId: status.item.providerOrderId,
            orderHash: parsed.txHash,
            status: "filled",
            price: fill?.averagePrice,
            size: fill?.shares,
            filledAt: now,
          })
        )
          repaired++;
        continue;
      }
    }
    const unboundAssessment = new Map<string, "matched" | "unmatched">();
    const observeHistory = (
      extraLocators?: DirectHistoryPage["locators"],
      observeUnboundLocators = false,
    ) =>
      observeLimitlessCollateralHistoryFill({
        db: pool,
        readReceipt: readHistoryReceipt,
        tokenId: row.token_id,
        side: row.side,
        userId: row.user_id,
        clientOrderId: row.client_order_id,
        submission,
        providerOrderId: knownProviderId,
        observeUnboundLocators:
          observeUnboundLocators || (!knownProviderId && knownHashes.size > 0),
        onLocatorResult: (hash, result) => unboundAssessment.set(hash, result),
        extraLocators: [
          ...Array.from(knownHashes, (tx_hash) => ({
            tx_hash,
            provider_order_id: knownProviderId,
          })),
          ...(extraLocators ?? []),
        ],
      });
    let proof = await observeHistory();
    let fresh: DirectHistoryPage | null = null;
    const ownerId = Number(row.order_payload.ownerId);
    if (
      !proof &&
      Number.isSafeInteger(ownerId) &&
      ownerId > 0 &&
      historyRequestsLeft > 0
    ) {
      historyRequestsLeft--;
      fresh = await readFreshHistory({
        ownerId,
        clientOrderId: row.client_order_id,
        providerOrderId: knownProviderId,
        historyScan: storedLocator.historyScan,
        postedAt: row.posted_at,
        marketSlug:
          typeof row.order_payload.marketSlug === "string"
            ? row.order_payload.marketSlug
            : undefined,
        tokenId: row.token_id,
        side: row.side,
      });
      if (fresh) {
        const history = describeHistoryObservation(
          fresh,
          storedLocator.historyScan,
        );
        if (history)
          await noteLimitlessDirectOrderLocator(pool, {
            ...identity,
            providerOrderId: null,
            history,
          });
        if (fresh.locators.length || fresh.unboundLocators?.length)
          proof = await observeHistory(
            [...fresh.locators, ...(fresh.unboundLocators ?? [])],
            Boolean(fresh.unboundLocators?.length),
          );
      }
    }
    if (proof) {
      await noteLimitlessDirectOrderLocator(pool, {
        ...identity,
        providerOrderId: proof.providerOrderId,
        txHash: proof.txHash,
      });
      if (
        await promoteLimitlessDirectOrderJournal(pool, {
          ...identity,
          providerOrderId: proof.providerOrderId,
          orderHash: proof.txHash,
          status: "filled",
          price: proof.price,
          size: proof.size,
          filledAt: proof.settledAt,
        })
      )
        repaired++;
      continue;
    }
    if (
      !conflictingStatus &&
      ((parsed && isLimitlessFokNegativeCandidate(parsed)) ||
        (status?.kind === "not_found" && !knownProviderId)) &&
      now.getTime() - row.posted_at.getTime() >=
        LIMITLESS_TRADE_ABSENCE_MIN_AGE_MS &&
      fresh?.coversSubmission &&
      !fresh.exactClientFound &&
      fresh.locators.length === 0 &&
      !fresh.unboundMissingTx &&
      (fresh.unboundLocators ?? []).every(
        ({ tx_hash }) => unboundAssessment.get(tx_hash) === "unmatched",
      ) &&
      !storedLocator.overflow &&
      [...knownHashes].every(
        (hash) => unboundAssessment.get(hash) === "unmatched",
      ) &&
      !(
        await fetchLimitlessHistoryReceiptLocators(pool, {
          userId: row.user_id,
          walletAddress: row.wallet_address,
          tokenId: row.token_id,
          side: row.side,
          clientOrderId: row.client_order_id,
          providerOrderId: knownProviderId,
        })
      ).length
    ) {
      if (
        await promoteLimitlessDirectOrderJournal(pool, {
          ...identity,
          status: parsed?.explicitNoFill ? "no_fill" : "failed",
          negativeCheckedHashes: [...knownHashes],
        })
      )
        repaired++;
      continue;
    }
  }
  return repaired;
}
