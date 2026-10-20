import {
  hip4BackgroundRequestWeightLimit,
  hip4BackgroundRepairWeightLimit,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import { Hip4ReadError } from "./hip4-client.js";
import type { Hip4RollingInfoAdmissionReceipt } from "./hip4-repository.js";

// Reserve before observing role/mode: a retained Standard snapshot is not proof
// that this refresh will not discover the more expensive default spot mode.
// Default: role60 + mode20 + legacy20 + borrow20 + metadata20 + spot2
//   + mode20 + legacy20 =182. Standard spot/perps uses124 of the same bound.
export const HIP4_ACCOUNT_CASH_REQUEST_WEIGHT = 182;
const REQUEST_BUDGET_WINDOW_MS = 60_000;

function budgetLimits(policy: Hip4ReadPolicy, background: boolean) {
  return {
    total: policy.requestWeightPerMinute,
    repair: background ? hip4BackgroundRepairWeightLimit(policy) : null,
    background: background ? hip4BackgroundRequestWeightLimit(policy) : null,
  };
}

/** One bounded reservation for the mandatory account cash phase only. The
 * individual clients receive boolean admission, never this aggregate receipt:
 * per-response accounting must not settle the whole phase prematurely. */
export async function reserveHip4AccountCashBudget(input: {
  background: boolean;
  recheck: () => Promise<Hip4ReadPolicy>;
  reserve: (
    weight: number,
    policy: Hip4ReadPolicy,
  ) => Promise<false | Hip4RollingInfoAdmissionReceipt>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const policy = await input.recheck();
  const limits = budgetLimits(policy, input.background);
  // Start before reserve: time spent waiting on its DB row cannot extend the
  // rolling admission's lifetime or authorize late, no-longer-reserved IO.
  const expiresAt = now() + REQUEST_BUDGET_WINDOW_MS;
  const receipt = await input.reserve(HIP4_ACCOUNT_CASH_REQUEST_WEIGHT, policy);
  if (!receipt) throw new Hip4ReadError("budget_exhausted");
  let usedWeight = 0;
  let settled = false;
  const checkCurrent = (currentPolicy: Hip4ReadPolicy, weight: number) => {
    const current = budgetLimits(currentPolicy, input.background);
    if (
      settled ||
      now() >= expiresAt ||
      !Number.isSafeInteger(weight) ||
      weight <= 0 ||
      usedWeight + weight > receipt.reservedWeight ||
      currentPolicy.environment !== policy.environment ||
      current.total < limits.total ||
      (current.repair !== null &&
        limits.repair !== null &&
        current.repair < limits.repair) ||
      (current.background !== null &&
        limits.background !== null &&
        current.background < limits.background)
    )
      throw new Hip4ReadError("budget_exhausted");
  };
  return {
    deadlineMs: expiresAt,
    admit: async (weight: number): Promise<boolean> => {
      // Ownership, lifecycle and account-read/environment checks remain at
      // every transport boundary, even though provider weight is prepaid.
      const currentPolicy = await input.recheck();
      checkCurrent(currentPolicy, weight);
      if (!(await receipt.renew())) throw new Hip4ReadError("budget_exhausted");
      // Match ordinary admission: authorization precedes the atomic budget
      // operation. No asynchronous work may separate the final rolling touch
      // from dispatch, or its timestamp could age before the actual request.
      checkCurrent(currentPolicy, weight);
      // Charge the complete transport bound before IO, including failed HTTP,
      // malformed responses and provider timeouts. Only unattempted IO refunds.
      usedWeight += weight;
      return true;
    },
    settle: async () => {
      if (settled) return;
      settled = true;
      // Existing receipts intentionally cannot settle below20. Retaining that
      // floor for a pre-transport revocation is conservative, not extra credit.
      try {
        await receipt.settle(Math.max(20, usedWeight));
      } catch {
        // Optional accounting must not erase independently valid cash facts.
        // On failure the full182 reservation remains charged until expiry.
      }
    },
  };
}
