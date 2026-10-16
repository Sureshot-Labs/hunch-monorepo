import { formatUnits } from "ethers";
import { z } from "zod";
import { HIP4_MAINNET_ORDER_UNITS } from "./hip4-order-amounts.js";

export const telegramNativeInputMarkerSchema = z
  .object({
    version: z.literal("hip4-input-v1"),
    contextId: z.string().uuid(),
    normalized: z.string().min(1).max(128),
    mode: z.enum(["usd", "shares", "percent", "all"]),
    action: z.enum(["buy", "sell"]),
    marketId: z.string().regex(/^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u),
    outcomeSide: z.enum(["YES", "NO"]),
    authorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type TelegramNativeInputSyntax = Readonly<{
  mode: "usd" | "shares" | "percent" | "all";
  normalized: string;
  scaled: bigint;
}>;

/** Native input is not the legacy USD6/shares6 amount contract. Keep exact
 * string arithmetic; product minimum/maximum remains current runtime policy. */
export function parseTelegramNativeTradeInput(
  action: "buy" | "sell",
  raw: string,
): TelegramNativeInputSyntax | null {
  const text = raw.trim();
  if (text.length > 128) return null;
  if (action === "buy") {
    const match = /^\$?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(text);
    if (!match) return null;
    const cents =
      BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
    if (cents <= 0n) return null;
    return {
      mode: "usd",
      normalized: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
      scaled:
        cents * 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.quoteRawDecimals - 2),
    };
  }
  if (/^all$/iu.test(text))
    return { mode: "all", normalized: "all", scaled: 100_000_000n };
  const percent = /^(100(?:\.0{1,6})?|(?:0|[1-9]\d?)(?:\.\d{1,6})?)%$/u.exec(
    text,
  );
  if (percent) {
    const [whole, fraction = ""] = percent[1].split(".");
    const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    return scaled > 0n && scaled <= 100_000_000n
      ? {
          mode: "percent",
          normalized: `${formatUnits(scaled, 6).replace(/\.0$/u, "")}%`,
          scaled,
        }
      : null;
  }
  if (!/^[1-9]\d*(?:\.0{1,5})?$/u.test(text)) return null;
  const quantity = BigInt(text.split(".")[0]);
  return { mode: "shares", normalized: quantity.toString(), scaled: quantity };
}

/** All/percentage means a portion of currently available stock, rounded DOWN
 * to venue lots. Exact quantities are never silently reduced. Admission still
 * rechecks the same ordinary live capacity and shared holds before submit. */
export function telegramNativeInputDebitCap(
  syntax: TelegramNativeInputSyntax,
  availableRaw?: bigint,
): string | null {
  if (syntax.mode === "usd") return syntax.scaled.toString();
  if (availableRaw === undefined || availableRaw < 0n) return null;
  const scale = 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.tokenRawDecimals);
  const quantity =
    syntax.mode === "shares"
      ? syntax.scaled
      : (availableRaw * syntax.scaled) / 100_000_000n / scale;
  const debit = quantity * scale;
  return debit > 0n && debit <= availableRaw ? debit.toString() : null;
}
