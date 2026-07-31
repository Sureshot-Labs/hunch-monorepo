import { FundingPersistenceError } from "../funding/persistence/funding-operation-repository.js";
import { FundingTradeAttemptError } from "../funding/persistence/funding-trade-attempt-repository.js";

export type PublicFundingTradeError = Readonly<{
  code:
    | "funding_reservation_conflict"
    | "funding_reservation_not_ready"
    | "funding_reservation_unavailable"
    | "funding_trade_reconciling"
    | "funding_trade_state_conflict";
  error: string;
}>;

export function toPublicFundingTradeError(
  error: unknown,
): PublicFundingTradeError {
  if (error instanceof FundingPersistenceError) {
    if (error.code === "operation_not_found") {
      return {
        code: "funding_reservation_unavailable",
        error: "Funding reservation is unavailable.",
      };
    }
    if (error.code === "invalid_state_transition") {
      return {
        code: "funding_reservation_not_ready",
        error: "Funding reservation is not ready for this exact trade.",
      };
    }
    if (error.code === "trade_submission_reconciling") {
      return {
        code: "funding_trade_reconciling",
        error: "This funding trade is already being reconciled.",
      };
    }
    return {
      code: "funding_reservation_conflict",
      error: "Funding reservation could not be used for this trade.",
    };
  }

  if (error instanceof FundingTradeAttemptError) {
    if (error.code === "reservation_unavailable") {
      return {
        code: "funding_reservation_unavailable",
        error: "Funding reservation is unavailable.",
      };
    }
    if (error.code === "attempt_conflict") {
      return {
        code: "funding_trade_reconciling",
        error: "This funding trade is already being reconciled.",
      };
    }
    return {
      code: "funding_trade_state_conflict",
      error: "Funding trade state changed. Refresh before retrying.",
    };
  }

  throw error;
}
