import assert from "node:assert/strict";
import { calculateWithdrawalCapacity } from "../../domain/withdrawal-capacity.js";

const sol = {
  nativeAsset: true,
  availableRaw: 3_280_121n,
  availableSolRaw: 3_280_121n,
  networkFeeRaw: 5_000n,
  accountRentRaw: 0n,
  payer: "user" as const,
};
assert.equal(calculateWithdrawalCapacity(sol).maximumSourceRaw, 3_275_121n);
assert.equal(
  calculateWithdrawalCapacity({ ...sol, payer: "privy_sponsor" })
    .maximumSourceRaw,
  sol.availableRaw,
);
const usdc = {
  ...sol,
  nativeAsset: false,
  availableRaw: 5_790_262n,
  availableSolRaw: 0n,
};
assert.equal(
  calculateWithdrawalCapacity(usdc).reasonCode,
  "insufficient_sol_for_fee",
);
assert.equal(
  calculateWithdrawalCapacity({ ...usdc, payer: "privy_sponsor" })
    .maximumSourceRaw,
  usdc.availableRaw,
);
assert.equal(
  calculateWithdrawalCapacity({ ...usdc, accountRentRaw: 2_039_280n })
    .reasonCode,
  "insufficient_sol_for_rent",
);
assert.equal(
  calculateWithdrawalCapacity({
    ...usdc,
    accountRentRaw: 2_039_280n,
    availableSolRaw: 2_044_280n,
  }).maximumSourceRaw,
  usdc.availableRaw,
);
assert.equal(
  calculateWithdrawalCapacity({
    ...usdc,
    accountRentRaw: 2_039_280n,
    availableSolRaw: 2_044_279n,
  }).maximumSourceRaw,
  0n,
);
assert.throws(() =>
  calculateWithdrawalCapacity({
    ...usdc,
    payer: "privy_sponsor",
    accountRentRaw: 1n,
  }),
);
assert.throws(() =>
  calculateWithdrawalCapacity({ ...sol, networkFeeRaw: -1n }),
);
