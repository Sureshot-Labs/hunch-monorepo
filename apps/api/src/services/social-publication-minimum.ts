import {
  compareSocialDecimal,
  multiplySocialDecimal,
} from "./social-primitives.js";

// Publication admission allows a 2% execution tolerance against the configured
// minimum. Economic facts, shares, transfers and accounting remain exact.
export function meetsPublicationMinimum(
  actual: string,
  minimum: string,
): boolean {
  if (
    compareSocialDecimal(actual, "0") <= 0 ||
    compareSocialDecimal(minimum, "0") <= 0
  )
    return false;
  const toleratedMinimum = multiplySocialDecimal(minimum, "0.98");
  return compareSocialDecimal(actual, toleratedMinimum) >= 0;
}
