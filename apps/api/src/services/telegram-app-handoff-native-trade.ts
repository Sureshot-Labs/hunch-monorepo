import { hip4Identity, hip4RawUnits } from "@hunch/shared";
import { z } from "zod";
import { HIP4_MAINNET_ORDER_UNITS } from "./hip4-order-amounts.js";

const raw = z
  .string()
  .max(128)
  .regex(/^[1-9]\d*$/u);
/** Economic authorization only. Book/fee/signing expiries belong to ordinary
 * fresh native prepare, not to a funding route which can take longer. The
 * connected consumer must enforce the shared intent/funding lifecycle at its
 * durable boundary; initial token TTL is not a new committed-funding expiry.
 * IOC can partially fill or not fill; no full-order receive floor is promised.
 */
export const telegramAppHandoffNativeTradeSchema = z
  .object({
    version: z.literal("hip4-ioc-v1"),
    environment: z.literal("mainnet"),
    marketId: z.string().regex(/^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u),
    outcomeTokenId: z.string(),
    outcomeSide: z.enum(["YES", "NO"]),
    controllerWalletRef: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    side: z.enum(["BUY", "SELL"]),
    timeInForce: z.literal("Ioc"),
    quantity: raw,
    limitPrice: z
      .string()
      .max(128)
      .regex(/^0\.\d+$/u),
    consentedDebitCapRaw: raw,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const identity = hip4Identity(
        "mainnet",
        Number(value.marketId.split(":").at(-1)),
      );
      const token = identity.sides[value.outcomeSide === "YES" ? 0 : 1];
      const price = hip4RawUnits(
        value.limitPrice,
        HIP4_MAINNET_ORDER_UNITS.priceDecimals,
      );
      const quantity = BigInt(value.quantity);
      const required =
        value.side === "BUY"
          ? quantity *
            price *
            10n **
              BigInt(
                HIP4_MAINNET_ORDER_UNITS.quoteRawDecimals -
                  HIP4_MAINNET_ORDER_UNITS.priceDecimals,
              )
          : quantity * 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.tokenRawDecimals);
      if (
        identity.marketId !== value.marketId ||
        token.tokenId !== value.outcomeTokenId ||
        price <= 0n ||
        price >= 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.priceDecimals) ||
        required > BigInt(value.consentedDebitCapRaw)
      )
        throw new Error("native scope mismatch");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "invalid native IOC economic scope",
      });
    }
  });
export type TelegramAppHandoffNativeTrade = z.infer<
  typeof telegramAppHandoffNativeTradeSchema
>;

/** Shared native branch of the versioned plan. Funding-specific source and
 * destination bounds are still parsed by the ordinary v2 materializer.
 */
export function parseTelegramAppHandoffNativePlan(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return null;
  const plan = snapshot as Record<string, unknown>;
  if (
    plan.version !== 2 ||
    plan.executionContractVersion !== 2 ||
    (plan.kind !== "direct_trade" && plan.kind !== "funding") ||
    !plan.trade ||
    typeof plan.trade !== "object" ||
    Array.isArray(plan.trade)
  )
    return null;
  const trade = plan.trade as Record<string, unknown>;
  const nativeTrade = parseTelegramAppHandoffNativeTrade(trade);
  if (!nativeTrade || (plan.kind === "funding" && nativeTrade.side !== "BUY"))
    return null;
  return { kind: plan.kind, trade, nativeTrade };
}

/** Public plan and persistence parse the SAME native tuple. Legacy trades
 * must not carry one, and a native trade must not fall back to USD6/FOK.
 */
export function parseTelegramAppHandoffNativeTrade(
  trade: Record<string, unknown>,
): TelegramAppHandoffNativeTrade | null {
  if (trade.venue !== "hyperliquid") return null;
  const parsed = telegramAppHandoffNativeTradeSchema.safeParse(
    trade.nativeTrade,
  );
  if (!parsed.success) return null;
  const value = parsed.data;
  if (
    trade.marketId !== value.marketId ||
    trade.outcomeTokenId !== value.outcomeTokenId ||
    trade.side !== value.outcomeSide ||
    trade.action !== value.side.toLowerCase() ||
    trade.assetContext != null ||
    // Native exact IOC terms have no legacy FOK/full-fill or USD6 bounds.
    // Carrying both would give a consumer two contradictory authorizations.
    [
      "amountUsd",
      "maxSpendUsd",
      "sharesRaw",
      "minimumReceiveRaw",
      "minReceiveShares",
      "maxSlippageBps",
      "strictSlippage",
    ].some((key) => trade[key] != null)
  )
    return null;
  return value;
}

export function sameTelegramAppHandoffNativeTrade(
  left: TelegramAppHandoffNativeTrade,
  right: TelegramAppHandoffNativeTrade,
): boolean {
  return (
    left.version === right.version &&
    left.environment === right.environment &&
    left.marketId === right.marketId &&
    left.outcomeTokenId === right.outcomeTokenId &&
    left.outcomeSide === right.outcomeSide &&
    left.controllerWalletRef === right.controllerWalletRef &&
    left.side === right.side &&
    left.timeInForce === right.timeInForce &&
    left.quantity === right.quantity &&
    hip4RawUnits(left.limitPrice, HIP4_MAINNET_ORDER_UNITS.priceDecimals) ===
      hip4RawUnits(right.limitPrice, HIP4_MAINNET_ORDER_UNITS.priceDecimals) &&
    left.consentedDebitCapRaw === right.consentedDebitCapRaw
  );
}

export function telegramAppHandoffNativeRequestedAmounts(
  trade: TelegramAppHandoffNativeTrade,
) {
  const tokenRaw =
    BigInt(trade.quantity) *
    10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.tokenRawDecimals);
  const grossQuoteRaw =
    BigInt(trade.quantity) *
    hip4RawUnits(trade.limitPrice, HIP4_MAINNET_ORDER_UNITS.priceDecimals) *
    10n **
      BigInt(
        HIP4_MAINNET_ORDER_UNITS.quoteRawDecimals -
          HIP4_MAINNET_ORDER_UNITS.priceDecimals,
      );
  return { tokenRaw, grossQuoteRaw };
}
