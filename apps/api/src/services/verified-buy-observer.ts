import type { Pool } from "@hunch/infra";
import { parsePolymarketAssetContext } from "@hunch/shared";
import { isRecord } from "../lib/type-guards.js";
import type {
  ClaimedPurchase,
  PurchaseObservation,
  VerifiedPurchaseEvidence,
} from "./verified-buy.js";
import {
  EvidenceBudgetExhausted,
  observationFailureReason,
} from "./verified-buy.js";
import {
  combinePurchaseEvidence,
  parseEvmClobBuyEvidence,
  parseEvmAmmBuyEvidence,
} from "./verified-buy-evidence.js";
import {
  verifiedBuyFactsSchema,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import {
  parseLimitlessOrderResult,
  isLimitlessTerminalRejectedStatus,
} from "./limitless-order-result.js";
import { resolveLimitlessClobEvidenceIdentity } from "./limitless-clob-evidence-identity.js";
import { resolveLimitlessReceiptFallback } from "./verified-buy-limitless-receipt.js";
import { readLimitlessAmmMarketAddress } from "./limitless-amm-address.js";
type Db = Pick<Pool, "query">;
export type PolymarketFillCandidate = {
  provider_tx_hash: string | null;
  provider_status: string | null;
  venue_trade_id?: string | null;
  venue_fill_id?: string | null;
  id?: string;
};
export type PolymarketFillObservation =
  | { state: "fills"; fills: PolymarketFillCandidate[] }
  | { state: "terminal_zero_fill" }
  | { state: "unavailable" | "not_found" | "malformed" | "identity_conflict" };
export type VerifiedBuyObserverDependencies = {
  maxEvidenceItems: number;
  assertEvidenceBudget?: (minimumReads: number) => void;
  limitlessPositionContract: string;
  limitlessExchangeAddress: string;
  solanaCollateralMint: string;
  /** Configured-chain reader: return null unless the receipt's block is canonical and finalized. */
  readEvmReceipt: (
    chainId: number,
    hash: string,
  ) => Promise<{ receipt: unknown; timestamp: string } | null>;
  readFinalizedSolanaTransaction: (signature: string) => Promise<unknown>;
  readLimitlessOrder: (input: {
    providerOrderId: string | null;
    clientOrderId: string | null;
  }) => Promise<unknown>;
  readDflowOrder: (signature: string) => Promise<unknown>;
  readPolymarketFills: (input: {
    userId: string;
    owner: string;
    signer: string;
    orderHash: string;
    tokenId: string;
  }) => Promise<PolymarketFillObservation>;
};

const pending = (
  reason: string,
  invalidatedEvidenceIds: string[] = [],
): PurchaseObservation => ({
  state: "pending",
  reason,
  ...(invalidatedEvidenceIds.length ? { invalidatedEvidenceIds } : {}),
});
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function root(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function failedReceipt(receipt: unknown, txHash: string): boolean {
  const record = root(receipt);
  return (
    String(record.hash ?? record.transactionHash).toLowerCase() ===
      txHash.toLowerCase() &&
    (record.status === 0 || record.status === "0x0")
  );
}
export function terminalZeroFill(input: {
  status: string | null;
  filledQuantity: string | null;
  evidenceCount: number;
}): boolean {
  return (
    ["CANCELLED", "CANCELED", "EXPIRED", "UNMATCHED", "NO_FILL"].includes(
      input.status?.toUpperCase() ?? "",
    ) &&
    /^0+(?:\.0+)?$/.test(input.filledQuantity ?? "") &&
    input.evidenceCount === 0
  );
}

export type VerifiedBuySourceRow = {
  id: string;
  user_id: string;
  venue: string;
  wallet_address: string | null;
  order_hash: string | null;
  venue_order_id: string | null;
  token_id: string | null;
  side: string | null;
  order_payload: unknown;
  client_order_id: string | null;
  tx_signature: string | null;
  market_id: string | null;
  outcome: string | null;
  expiration_time: Date | null;
  market_metadata: unknown;
  input_mint: string | null;
  output_mint: string | null;
  signer_address?: string | null;
  verified_buy_facts?: unknown;
};

/** Only read paths are injected. This module has no API env/auth/executor imports. */
export function createVerifiedBuyObserver(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
) {
  return async (claim: ClaimedPurchase): Promise<PurchaseObservation> => {
    const source =
      claim.purchaseRef.kind === "order"
        ? await db.query<VerifiedBuySourceRow>(
            `select purchase_row.id, purchase_row.user_id, purchase_row.venue,
          purchase_row.wallet_address, purchase_row.signer_address,purchase_row.order_hash, purchase_row.venue_order_id,
          purchase_row.token_id, purchase_row.side, purchase_row.order_payload, purchase_row.verified_buy_facts,
          coalesce(purchase_row.order_payload->>'clientOrderId',purchase_row.order_payload->'submitted'->>'clientOrderId',
            purchase_row.order_payload->'_hunchSubmitted'->>'clientOrderId') as client_order_id,
          null::text as tx_signature, token_row.market_id, token_row.side as outcome,
          market_row.expiration_time, market_row.metadata as market_metadata,
          null::text as input_mint, null::text as output_mint
        from orders purchase_row left join unified_tokens token_row on token_row.token_id = purchase_row.token_id
        left join unified_markets market_row on market_row.id = token_row.market_id
        where purchase_row.id = $1 and purchase_row.user_id = $2`,
            [claim.purchaseRef.id, claim.userId],
          )
        : await db.query<VerifiedBuySourceRow>(
            `select purchase_row.id, purchase_row.user_id, purchase_row.venue,
          purchase_row.wallet_address, null::text as order_hash, purchase_row.venue_order_id,
          token_row.token_id, purchase_row.side, null::jsonb as order_payload, null::text as client_order_id, purchase_row.verified_buy_facts,
          purchase_row.tx_signature, purchase_row.unified_market_id as market_id, token_row.side as outcome,
          market_row.expiration_time, market_row.metadata as market_metadata,
          purchase_row.input_mint, purchase_row.output_mint
        from executions purchase_row
        left join unified_tokens token_row on token_row.token_id = 'sol:' || purchase_row.output_mint
          and token_row.market_id = purchase_row.unified_market_id
        left join unified_markets market_row on market_row.id = purchase_row.unified_market_id
        where purchase_row.id = $1 and purchase_row.user_id = $2`,
            [claim.purchaseRef.id, claim.userId],
          );
    return observeVerifiedBuySource(db, deps, source.rows[0]);
  };
}

export async function observeVerifiedBuySource(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
  row: VerifiedBuySourceRow | undefined,
): Promise<PurchaseObservation> {
  if (!row || row.side?.toUpperCase() !== "BUY" || !row.wallet_address)
    return pending("purchase_identity_missing");
  const payload = root(row.order_payload);
  let context = parsePolymarketAssetContext(payload.assetContext);
  if (!context && row.venue === "polymarket" && row.token_id) {
    // Append-only historical binding, not today's replaceable token mapping.
    // Ambiguous ledger identities remain pending rather than guessing a generation.
    const bindings = await db.query<{ context: unknown }>(
      `select jsonb_build_object(
        'contextVersion',1,'chainId',chain_id,'positionContract',position_contract,'assetId',asset_id,'marketId',market_id,
        'protocolVersion',protocol_version,'assetKind',asset_kind,'conditionId',condition_id,
        'outcomeIndex',outcome_index,'negRisk',neg_risk,'exchangeAddress',exchange_address,
        'orderDomainVersion',order_domain_version,'conditionalAssetType',conditional_asset_type) as context
        from polymarket_asset_bindings where asset_id=$1 order by chain_id,position_contract limit 2`,
      [row.token_id],
    );
    if (bindings.rows.length === 1)
      context = parsePolymarketAssetContext(bindings.rows[0]?.context);
  }
  const marketId = context?.marketId ?? row.market_id;
  const tokenId = context?.assetId ?? row.token_id;
  const outcome = context
    ? context.outcomeIndex === 0
      ? "YES"
      : "NO"
    : row.outcome;
  if (
    !marketId ||
    !tokenId ||
    (outcome !== "YES" && outcome !== "NO") ||
    !["polymarket", "limitless", "kalshi"].includes(row.venue)
  )
    return pending("instrument_binding_missing");
  let instrument: VerifiedBuyFacts["instrument"] = {
    venue: row.venue as VerifiedBuyFacts["instrument"]["venue"],
    marketId,
    tokenId,
    outcome,
    generation: context
      ? `${context.chainId}:${context.positionContract.toLowerCase()}:${context.protocolVersion}`
      : row.venue === "kalshi"
        ? `solana:mainnet:${tokenId}`
        : `8453:${deps.limitlessPositionContract.toLowerCase()}:${tokenId}`,
    expiry: row.expiration_time?.toISOString() ?? null,
  };
  if (row.venue === "polymarket") {
    if (
      !context ||
      context.assetId !== row.token_id ||
      !row.order_hash ||
      !/^0x[0-9a-f]{64}$/i.test(row.order_hash)
    )
      return pending("frozen_order_binding_missing");
    const validHash = (value: string | null): value is string =>
      value !== null && /^0x[0-9a-f]{64}$/i.test(value);
    const previousHashes = new Set<string>();
    const previousEvidenceByHash = new Map<string, string[]>();
    if (row.verified_buy_facts != null) {
      const parsed = verifiedBuyFactsSchema.safeParse(row.verified_buy_facts);
      const expectedKey = `polymarket:${context.chainId}:${context.exchangeAddress.toLowerCase()}:${row.order_hash.toLowerCase()}`;
      if (
        !parsed.success ||
        parsed.data.canonicalPurchaseKey !== expectedKey ||
        parsed.data.owner.toLowerCase() !== row.wallet_address.toLowerCase() ||
        (
          ["venue", "marketId", "tokenId", "outcome", "generation"] as const
        ).some((field) => parsed.data.instrument[field] !== instrument[field])
      )
        return pending("previous_proof_identity_conflict");
      for (const id of parsed.data.evidenceIds) {
        const match = /^(\d+):(0x[0-9a-f]{64}):(0|[1-9]\d*)$/i.exec(id);
        const evidenceHash = match?.[2];
        if (
          !match ||
          !evidenceHash ||
          match[1] !== String(context.chainId) ||
          !Number.isSafeInteger(Number(match[3]))
        )
          return pending("previous_proof_identity_conflict");
        previousHashes.add(evidenceHash.toLowerCase());
        previousEvidenceByHash.set(evidenceHash.toLowerCase(), [
          ...(previousEvidenceByHash.get(evidenceHash.toLowerCase()) ?? []),
          id,
        ]);
      }
      // Expiry is part of the frozen snapshot, not today's mutable market data.
      instrument = parsed.data.instrument;
    }
    // Acquire this exact purchase's known source ONCE. A raw fill-count LIMIT
    // would silently lose concrete candidates; repeated materialized pages cost
    // O(N²/pageSize). Memory is O(this order's fill rows), never the global queue.
    const source = await db.query<PolymarketFillCandidate>(
      `select id, venue_fill_id, venue_trade_id, provider_tx_hash, provider_status
       from order_fills where order_id=$1`,
      [row.id],
    );
    const fills = source.rows.map((fill) => ({ ...fill }));
    const knownHashes = new Set(previousHashes);
    for (const fill of fills) {
      if (
        validHash(fill.provider_tx_hash) &&
        fill.provider_status?.toUpperCase() !== "FAILED"
      )
        knownHashes.add(fill.provider_tx_hash.toLowerCase());
      if (knownHashes.size > deps.maxEvidenceItems)
        throw new EvidenceBudgetExhausted(
          knownHashes.size,
          deps.maxEvidenceItems,
        );
    }
    let discovery: PolymarketFillObservation | null = null;
    const unresolved = (fill: PolymarketFillCandidate) =>
      fill.provider_status?.toUpperCase() !== "FAILED" &&
      !validHash(fill.provider_tx_hash);
    if ((!fills.length && !previousHashes.size) || fills.some(unresolved)) {
      discovery = await deps.readPolymarketFills({
        userId: row.user_id,
        owner: row.wallet_address,
        signer: row.signer_address ?? row.wallet_address,
        orderHash: row.order_hash,
        tokenId,
      });
      if (discovery.state === "fills") {
        for (const remote of discovery.fills) {
          // Only the same provider trade may fill a missing local identity.
          const matching = remote.venue_trade_id
            ? fills.filter(
                (fill) => fill.venue_trade_id === remote.venue_trade_id,
              )
            : [];
          for (const local of matching) {
            if (
              validHash(local.provider_tx_hash) &&
              validHash(remote.provider_tx_hash) &&
              local.provider_tx_hash.toLowerCase() !==
                remote.provider_tx_hash.toLowerCase()
            )
              return pending("provider_order_identity_conflict");
            if (
              unresolved(local) &&
              (validHash(remote.provider_tx_hash) ||
                remote.provider_status?.toUpperCase() === "FAILED")
            ) {
              local.provider_tx_hash = remote.provider_tx_hash;
              local.provider_status = remote.provider_status;
            }
          }
          if (!matching.length) fills.push(remote);
        }
      }
    }
    // A failed settlement attempt is not evidence against another actual fill
    // of the same order. Only surviving candidates contribute purchase proof.
    const candidates = fills.filter(
      (fill) => fill.provider_status?.toUpperCase() !== "FAILED",
    );
    const hasUnresolvedFill = candidates.some(unresolved);
    const parts: VerifiedPurchaseEvidence[] = [];
    const hashes = new Set([
      ...previousHashes,
      ...candidates.flatMap((fill) =>
        validHash(fill.provider_tx_hash)
          ? [fill.provider_tx_hash.toLowerCase()]
          : [],
      ),
    ]);
    if (!hashes.size) {
      if (hasUnresolvedFill)
        return pending("fill_transaction_identity_missing");
      if (fills.length && !candidates.length)
        return { state: "revoked", reason: "provider_fill_failed" };
      if (discovery?.state === "terminal_zero_fill")
        return { state: "revoked", reason: "provider_terminal_zero_fill" };
      if (discovery && discovery.state !== "fills")
        return pending(`provider_evidence_${discovery.state}`);
      return pending("fill_transaction_identity_missing");
    }
    if (hashes.size > deps.maxEvidenceItems)
      throw new EvidenceBudgetExhausted(hashes.size, deps.maxEvidenceItems);
    deps.assertEvidenceBudget?.(hashes.size * 3);
    const invalidatedEvidenceIds: string[] = [];
    let incompleteReason: string | null = null;
    for (const hash of hashes) {
      let observed: Awaited<
        ReturnType<VerifiedBuyObserverDependencies["readEvmReceipt"]>
      >;
      try {
        observed = await deps.readEvmReceipt(context.chainId, hash);
      } catch (error) {
        incompleteReason = observationFailureReason(error);
        if (error instanceof EvidenceBudgetExhausted) break;
        continue;
      }
      if (!observed) {
        incompleteReason ??= hasUnresolvedFill
          ? "fill_transaction_identity_missing"
          : !previousHashes.size &&
              candidates.some(
                (fill) => fill.provider_status?.toUpperCase() !== "CONFIRMED",
              )
            ? "provider_settlement_pending"
            : "receipt_pending";
        continue;
      }
      if (failedReceipt(observed.receipt, hash)) {
        invalidatedEvidenceIds.push(
          ...(previousEvidenceByHash.get(hash) ?? []),
        );
        continue;
      }
      const evidence = parseEvmClobBuyEvidence({
        receipt: observed.receipt,
        txHash: hash,
        owner: row.wallet_address,
        orderHash: row.order_hash,
        exchangeAddress: context.exchangeAddress,
        positionContract: context.positionContract,
        tokenId,
        chainId: context.chainId,
        instrument,
        purchasedAt: observed.timestamp,
      });
      if (!evidence) {
        incompleteReason ??= hasUnresolvedFill
          ? "fill_transaction_identity_missing"
          : "receipt_exact_fill_unavailable";
        continue;
      }
      parts.push(evidence);
    }
    // Known incomplete identity prevents publishing totals, but must not prevent
    // canonicality reads of already-known proof locators above.
    if (incompleteReason)
      return pending(incompleteReason, invalidatedEvidenceIds);
    if (hasUnresolvedFill)
      return pending(
        "fill_transaction_identity_missing",
        invalidatedEvidenceIds,
      );
    if (!parts.length)
      return { state: "revoked", reason: "finalized_receipt_failed" };
    const facts = combinePurchaseEvidence(parts);
    return facts
      ? { state: "verified", facts }
      : pending("evidence_identity_conflict");
  }
  if (row.venue === "limitless") {
    const ammMatch = row.venue_order_id?.match(/^amm:(0x[0-9a-f]{64}):/i);
    if (ammMatch?.[1]) {
      const marketAddress = readLimitlessAmmMarketAddress(
        row.market_metadata,
        payload.marketAddress,
      );
      if (!marketAddress) return pending("amm_contract_missing");
      const observed = await deps.readEvmReceipt(8453, ammMatch[1]);
      if (!observed) return pending("receipt_pending");
      if (failedReceipt(observed.receipt, ammMatch[1]))
        return { state: "revoked", reason: "finalized_receipt_failed" };
      const evidence = parseEvmAmmBuyEvidence({
        receipt: observed.receipt,
        txHash: ammMatch[1],
        owner: row.wallet_address,
        marketAddress,
        positionContract: deps.limitlessPositionContract,
        tokenId: tokenId.replace(/^limitless:/, ""),
        outcomeIndex: outcome === "YES" ? 0 : 1,
        chainId: 8453,
        instrument,
        purchasedAt: observed.timestamp,
      });
      const facts = evidence && combinePurchaseEvidence([evidence]);
      return facts
        ? { state: "verified", facts }
        : pending("amm_exact_fill_unavailable");
    }
    const status = root(
      await deps.readLimitlessOrder({
        providerOrderId: row.venue_order_id,
        clientOrderId: row.client_order_id,
      }),
    );
    if (
      status.status === "not_found" &&
      status.orderId === row.venue_order_id &&
      (!row.client_order_id || status.clientOrderId === row.client_order_id)
    ) {
      const fallback = resolveLimitlessReceiptFallback({
        payload,
        providerOrderId: row.venue_order_id,
        clientOrderId: row.client_order_id,
        owner: row.wallet_address,
        tokenId: tokenId.replace(/^limitless:/, ""),
        marketMetadata: row.market_metadata,
        legacyExchangeAddress: deps.limitlessExchangeAddress,
      });
      if (!fallback.ready) return pending(fallback.reason);
      deps.assertEvidenceBudget?.(3);
      const observed = await deps.readEvmReceipt(8453, fallback.txHash);
      if (!observed) return pending("receipt_pending");
      // A stale locator to a failed attempt is not a definitive rejection of
      // this purchase while the provider itself reports absence. Retry safely.
      const evidence = parseEvmClobBuyEvidence({
        receipt: observed.receipt,
        txHash: fallback.txHash,
        owner: row.wallet_address,
        orderHash: fallback.orderHash,
        providerOrderId: fallback.providerOrderId,
        exchangeAddress: fallback.exchangeAddress,
        positionContract: deps.limitlessPositionContract,
        tokenId: tokenId.replace(/^limitless:/, ""),
        chainId: 8453,
        instrument,
        purchasedAt: observed.timestamp,
      });
      const facts = evidence && combinePurchaseEvidence([evidence]);
      return facts
        ? { state: "verified", facts }
        : pending("receipt_exact_fill_unavailable");
    }
    if (
      status.status !== "found" ||
      (row.client_order_id && status.clientOrderId !== row.client_order_id)
    )
      return pending("provider_order_pending");
    const providerOrderId = text(status.orderId);
    if (
      !providerOrderId ||
      (row.venue_order_id &&
        !row.venue_order_id.startsWith("client:") &&
        providerOrderId !== row.venue_order_id)
    )
      return pending("provider_order_identity_conflict");
    const data = root(status.data),
      wrapper = root(data.order),
      order = root(wrapper.order ?? data.order);
    const execution = root(wrapper.execution ?? data.execution);
    const parsedOrder = parseLimitlessOrderResult(status);
    const totals = root(execution.totalsRaw);
    const matches =
      wrapper.makerMatches ?? data.makerMatches ?? order.makerMatches;
    if (
      parsedOrder.explicitNoFill ||
      (isLimitlessTerminalRejectedStatus(parsedOrder.status) &&
        parsedOrder.matched === false &&
        terminalZeroFill({
          status: parsedOrder.status,
          filledQuantity: text(totals.contractsGross),
          evidenceCount: Array.isArray(matches) ? matches.length : -1,
        }) &&
        /^0+$/.test(text(totals.usdGross) ?? "") &&
        !text(execution.txHash))
    )
      return { state: "revoked", reason: "provider_terminal_zero_fill" };
    if (
      ["FAILED", "REVERTED"].includes(
        String(execution.settlementStatus).toUpperCase(),
      )
    )
      return { state: "revoked", reason: "provider_settlement_failed" };
    const hash = text(execution.txHash);
    const identity = resolveLimitlessClobEvidenceIdentity({
      orderPayload: payload,
      marketMetadata: row.market_metadata,
      legacyExchangeAddress: deps.limitlessExchangeAddress,
      providerOrder: order,
    });
    if (!identity) return pending("signed_order_identity_missing");
    if (
      !hash ||
      !["MINED", "CONFIRMED"].includes(
        String(execution.settlementStatus).toUpperCase(),
      )
    )
      return pending("provider_settlement_pending");
    const observed = await deps.readEvmReceipt(8453, hash);
    if (!observed) return pending("receipt_pending");
    if (failedReceipt(observed.receipt, hash))
      return { state: "revoked", reason: "finalized_receipt_failed" };
    const evidence = parseEvmClobBuyEvidence({
      receipt: observed.receipt,
      txHash: hash,
      owner: row.wallet_address,
      orderHash: identity.orderHash,
      providerOrderId,
      exchangeAddress: identity.exchangeAddress,
      positionContract: deps.limitlessPositionContract,
      tokenId: tokenId.replace(/^limitless:/, ""),
      chainId: 8453,
      instrument,
      purchasedAt: observed.timestamp,
    });
    const facts = evidence && combinePurchaseEvidence([evidence]);
    return facts
      ? { state: "verified", facts }
      : pending("receipt_exact_fill_unavailable");
  }
  // Deprecated venue: no speculative provider field names become verified money.
  return pending("dflow_evidence_unsupported");
}
