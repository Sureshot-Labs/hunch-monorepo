import {
  compareSocialDecimal,
  subtractSocialDecimal,
} from "./social-primitives.js";

// One USD atom of six-decimal settlement collateral. This only admits the
// publication minimum; executed quantities, snapshots and accounting stay exact.
const PUBLICATION_ROUNDING_USD = "0.000001";

export function meetsPublicationMinimum(
  actual: string,
  minimum: string,
): boolean {
  if (
    compareSocialDecimal(actual, "0") <= 0 ||
    compareSocialDecimal(minimum, "0") <= 0
  )
    return false;
  if (compareSocialDecimal(actual, minimum) >= 0) return true;
  return (
    compareSocialDecimal(
      subtractSocialDecimal(minimum, actual),
      PUBLICATION_ROUNDING_USD,
    ) <= 0
  );
}
