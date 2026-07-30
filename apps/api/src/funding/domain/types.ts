export type UserId = string;
export type AccountId = UserId;
export type WalletId = string;
export type NetworkId = string;
export type AssetId = string;
export type LocationId = string;
export type VenueId = string;
export type VenueBindingId = string;
export type ProviderId = string;
export type OperationId = string;
export type RawAmount = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export type AssetRef = Readonly<{
  networkId: NetworkId;
  assetId: AssetId;
  decimals: number;
}>;

export type Money = Readonly<{
  asset: AssetRef;
  raw: RawAmount;
}>;

export type UsdEstimate = Readonly<{
  value: string;
  asOf: string;
  priceSource: string;
  confidence: "high" | "medium" | "low";
  policyId: string;
}>;

/**
 * Core treats a location as a capability-bearing envelope. Adapters own the
 * typed details for a concrete location kind, which lets future location kinds
 * participate without adding a branch to core funding logic.
 */
export type AssetLocation<
  Kind extends string = string,
  Details extends JsonObject = JsonObject,
> = Readonly<{
  kind: Kind;
  locationId: LocationId;
  accountId: AccountId;
  asset: AssetRef;
  details: Details;
}>;

export type WalletAssetLocation = AssetLocation<
  "wallet",
  Readonly<{
    walletId: WalletId;
    address: string;
  }>
>;

export type VenueAccountLocation = AssetLocation<
  "venue_account",
  Readonly<{
    venueId: VenueId;
    accountRef: string;
    controllerWalletId: WalletId | null;
    address: string | null;
  }>
>;

export type InTransitClaimLocation = AssetLocation<
  "in_transit_claim",
  Readonly<{
    operationId: OperationId;
  }>
>;

export type ValidatedExternalRecipient = Readonly<{
  recipientId: string;
  accountId: AccountId;
  networkId: NetworkId;
  asset: AssetRef;
  addressFingerprint: string;
  validatedAt: string;
  expiresAt: string;
  validationPolicyVersion: number;
}>;

export type ResolvedExternalRecipient = ValidatedExternalRecipient &
  Readonly<{
    address: string;
  }>;

export type FundingTarget =
  | Readonly<{ kind: "owned_location"; location: AssetLocation }>
  | Readonly<{
      kind: "external_recipient";
      recipient: ValidatedExternalRecipient;
    }>;

export type ExternalIngressKind =
  | "controlled_wallet"
  | "exchange"
  | "privy"
  | "manual";

export type FundingSourceRef =
  | Readonly<{ kind: "owned_location"; location: AssetLocation }>
  | Readonly<{
      kind: "external_ingress";
      ingressKind: ExternalIngressKind;
      networkId: NetworkId | null;
      asset: AssetRef | null;
      controlledSender: boolean;
    }>
  | Readonly<{
      kind: "composite";
      legCount: number;
    }>
  | Readonly<{
      kind: "venue_preparation";
      venueId: VenueId;
      venueBindingId: string;
      inputCount: number;
    }>;

export const LOCATION_CAPABILITIES = [
  "observe",
  "value",
  "execution_source",
  "venue_settlement",
  "intermediate",
  "withdrawal_source",
] as const;

export type LocationCapability = (typeof LOCATION_CAPABILITIES)[number];

export type AssetLocationPolicy = Readonly<{
  locationPatternId: string;
  locationKind: string;
  ownership: "owned" | "external_recipient";
  observable: boolean;
  capabilities: readonly LocationCapability[];
  enabled: boolean;
  policyVersion: number;
}>;

export type WalletExecutionProfile = Readonly<{
  walletId: WalletId;
  controllerWalletRef?: string | null;
  networkId: NetworkId;
  address: string;
  source: "embedded" | "smart" | "external";
  signingModes: readonly (
    | "web_client"
    | "privy_authorization"
    | "privy_delegated"
  )[];
  serverWalletRef: string | null;
  sponsorshipPolicyIds: readonly string[];
  /**
   * Explicit wallet capability. Omitted profiles are treated as unable to
   * atomically execute multiple EVM calls.
   */
  evmAtomicBatchMode?: "privy_wallet_send_calls" | null;
}>;

export type TradingWalletReadinessClass =
  | "internal_managed"
  | "external_ready"
  | "external_setup_available"
  | "external_source_only"
  | "external_view_only";

export type PreparationPurpose =
  | "fund"
  | "buy"
  | "sell"
  | "redeem"
  | "withdraw";

export type PreparationStatus =
  | "ready"
  | "setup_required"
  | "user_action_required"
  | "unavailable";

export type PreparationExecutionMode =
  | "web_client"
  | "privy_authorization"
  | "privy_delegated"
  | "venue_relayer";

export type VenueAccountBinding = Readonly<{
  bindingId: VenueBindingId;
  venueId: VenueId;
  controllerWalletId: WalletId;
  executionWalletId: WalletId;
  accountRef: string;
  settlementLocation: AssetLocation;
  signingMode: "web_client" | "privy_authorization" | "privy_delegated";
}>;

export type VenueBindingOption = Readonly<{
  venueBindingOptionId: string;
  safeLabel: string;
  readinessClass: TradingWalletReadinessClass;
  preparationPurpose: PreparationPurpose;
  marketClass: string | null;
  topology: string;
  inspectionRevision: string;
  selectable: boolean;
  reasonCodes: readonly FundingReasonCode[];
}>;

export type ObservationError = Readonly<{
  code: string;
  retryable: boolean;
}>;

export type ObservedAsset = Readonly<{
  componentId: string;
  location: AssetLocation;
  amount: Money;
  ownershipEvidenceId: string;
  observedAt: string;
  observationFreshness: "fresh" | "stale" | "unknown";
  observationError: ObservationError | null;
  metadataRisk: "verified" | "unverified" | "spam";
}>;

export type ValuedAssetComponent = Readonly<{
  componentId: string;
  location: AssetLocation;
  amount: Money;
  category: "cash" | "token" | "in_transit";
  estimatedUsd: UsdEstimate | null;
  observedAt: string;
  observationFreshness: "fresh" | "stale" | "unknown";
  observationError: ObservationError | null;
  valuationEligibility: "included" | "unpriced" | "stale" | "excluded";
  executionEligibility:
    | "unknown"
    | "eligible"
    | "temporarily_unavailable"
    | "ineligible";
  reasonCodes: readonly FundingReasonCode[];
}>;

export type ValuedPositionComponent = Readonly<{
  componentId: string;
  venueId: VenueId;
  venueBindingId: VenueBindingId;
  positionRef: string;
  positionActionRef: string;
  estimatedUsd: UsdEstimate | null;
  valuationMethod: string;
  observedAt: string;
  observationFreshness: "fresh" | "stale" | "unknown";
  observationError: ObservationError | null;
  valuationEligibility: "included" | "unpriced" | "stale" | "excluded";
  reasonCodes: readonly FundingReasonCode[];
}>;

export type HeadlineValueMode = "liquid_only" | "liquid_plus_positions";

export type AccountValueProjection = Readonly<{
  accountId: AccountId;
  liquidAssetsEstimatedUsd: string;
  positionsEstimatedUsd: string;
  totalPortfolioEstimatedUsd: string;
  headlineMode: HeadlineValueMode;
  positionValuationCompleteness: "complete" | "partial";
  positionValuationFreshness: "fresh" | "stale";
  cashEstimatedUsd: string;
  tokenEstimatedUsd: string;
  inTransitEstimatedUsd: string;
  valuationCompleteness: "complete" | "partial";
  valuationFreshness: "fresh" | "stale";
  collectorErrors: readonly Readonly<{
    collectorId: string;
    code: string;
    retryable: boolean;
  }>[];
  unpricedAssetCount: number;
  asOf: string;
  components: readonly ValuedAssetComponent[];
  positionComponents: readonly ValuedPositionComponent[];
}>;

export type FundingPurpose =
  | "add_funds"
  | "trade_shortfall"
  | "convert_asset"
  | "withdrawal"
  | "manual_rebalance";

export type FundingTradeConsumerIntentInput = Readonly<{
  venueId: VenueId;
  /** Canonical unified market ID in venue:venue_market_id form. */
  marketId: string;
  marketContextId: string;
  side: "BUY";
  spend: Money;
}>;

export type FundingIntent = Readonly<{
  purpose: FundingPurpose;
  requestedDestinationAmount: Money | null;
  confirmedSourceAmount: Money | null;
  marketContextId: string | null;
  consumerIntent?: FundingTradeConsumerIntentInput | null;
  destinationOptionId: string | null;
  withdrawalRecipientId: string | null;
  venueBindingOptionId: string | null;
  controllerWalletRef?: string | null;
  maxFeeUsd: string | null;
  maxSlippageBps: number | null;
  deadline: string | null;
}>;

export type ActionSummary = Readonly<{
  kind:
    | "evm_transaction"
    | "evm_transaction_batch"
    | "svm_transaction"
    | "signature"
    | "external_handoff";
  safeLabel: string;
  actor: "user" | "server";
  valueMoving: boolean;
  sponsorship: "none" | "requested" | "required";
}>;

export type SourceOptionLeg = Readonly<{
  sourceLegId: string;
  safeLabel: string;
  source: Extract<
    FundingSourceRef,
    Readonly<{
      kind: "owned_location" | "external_ingress" | "venue_preparation";
    }>
  >;
  sourceAmount: Money;
  expectedDestination: Money;
  minimumDestination: Money;
  fees: readonly Readonly<{
    kind: string;
    amount: Money;
    estimatedUsd: string | null;
  }>[];
  eta: Readonly<{ minSeconds: number; maxSeconds: number }> | null;
  requiredActions: readonly ActionSummary[];
}>;

export type SourceOption = Readonly<{
  sourceOptionId: string;
  kind:
    | "wallet_asset"
    | "venue_cash"
    | "privy_funding_method"
    | "manual_receive"
    | "relay_deposit_address"
    | "venue_preparation"
    | "composite";
  safeLabel: string;
  source: FundingSourceRef;
  ingress?: ExternalIngressInstruction;
  sourceLegs?: readonly SourceOptionLeg[];
  amountMode: "exact_input" | "exact_output" | "variable_external";
  maximumSourceRaw: RawAmount | null;
  expectedDestination: Money | null;
  minimumDestination: Money | null;
  estimatedUsd: string | null;
  fees: readonly Readonly<{
    kind: string;
    amount: Money;
    estimatedUsd: string | null;
  }>[];
  eta: Readonly<{ minSeconds: number; maxSeconds: number }> | null;
  experienceMode: "inline_funding" | "prepare_first" | "unavailable";
  requiredActions: readonly ActionSummary[];
  expiresAt: string;
  recommended: boolean;
  selectable: boolean;
  reasonCodes: readonly FundingReasonCode[];
}>;

export type FundingDestinationOption = Readonly<{
  destinationOptionId: string;
  venueId: VenueId;
  venueBindingId: VenueBindingId;
  venueBindingOptionId: string;
  controllerWalletId: WalletId;
  safeLabel: string;
  requiredAsset: AssetRef;
  networkLabel: string;
  readinessClass: TradingWalletReadinessClass;
  preparationStatus: PreparationStatus;
  preparationPurpose: PreparationPurpose;
  executionMode: PreparationExecutionMode;
  marketClass: string | null;
  topology: string;
  inspectionRevision: string;
  recommended: boolean;
  selectable: boolean;
  reasonCodes: readonly FundingReasonCode[];
}>;

export type IntentLiquidityProjection = Readonly<{
  liquidityProjectionId: string;
  marketContextId: string | null;
  venueId: VenueId | null;
  venueBindingOptionId: string | null;
  destinationOptionId: string | null;
  collateralAsset: AssetRef;
  requestedCollateralRaw: RawAmount;
  availableNowRaw: RawAmount;
  shortfallRaw: RawAmount;
  convertibleRaw: RawAmount;
  requestedUsd: string;
  availableNowUsd: string;
  shortfallUsd: string;
  convertibleUsd: string;
  mode: "instant" | "inline_funding" | "prepare_first" | "unavailable";
  eta: Readonly<{ minSeconds: number; maxSeconds: number }> | null;
  requiredActions: readonly ActionSummary[];
  sourceOptions: readonly SourceOption[];
  asOf: string;
  expiresAt: string;
  policyVersion: number;
  completeness: "complete" | "partial";
  freshness: "fresh" | "stale";
  errors: readonly ObservationError[];
  reasonCodes: readonly FundingReasonCode[];
  destinationOptions: readonly FundingDestinationOption[];
}>;

export type FundingDiscoveryRequest = FundingIntent;

export type FundingQuoteRequest = Readonly<{
  liquidityProjectionId: string;
  selectedSourceOptionId: string;
  confirmedSourceAmount: Money | null;
  requestedDestinationAmount: Money | null;
}>;

export type FundingCommitRequest = Readonly<{
  quoteId: string;
  consentToken: string;
  idempotencyKey: string;
}>;

export type FundingQuoteSummary = Readonly<{
  quoteId: string;
  liquidityProjectionId: string;
  selectedSourceOptionId: string;
  destinationOptionId: string | null;
  venueBindingOptionId: string | null;
  planKind: FundingExecutionPlan["kind"];
  experienceMode: "instant" | "inline_funding" | "prepare_first";
  consentMode: "trade_intent" | "explicit_economic_review" | "external_action";
  sourceAmounts: readonly Readonly<{
    safeLabel: string;
    amount: Money;
  }>[];
  expectedDestination: Money;
  minimumDestination: Money;
  fees: SourceOption["fees"];
  eta: Readonly<{ minSeconds: number; maxSeconds: number }> | null;
  requiredActions: readonly ActionSummary[];
  ingress: ExternalIngressInstruction | null;
  planHash: string;
  consentToken: string;
  expiresAt: string;
  policyVersion: number;
}>;

export type MarketContextBinding = Readonly<{
  marketContextId: string;
  venueId: VenueId;
  marketId: string;
  side: string;
  executionProfileId: string;
  marketPriceRevision: string;
  collateralAsset: AssetRef;
  requestedCollateralRaw: RawAmount;
  compatibleVenueBindingOptionIds: readonly string[];
  expiresAt: string;
}>;

export type PlacementDecision = Readonly<{
  mode:
    | "confirmed_deposit_amount"
    | "trade_shortfall_only"
    | "confirmed_conversion_amount"
    | "confirmed_withdrawal_amount"
    | "manual_rebalance";
  sourceAmount: Money;
  destinationRequirement: Money;
  targetVenueId: VenueId | null;
  target: FundingTarget;
  boundedBuffer: Money | null;
  reason: "explicit" | "current_trade" | "single_valid_option";
  policyVersion: number;
}>;

export type ProviderSegment = Readonly<{
  segmentId: string;
  providerId: ProviderId;
  adapterId: string;
  adapterVersion: number;
  source: FundingSourceRef;
  destination: FundingTarget;
  amountMode: "exact_input" | "exact_output";
}>;

export type RelayDepositAddressSegment = ProviderSegment &
  Readonly<{
    providerId: "relay";
    mode: "strict";
    providerRequestFingerprint: string;
  }>;

export type ExternalIngressInstruction = Readonly<{
  ingressKind: ExternalIngressKind;
  sourceNetworkId: NetworkId | null;
  sourceAsset: AssetRef | null;
  /**
   * An ingress intent may expose several independently verified receive
   * targets. Assets listed on the same target share its network and address;
   * another EVM network or Solana is represented by another target rather
   * than by overloading one address.
   *
   * Legacy/provider ingress contracts may omit this field and remain exact to
   * sourceNetworkId/sourceAsset/destinationAddress.
   */
  receiveTargets?: readonly Readonly<{
    receiveTargetId: string;
    networkId: NetworkId;
    destinationAddress: string;
    acceptedAssets: readonly Readonly<{
      asset: AssetRef;
      handling: FundingReceiveHandling;
    }>[];
    safeInstructions: readonly string[];
  }>[];
  recommendedReceiveTargetId?: string | null;
  destinationOptionId: string;
  destinationAddress: string;
  requestedAmount: Money | null;
  amountSemantics: "minimum" | "exact";
  expiresAt: string | null;
  safeInstructions: readonly string[];
}>;

export type FundingReceiveSessionStatus =
  | "open"
  | "processing"
  | "review_required"
  | "completed"
  | "expired"
  | "cancelled"
  | "recovery_required";

export type FundingReceiveMethod = Readonly<{
  methodId: string;
  kind: "manual" | "privy";
  safeLabel: string;
  ingress: ExternalIngressInstruction;
}>;

export type FundingReceiveAutomationPolicy = Readonly<{
  stableConversion: "automatic_within_caps";
  volatileConversion: "review_required";
  maximumFeeUsd: string;
  maximumFeeBps: number;
  maximumSlippageBps: number;
}>;

export type FundingReceiveSession = Readonly<{
  receiveSessionId: string;
  status: FundingReceiveSessionStatus;
  venueId: VenueId;
  destinationOptionId: string;
  venueBindingOptionId: string;
  destinationAsset: AssetRef;
  methods: readonly FundingReceiveMethod[];
  receiveTargets: NonNullable<ExternalIngressInstruction["receiveTargets"]>;
  selectedReceiveTargetId: string | null;
  automationPolicy: FundingReceiveAutomationPolicy;
  version: number;
  openedAt: string;
  lastObservedAt: string | null;
  expiresAt: string;
  observeUntil: string;
  closedAt: string | null;
}>;

export type FundingReceiveReceipt = Readonly<{
  receiptId: string;
  receiveSessionId: string;
  variantId: string;
  asset: AssetRef;
  destinationAddress: string;
  rawAmount: RawAmount;
  observationRevision: string;
  observedAt: string;
  status:
    | "observed"
    | "review_required"
    | "routing"
    | "ready"
    | "recovery_required";
  handling: FundingReceiveHandling;
  childFundingOperationId: string | null;
}>;

export type FundingReceiveHandling =
  | "direct"
  | "automatic_conversion"
  | "review_required";

export type FundingExecutionPlan =
  | Readonly<{
      kind: "wallet_route";
      segments: readonly [ProviderSegment];
    }>
  | Readonly<{
      kind: "relay_deposit_address";
      segments: readonly [RelayDepositAddressSegment];
      ingress: ExternalIngressInstruction;
    }>
  | Readonly<{
      kind: "direct_external_handoff";
      segments: readonly [];
      ingress: ExternalIngressInstruction;
    }>
  | Readonly<{
      kind: "already_available";
      segments: readonly [];
    }>
  | Readonly<{
      kind: "venue_preparation";
      segments: readonly [];
    }>
  | Readonly<{
      kind: "composite_route";
      segments: readonly ProviderSegment[];
    }>;

export type EvmTransactionAction = Readonly<{
  kind: "evm_transaction";
  actionId: string;
  networkId: NetworkId;
  senderWalletId: WalletId;
  to: string;
  data: string;
  valueRaw: RawAmount;
  gasLimitRaw: RawAmount | null;
}>;

export type EvmTransactionBatchCall = Readonly<{
  actionId: string;
  to: string;
  data: string;
  valueRaw: RawAmount;
}>;

export type EvmTransactionBatchAction = Readonly<{
  kind: "evm_transaction_batch";
  actionId: string;
  networkId: NetworkId;
  senderWalletId: WalletId;
  calls: readonly EvmTransactionBatchCall[];
}>;

export type SvmAccountMeta = Readonly<{
  address: string;
  signer: boolean;
  writable: boolean;
}>;

export type SvmInstruction = Readonly<{
  programId: string;
  accounts: readonly SvmAccountMeta[];
  data: string;
  dataEncoding: "hex";
}>;

export type SvmTransactionAction = Readonly<{
  kind: "svm_transaction";
  actionId: string;
  networkId: NetworkId;
  signerWalletId: WalletId;
  instructions: readonly SvmInstruction[];
  addressLookupTables: readonly string[];
}>;

export type SignatureAction = Readonly<{
  kind: "signature";
  actionId: string;
  networkId: NetworkId;
  signerWalletId: WalletId;
  payloadKind: "eip712" | "personal_message" | "solana_message";
  payload: JsonObject;
}>;

export type ExternalHandoffAction = Readonly<{
  kind: "external_handoff";
  actionId: string;
  networkId: NetworkId;
  actorWalletId: WalletId;
  /**
   * Stable adapter-owned action type. Core deliberately treats this as an
   * opaque, namespaced identifier; the matching handoff executor owns payload
   * validation and execution policy.
   */
  handoffKind: string;
  payload: JsonObject;
}>;

export type NormalizedAction =
  | EvmTransactionAction
  | EvmTransactionBatchAction
  | ExternalHandoffAction
  | SvmTransactionAction
  | SignatureAction;

export const FUNDING_REASON_CODES = [
  "account_not_authenticated",
  "ambiguous_duplicate_observation",
  "ambiguous_duplicate_position",
  "asset_metadata_spam",
  "asset_not_registered",
  "asset_unpriced",
  "balance_observation_stale",
  "binding_not_ready",
  "binding_owner_mismatch",
  "cash_availability_unknown",
  "clob_collateral_not_visible",
  "condition_unresolved",
  "credentials_foreign",
  "credentials_missing",
  "credentials_stale",
  "creation_mode_off",
  "destination_not_selected",
  "destination_selection_required",
  "destination_setup_required",
  "destination_unavailable",
  "external_signer_required",
  "fee_limit_exceeded",
  "funding_cost_warning",
  "fixture_adapter_forbidden",
  "insufficient_gas",
  "insufficient_liquidity",
  "invalid_action",
  "invalid_amount",
  "invalid_market_context",
  "invalid_policy",
  "locked_funds",
  "market_class_required",
  "market_evidence_unavailable",
  "invalid_state_transition",
  "trade_submission_reconciling",
  "minimum_output_not_met",
  "movement_representation_replaced",
  "operator_approval_required",
  "operation_reconcile_required",
  "policy_gate_closed",
  "position_action_required",
  "position_owner_mismatch",
  "provider_capability_disabled",
  "provider_status_unknown",
  "preparation_evidence_stale",
  "quote_expired",
  "quote_slippage_exceeded",
  "refund_location_unsafe",
  "rpc_unavailable",
  "route_not_allowlisted",
  "source_not_selected",
  "stale_projection",
  "stable_asset_impaired",
  "trusted_price_stale",
  "trusted_price_unavailable",
  "unsupported_safe_threshold",
  "unsupported_location",
  "unsupported_signer",
  "unsupported_wallet_topology",
  "venue_profile_foreign",
  "venue_profile_missing",
  "venue_profile_stale",
  "wallet_not_deployed",
  "wallet_provisioning_pending",
  "wallet_unavailable",
  "withdrawal_recipient_invalid",
] as const;

export type FundingReasonCode = (typeof FUNDING_REASON_CODES)[number];
