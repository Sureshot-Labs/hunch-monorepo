import type {
  PreparationInspectionInput,
  PreparationPostcondition,
} from "../domain/contracts.js";
import type {
  FundingReasonCode,
  JsonObject,
  PreparationExecutionMode,
  TradingWalletReadinessClass,
  VenueAccountBinding,
} from "../domain/types.js";
import type {
  PreparationActionTemplate,
  PreparationFactCheck,
  VenuePreparationFacts,
} from "./core-adapter.js";

export type RuntimeWalletAuthority = Readonly<{
  source: "embedded" | "smart" | "external" | "unknown";
  internal: boolean;
  privyWalletId: string | null;
  profileObservedAt: string | null;
}>;

export type RuntimeCredentialEvidence = Readonly<{
  present: boolean;
  boundToExactWallet: boolean;
  verified: boolean;
  observedAt: string | null;
  stale: boolean;
}>;

export type RuntimeMarketEvidence = Readonly<{
  resolved: boolean;
  orderable: boolean;
  adapterResolved: boolean;
  exchangeResolved: boolean;
  quoteGuardAvailable: boolean;
  safeMarketRef: string | null;
}>;

export type RuntimePositionEvidence = Readonly<{
  ownerMatchesBinding: boolean;
  balanceRaw: string | null;
  lockedRaw: string | null;
  conditionResolved: boolean | null;
  canonicalPlanAvailable: boolean;
  operatorApproved: boolean | null;
}>;

export type RuntimeWithdrawalEvidence = Readonly<{
  assetSupported: boolean;
  recipientValid: boolean;
  callValidated: boolean;
}>;

export type RuntimePolymarketFundingRouterEvidence = Readonly<{
  canonical: boolean;
  configured: boolean;
  depositUsdceAllowanceRaw: string | null;
  nonceRaw: string | null;
  pUsdAllowanceRaw: string | null;
  routerAddress: string | null;
  usdceAllowanceRaw: string | null;
}>;

export type PolymarketRuntimeEvidence = Readonly<{
  binding: VenueAccountBinding;
  wallet: RuntimeWalletAuthority;
  topology:
    | "signer"
    | "deposit_wallet"
    | "safe_1_1"
    | "safe_unsupported"
    | "magic_proxy"
    | "unknown_contract";
  executionMode: PreparationExecutionMode;
  rpcAvailable: boolean;
  walletDeployed: boolean;
  ownerVerified: boolean;
  credentials: RuntimeCredentialEvidence;
  market: RuntimeMarketEvidence;
  position: RuntimePositionEvidence | null;
  withdrawal: RuntimeWithdrawalEvidence | null;
  collateralObserved: boolean;
  collateralRaw: string | null;
  collateralLockedRaw: string | null;
  fundingRouter: RuntimePolymarketFundingRouterEvidence | null;
  clobCollateralVisible: boolean;
  standardExchangeAllowance: boolean;
  negRiskExchangeAllowance: boolean;
  negRiskAdapterAllowance: boolean;
  standardExchangeApproval: boolean;
  negRiskExchangeApproval: boolean;
  negRiskAdapterApproval: boolean;
  observedAt: string;
  expiresAt: string;
  safeEvidence: JsonObject;
}>;

export type LimitlessRuntimeEvidence = Readonly<{
  binding: VenueAccountBinding;
  wallet: RuntimeWalletAuthority;
  topology: "internal_eoa" | "external_eoa" | "unknown_wallet";
  executionMode: PreparationExecutionMode;
  rpcAvailable: boolean;
  ownerVerified: boolean;
  credentials: RuntimeCredentialEvidence;
  market: RuntimeMarketEvidence;
  position: RuntimePositionEvidence | null;
  withdrawal: RuntimeWithdrawalEvidence | null;
  cashObserved: boolean;
  cashRaw: string | null;
  cashLockedRaw: string | null;
  clobAllowance: boolean;
  negRiskClobAllowance: boolean;
  ammAllowance: boolean;
  clobApproval: boolean;
  negRiskClobApproval: boolean;
  ammApproval: boolean;
  marketAdapterApproval: boolean;
  observedAt: string;
  expiresAt: string;
  safeEvidence: JsonObject;
}>;

function postcondition(
  kind: string,
  safeLabel: string,
): PreparationPostcondition {
  return { kind, safeLabel };
}

function actionRequirement(input: {
  actionKey: string;
  kind: "evm_transaction" | "external_handoff" | "signature";
  safeLabel: string;
  actor: "server" | "user";
  valueMoving?: boolean;
  sponsorship?: "none" | "requested" | "required";
}): PreparationActionTemplate {
  return {
    actionKey: input.actionKey,
    action: null,
    summary: {
      kind: input.kind,
      safeLabel: input.safeLabel,
      actor: input.actor,
      valueMoving: input.valueMoving ?? false,
      sponsorship: input.sponsorship ?? "none",
    },
  };
}

function satisfied(checkId: string, safeLabel: string): PreparationFactCheck {
  return {
    checkId,
    status: "satisfied",
    safeLabel,
    reasonCode: null,
    actions: [],
    postcondition: postcondition(checkId, safeLabel),
  };
}

function unavailable(
  checkId: string,
  safeLabel: string,
  reasonCode: FundingReasonCode,
): PreparationFactCheck {
  return {
    checkId,
    status: "unavailable",
    safeLabel,
    reasonCode,
    actions: [],
    postcondition: null,
  };
}

function unsupported(
  checkId: string,
  safeLabel: string,
  reasonCode: FundingReasonCode,
): PreparationFactCheck {
  return {
    checkId,
    status: "unsupported",
    safeLabel,
    reasonCode,
    actions: [],
    postcondition: null,
  };
}

function required(input: {
  checkId: string;
  safeLabel: string;
  reasonCode: FundingReasonCode;
  action: PreparationActionTemplate;
  userAction: boolean;
}): PreparationFactCheck {
  return {
    checkId: input.checkId,
    status: input.userAction ? "user_action_required" : "action_required",
    safeLabel: input.safeLabel,
    reasonCode: input.reasonCode,
    actions: [input.action],
    postcondition: postcondition(input.checkId, input.safeLabel),
  };
}

function positiveRaw(value: string | null): boolean {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return BigInt(value) > 0n;
}

function spendableRaw(balance: string | null, locked: string | null): boolean {
  if (!positiveRaw(balance)) return false;
  if (!locked || !/^(0|[1-9][0-9]*)$/.test(locked)) return true;
  return BigInt(balance ?? "0") > BigInt(locked);
}

function readinessClass(
  wallet: RuntimeWalletAuthority,
  setupMissing: boolean,
): TradingWalletReadinessClass {
  if (wallet.source === "unknown") return "external_view_only";
  if (wallet.internal && wallet.privyWalletId) return "internal_managed";
  return setupMissing ? "external_setup_available" : "external_ready";
}

function walletChecks(
  wallet: RuntimeWalletAuthority,
  ownerVerified: boolean,
  rpcAvailable: boolean,
): PreparationFactCheck[] {
  const provisioned =
    wallet.source !== "unknown" &&
    (!wallet.internal || Boolean(wallet.privyWalletId));
  return [
    provisioned
      ? satisfied("wallet_provisioned", "Trading Wallet is provisioned")
      : unavailable(
          "wallet_provisioned",
          wallet.internal
            ? "Trading Wallet provisioning is pending"
            : "Trading Wallet authority is unavailable",
          wallet.internal
            ? "wallet_provisioning_pending"
            : "wallet_unavailable",
        ),
    ownerVerified
      ? satisfied("binding_owned", "Venue binding belongs to this account")
      : unavailable(
          "binding_owned",
          "Venue binding ownership could not be verified",
          "binding_owner_mismatch",
        ),
    rpcAvailable
      ? satisfied("rpc_fresh", "Fresh chain evidence is available")
      : unavailable(
          "rpc_fresh",
          "Fresh chain evidence is unavailable",
          "rpc_unavailable",
        ),
  ];
}

function credentialsCheck(
  evidence: RuntimeCredentialEvidence,
  actionKey: string,
  label: string,
  internal: boolean,
): PreparationFactCheck {
  if (!evidence.present) {
    return required({
      checkId: "credentials_valid",
      safeLabel: `${label} connection is required`,
      reasonCode: "credentials_missing",
      userAction: !internal,
      action: actionRequirement({
        actionKey,
        kind: "signature",
        safeLabel: `Connect ${label}`,
        actor: "user",
      }),
    });
  }
  if (!evidence.boundToExactWallet) {
    return required({
      checkId: "credentials_valid",
      safeLabel: `${label} connection belongs to another wallet`,
      reasonCode: "credentials_foreign",
      userAction: !internal,
      action: actionRequirement({
        actionKey: `${actionKey}-repair-foreign`,
        kind: "signature",
        safeLabel: `Reconnect ${label} to this Trading Wallet`,
        actor: "user",
      }),
    });
  }
  if (!evidence.verified || evidence.stale) {
    return required({
      checkId: "credentials_valid",
      safeLabel: `${label} connection must be refreshed`,
      reasonCode: "credentials_stale",
      userAction: !internal,
      action: actionRequirement({
        actionKey: `${actionKey}-repair-stale`,
        kind: "signature",
        safeLabel: `Refresh ${label} connection`,
        actor: "user",
      }),
    });
  }
  return satisfied("credentials_valid", `${label} connection is valid`);
}

function marketChecks(market: RuntimeMarketEvidence): PreparationFactCheck[] {
  return [
    market.resolved && market.orderable
      ? satisfied("market_context_resolved", "Exact market is executable")
      : unavailable(
          "market_context_resolved",
          market.resolved
            ? "Market is not currently executable"
            : "Exact market evidence is unavailable",
          "market_evidence_unavailable",
        ),
    market.adapterResolved
      ? satisfied(
          "market_adapter_resolved",
          "Canonical market adapter resolved",
        )
      : unavailable(
          "market_adapter_resolved",
          "Canonical market adapter is unavailable",
          "market_evidence_unavailable",
        ),
  ];
}

function approvalCheck(input: {
  actionKind?: "evm_transaction" | "external_handoff";
  checkId: string;
  approved: boolean;
  internal: boolean;
  safeLabel: string;
}): PreparationFactCheck {
  return input.approved
    ? satisfied(input.checkId, input.safeLabel)
    : required({
        checkId: input.checkId,
        safeLabel: input.safeLabel,
        reasonCode: "operator_approval_required",
        userAction: !input.internal,
        action: actionRequirement({
          actionKey: `approve-${input.checkId}`,
          kind: input.actionKind ?? "evm_transaction",
          safeLabel: input.safeLabel,
          actor: "user",
          sponsorship: input.internal ? "requested" : "none",
        }),
      });
}

function polymarketFundingRouterChecks(
  evidence: PolymarketRuntimeEvidence,
): PreparationFactCheck[] {
  if (evidence.topology !== "deposit_wallet") {
    return [
      satisfied(
        "funding_router_ready",
        "Polymarket Funding Router is not required for this topology",
      ),
      satisfied(
        "funding_router_deposit_usdce_allowance",
        "Deposit Wallet Funding Router allowance is not required",
      ),
      satisfied(
        "funding_router_signer_pusd_allowance",
        "Signer pUSD Funding Router allowance is not required",
      ),
      satisfied(
        "funding_router_signer_usdce_allowance",
        "Signer USDC.e Funding Router allowance is not required",
      ),
    ];
  }
  const router = evidence.fundingRouter;
  const routerReadable = Boolean(
    router?.configured &&
    router.canonical &&
    router.routerAddress &&
    router.nonceRaw &&
    /^(0|[1-9][0-9]*)$/.test(router.nonceRaw),
  );
  const unavailableAllowance = (
    checkId: string,
    safeLabel: string,
  ): PreparationFactCheck =>
    unavailable(
      checkId,
      safeLabel,
      router?.configured && router.canonical
        ? "rpc_unavailable"
        : "binding_not_ready",
    );
  const allowance = (input: {
    actionKey: string;
    checkId: string;
    kind: "evm_transaction" | "external_handoff";
    raw: string | null | undefined;
    safeLabel: string;
  }): PreparationFactCheck => {
    if (!routerReadable || input.raw == null) {
      return unavailableAllowance(input.checkId, input.safeLabel);
    }
    if (positiveRaw(input.raw ?? null)) {
      return satisfied(input.checkId, input.safeLabel);
    }
    return required({
      checkId: input.checkId,
      safeLabel: input.safeLabel,
      reasonCode: "operator_approval_required",
      userAction: !evidence.wallet.internal,
      action: actionRequirement({
        actionKey: input.actionKey,
        kind: input.kind,
        safeLabel: input.safeLabel,
        actor: "user",
        sponsorship: evidence.wallet.internal ? "requested" : "none",
      }),
    });
  };
  return [
    routerReadable
      ? satisfied(
          "funding_router_ready",
          "Canonical Polymarket Funding Router and nonce are available",
        )
      : unavailable(
          "funding_router_ready",
          router?.configured && router.canonical
            ? "Polymarket Funding Router nonce is unavailable"
            : "Canonical Polymarket Funding Router is not configured",
          router?.configured && router.canonical
            ? "rpc_unavailable"
            : "binding_not_ready",
        ),
    allowance({
      actionKey: "approve-funding-router-deposit-usdce",
      checkId: "funding_router_deposit_usdce_allowance",
      kind: "external_handoff",
      raw: router?.depositUsdceAllowanceRaw,
      safeLabel: "Approve Deposit Wallet USDC.e for the Funding Router",
    }),
    allowance({
      actionKey: "approve-funding-router-signer-pusd",
      checkId: "funding_router_signer_pusd_allowance",
      kind: "evm_transaction",
      raw: router?.pUsdAllowanceRaw,
      safeLabel: "Approve signer pUSD for the Funding Router",
    }),
    allowance({
      actionKey: "approve-funding-router-signer-usdce",
      checkId: "funding_router_signer_usdce_allowance",
      kind: "evm_transaction",
      raw: router?.usdceAllowanceRaw,
      safeLabel: "Approve signer USDC.e for the Funding Router",
    }),
  ];
}

function positionChecks(
  position: RuntimePositionEvidence | null,
  canonicalCheckId: string,
): PreparationFactCheck[] {
  if (!position) {
    return [
      unavailable(
        "position_owner",
        "Position owner evidence is unavailable",
        "market_evidence_unavailable",
      ),
      unavailable(
        "shares_spendable",
        "Position balance evidence is unavailable",
        "market_evidence_unavailable",
      ),
      unavailable(
        "condition_resolved",
        "Resolution evidence is unavailable",
        "market_evidence_unavailable",
      ),
      unavailable(
        "redeemable_balance",
        "Redeemable balance evidence is unavailable",
        "market_evidence_unavailable",
      ),
      unavailable(
        canonicalCheckId,
        "Canonical position action plan is unavailable",
        "market_evidence_unavailable",
      ),
    ];
  }
  return [
    position.ownerMatchesBinding
      ? satisfied("position_owner", "Position belongs to the exact binding")
      : unavailable(
          "position_owner",
          "Position belongs to another wallet binding",
          "position_owner_mismatch",
        ),
    spendableRaw(position.balanceRaw, position.lockedRaw)
      ? satisfied("shares_spendable", "Position shares are spendable")
      : unavailable(
          "shares_spendable",
          positiveRaw(position.balanceRaw)
            ? "Position shares are locked"
            : "No spendable position shares are available",
          positiveRaw(position.balanceRaw)
            ? "locked_funds"
            : "market_evidence_unavailable",
        ),
    position.conditionResolved === true
      ? satisfied("condition_resolved", "Position condition is resolved")
      : unavailable(
          "condition_resolved",
          "Position condition is not resolved",
          "condition_unresolved",
        ),
    positiveRaw(position.balanceRaw)
      ? satisfied("redeemable_balance", "Redeemable position balance exists")
      : unavailable(
          "redeemable_balance",
          "No redeemable position balance exists",
          "market_evidence_unavailable",
        ),
    position.canonicalPlanAvailable
      ? satisfied(canonicalCheckId, "Canonical position action plan validated")
      : unavailable(
          canonicalCheckId,
          "Canonical position action plan is unavailable",
          "market_evidence_unavailable",
        ),
  ];
}

function withdrawalChecks(
  withdrawal: RuntimeWithdrawalEvidence | null,
): PreparationFactCheck[] {
  return [
    withdrawal?.assetSupported
      ? satisfied("withdrawal_asset_supported", "Withdrawal asset is supported")
      : unsupported(
          "withdrawal_asset_supported",
          "Withdrawal asset is unsupported or unspecified",
          "unsupported_location",
        ),
    withdrawal?.recipientValid
      ? satisfied(
          "withdrawal_recipient_valid",
          "Withdrawal recipient is validated",
        )
      : unavailable(
          "withdrawal_recipient_valid",
          "Withdrawal recipient is missing or invalid",
          "withdrawal_recipient_invalid",
        ),
    withdrawal?.callValidated
      ? satisfied("withdrawal_call_validated", "Withdrawal call is validated")
      : unavailable(
          "withdrawal_call_validated",
          "Withdrawal call has not been validated",
          "invalid_action",
        ),
  ];
}

function mapChecks(
  checks: readonly PreparationFactCheck[],
): PreparationFactCheck[] {
  const byId = new Map<string, PreparationFactCheck>();
  for (const check of checks) byId.set(check.checkId, check);
  return [...byId.values()];
}

export function buildPolymarketRuntimeFacts(
  input: PreparationInspectionInput,
  evidence: PolymarketRuntimeEvidence,
): VenuePreparationFacts {
  const internal = evidence.wallet.internal;
  const topologySupported =
    evidence.topology === "signer" ||
    evidence.topology === "deposit_wallet" ||
    evidence.topology === "safe_1_1" ||
    evidence.topology === "magic_proxy";
  const common = [
    ...walletChecks(
      evidence.wallet,
      evidence.ownerVerified,
      evidence.rpcAvailable,
    ),
    topologySupported
      ? satisfied(
          "topology_supported",
          "Polymarket wallet topology is supported",
        )
      : unsupported(
          "topology_supported",
          evidence.topology === "safe_unsupported"
            ? "Polymarket Safe threshold is unsupported"
            : "Polymarket wallet topology is unsupported",
          evidence.topology === "safe_unsupported"
            ? "unsupported_safe_threshold"
            : "unsupported_wallet_topology",
        ),
    evidence.walletDeployed
      ? satisfied("wallet_deployed", "Polymarket execution wallet is deployed")
      : required({
          checkId: "wallet_deployed",
          safeLabel: "Polymarket execution wallet must be deployed",
          reasonCode: "wallet_not_deployed",
          userAction: !internal,
          action: actionRequirement({
            actionKey: "deploy-polymarket-wallet",
            kind: "external_handoff",
            safeLabel: "Deploy Polymarket Deposit Wallet",
            actor: "user",
          }),
        }),
  ];
  const credential = credentialsCheck(
    evidence.credentials,
    "connect-polymarket",
    "Polymarket",
    internal,
  );
  const market = marketChecks(evidence.market);
  const approvalActionKind =
    evidence.topology === "signer"
      ? ("evm_transaction" as const)
      : ("external_handoff" as const);
  const collateralSpendable = spendableRaw(
    evidence.collateralRaw,
    evidence.collateralLockedRaw,
  );
  const checks: PreparationFactCheck[] = [
    ...common,
    evidence.collateralObserved
      ? satisfied("collateral_observed", "Polymarket collateral was observed")
      : unavailable(
          "collateral_observed",
          "Polymarket collateral could not be observed",
          "cash_availability_unknown",
        ),
    ...polymarketFundingRouterChecks(evidence),
    evidence.clobCollateralVisible
      ? satisfied(
          "clob_collateral_visible",
          "Polymarket CLOB collateral is visible",
        )
      : unavailable(
          "clob_collateral_visible",
          "Polymarket CLOB collateral visibility is unverified",
          "clob_collateral_not_visible",
        ),
    credential,
    ...market,
    collateralSpendable
      ? satisfied("collateral_spendable", "Polymarket collateral is spendable")
      : unavailable(
          "collateral_spendable",
          positiveRaw(evidence.collateralRaw)
            ? "Polymarket collateral is locked"
            : "No spendable Polymarket collateral is available",
          positiveRaw(evidence.collateralRaw)
            ? "locked_funds"
            : "cash_availability_unknown",
        ),
    evidence.market.quoteGuardAvailable
      ? satisfied("fresh_quote_guard", "Fresh trade quote guard is available")
      : unavailable(
          "fresh_quote_guard",
          "Fresh trade quote guard is unavailable",
          "quote_slippage_exceeded",
        ),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "erc20_exchange_allowance",
      approved: evidence.standardExchangeAllowance,
      internal,
      safeLabel: "Approve pUSD for the standard exchange",
    }),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "erc20_neg_risk_exchange_allowance",
      approved: evidence.negRiskExchangeAllowance,
      internal,
      safeLabel: "Approve pUSD for the neg-risk exchange",
    }),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "erc20_neg_risk_adapter_allowance",
      approved: evidence.negRiskAdapterAllowance,
      internal,
      safeLabel: "Approve pUSD for the neg-risk adapter",
    }),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "ctf_exchange_approval",
      approved: evidence.standardExchangeApproval,
      internal,
      safeLabel: "Approve conditional tokens for the standard exchange",
    }),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "ctf_neg_risk_exchange_approval",
      approved: evidence.negRiskExchangeApproval,
      internal,
      safeLabel: "Approve conditional tokens for the neg-risk exchange",
    }),
    approvalCheck({
      actionKind: approvalActionKind,
      checkId: "ctf_neg_risk_adapter_approval",
      approved: evidence.negRiskAdapterApproval,
      internal,
      safeLabel: "Approve conditional tokens for the neg-risk adapter",
    }),
    ...positionChecks(evidence.position, "canonical_redemption_plan"),
    evidence.position?.operatorApproved !== false
      ? satisfied(
          "redemption_operator_approval",
          "Redemption operator approval is satisfied",
        )
      : approvalCheck({
          actionKind: approvalActionKind,
          checkId: "redemption_operator_approval",
          approved: false,
          internal,
          safeLabel: "Approve the canonical redemption operator",
        }),
    ...withdrawalChecks(evidence.withdrawal),
  ];
  const setupMissing =
    !evidence.credentials.present ||
    !evidence.walletDeployed ||
    !topologySupported;
  return {
    binding: evidence.binding,
    safeLabel: `Polymarket · ${evidence.binding.accountRef.slice(0, 8)}…`,
    purpose: input.purpose,
    marketClass: input.marketClass,
    readinessClass: readinessClass(evidence.wallet, setupMissing),
    executionMode: evidence.executionMode,
    topology: evidence.topology,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
    evidence: evidence.safeEvidence,
    checks: mapChecks(checks),
  };
}

export function buildLimitlessRuntimeFacts(
  input: PreparationInspectionInput,
  evidence: LimitlessRuntimeEvidence,
): VenuePreparationFacts {
  const internal = evidence.wallet.internal;
  const credential = credentialsCheck(
    evidence.credentials,
    "connect-limitless",
    "Limitless",
    internal,
  );
  const market = marketChecks(evidence.market);
  const cashSpendable = spendableRaw(evidence.cashRaw, evidence.cashLockedRaw);
  const position = positionChecks(
    evidence.position,
    input.marketClass?.includes("neg_risk")
      ? "canonical_neg_risk_redemption_plan"
      : "canonical_standard_redemption_plan",
  );
  const checks: PreparationFactCheck[] = [
    ...walletChecks(
      evidence.wallet,
      evidence.ownerVerified,
      evidence.rpcAvailable,
    ),
    evidence.cashObserved
      ? satisfied("cash_observed", "Limitless cash balance was observed")
      : unavailable(
          "cash_observed",
          "Limitless cash balance is unavailable",
          "cash_availability_unknown",
        ),
    evidence.cashObserved
      ? satisfied(
          "cash_receipt_observed",
          "Limitless cash receipt observation is available",
        )
      : unavailable(
          "cash_receipt_observed",
          "Limitless cash receipt is not observable",
          "cash_availability_unknown",
        ),
    {
      ...credential,
      checkId: "partner_profile_valid",
      reasonCode:
        credential.reasonCode === "credentials_missing"
          ? "venue_profile_missing"
          : credential.reasonCode === "credentials_foreign"
            ? "venue_profile_foreign"
            : credential.reasonCode === "credentials_stale"
              ? "venue_profile_stale"
              : credential.reasonCode,
    },
    ...market,
    evidence.market.exchangeResolved
      ? satisfied("clob_exchange_resolved", "Limitless CLOB exchange resolved")
      : unavailable(
          "clob_exchange_resolved",
          "Limitless CLOB exchange is unavailable",
          "market_evidence_unavailable",
        ),
    evidence.market.exchangeResolved
      ? satisfied(
          "clob_neg_risk_exchange_resolved",
          "Limitless neg-risk CLOB exchange resolved",
        )
      : unavailable(
          "clob_neg_risk_exchange_resolved",
          "Limitless neg-risk CLOB exchange is unavailable",
          "market_evidence_unavailable",
        ),
    evidence.market.adapterResolved
      ? satisfied("amm_market_resolved", "Canonical Limitless AMM resolved")
      : unavailable(
          "amm_market_resolved",
          "Canonical Limitless AMM is unavailable",
          "market_evidence_unavailable",
        ),
    cashSpendable
      ? satisfied("cash_spendable", "Limitless cash is spendable")
      : unavailable(
          "cash_spendable",
          positiveRaw(evidence.cashRaw)
            ? "Limitless cash is locked"
            : "No spendable Limitless cash is available",
          positiveRaw(evidence.cashRaw)
            ? "locked_funds"
            : "cash_availability_unknown",
        ),
    approvalCheck({
      checkId: "clob_usdc_allowance",
      approved: evidence.clobAllowance,
      internal,
      safeLabel: "Approve USDC for the Limitless CLOB exchange",
    }),
    approvalCheck({
      checkId: "clob_neg_risk_usdc_allowance",
      approved: evidence.negRiskClobAllowance,
      internal,
      safeLabel: "Approve USDC for the Limitless neg-risk exchange",
    }),
    approvalCheck({
      checkId: "amm_usdc_allowance",
      approved: evidence.ammAllowance,
      internal,
      safeLabel: "Approve USDC for the canonical Limitless AMM",
    }),
    evidence.market.quoteGuardAvailable
      ? satisfied("clob_quote_guard", "Limitless CLOB quote guard is available")
      : unavailable(
          "clob_quote_guard",
          "Limitless CLOB quote guard is unavailable",
          "quote_slippage_exceeded",
        ),
    evidence.market.quoteGuardAvailable
      ? satisfied("amm_quote_guard", "Limitless AMM quote guard is available")
      : unavailable(
          "amm_quote_guard",
          "Limitless AMM quote guard is unavailable",
          "quote_slippage_exceeded",
        ),
    ...position,
    approvalCheck({
      checkId: "clob_operator_approval",
      approved: evidence.clobApproval,
      internal,
      safeLabel: "Approve conditional tokens for the Limitless CLOB exchange",
    }),
    approvalCheck({
      checkId: "clob_neg_risk_operator_approval",
      approved: evidence.negRiskClobApproval,
      internal,
      safeLabel:
        "Approve conditional tokens for the Limitless neg-risk exchange",
    }),
    approvalCheck({
      checkId: "amm_operator_approval",
      approved: evidence.ammApproval,
      internal,
      safeLabel: "Approve conditional tokens for the canonical Limitless AMM",
    }),
    approvalCheck({
      checkId: "market_adapter_approval",
      approved: evidence.marketAdapterApproval,
      internal,
      safeLabel: "Approve the canonical Limitless market adapter",
    }),
    evidence.position?.operatorApproved !== false
      ? satisfied(
          "redemption_operator_approval",
          "Redemption operator approval is satisfied",
        )
      : approvalCheck({
          checkId: "redemption_operator_approval",
          approved: false,
          internal,
          safeLabel: "Approve the canonical Limitless redemption adapter",
        }),
    ...withdrawalChecks(evidence.withdrawal),
  ];
  const setupMissing =
    !evidence.credentials.present || evidence.topology === "unknown_wallet";
  return {
    binding: evidence.binding,
    safeLabel: `Limitless · ${evidence.binding.accountRef.slice(0, 8)}…`,
    purpose: input.purpose,
    marketClass: input.marketClass,
    readinessClass: readinessClass(evidence.wallet, setupMissing),
    executionMode: evidence.executionMode,
    topology: evidence.topology,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
    evidence: evidence.safeEvidence,
    checks: mapChecks(checks),
  };
}
