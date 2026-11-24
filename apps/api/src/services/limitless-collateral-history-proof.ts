import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import { fetchLimitlessHistoryReceiptCandidates } from "../repos/limitless-history-receipt-locators.js";
import { readRetainedLimitlessClobSubmission } from "./limitless-clob-evidence-identity.js";
import { readCanonicalFinalizedBuyReceipt } from "./verified-buy-evm-receipt.js";
import { createEvmRpcProvider } from "./rpc-client-factory.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";

type ReceiptReader = (
  txHash: string,
) => ReturnType<typeof readCanonicalFinalizedBuyReceipt>;
type ObservedReceipt = NonNullable<Awaited<ReturnType<ReceiptReader>>>;
const finalizedLocatorCache = new Map<
  string,
  { receipt: ObservedReceipt; checkedAt: number }
>();
const MAX_FINALIZED_LOCATORS = 256;
const FINALIZED_LOCATOR_TTL_MS = 15 * 60_000;
const recentUnclassified = new Map<string, number>();
const UNCLASSIFIED_REVISIT_MS = 60_000;
/** Shared per-batch cap; status-only lanes must never spend a full job
 * polling previously settled trades during upstream outages. */
export function createLimitlessHistoryReceiptReader(): ReceiptReader {
  let provider: ReturnType<typeof createEvmRpcProvider> | undefined;
  let remainingReads = 12;
  const deadline = Date.now() + 15_000;
  return async (txHash) => {
    const cached = finalizedLocatorCache.get(txHash);
    if (cached && Date.now() - cached.checkedAt < FINALIZED_LOCATOR_TTL_MS)
      return cached.receipt;
    // Leave room for later candidates if the first receipts are temporarily
    // absent. A skipped read remains unknown, never an absence assessment.
    if (
      Date.now() - (recentUnclassified.get(txHash) ?? 0) <
      UNCLASSIFIED_REVISIT_MS
    )
      return null;
    if (remainingReads < 3 || Date.now() > deadline) return null;
    recentUnclassified.delete(txHash);
    if (recentUnclassified.size >= MAX_FINALIZED_LOCATORS) {
      const oldest = recentUnclassified.keys().next();
      if (!oldest.done) recentUnclassified.delete(oldest.value);
    }
    recentUnclassified.set(txHash, Date.now());
    provider ??= createEvmRpcProvider(
      fundingSidecarRuntimeConfig.baseRpcUrl,
      8453,
      undefined,
      {
        timeoutMs: Math.min(
          fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
          3_000,
        ),
      },
    );
    try {
      const observed = await readCanonicalFinalizedBuyReceipt(
        provider,
        txHash,
        () => {
          if (remainingReads-- <= 0 || Date.now() > deadline)
            throw new Error("Limitless history receipt budget exhausted");
        },
      );
      // Cache only finalized canonical data; a missing or unsettled receipt
      // never consumes the next pass's proof or becomes absence evidence.
      if (observed) {
        recentUnclassified.delete(txHash);
        finalizedLocatorCache.delete(txHash);
        if (finalizedLocatorCache.size >= MAX_FINALIZED_LOCATORS) {
          const oldest = finalizedLocatorCache.keys().next();
          if (!oldest.done) finalizedLocatorCache.delete(oldest.value);
        }
        finalizedLocatorCache.set(txHash, {
          receipt: observed,
          checkedAt: Date.now(),
        });
      }
      return observed;
    } catch {
      return null;
    }
  };
}
const fillInterface = new Interface([
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
]);
const orderIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The row gives us an exact client/provider binding and locator, not
 * execution proof. Only the matching frozen order in a finalized receipt
 * can complete an otherwise ambiguous FOK. No signing or submit dependency. */
export async function observeLimitlessCollateralHistoryFill(input: {
  db: Pick<Pool, "query">;
  readReceipt: ReceiptReader;
  userId: string;
  clientOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  submission: unknown;
  extraLocators?: readonly {
    tx_hash: string;
    provider_order_id: string | null;
  }[];
  providerOrderId?: string | null;
  observeUnboundLocators?: boolean;
  onLocatorResult?: (hash: string, result: "matched" | "unmatched") => void;
}): Promise<{
  providerOrderId: string;
  txHash: string;
  settledAt: Date;
  size: number;
  price: number;
} | null> {
  const saved = input.submission;
  if (
    !isRecord(saved) ||
    !isRecord(saved.order) ||
    typeof saved.order.maker !== "string"
  )
    return null;
  const frozen = readRetainedLimitlessClobSubmission(saved, {
    walletAddress: saved.order.maker,
    tokenId: input.tokenId,
    side: input.side,
  });
  if (!frozen?.context.collateralFeeModule || frozen.order.takerAmount !== "1")
    return null;
  const tokenId = BigInt(frozen.order.tokenId);
  const owner = frozen.order.maker.toLowerCase();
  const exchange = frozen.context.exchangeAddress.toLowerCase();
  const local = await fetchLimitlessHistoryReceiptCandidates(input.db, {
    userId: input.userId,
    walletAddress: owner,
    tokenId: input.tokenId,
    side: input.side,
    clientOrderId: input.clientOrderId,
    providerOrderId: input.providerOrderId,
  });
  const candidates = [
    ...new Map(
      [...local, ...(input.extraLocators ?? [])].map((candidate) => [
        `${candidate.tx_hash}:${candidate.provider_order_id}`,
        candidate,
      ]),
    ).values(),
  ];
  if (!candidates.length) return null;
  const ids = new Set(
    candidates
      .map(({ provider_order_id }) => provider_order_id)
      .filter(Boolean),
  );
  if (input.providerOrderId) ids.add(input.providerOrderId);
  if (!input.observeUnboundLocators && ids.size !== 1) return null;
  const proved = [];
  for (const txHash of new Set(
    candidates.map((candidate) => candidate.tx_hash),
  )) {
    const observed = await input.readReceipt(txHash);
    if (!observed || observed.receipt.hash.toLowerCase() !== txHash) continue;
    if (observed.receipt.status === 0) {
      input.onLocatorResult?.(txHash, "unmatched");
      continue;
    }
    if (observed.receipt.status !== 1) continue;
    const hasExactEvent = observed.receipt.logs.some(
      (log) =>
        log.address.toLowerCase() === exchange &&
        log.topics[1]?.toLowerCase() === frozen.context.orderHash &&
        log.topics[0] === fillInterface.getEvent("OrderFilled")?.topicHash,
    );
    input.onLocatorResult?.(txHash, hasExactEvent ? "matched" : "unmatched");
    const matching = observed.receipt.logs.flatMap((log) => {
      if (
        log.address.toLowerCase() !== exchange ||
        log.topics[1]?.toLowerCase() !== frozen.context.orderHash
      )
        return [];
      try {
        const fill = fillInterface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!fill || String(fill.args.maker).toLowerCase() !== owner) return [];
        const buy = input.side === "BUY";
        const makerAsset = buy ? 0n : tokenId;
        const takerAsset = buy ? tokenId : 0n;
        if (
          fill.args.makerAssetId !== makerAsset ||
          fill.args.takerAssetId !== takerAsset ||
          fill.args.makerAmountFilled <= 0n ||
          fill.args.takerAmountFilled <= 0n ||
          fill.args.makerAmountFilled > BigInt(frozen.order.makerAmount)
        )
          return [];
        return [
          {
            shares: Number(
              buy ? fill.args.takerAmountFilled : fill.args.makerAmountFilled,
            ),
            usd: Number(
              buy ? fill.args.makerAmountFilled : fill.args.takerAmountFilled,
            ),
          },
        ];
      } catch {
        return [];
      }
    });
    const fill = matching.length === 1 ? matching[0] : undefined;
    if (
      !fill ||
      !Number.isSafeInteger(fill.shares) ||
      !Number.isSafeInteger(fill.usd) ||
      fill.usd > fill.shares
    )
      continue;
    const boundIds = input.observeUnboundLocators
      ? new Set(
          candidates
            .filter((candidate) => candidate.tx_hash === txHash)
            .map((candidate) => candidate.provider_order_id)
            .filter(Boolean),
        )
      : ids;
    if (input.providerOrderId) boundIds.add(input.providerOrderId);
    const providerOrderId = [...boundIds][0];
    if (
      boundIds.size !== 1 ||
      !providerOrderId ||
      !orderIdPattern.test(providerOrderId)
    )
      continue;
    proved.push({
      providerOrderId,
      txHash,
      settledAt: new Date(observed.timestamp),
      size: fill.shares / 1e6,
      price: fill.usd / fill.shares,
    });
  }
  return proved.length === 1 ? proved[0] : null;
}
