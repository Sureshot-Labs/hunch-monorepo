import type { Pool } from "@hunch/infra";
import { TypedDataEncoder } from "ethers";
import { parsePolymarketAssetContext } from "@hunch/shared";
import { isRecord } from "../lib/type-guards.js";
import type {
  ClaimedPurchase,
  PurchaseObservation,
  VerifiedPurchaseEvidence,
} from "./verified-buy.js";
import { EvidenceBudgetExhausted } from "./verified-buy.js";
import {
  combinePurchaseEvidence,
  parseEvmClobBuyEvidence,
  parseEvmAmmBuyEvidence,
} from "./verified-buy-evidence.js";
import type { VerifiedBuyFacts } from "../schemas/social-trade.js";
import {
  parseLimitlessOrderResult,
  isLimitlessTerminalRejectedStatus,
} from "./limitless-order-result.js";
import {
  LIMITLESS_CLOB_ORDER_TYPES,
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
} from "./limitless-order-contract.js";
type Db = Pick<Pool, "query">;
export type VerifiedBuyObserverDependencies = {
  maxEvidenceItems: number;
  assertEvidenceBudget?: (minimumReads: number) => void;
  limitlessPositionContract: string;
  limitlessExchangeAddress: string;
  solanaCollateralMint: string;
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
  }) => Promise<
    Array<{ provider_tx_hash: string | null; provider_status: string | null }>
  >;
};

const pending = (reason: string): PurchaseObservation => ({
  state: "pending",
  reason,
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
          purchase_row.token_id, purchase_row.side, purchase_row.order_payload,
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
          token_row.token_id, purchase_row.side, null::jsonb as order_payload, null::text as client_order_id,
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
  const instrument: VerifiedBuyFacts["instrument"] = {
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
    if (!context || !row.order_hash)
      return pending("frozen_order_binding_missing");
    const fills = await db.query<{
      provider_tx_hash: string | null;
      provider_status: string | null;
    }>(
      `
        select distinct provider_tx_hash, provider_status from order_fills where order_id = $1
        order by provider_tx_hash limit $2`,
      [row.id, deps.maxEvidenceItems + 1],
    );
    if (
      !fills.rows.length ||
      fills.rows.some(
        (fill) =>
          !fill.provider_tx_hash ||
          fill.provider_status?.toUpperCase() !== "CONFIRMED",
      )
    ) {
      fills.rows = await deps.readPolymarketFills({
        userId: row.user_id,
        owner: row.wallet_address,
        signer: row.signer_address ?? row.wallet_address,
        orderHash: row.order_hash,
        tokenId,
      });
    }
    if (fills.rows.length > deps.maxEvidenceItems)
      throw new EvidenceBudgetExhausted(
        fills.rows.length,
        deps.maxEvidenceItems,
      );
    if (fills.rows.length === 1 && fills.rows[0]?.provider_status === "NO_FILL")
      return { state: "revoked", reason: "provider_terminal_zero_fill" };
    if (
      fills.rows.some(
        (fill) => fill.provider_status?.toUpperCase() === "FAILED",
      )
    )
      return { state: "revoked", reason: "provider_fill_failed" };
    if (!fills.rows.length || fills.rows.some((fill) => !fill.provider_tx_hash))
      return pending("fill_transaction_identity_missing");
    if (
      fills.rows.some(
        (fill) => fill.provider_status?.toUpperCase() !== "CONFIRMED",
      )
    )
      return pending("provider_settlement_pending");
    const parts: VerifiedPurchaseEvidence[] = [];
    const hashes = new Set(
      fills.rows.flatMap((fill) =>
        fill.provider_tx_hash ? [fill.provider_tx_hash] : [],
      ),
    );
    deps.assertEvidenceBudget?.(hashes.size * 3);
    for (const hash of hashes) {
      const observed = await deps.readEvmReceipt(context.chainId, hash);
      if (!observed) return pending("receipt_pending");
      if (failedReceipt(observed.receipt, hash))
        return { state: "revoked", reason: "finalized_receipt_failed" };
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
      if (!evidence) return pending("receipt_exact_fill_unavailable");
      parts.push(evidence);
    }
    const facts = combinePurchaseEvidence(parts);
    return facts
      ? { state: "verified", facts }
      : pending("evidence_identity_conflict");
  }
  if (row.venue === "limitless") {
    const ammMatch = row.venue_order_id?.match(/^amm:(0x[0-9a-f]{64}):/i);
    if (ammMatch?.[1]) {
      const marketAddress =
        text(root(row.market_metadata).marketAddress) ??
        text(payload.marketAddress);
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
    let orderHash = text(order.orderHash ?? order.hash);
    if (!orderHash) {
      try {
        orderHash = TypedDataEncoder.hash(
          {
            name: LIMITLESS_CLOB_EIP712_NAME,
            version: LIMITLESS_CLOB_EIP712_VERSION,
            chainId: 8453,
            verifyingContract: deps.limitlessExchangeAddress,
          },
          {
            Order: LIMITLESS_CLOB_ORDER_TYPES.Order.map((field) => ({
              ...field,
            })),
          },
          order,
        );
      } catch {
        return pending("signed_order_identity_missing");
      }
    }
    if (
      !hash ||
      !orderHash ||
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
      orderHash,
      providerOrderId,
      exchangeAddress: deps.limitlessExchangeAddress,
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
