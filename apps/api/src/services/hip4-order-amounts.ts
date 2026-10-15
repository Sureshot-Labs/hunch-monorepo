import { hip4DecimalSchema, hip4RawUnits } from "@hunch/shared";
import { formatUnits } from "ethers";

/** Mainnet outcome terms, not generic spot rules or configurable defaults.
 * Provenance: docs/hyperliquid-hip4-integration.md sections 18–19 and the pinned
 * original-order-minimum-20261012 fixture. No testnet equivalence is assumed.
 * This module does not enable a venue, estimate fees or authorize submission.
 */
export const HIP4_MAINNET_ORDER_UNITS = Object.freeze({
  version: "hip4-mainnet-outcome-20261012",
  priceDecimals: 5,
  quantityDecimals: 0,
  tokenRawDecimals: 5,
  quoteRawDecimals: 8,
  protocolMinimumBuyNotional: "1",
});

type Decimal = string;
export type Hip4OrderAmountInput = Readonly<{
  environment: "mainnet" | "testnet";
  side: "BUY" | "SELL";
  timeInForce: "Gtc" | "Ioc" | "Alo";
  limitPrice: Decimal;
  quantity: Decimal;
  /** Already resolved current financial policy; never use the read policy or
   * silently replace a missing/invalid policy with a local minimum. */
  policy?: Readonly<{ revision: string; minimumBuyNotionalUsd: Decimal }>;
  /** Verified total fee upper bound in quote atoms (including any builder
   * component once). Null means unknown, not free. Funding fees are separate. */
  feeCapRaw: string | null;
  /** SELL-only current-terms estimate, not a guaranteed lifetime fee cap. When
   * present, proceeds are explicitly estimates and feeCapRaw must be null. */
  sellFeeEstimateAtLimitRaw?: string;
  /** User-consented BUY cash cap or SELL token cap, not an inferred balance. */
  consentedDebitCapRaw: string;
}>;

type AmountFailure =
  | "unsupported_environment"
  | "invalid_policy"
  | "invalid_order_amount"
  | "invalid_order_type"
  | "price_out_of_range"
  | "quantity_below_lot"
  | "fee_unavailable"
  | "buy_below_minimum"
  | "consented_debit_exceeded"
  | "fee_exceeds_proceeds";

function decimal(value: unknown): string | null {
  // Resource/transport envelope, not a product amount threshold.
  return typeof value === "string" &&
    value.length <= 128 &&
    hip4DecimalSchema.safeParse(value).success
    ? value
    : null;
}
function rawInteger(value: unknown): bigint | null {
  return typeof value === "string" &&
    value.length <= 128 &&
    /^(0|[1-9]\d*)$/u.test(value)
    ? BigInt(value)
    : null;
}
function quantize(value: string, decimals: number, up: boolean): bigint {
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return raw + (up && /[1-9]/u.test(fraction.slice(decimals)) ? 1n : 0n);
}
function display(raw: bigint, decimals: number): string {
  const [whole, fraction = ""] = formatUnits(raw, decimals).split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** Exact order arithmetic shared by quote/prepare. Round quantity down; a BUY
 * limit rounds down and SELL rounds up, so normalization cannot worsen the
 * requested limit. IOC must pass its server-calculated execution limit here,
 * not a midpoint. Partial fills and resting remainders must NOT use this new-
 * order floor. No Max/Half/Copy budget or owned quantity is increased here.
 */
export function calculateHip4OrderAmounts(input: Hip4OrderAmountInput) {
  const invalid = (reason: AmountFailure) => ({
    kind: "invalid" as const,
    reason,
  });
  if (input.environment !== "mainnet")
    return invalid("unsupported_environment");
  if (
    !["BUY", "SELL"].includes(input.side) ||
    !["Gtc", "Ioc", "Alo"].includes(input.timeInForce)
  )
    return invalid("invalid_order_type");
  let policyRevision: string | null = null;
  let productMinimum = 0n;
  if (input.side === "BUY") {
    const policy = input.policy;
    const policyMinimum = decimal(policy?.minimumBuyNotionalUsd);
    if (
      !policyMinimum ||
      !/[1-9]/u.test(policyMinimum) ||
      typeof policy?.revision !== "string" ||
      !policy.revision.trim()
    )
      return invalid("invalid_policy");
    policyRevision = policy.revision;
    // A sub-atom policy fraction rounds UP and cannot lower the BUY floor.
    productMinimum = quantize(
      policyMinimum,
      HIP4_MAINNET_ORDER_UNITS.quoteRawDecimals,
      true,
    );
  }
  const priceInput = decimal(input.limitPrice),
    quantityInput = decimal(input.quantity);
  const cap = rawInteger(input.consentedDebitCapRaw);
  if (!priceInput || !quantityInput || cap === null)
    return invalid("invalid_order_amount");
  if (priceInput.split(".")[0] !== "0" || !/[1-9]/u.test(priceInput))
    return invalid("price_out_of_range");
  const units = HIP4_MAINNET_ORDER_UNITS;
  const price = quantize(
    priceInput,
    units.priceDecimals,
    input.side === "SELL",
  );
  if (price <= 0n || price >= 10n ** BigInt(units.priceDecimals))
    return invalid("price_out_of_range");
  const quantity = quantize(quantityInput, units.quantityDecimals, false);
  if (quantity === 0n) return invalid("quantity_below_lot");
  const estimatedSell = input.sellFeeEstimateAtLimitRaw !== undefined;
  if (estimatedSell && (input.side !== "SELL" || input.feeCapRaw !== null))
    return invalid("invalid_order_amount");
  const feeCap = estimatedSell
    ? rawInteger(input.sellFeeEstimateAtLimitRaw)
    : input.feeCapRaw === null
      ? null
      : rawInteger(input.feeCapRaw);
  if (feeCap === null) return invalid("fee_unavailable");
  const unitQuoteRaw =
    price * 10n ** BigInt(units.quoteRawDecimals - units.priceDecimals);
  const grossQuoteRaw = quantity * unitQuoteRaw;
  const tokenRaw = quantity * 10n ** BigInt(units.tokenRawDecimals);
  const protocolMinimum = hip4RawUnits(
    units.protocolMinimumBuyNotional,
    units.quoteRawDecimals,
  );
  const effectiveMinimum =
    productMinimum > protocolMinimum ? productMinimum : protocolMinimum;
  const minimumQuantity = (effectiveMinimum + unitQuoteRaw - 1n) / unitQuoteRaw;
  const debitCapRaw = input.side === "BUY" ? grossQuoteRaw + feeCap : tokenRaw;
  const issue: AmountFailure | null =
    input.side === "BUY" && grossQuoteRaw < effectiveMinimum
      ? "buy_below_minimum"
      : debitCapRaw > cap
        ? "consented_debit_exceeded"
        : input.side === "SELL" && feeCap > grossQuoteRaw
          ? "fee_exceeds_proceeds"
          : null;
  return {
    kind: "calculated" as const,
    validation: { valid: issue === null, reason: issue },
    protocolVersion: units.version,
    policyRevision,
    side: input.side,
    timeInForce: input.timeInForce,
    limitPrice: display(price, units.priceDecimals),
    quantity: quantity.toString(),
    tokenRaw: tokenRaw.toString(),
    grossQuoteRaw: grossQuoteRaw.toString(),
    feeCapRaw: estimatedSell ? null : feeCap.toString(),
    sellFeeEstimateAtLimitRaw: estimatedSell ? feeCap.toString() : null,
    debitAsset:
      input.side === "BUY" ? ("quote" as const) : ("outcome" as const),
    debitCapRaw: debitCapRaw.toString(),
    // Lower bound for a FULL fill at this limit, not guaranteed proceeds from
    // a partially filled IOC/GTC order. Reconciliation uses actual fills.
    minimumNetProceedsRaw:
      !estimatedSell && input.side === "SELL" && feeCap <= grossQuoteRaw
        ? (grossQuoteRaw - feeCap).toString()
        : null,
    estimatedNetProceedsAtLimitRaw:
      estimatedSell && feeCap <= grossQuoteRaw
        ? (grossQuoteRaw - feeCap).toString()
        : null,
    minimum:
      input.side === "BUY"
        ? {
            protocolQuoteRaw: protocolMinimum.toString(),
            productQuoteRaw: productMinimum.toString(),
            effectiveQuoteRaw: effectiveMinimum.toString(),
            quantity: minimumQuantity.toString(),
            normalizedNotionalRaw: (minimumQuantity * unitQuoteRaw).toString(),
          }
        : null,
    // Native SELL minimum/exemption is not inferred from the BUY floor or the
    // reduceOnly flag. Venue acceptance is still required for sub-$1 closes.
    sellMinimumKnown: false as const,
  };
}
