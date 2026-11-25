import type { Pool } from "@hunch/infra";
import { env } from "../../env.js";
import { normalizeLimitlessRawTokenId } from "../../lib/limitless-token.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  findTradeMarketById,
  isOrderable,
} from "../../services/api-trading-market-repo.js";
import { quoteLimitlessClobMarket } from "../../services/limitless-clob-quote.js";
import { fetchLimitlessClobMarket } from "../../services/limitless-clob-fee-runtime.js";
import {
  maxLimitlessPrincipalRaw,
  readLimitlessBuyReservePolicy,
  standardLimitlessBuyTotalRaw,
} from "../../services/limitless-collateral-buy.js";
import { isLimitlessAmmMarketMetadata } from "../../services/limitless-market-mode.js";
import { quoteLimitlessAmmTrade } from "../../services/limitless-trading-service.js";

/** Read-only advice. On the collateral venue the funding budget must
 * cover both the Buy principal and the standard reserve.
 */
export async function checkLimitlessBuyBudget(
  pool: Pool,
  input: {
    marketId: string;
    tokenId: string;
    budgetRaw: bigint;
    maxPrincipalRaw?: bigint;
  },
  dependencies = {
    findMarket: findTradeMarketById,
    fetchMarket: fetchLimitlessClobMarket,
    quoteClob: quoteLimitlessClobMarket,
    quoteAmm: quoteLimitlessAmmTrade,
  },
) {
  const principalCap = (raw: bigint) => {
    const capped =
      input.maxPrincipalRaw != null && raw > input.maxPrincipalRaw
        ? input.maxPrincipalRaw
        : raw;
    return (capped / 10_000n) * 10_000n;
  };
  if (principalCap(input.budgetRaw) < 10_000n) return undefined;
  const market = await dependencies.findMarket(pool, input.marketId);
  const token = normalizeLimitlessRawTokenId(input.tokenId);
  if (!market || market.venue !== "limitless" || !isOrderable(market) || !token)
    return null;
  const outcomeIndex = [market.token_yes, market.token_no]
    .map(normalizeLimitlessRawTokenId)
    .indexOf(token);
  if (outcomeIndex < 0) return null;
  if (isLimitlessAmmMarketMetadata(market.metadata)) {
    const amountRaw = principalCap(input.budgetRaw);
    const metadata = isRecord(market.metadata) ? market.metadata : {};
    const address = [
      metadata.address,
      metadata.marketAddress,
      metadata.market_address,
      metadata.ammAddress,
      metadata.amm_address,
    ].find(
      (value): value is string =>
        typeof value === "string" && /^0x[\da-fA-F]{40}$/.test(value),
    );
    if (!address) return null;
    const quote = await dependencies.quoteAmm({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      marketAddress: address,
      outcomeIndex,
      side: "BUY",
      amountUsdRaw: amountRaw,
    });
    if (!quote.sharesRaw || BigInt(quote.sharesRaw) <= 0n) return undefined;
    return {
      amountRaw,
      requiredRaw: amountRaw,
      expiresAtMs: Date.now() + 5_000,
    };
  }
  if (!market.slug) return null;
  let reserveBps: bigint | null;
  try {
    const payload = await dependencies.fetchMarket(market.slug, {
      timeoutMs: 1_500,
    });
    ({ reserveBps } = readLimitlessBuyReservePolicy(payload, market.slug));
  } catch {
    return null;
  }
  if (reserveBps === null) return null;
  const amountRaw = principalCap(
    maxLimitlessPrincipalRaw(input.budgetRaw, reserveBps),
  );
  if (amountRaw < 10_000n) return undefined;
  if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const quote = await dependencies.quoteClob({
    slug: market.slug,
    tokenId: token,
    side: "BUY",
    amountUsd: Number(amountRaw) / 1_000_000,
  });
  if (quote.status !== "ready")
    return quote.status === "unavailable" ? null : undefined;
  if (!Number.isFinite(quote.executableShares) || quote.executableShares <= 0)
    return null;
  // This is market BUY/FOK advice. The book's minimum applies to resting
  // limit orders, not an executable exact-input market quote.
  return {
    amountRaw,
    requiredRaw: standardLimitlessBuyTotalRaw(amountRaw, reserveBps),
    expiresAtMs: Date.parse(quote.expiresAt),
  };
}
