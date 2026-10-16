import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { hip4Identity, hip4RawUnits } from "@hunch/shared";
import { quoteHip4OrderWithCurrentContext } from "../../services/hip4-order-runtime.js";
import type { FundingIntent } from "../domain/types.js";

type LimitQuote = typeof quoteHip4OrderWithCurrentContext;
type Quote = (
  pool: Pool,
  input: Parameters<LimitQuote>[1],
) => Promise<Pick<Awaited<ReturnType<LimitQuote>>, "amounts" | "expiresAfter">>;

/** Resting limits use the ordinary exact limit quote, not IOC sizing or L2
 * depth. This only advises a smaller input; it never reserves or submits. */
export async function checkHip4LimitBuyBudget(
  pool: Pool,
  input: {
    userId: string;
    controllerWalletRef: string;
    marketId: string;
    tokenId: string;
    budgetRaw: bigint;
    deadlineMs: number;
    limitBuy: NonNullable<FundingIntent["limitBuy"]>;
  },
  quote: Quote = quoteHip4OrderWithCurrentContext,
) {
  try {
    const { limitBuy } = input;
    const match = /^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u.exec(
      input.marketId,
    );
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !/^[1-9]\d*$/u.test(limitBuy.quantity) ||
      limitBuy.quantity.length > 128 ||
      !/^0\.\d{1,5}$/u.test(limitBuy.limitPrice) ||
      !["Gtc", "Alo"].includes(limitBuy.timeInForce) ||
      !Number.isFinite(input.deadlineMs) ||
      Date.now() >= input.deadlineMs
    )
      return null;
    const identity = hip4Identity("mainnet", Number(match[1]));
    const tokenId = input.tokenId.startsWith("hyperliquid:")
      ? input.tokenId
      : `hyperliquid:${input.tokenId}`;
    const outcome = identity.sides.find((side) => side.tokenId === tokenId);
    if (!outcome) return null;
    const unitRaw = hip4RawUnits(limitBuy.limitPrice, 8);
    if (unitRaw <= 0n || unitRaw >= 100_000_000n) return null;
    const original = BigInt(limitBuy.quantity);
    const byBudget = input.budgetRaw / unitRaw;
    const quantity = byBudget < original ? byBudget : original - 1n;
    if (quantity <= 0n) return undefined;
    const result = await quote(pool, {
      userId: input.userId,
      actor: "web_app",
      request: {
        requestKey: randomUUID(),
        controllerWalletRef: input.controllerWalletRef,
        marketId: input.marketId,
        outcomeSide: outcome.sideIndex === 0 ? "YES" : "NO",
        side: "BUY",
        timeInForce: limitBuy.timeInForce,
        limitPrice: limitBuy.limitPrice,
        quantity: quantity.toString(),
        consentedDebitCapRaw: input.budgetRaw.toString(),
      },
    });
    const { amounts } = result;
    const requiredRaw = BigInt(amounts.debitCapRaw);
    if (
      amounts.quantity !== quantity.toString() ||
      amounts.side !== "BUY" ||
      amounts.timeInForce !== limitBuy.timeInForce ||
      hip4RawUnits(amounts.limitPrice, 8) !== unitRaw ||
      BigInt(amounts.grossQuoteRaw) !== quantity * unitRaw ||
      amounts.feeCapRaw === null ||
      requiredRaw !== quantity * unitRaw + BigInt(amounts.feeCapRaw) ||
      requiredRaw <= 0n ||
      requiredRaw > input.budgetRaw ||
      !Number.isFinite(result.expiresAfter) ||
      result.expiresAfter <= Date.now() ||
      Date.now() >= input.deadlineMs
    )
      return null;
    return {
      quantity: quantity.toString(),
      requiredRaw,
      expiresAtMs: result.expiresAfter,
    };
  } catch (error) {
    return error instanceof Error &&
      [
        "hip4_preparation_quantity_below_lot",
        "hip4_preparation_buy_below_minimum",
      ].includes(error.message)
      ? undefined
      : null;
  }
}
