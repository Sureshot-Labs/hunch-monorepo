import type { PreparationInspectionInput } from "../domain/contracts.js";
import {
  PurposeAwareWalletPreparationAdapter,
  type PreparationActionMaterializer,
  type PreparationRequirementResolver,
  type VenuePreparationFactsInspector,
} from "./core-adapter.js";

const COMMON = ["wallet_provisioned", "binding_owned", "rpc_fresh"] as const;
const CONNECTION = [...COMMON, "partner_profile_valid"] as const;
const MARKET = [
  ...CONNECTION,
  "market_context_resolved",
  "market_adapter_resolved",
] as const;

export const LIMITLESS_PREPARATION_REQUIREMENTS = {
  fund: {
    clob: [...COMMON, "cash_observed", "cash_receipt_observed"],
    clob_neg_risk: [...COMMON, "cash_observed", "cash_receipt_observed"],
    amm: [...COMMON, "cash_observed", "cash_receipt_observed"],
    amm_neg_risk: [...COMMON, "cash_observed", "cash_receipt_observed"],
  },
  buy: {
    clob: [
      ...MARKET,
      "clob_exchange_resolved",
      "cash_spendable",
      "clob_usdc_allowance",
      "clob_quote_guard",
    ],
    clob_neg_risk: [
      ...MARKET,
      "clob_neg_risk_exchange_resolved",
      "cash_spendable",
      "clob_neg_risk_usdc_allowance",
      "clob_quote_guard",
    ],
    amm: [
      ...MARKET,
      "amm_market_resolved",
      "cash_spendable",
      "amm_usdc_allowance",
      "amm_quote_guard",
    ],
    amm_neg_risk: [
      ...MARKET,
      "amm_market_resolved",
      "cash_spendable",
      "amm_usdc_allowance",
      "amm_quote_guard",
    ],
  },
  sell: {
    clob: [
      ...MARKET,
      "position_owner",
      "clob_exchange_resolved",
      "shares_spendable",
      "clob_operator_approval",
      "market_adapter_approval",
      "clob_quote_guard",
    ],
    clob_neg_risk: [
      ...MARKET,
      "position_owner",
      "clob_neg_risk_exchange_resolved",
      "shares_spendable",
      "clob_neg_risk_operator_approval",
      "market_adapter_approval",
      "clob_quote_guard",
    ],
    amm: [
      ...MARKET,
      "position_owner",
      "amm_market_resolved",
      "shares_spendable",
      "amm_operator_approval",
      "market_adapter_approval",
      "amm_quote_guard",
    ],
    amm_neg_risk: [
      ...MARKET,
      "position_owner",
      "amm_market_resolved",
      "shares_spendable",
      "amm_operator_approval",
      "market_adapter_approval",
      "amm_quote_guard",
    ],
  },
  redeem: {
    clob: [
      ...COMMON,
      "position_owner",
      "condition_resolved",
      "redeemable_balance",
      "canonical_standard_redemption_plan",
    ],
    clob_neg_risk: [
      ...COMMON,
      "position_owner",
      "condition_resolved",
      "redeemable_balance",
      "canonical_neg_risk_redemption_plan",
      "redemption_operator_approval",
    ],
    amm: [
      ...COMMON,
      "position_owner",
      "condition_resolved",
      "redeemable_balance",
      "canonical_standard_redemption_plan",
    ],
    amm_neg_risk: [
      ...COMMON,
      "position_owner",
      "condition_resolved",
      "redeemable_balance",
      "canonical_neg_risk_redemption_plan",
      "redemption_operator_approval",
    ],
  },
  withdraw: {
    clob: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
    clob_neg_risk: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
    amm: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
    amm_neg_risk: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
  },
} as const;

type LimitlessMarketClass =
  keyof (typeof LIMITLESS_PREPARATION_REQUIREMENTS)["buy"];

function isLimitlessMarketClass(
  marketClass: string | null,
): marketClass is LimitlessMarketClass {
  return (
    marketClass === "clob" ||
    marketClass === "clob_neg_risk" ||
    marketClass === "amm" ||
    marketClass === "amm_neg_risk"
  );
}

const resolveLimitlessRequirements: PreparationRequirementResolver = (
  input,
) => {
  if (
    input.marketClass == null &&
    (input.purpose === "fund" || input.purpose === "withdraw")
  ) {
    return LIMITLESS_PREPARATION_REQUIREMENTS[input.purpose].clob;
  }
  if (!isLimitlessMarketClass(input.marketClass)) return null;
  return LIMITLESS_PREPARATION_REQUIREMENTS[input.purpose][input.marketClass];
};

export class LimitlessWalletPreparationAdapter extends PurposeAwareWalletPreparationAdapter {
  constructor(
    inspectFacts: VenuePreparationFactsInspector,
    clock?: () => Date,
    materializeActions?: PreparationActionMaterializer,
  ) {
    super(
      "limitless-wallet-preparation-v1",
      async (input: PreparationInspectionInput) => {
        if (input.binding.venueId !== "limitless") {
          throw new Error("Limitless adapter received a foreign venue binding");
        }
        return inspectFacts(input);
      },
      resolveLimitlessRequirements,
      clock,
      materializeActions,
    );
  }
}
