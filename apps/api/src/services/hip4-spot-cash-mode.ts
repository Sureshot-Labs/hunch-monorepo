import { hip4RawUnits } from "@hunch/shared";
import {
  hip4BorrowLendStateSchema,
  hip4SpotAccountStateSchema,
} from "./hip4-account-contract.js";

/** Ancillary evidence for the legacy default SPOT topology, not a Standard
 * alias or authority for perps cash / SendAsset. Callers sandwich this evidence
 * and spot state with exact raw-mode and legacy-abstraction reads. */
export type Hip4DefaultSpotCashEvidence = {
  legacyDexAbstraction: unknown;
  borrowLendState: unknown;
};

export function hasHip4DefaultSpotCashEvidence(input: {
  mode: string;
  role: string;
  state: unknown;
  evidence?: Hip4DefaultSpotCashEvidence;
}): boolean {
  if (
    input.mode !== "default" ||
    input.role !== "user" ||
    !input.evidence ||
    (input.evidence.legacyDexAbstraction !== null &&
      input.evidence.legacyDexAbstraction !== false)
  )
    return false;
  try {
    const state = hip4SpotAccountStateSchema.parse(input.state);
    const lending = hip4BorrowLendStateSchema.parse(
      input.evidence.borrowLendState,
    );
    if (
      lending.health !== "healthy" ||
      lending.healthFactor !== null ||
      lending.tokenToState.some(([, row]) =>
        [
          row.borrow.basis,
          row.borrow.value,
          row.supply.basis,
          row.supply.value,
        ].some((value) => /[1-9]/u.test(value)),
      ) ||
      state.portfolioMarginEnabled === true ||
      // Populated maintenance/portfolio views are collateral-context facts,
      // outside this bounded legacy spot inference even when amounts are zero.
      state.tokenToAvailableAfterMaintenance?.length ||
      state.tokenToPortfolioBorrowRatio?.length ||
      state.tokenToPortfolioSupplyRatio?.length ||
      (state.portfolioMarginRatio != null &&
        /[1-9]/u.test(state.portfolioMarginRatio)) ||
      state.balances.some((row) => {
        const precision = Math.max(
          ...[row.total, row.hold, row.spotHold ?? "0"].map(
            (value) => value.split(".")[1]?.length ?? 0,
          ),
        );
        const total = hip4RawUnits(row.total, precision);
        const held = hip4RawUnits(row.hold, precision);
        return (
          total < 0n ||
          held < 0n ||
          held > total ||
          [row.borrowed, row.supplied].some(
            (value) => value != null && /[1-9]/u.test(value),
          ) ||
          (row.spotHold != null &&
            (hip4RawUnits(row.spotHold, precision) < 0n ||
              hip4RawUnits(row.spotHold, precision) > total))
        );
      })
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
