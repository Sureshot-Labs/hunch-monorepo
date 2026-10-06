import { tx, type Pool } from "@hunch/infra";
import { AuthService } from "../../auth.js";
import { env } from "../../env.js";
import { isRecord } from "../../lib/type-guards.js";
import { parsePolymarketAssetContext } from "@hunch/shared";
import {
  loadPolymarketHoldingLedgers,
  selectPolymarketSyncedOrderContext,
} from "../../services/polymarket-asset-context.js";
import { storeOrderInTransaction } from "../../repos/orders-repo.js";
import {
  fetchPolymarketOrderByHash,
  type PolymarketOpenOrder,
} from "../../services/polymarket-clob-l2.js";
import {
  attachRecoveredPolymarketAttemptOrderInTransaction,
  claimAmbiguousPolymarketTradeAttemptsForReconciliation,
  type FundingTradeAttempt,
} from "../persistence/funding-trade-attempt-repository.js";

type Scope = {
  owner: string;
  signer: string;
  tokenId: string;
  spendRaw: string;
};

/** Repair metadata only from the immutable funding snapshot or canonical
 * ledger binding. Raw CLOB JSON alone cannot identify a V2 position ledger. */
export async function buildOrphanPolymarketOrderPayload(input: {
  db: Pool;
  marketId: string;
  marketSnapshot: Record<string, unknown>;
  order: PolymarketOpenOrder;
  payload: unknown;
}): Promise<unknown> {
  const frozen = input.marketSnapshot.positionAssetContext;
  const context =
    frozen != null
      ? parsePolymarketAssetContext(frozen)
      : input.order.assetId
        ? selectPolymarketSyncedOrderContext(
            (
              await loadPolymarketHoldingLedgers(input.db, [
                input.order.assetId,
              ])
            ).map((ledger) => ({
              ...ledger,
              tokenContexts: new Map(
                [...ledger.tokenContexts].filter(
                  ([, candidate]) =>
                    !candidate || candidate.marketId === input.marketId,
                ),
              ),
            })),
            input.order.assetId,
            input.order.market,
          )
        : null;
  if (
    (frozen != null && !context) ||
    (context &&
      (context.marketId !== input.marketId ||
        context.assetId !== input.order.assetId ||
        (input.order.market != null &&
          context.conditionId.toLowerCase() !==
            input.order.market.toLowerCase())))
  )
    throw new Error(
      "Recovered Polymarket order conflicts with its frozen ledger scope",
    );
  return context
    ? {
        ...(isRecord(input.payload)
          ? input.payload
          : { _hunchUpstream: input.payload }),
        assetContext: context,
      }
    : input.payload;
}
export function matchesOrphanPolymarketOrder(
  hash: string,
  scope: Scope,
  order: PolymarketOpenOrder,
): boolean {
  if (
    order.id?.toLowerCase() !== hash.toLowerCase() ||
    order.makerAddress?.toLowerCase() !== scope.owner.toLowerCase() ||
    order.assetId !== scope.tokenId ||
    order.side?.toUpperCase() !== "BUY"
  )
    return false;
  const decimalRaw = (value: string | null) => {
    const parts = value?.match(/^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/);
    return parts?.[1]
      ? BigInt(parts[1]) * 1000000n + BigInt((parts[2] ?? "").padEnd(6, "0"))
      : null;
  };
  const price = decimalRaw(order.price),
    size = decimalRaw(order.originalSize);
  return (
    price !== null &&
    size !== null &&
    price > 0n &&
    price <= 1000000n &&
    size > 0n &&
    price * size <= BigInt(scope.spendRaw) * 1000000n
  );
}

export async function reconcileOrphanPolymarketAttempts(
  db: Pool,
): Promise<{ claimed: number; found: number; unknown: number }> {
  const attempts =
    await claimAmbiguousPolymarketTradeAttemptsForReconciliation(db);
  let found = 0;
  for (const attempt of attempts) {
    try {
      if (await reconcileOne(db, attempt)) found++;
    } catch {
      // No provider error text/credentials in logs; the bounded lease requeues.
    }
  }
  return { claimed: attempts.length, found, unknown: attempts.length - found };
}

async function reconcileOne(
  db: Pool,
  attempt: FundingTradeAttempt,
): Promise<boolean> {
  const result = await db.query<{
    destination_target_snapshot: unknown;
    wallet_execution_snapshot: unknown;
    market_context_snapshot: unknown;
  }>(
    `select destination_target_snapshot, wallet_execution_snapshot, market_context_snapshot from funding_operations where id = $1 and user_id = $2`,
    [attempt.operationId, attempt.userId],
  );
  const row = result.rows[0];
  const target = row?.destination_target_snapshot;
  const execution = row?.wallet_execution_snapshot;
  const market = row?.market_context_snapshot;
  if (
    !isRecord(target) ||
    !isRecord(target.location) ||
    !isRecord(target.location.details) ||
    !isRecord(execution) ||
    !isRecord(market) ||
    typeof target.location.details.address !== "string" ||
    typeof execution.address !== "string" ||
    typeof market.marketContextId !== "string" ||
    market.marketContextId !== attempt.consumerIntent.marketContextId ||
    !attempt.externalReference
  )
    return false;
  const scope = {
    owner: target.location.details.address,
    signer: execution.address,
    tokenId: market.marketContextId,
    spendRaw: attempt.consumerIntent.spend.raw,
  };
  const creds = await AuthService.getVenueCredentials(
    attempt.userId,
    "polymarket",
    scope.signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) return false;
  const response = await fetchPolymarketOrderByHash({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 5000,
    address: scope.signer,
    creds: {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiPassphrase: creds.apiPassphrase,
    },
    orderHash: attempt.externalReference,
  });
  if (
    !response.ok ||
    !response.order ||
    !matchesOrphanPolymarketOrder(
      attempt.externalReference,
      scope,
      response.order,
    )
  )
    return false;
  const order = response.order,
    reference = attempt.externalReference;
  const orderPayload = await buildOrphanPolymarketOrderPayload({
    db,
    marketId: attempt.marketId,
    marketSnapshot: market,
    order,
    payload: response.payload,
  });
  // Even a historical matched CLOB status does not manufacture fills, fees,
  // or token balances. Existing canonical fill sync owns those projections.
  const status = ["live", "open"].includes(
    response.order.status?.toLowerCase() ?? "",
  )
    ? "live"
    : "unconfirmed";
  await tx(db, async (client) => {
    const stored = await storeOrderInTransaction(client, {
      fundingRecoveryMode: "explicit_only",
      userId: attempt.userId,
      walletAddress: scope.owner,
      signerAddress: scope.signer,
      venue: "polymarket",
      venueOrderId: reference,
      orderHash: reference,
      tokenId: scope.tokenId,
      side: "BUY",
      orderType: ["FOK", "FAK", "GTC", "GTD"].includes(order.type ?? "")
        ? (order.type as "FOK" | "FAK" | "GTC" | "GTD")
        : null,
      price: Number(order.price),
      size: Number(order.originalSize),
      status,
      errorMessage: null,
      rawError: null,
      orderPayload,
      postedAt: attempt.claimedAt,
    });
    await attachRecoveredPolymarketAttemptOrderInTransaction(client, {
      attempt,
      orderId: stored.order.id,
    });
  });
  return true;
}
