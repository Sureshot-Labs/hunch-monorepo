import { compareSocialDecimal } from "./social-primitives.js";

// Publication eligibility follows the USD cents shown to users. Economic facts,
// snapshots, transfers and accounting retain their original exact quantities.
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
  const [whole, fraction = ""] = actual.split(".");
  const cents =
    BigInt(whole) * 100n +
    BigInt((fraction + "00").slice(0, 2)) +
    ((fraction[2] ?? "0") >= "5" ? 1n : 0n);
  const displayed = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return compareSocialDecimal(displayed, minimum) >= 0;
}
