import type { PreparationInspectionInput } from "../domain/contracts.js";
import {
  PurposeAwareWalletPreparationAdapter,
  type PreparationActionMaterializer,
  type PreparationRequirementResolver,
  type VenuePreparationFactsInspector,
} from "./core-adapter.js";

const COMMON = [
  "wallet_provisioned",
  "binding_owned",
  "topology_supported",
  "wallet_deployed",
  "rpc_fresh",
] as const;

const FUND = [
  ...COMMON,
  "collateral_observed",
  "funding_router_ready",
  "funding_router_deposit_usdce_allowance",
  "funding_router_signer_pusd_allowance",
  "funding_router_signer_usdce_allowance",
  "clob_collateral_visible",
] as const;

const BUY_COMMON = [
  ...FUND,
  "credentials_valid",
  "market_context_resolved",
  "collateral_spendable",
  "fresh_quote_guard",
] as const;

const SELL_COMMON = [
  ...COMMON,
  "position_owner",
  "credentials_valid",
  "market_context_resolved",
  "shares_spendable",
  "fresh_quote_guard",
] as const;

const REDEEM_COMMON = [
  ...COMMON,
  "position_owner",
  "condition_resolved",
  "redeemable_balance",
  "canonical_redemption_plan",
  "redemption_operator_approval",
] as const;

export const POLYMARKET_PREPARATION_REQUIREMENTS = {
  fund: {
    standard: FUND,
    neg_risk: FUND,
  },
  buy: {
    standard: [...BUY_COMMON, "erc20_exchange_allowance"],
    neg_risk: [
      ...BUY_COMMON,
      "erc20_neg_risk_exchange_allowance",
      "erc20_neg_risk_adapter_allowance",
    ],
  },
  sell: {
    standard: [...SELL_COMMON, "ctf_exchange_approval"],
    neg_risk: [
      ...SELL_COMMON,
      "ctf_neg_risk_exchange_approval",
      "ctf_neg_risk_adapter_approval",
    ],
  },
  redeem: {
    standard: REDEEM_COMMON,
    neg_risk: REDEEM_COMMON,
  },
  withdraw: {
    standard: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
    neg_risk: [
      ...COMMON,
      "withdrawal_asset_supported",
      "withdrawal_recipient_valid",
      "withdrawal_call_validated",
    ],
  },
} as const;

const resolvePolymarketRequirements: PreparationRequirementResolver = (
  input,
) => {
  if (
    input.marketClass == null &&
    (input.purpose === "fund" || input.purpose === "withdraw")
  ) {
    return POLYMARKET_PREPARATION_REQUIREMENTS[input.purpose].standard;
  }
  if (input.marketClass !== "standard" && input.marketClass !== "neg_risk") {
    return null;
  }
  return POLYMARKET_PREPARATION_REQUIREMENTS[input.purpose][input.marketClass];
};

export class PolymarketWalletPreparationAdapter extends PurposeAwareWalletPreparationAdapter {
  constructor(
    inspectFacts: VenuePreparationFactsInspector,
    clock?: () => Date,
    materializeActions?: PreparationActionMaterializer,
  ) {
    super(
      "polymarket-wallet-preparation-v1",
      async (input: PreparationInspectionInput) => {
        if (input.binding.venueId !== "polymarket") {
          throw new Error(
            "Polymarket adapter received a foreign venue binding",
          );
        }
        return inspectFacts(input);
      },
      resolvePolymarketRequirements,
      clock,
      materializeActions,
    );
  }
}
