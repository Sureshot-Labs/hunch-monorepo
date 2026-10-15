import { hip4BookSchema, hip4Identity, hip4RawUnits } from "@hunch/shared";
import { formatUnits } from "ethers";
import { z } from "zod";
import { hip4OrderPreparationRequestSchema } from "../repos/hip4-order-preparation.js";
import { HIP4_MAINNET_ORDER_UNITS } from "./hip4-order-amounts.js";

/** The ordinary ticket supplies its explicit slippage and debit budget. BUY is
 * quote atoms (8 decimals), SELL is outcome atoms (5), never legacy USDC6. */
export const hip4MarketOrderQuoteRequestSchema =
  hip4OrderPreparationRequestSchema
    .pick({
      requestKey: true,
      marketId: true,
      outcomeSide: true,
      side: true,
      controllerWalletRef: true,
    })
    .extend({
      consentedDebitCapRaw: z
        .string()
        .max(128)
        .regex(/^[1-9]\d*$/u),
      slippageBps: z.number().int().min(0).max(10_000).optional(),
    })
    .strict();
export type Hip4MarketOrderQuoteRequest = z.infer<
  typeof hip4MarketOrderQuoteRequestSchema
>;

/** A price-protected IOC, not FOK and not an executable quote guarantee.
 * Whole lots are sized against the WORST permitted price, not midpoint/VWAP.
 * Current no-builder BUY fees are zero; the shared fee/amount validator MUST
 * still run after this candidate is built. Nonzero/unknown fees must never
 * bypass the user's total cap. No order, reservation or nonce is created here.
 */
export function sizeHip4MarketOrder(input: {
  request: Hip4MarketOrderQuoteRequest & { slippageBps: number };
  book: unknown;
  now: number;
  bookMaxAgeMs: number;
}) {
  const request = hip4MarketOrderQuoteRequestSchema
    .extend({ slippageBps: z.number().int().min(0).max(10_000) })
    .parse(input.request);
  const parsed = hip4BookSchema.safeParse(input.book);
  if (!parsed.success) throw new Error("hip4_market_book_invalid");
  const book = parsed.data;
  const identity = hip4Identity(
    "mainnet",
    Number(request.marketId.split(":").at(-1)),
  );
  const coin = identity.sides[request.outcomeSide === "YES" ? 0 : 1].coin;
  if (book.coin !== coin) throw new Error("hip4_market_book_identity_mismatch");
  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.bookMaxAgeMs) ||
    input.bookMaxAgeMs <= 0 ||
    !Number.isSafeInteger(book.time) ||
    book.time > input.now ||
    book.time + input.bookMaxAgeMs <= input.now
  )
    throw new Error("hip4_market_book_stale");
  const units = HIP4_MAINNET_ORDER_UNITS;
  const priceScale = 10n ** BigInt(units.priceDecimals);
  const quoteScale =
    10n ** BigInt(units.quoteRawDecimals - units.priceDecimals);
  const tokenScale = 10n ** BigInt(units.tokenRawDecimals);
  const levels = book.levels.map((side, sideIndex) => {
    let previous: bigint | null = null;
    return side.map((level) => {
      let price: bigint, quantity: bigint;
      try {
        if (level.px.length > 128 || level.sz.length > 128) throw new Error();
        price = hip4RawUnits(level.px, units.priceDecimals);
        quantity = hip4RawUnits(level.sz, units.quantityDecimals);
      } catch {
        throw new Error("hip4_market_book_invalid");
      }
      if (
        price <= 0n ||
        price >= priceScale ||
        quantity <= 0n ||
        level.n <= 0 ||
        (previous !== null &&
          (sideIndex === 0 ? price >= previous : price <= previous))
      )
        throw new Error("hip4_market_book_invalid");
      previous = price;
      return { price, quantity };
    });
  });
  if (levels[0][0] && levels[1][0] && levels[0][0].price >= levels[1][0].price)
    throw new Error("hip4_market_book_invalid");
  const buy = request.side === "BUY";
  const executable = levels[buy ? 1 : 0];
  const best = executable[0]?.price;
  if (best === undefined) throw new Error("hip4_market_no_liquidity");
  const bpsScale = 10_000n;
  const numerator =
    best * (bpsScale + BigInt(request.slippageBps) * (buy ? 1n : -1n));
  const rounded = buy
    ? numerator / bpsScale
    : (numerator + bpsScale - 1n) / bpsScale;
  // Protocol endpoints aren't executable. Clamping inward cannot worsen consent.
  const limit =
    rounded <= 0n ? 1n : rounded >= priceScale ? priceScale - 1n : rounded;
  const cap = BigInt(request.consentedDebitCapRaw);
  const quantity = buy ? cap / (limit * quoteScale) : cap / tokenScale;
  if (quantity === 0n) throw new Error("hip4_preparation_quantity_below_lot");
  let remaining = quantity;
  let estimatedGross = 0n;
  for (const level of executable) {
    if (buy ? level.price > limit : level.price < limit) break;
    const filled = level.quantity < remaining ? level.quantity : remaining;
    estimatedGross += filled * level.price * quoteScale;
    remaining -= filled;
    if (remaining === 0n) break;
  }
  const preparationRequest = hip4OrderPreparationRequestSchema.parse({
    requestKey: request.requestKey,
    marketId: request.marketId,
    outcomeSide: request.outcomeSide,
    side: request.side,
    controllerWalletRef: request.controllerWalletRef,
    consentedDebitCapRaw: request.consentedDebitCapRaw,
    timeInForce: "Ioc",
    limitPrice: formatUnits(limit, units.priceDecimals),
    quantity: quantity.toString(),
  });
  return {
    preparationRequest,
    executionEstimate: {
      source: "native_l2" as const,
      coin,
      observedAt: new Date(book.time).toISOString(),
      expiresAt: new Date(book.time + input.bookMaxAgeMs).toISOString(),
      slippageBps: request.slippageBps,
      referencePrice: formatUnits(best, units.priceDecimals),
      estimatedFillQuantity: (quantity - remaining).toString(),
      estimatedUnfilledQuantity: remaining.toString(),
      estimatedGrossQuoteRaw: estimatedGross.toString(),
      // Displayed depth is finite and can change before an IOC arrives.
      partialFillPossible: true as const,
      guaranteed: false as const,
    },
  };
}
