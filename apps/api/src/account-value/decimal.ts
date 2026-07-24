const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

type ParsedDecimal = Readonly<{
  coefficient: bigint;
  scale: number;
}>;

function powerOfTen(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) {
    throw new Error(`decimal scale is out of range: ${scale}`);
  }
  return 10n ** BigInt(scale);
}

export function parseUnsignedDecimal(value: string): ParsedDecimal {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error(`invalid unsigned decimal: ${value}`);
  const fraction = match[1] ?? "";
  return {
    coefficient: BigInt(value.replace(".", "")),
    scale: fraction.length,
  };
}

export function formatUnsignedDecimal(
  coefficient: bigint,
  scale: number,
): string {
  if (coefficient < 0n) {
    throw new Error("unsigned decimal coefficient cannot be negative");
  }
  const divisor = powerOfTen(scale);
  const whole = coefficient / divisor;
  if (scale === 0) return whole.toString();
  const fraction = (coefficient % divisor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

export function normalizeUnsignedDecimal(value: string): string {
  const parsed = parseUnsignedDecimal(value);
  return formatUnsignedDecimal(parsed.coefficient, parsed.scale);
}

export function addUnsignedDecimals(values: readonly string[]): string {
  if (values.length === 0) return "0";
  const parsed = values.map(parseUnsignedDecimal);
  const scale = Math.max(...parsed.map((item) => item.scale));
  const total = parsed.reduce(
    (sum, item) => sum + item.coefficient * powerOfTen(scale - item.scale),
    0n,
  );
  return formatUnsignedDecimal(total, scale);
}

export function compareUnsignedDecimals(left: string, right: string): number {
  const leftParsed = parseUnsignedDecimal(left);
  const rightParsed = parseUnsignedDecimal(right);
  const scale = Math.max(leftParsed.scale, rightParsed.scale);
  const leftCoefficient =
    leftParsed.coefficient * powerOfTen(scale - leftParsed.scale);
  const rightCoefficient =
    rightParsed.coefficient * powerOfTen(scale - rightParsed.scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

export function multiplyRawByUnitPrice(inputs: {
  raw: string;
  decimals: number;
  unitPriceUsd: string;
}): string {
  if (!/^(0|[1-9]\d*)$/.test(inputs.raw)) {
    throw new Error(`invalid raw amount: ${inputs.raw}`);
  }
  const price = parseUnsignedDecimal(inputs.unitPriceUsd);
  const coefficient = BigInt(inputs.raw) * price.coefficient;
  return formatUnsignedDecimal(coefficient, inputs.decimals + price.scale);
}

export function multiplyUnsignedDecimals(left: string, right: string): string {
  const leftParsed = parseUnsignedDecimal(left);
  const rightParsed = parseUnsignedDecimal(right);
  return formatUnsignedDecimal(
    leftParsed.coefficient * rightParsed.coefficient,
    leftParsed.scale + rightParsed.scale,
  );
}

export function scaleUnsignedDecimalByRawRatio(inputs: {
  value: string;
  numeratorRaw: string;
  denominatorRaw: string;
}): string {
  const value = parseUnsignedDecimal(inputs.value);
  if (!/^(0|[1-9]\d*)$/.test(inputs.numeratorRaw)) {
    throw new Error(`invalid raw numerator: ${inputs.numeratorRaw}`);
  }
  if (!/^[1-9]\d*$/.test(inputs.denominatorRaw)) {
    throw new Error(`invalid raw denominator: ${inputs.denominatorRaw}`);
  }
  const additionalScale = Math.min(18, 36 - value.scale);
  const scaled =
    (value.coefficient *
      BigInt(inputs.numeratorRaw) *
      powerOfTen(additionalScale)) /
    BigInt(inputs.denominatorRaw);
  return formatUnsignedDecimal(scaled, value.scale + additionalScale);
}

export function subtractUnsignedDecimals(
  minuend: string,
  subtrahend: string,
): string {
  const left = parseUnsignedDecimal(minuend);
  const right = parseUnsignedDecimal(subtrahend);
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(scale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(scale - right.scale);
  if (rightCoefficient > leftCoefficient) {
    throw new Error("unsigned decimal subtraction would be negative");
  }
  return formatUnsignedDecimal(leftCoefficient - rightCoefficient, scale);
}

export function subtractRawFloor(
  raw: string,
  deductions: readonly string[],
): string {
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`invalid raw amount: ${raw}`);
  }
  const totalDeductions = deductions.reduce((sum, value) => {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`invalid raw deduction: ${value}`);
    }
    return sum + BigInt(value);
  }, 0n);
  const available = BigInt(raw) - totalDeductions;
  return (available > 0n ? available : 0n).toString();
}
