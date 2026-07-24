import type {
  AccountId,
  ActionSummary,
  FundingDestinationOption,
  FundingReasonCode,
  FundingSourceRef,
  FundingTarget,
  JsonObject,
  Money,
  NetworkId,
  NormalizedAction,
  ObservedAsset,
  OperationId,
  PreparationExecutionMode,
  PreparationPurpose,
  PreparationStatus,
  ProviderId,
  SourceOption,
  UsdEstimate,
  ValuedPositionComponent,
  VenueAccountBinding,
  VenueBindingId,
  VenueId,
  WalletExecutionProfile,
} from "./types.js";
import type { FundingOperationState, SegmentStatus } from "./transitions.js";

export type OwnershipGraph = Readonly<{
  accountId: AccountId;
  wallets: readonly WalletExecutionProfile[];
  venueBindings: readonly VenueAccountBinding[];
  evidenceRevision: string;
  asOf: string;
}>;

export interface WalletOwnershipResolver {
  resolve(accountId: AccountId): Promise<OwnershipGraph>;
}

export type InventoryInput = Readonly<{
  accountId: AccountId;
  ownership: OwnershipGraph;
  asOf: string;
}>;

export interface AssetInventoryCollector {
  readonly collectorId: string;
  collect(input: InventoryInput): Promise<readonly ObservedAsset[]>;
}

export type PriceRequest = Readonly<{
  amount: Money;
  observedAt: string;
  policyId: string;
}>;

export interface PriceAdapter {
  readonly adapterId: string;
  value(input: PriceRequest): Promise<UsdEstimate | null>;
}

export type PositionValueInput = Readonly<{
  accountId: AccountId;
  venueId: VenueId;
  bindingIds: readonly VenueBindingId[];
  asOf: string;
}>;

export interface PositionValueCollector {
  readonly collectorId: string;
  collect(
    input: PositionValueInput,
  ): Promise<readonly ValuedPositionComponent[]>;
}

export type VenueBalanceInput = Readonly<{
  accountId: AccountId;
  venueId: VenueId;
  bindingId: VenueBindingId;
  asOf: string;
}>;

export type VenueBalanceFacts = Readonly<{
  bindingId: VenueBindingId;
  balances: readonly ObservedAsset[];
  observedAt: string;
  reasonCodes: readonly FundingReasonCode[];
}>;

export interface BalanceCollector {
  readonly collectorId: string;
  collect(input: VenueBalanceInput): Promise<VenueBalanceFacts>;
}

export type VenueBindingInput = Readonly<{
  accountId: AccountId;
  venueId: VenueId;
  purpose: PreparationPurpose;
  explicitVenueBindingOptionId: string | null;
  positionOwnerBindingId: VenueBindingId | null;
}>;

export interface VenueAccountResolver {
  resolve(input: VenueBindingInput): Promise<readonly VenueAccountBinding[]>;
}

export type DestinationOptionsInput = Readonly<{
  accountId: AccountId;
  purpose: PreparationPurpose;
  marketContextId: string | null;
  marketClass: string | null;
  compatibleVenueBindingOptionIds: readonly string[] | null;
}>;

export type DestinationInput = Readonly<{
  accountId: AccountId;
  destinationOptionId: string;
  purpose: PreparationPurpose;
  marketClass: string | null;
  marketContextId: string | null;
  requestedAmount: Money;
}>;

export type FundingRequirement = Readonly<{
  option: FundingDestinationOption;
  target: FundingTarget;
  requiredAmount: Money;
}>;

export interface FundingDestination {
  listOptions(
    input: DestinationOptionsInput,
  ): Promise<readonly FundingDestinationOption[]>;
  resolve(input: DestinationInput): Promise<FundingRequirement>;
}

export type PreparationInspectionInput = Readonly<{
  accountId: AccountId;
  binding: VenueAccountBinding;
  purpose: PreparationPurpose;
  marketClass: string | null;
  marketContextId: string | null;
}>;

export type PreparationPostcondition = Readonly<{
  kind: string;
  safeLabel: string;
}>;

export type PreparationCheckStatus =
  | "satisfied"
  | "action_required"
  | "user_action_required"
  | "pending"
  | "unavailable"
  | "unsupported";

export type PreparationCheckEvidence = Readonly<{
  checkId: string;
  status: PreparationCheckStatus;
  safeLabel: string;
  reasonCode: FundingReasonCode | null;
}>;

export type PreparationInspectionEvidence = Readonly<{
  /**
   * Sanitized, non-secret evidence only. Credential secrets, authorization
   * material, signatures, private keys, and raw provider responses must never
   * be placed in this object.
   */
  facts: JsonObject;
  checks: readonly PreparationCheckEvidence[];
}>;

export type PreparationResult = Readonly<{
  status: PreparationStatus;
  binding: VenueAccountBinding;
  safeLabel: string;
  purpose: PreparationPurpose;
  marketClass: string | null;
  readinessClass:
    | "internal_managed"
    | "external_ready"
    | "external_setup_available"
    | "external_source_only"
    | "external_view_only";
  executionMode: PreparationExecutionMode;
  topology: string;
  inspectionRevision: string;
  inspectedAt: string;
  expiresAt: string;
  requiredActions: readonly ActionSummary[];
  postconditions: readonly PreparationPostcondition[];
  reasonCodes: readonly FundingReasonCode[];
  evidence: PreparationInspectionEvidence;
}>;

export type PreparationInput = PreparationInspectionInput &
  Readonly<{
    operationId: OperationId;
    expectedInspectionRevision: string;
  }>;

export interface WalletPreparationAdapter {
  readonly adapterId: string;
  inspect(input: PreparationInspectionInput): Promise<PreparationResult>;
  prepare(input: PreparationInput): Promise<readonly NormalizedAction[]>;
}

export type TradeQuoteInput = Readonly<{
  accountId: AccountId;
  marketContextId: string;
  bindingId: VenueBindingId;
  amount: Money;
}>;

export type TradeQuote = Readonly<{
  quoteId: string;
  expiresAt: string;
  collateral: Money;
  opaqueVenueQuoteRef: string;
}>;

export type TradeSubmitInput = Readonly<{
  quote: TradeQuote;
  operationId: OperationId | null;
  idempotencyKey: string;
}>;

export type TradeResult = Readonly<{
  submissionFingerprint: string;
  status: "submitted" | "accepted" | "reconcile_required";
}>;

export interface TradingExecutor {
  quote(input: TradeQuoteInput): Promise<TradeQuote>;
  submit(input: TradeSubmitInput): Promise<TradeResult>;
}

export type PositionActionKind = "sell" | "redeem";

export type PositionActionInspectionInput = Readonly<{
  accountId: AccountId;
  action: PositionActionKind;
  venueId: VenueId;
  positionRef: string;
  ownerBindingId: VenueBindingId;
}>;

export type PositionActionReadiness = Readonly<{
  ready: boolean;
  action: PositionActionKind;
  venueId: VenueId;
  positionRef: string;
  ownerBindingId: VenueBindingId;
  inspectionRevision: string;
  inspectedAt: string;
  expiresAt: string;
  requiredActions: readonly ActionSummary[];
  postconditions: readonly PreparationPostcondition[];
  reasonCodes: readonly FundingReasonCode[];
  evidence: PreparationInspectionEvidence;
}>;

export type PositionActionInput = PositionActionInspectionInput &
  Readonly<{
    actionOperationId: string;
    expectedInspectionRevision: string;
  }>;

export type PositionActionReconcileInput = Readonly<{
  actionOperationId: string;
  submissionFingerprint: string;
}>;

export type PositionActionResult = Readonly<{
  status: "in_progress" | "completed" | "reconcile_required" | "failed";
  submissionFingerprint: string | null;
  reasonCodes: readonly FundingReasonCode[];
}>;

export interface PositionActionExecutor {
  readonly adapterId: string;
  inspect(
    input: PositionActionInspectionInput,
  ): Promise<PositionActionReadiness>;
  prepare(input: PositionActionInput): Promise<readonly NormalizedAction[]>;
  reconcile(input: PositionActionReconcileInput): Promise<PositionActionResult>;
}

export type ProviderDescriptor = Readonly<{
  providerId: ProviderId;
  adapterId: string;
  adapterVersion: number;
  runtimeKind: "production" | "fixture" | "simulator";
  capabilities: readonly (
    | "same_network_swap"
    | "cross_network_transfer"
    | "cross_network_swap"
    | "deposit_address"
  )[];
}>;

export type ProviderEligibilityInput = Readonly<{
  source: FundingSourceRef;
  destination: FundingTarget;
  sourceAmount: Money;
  minimumOutput: Money;
  policyRevision: string;
}>;

export type ProviderEligibility = Readonly<{
  eligible: boolean;
  reasonCodes: readonly FundingReasonCode[];
}>;

export type ProviderFee = Readonly<{
  kind: string;
  amount: Money;
}>;

export type ProviderQuoteInput = ProviderEligibilityInput &
  Readonly<{
    accountId: AccountId;
    quoteCorrelationId: string;
    deadline: string;
  }>;

export type ProviderQuoteCandidate = Readonly<{
  providerId: ProviderId;
  adapterVersion: number;
  capability:
    | "same_network_swap"
    | "cross_network_transfer"
    | "cross_network_swap";
  amountMode: "exact_input" | "exact_output";
  source: FundingSourceRef;
  destination: FundingTarget;
  expectedOutput: Money;
  minimumOutput: Money;
  fees: readonly ProviderFee[];
  eta: Readonly<{ minSeconds: number; maxSeconds: number }>;
  expiresAt: string;
  actionKinds: readonly NormalizedAction["kind"][];
  refundSemantics: string;
  opaqueQuoteRef: string;
}>;

export type ProviderActionInput = Readonly<{
  operationId: OperationId;
  opaqueQuoteRef: string;
  policyRevision: string;
}>;

export type ProviderReconcileInput = Readonly<{
  operationId: OperationId;
  segmentId: string;
  requestFingerprint: string | null;
  submissionFingerprints: readonly string[];
}>;

export type SegmentReconcileResult = Readonly<{
  status: SegmentStatus;
  rawProviderStatus: string | null;
  actualOutput: Money | null;
  reasonCodes: readonly FundingReasonCode[];
}>;

export interface RoutingProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  checkEligibility(
    input: ProviderEligibilityInput,
  ): Promise<ProviderEligibility>;
  quote(input: ProviderQuoteInput): Promise<ProviderQuoteCandidate>;
  prepareActions(
    input: ProviderActionInput,
  ): Promise<readonly NormalizedAction[]>;
  reconcile(input: ProviderReconcileInput): Promise<SegmentReconcileResult>;
}

export type ActionValidationContext = Readonly<{
  operationId: OperationId;
  expectedState: FundingOperationState;
  expectedNetworkId: NetworkId;
  expectedSignerWalletId: string;
  sourceAmount: Money;
  minimumOutput: Money;
  policyRevision: string;
  routeId: string;
}>;

export type ValidatedNormalizedAction = Readonly<{
  action: NormalizedAction;
  validatorId: string;
  validationRevision: string;
  validatedAt: string;
}>;

export interface ActionValidator {
  readonly validatorId: string;
  validate(
    action: NormalizedAction,
    context: ActionValidationContext,
  ): Promise<ValidatedNormalizedAction>;
}

export type NetworkSimulationResult = Readonly<{
  accepted: boolean;
  estimatedFee: Money | null;
  reasonCodes: readonly FundingReasonCode[];
  rawMetadata: JsonObject;
}>;

export type NetworkSubmissionResult = Readonly<{
  submissionFingerprint: string;
  submittedAt: string;
  rawReference: string;
}>;

export type NetworkSubmissionObservation = Readonly<{
  submissionFingerprint: string;
  status: "unknown" | "pending" | "confirmed" | "finalized" | "failed";
  observedAt: string;
  rawMetadata: JsonObject;
}>;

export interface NetworkExecutor {
  readonly executorId: string;
  readonly networkId: NetworkId;
  simulate(action: ValidatedNormalizedAction): Promise<NetworkSimulationResult>;
  broadcast(
    action: ValidatedNormalizedAction,
  ): Promise<NetworkSubmissionResult>;
  observe(submissionFingerprint: string): Promise<NetworkSubmissionObservation>;
}

export type SourceOptionsInput = Readonly<{
  accountId: AccountId;
  destinationOptionId: string;
  requestedAmount: Money;
}>;

export interface SourceOptionsService {
  list(input: SourceOptionsInput): Promise<readonly SourceOption[]>;
}
