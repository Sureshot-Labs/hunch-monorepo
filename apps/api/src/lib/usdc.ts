const MICRO_USDC_SCALE = 6;
const MICRO_USDC_FACTOR = 10n ** BigInt(MICRO_USDC_SCALE);

function normalizeDecimalString(value: string): string {
  return value.trim().replace(/_/g, "");
}

function splitDecimal(value: string): { whole: string; fraction: string } | null {
  const normalized = normalizeDecimalString(value);
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parts = normalized.split(".");
  return {
    whole: parts[0] ?? "0",
    fraction: parts[1] ?? "",
  };
}

export function parseUsdcToMicro(input: string): bigint | null {
  const parsed = splitDecimal(input);
  if (!parsed) return null;
  if (parsed.fraction.length > MICRO_USDC_SCALE) return null;

  const whole = BigInt(parsed.whole);
  const paddedFraction = (parsed.fraction + "0".repeat(MICRO_USDC_SCALE)).slice(
    0,
    MICRO_USDC_SCALE,
  );
  const fraction = BigInt(paddedFraction || "0");
  return whole * MICRO_USDC_FACTOR + fraction;
}

export function parseUsdcToMicroFloor(input: string): bigint | null {
  const parsed = splitDecimal(input);
  if (!parsed) return null;

  const whole = BigInt(parsed.whole);
  const paddedFraction = (parsed.fraction + "0".repeat(MICRO_USDC_SCALE)).slice(
    0,
    MICRO_USDC_SCALE,
  );
  const fraction = BigInt(paddedFraction || "0");
  return whole * MICRO_USDC_FACTOR + fraction;
}

export function usdcMicroToDecimalString(value: bigint): string {
  if (value < 0n) throw new Error("USDC value cannot be negative");
  const whole = value / MICRO_USDC_FACTOR;
  const fraction = value % MICRO_USDC_FACTOR;
  return `${whole.toString()}.${fraction.toString().padStart(MICRO_USDC_SCALE, "0")}`;
}

export function usdcMicroFromUnsafeNumber(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const micros = Math.floor(value * Number(MICRO_USDC_FACTOR));
  return BigInt(Math.max(0, micros));
}

export function usdcDecimalStringHasValidScale(input: string): boolean {
  const parsed = splitDecimal(input);
  if (!parsed) return false;
  return parsed.fraction.length <= MICRO_USDC_SCALE;
}

export const USDC_SCALE = MICRO_USDC_SCALE;
