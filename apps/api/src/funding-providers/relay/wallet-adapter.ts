import type {
  ProviderQuoteCandidate,
  ProviderDescriptor,
} from "../../funding/domain/contracts.js";
import type {
  AssetLocation,
  FundingSourceRef,
  FundingTarget,
  Money,
  NormalizedAction,
} from "../../funding/domain/types.js";
import {
  canonicalJsonHash,
  canonicalJsonEqual,
} from "../../funding/persistence/canonical.js";
import { RelayClient } from "./client.js";
import {
  assertRelayRouteAssets,
  normalizeRelayAccountAddress,
  relayChainIdForNetwork,
  relayCurrencyForAsset,
  relayRouteCapability,
  resolveRelaySolanaDirectDestinationContract,
  RELAY_ROUTE_SPECS,
  type RelayRouteSpec,
} from "./mappings.js";
import { normalizeRelayFees, normalizeRelayFeeUsd } from "./fees.js";
import { rejectDisabledRelayCapabilities } from "./schemas.js";
import {
  SOLANA_NATIVE,
  SOLANA_USDC,
  assertEvmActionGasWithinHardPolicy,
  validateRelayRehearsalQuote,
} from "./rehearsal.js";
import { validateRelaySolanaDirectQuote } from "./solana-rehearsal.js";
import {
  validateRelayHypercoreQuote,
  type RelayHypercoreQuoteInput,
} from "./hypercore-quote.js";
import { relayHypercoreNormalizedActions } from "./hypercore-operation-plan.js";
import {
  validateRelayHypercoreInboundQuote,
  type RelayHypercoreInboundQuoteInput,
} from "./hypercore-inbound-quote.js";
import { relayRefundLocation } from "./refund-location.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreMainnetUsdc,
  hypercoreLocationDex,
  RELAY_HYPERCORE_PERPS_CURRENCY,
} from "../../funding/domain/hypercore-identity.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../../funding/domain/asset-identity.js";
import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import { relayQuoteResponseSchema } from "./schemas.js";
import type { ResolvedRouteDestination } from "../../funding/planner/destination-adapters.js";
import {
  assertNativeTransferFeeObservation,
  NativeTransferFeeCapabilityError,
  type NativeTransferFeeBinding,
  type NativeTransferFeeObservation,
} from "../../services/hip4-transfer-fee-capability.js";

export const RELAY_PROVIDER_DESCRIPTOR: ProviderDescriptor = {
  providerId: "relay",
  adapterId: "relay_quote_v2",
  adapterVersion: 1,
  runtimeKind: "production",
  capabilities: [
    "same_network_swap",
    "cross_network_transfer",
    "cross_network_swap",
    "deposit_address",
  ],
};

export type NormalizedRelayWalletQuote = Readonly<{
  candidate: ProviderQuoteCandidate;
  actions: readonly NormalizedAction[];
  requestId: string;
  requestFingerprint: string;
  routeShape: string;
  sourceAmount: Money;
  sourceEstimatedUsd: string | null;
  feeUsd: readonly (string | null)[];
  /** Native spot outflow or inbound EVM funding may refund into owned perps
   * cash. Resolve against source owner / destination owner respectively;
   * never copy this identity from provider presentation. */
  nativeRefundLocation?: AssetLocation;
  nativeFeeBreakdownVarianceRaw?: string | null;
}>;

export type RelayWalletQuoteInput = Readonly<{
  route: RelayRouteSpec;
  source: FundingSourceRef;
  destination: FundingTarget;
  sourceAmount: Money;
  minimumOutput: Money;
  userAddress: string;
  recipientAddress: string;
  senderWalletId: string;
  quoteCorrelationId: string;
  deadline: Date;
  maximumQuoteTtlMs?: number;
  maximumSlippageBps?: number;
  now?: Date;
}>;

function normalizedEvmActions(input: {
  actions: ReturnType<typeof validateRelayRehearsalQuote>["actions"];
  requestId: string;
  networkId: string;
  senderWalletId: string;
}): readonly NormalizedAction[] {
  const fingerprint = canonicalJsonHash({
    provider: "relay",
    requestId: input.requestId,
  });
  return input.actions.map((action) => {
    assertEvmActionGasWithinHardPolicy(action);
    return {
      kind: "evm_transaction",
      actionId: `relay:${fingerprint}:${action.stepId}`,
      networkId: input.networkId,
      senderWalletId: input.senderWalletId,
      to: action.to,
      data: action.data,
      valueRaw: action.value.toString(),
      gasLimitRaw: action.gasLimit.toString(),
    };
  });
}

/** Common EVM source actions, reservations and fee valuation; the native
 * destination is never represented as an EVM wallet or an extra bridge leg. */
export function normalizeRelayHypercoreInboundWalletQuote(input: {
  validation: RelayHypercoreInboundQuoteInput;
  source: Extract<FundingSourceRef, { kind: "owned_location" }>;
  destination: ResolvedRouteDestination;
  nativeRefundLocation: AssetLocation;
  actorWalletId: string;
}): NormalizedRelayWalletQuote {
  const source = input.source.location,
    target = input.destination.target;
  const chainId = input.validation.contracts.destinationChainId;
  if (
    source.kind !== "wallet" ||
    source.details.walletId !== input.actorWalletId ||
    source.asset.networkId !== `evm:${chainId}` ||
    source.asset.decimals !== 6 ||
    typeof source.details.address !== "string" ||
    !sameAccountAddress(
      source.asset.networkId,
      source.details.address,
      input.validation.owner,
    ) ||
    target.kind !== "owned_location" ||
    target.location.accountId !== source.accountId ||
    !isHypercoreMainnetUsdc(input.destination.requiredAsset) ||
    !sameAsset(input.destination.requiredAsset, target.location.asset) ||
    hypercoreLocationDex(target.location) !== "spot" ||
    typeof target.location.details.address !== "string" ||
    !sameAccountAddress(
      target.location.asset.networkId,
      target.location.details.address,
      input.validation.recipient,
    )
  )
    throw new Error("native_inbound_owned_location_mismatch");
  // Match source token against the registered route as well as its chain.
  const route = Object.values(RELAY_ROUTE_SPECS).find(
    (spec) =>
      spec.destinationVm === "hypercore" &&
      sameAsset(spec.source, source.asset),
  );
  if (
    !route ||
    !sameAsset(source.asset, {
      networkId: `evm:${chainId}`,
      assetId: input.validation.sourceCurrency,
      decimals: 6,
    })
  )
    throw new Error("native_inbound_source_asset_mismatch");
  const validated = validateRelayHypercoreInboundQuote(input.validation);
  const minimumOutput = {
    asset: HYPERCORE_MAINNET_USDC,
    raw: validated.minimumOutputRaw.toString(),
  };
  const refund = relayRefundLocation({
    sourceLocation: target.location,
    sourceAmount: minimumOutput,
    nativeRefundLocation: input.nativeRefundLocation,
  });
  const actions = normalizedEvmActions({
    actions: validated.actions,
    requestId: validated.requestId,
    networkId: source.asset.networkId,
    senderWalletId: input.actorWalletId,
  });
  const wire = relayQuoteResponseSchema.parse(input.validation.quote);
  const estimate = Math.max(0, Math.ceil(wire.details.timeEstimate ?? 0));
  const sourceAmount = {
    asset: source.asset,
    raw: validated.sourceAmountRaw.toString(),
  };
  return {
    candidate: {
      providerId: "relay",
      adapterVersion: 1,
      capability: relayRouteCapability(route),
      amountMode:
        input.validation.amountMode === "expected_output"
          ? "exact_output"
          : "exact_input",
      source: structuredClone(input.source),
      destination: structuredClone(target),
      expectedOutput: {
        asset: HYPERCORE_MAINNET_USDC,
        raw: validated.expectedOutputRaw.toString(),
      },
      minimumOutput,
      fees: validated.fees,
      eta: { minSeconds: estimate, maxSeconds: Math.max(estimate, 1) * 3 },
      expiresAt: validated.expiresAt.toISOString(),
      actionKinds: actions.map((action) => action.kind),
      refundSemantics: "relay_provider_refund_requires_owned_observation_v1",
      opaqueQuoteRef: `relay:${validated.fingerprint}`,
    },
    actions,
    requestId: validated.requestId,
    requestFingerprint: canonicalJsonHash({
      provider: "relay",
      requestId: validated.requestId,
    }),
    routeShape: "relay-depository-v2-hypercore",
    sourceAmount,
    sourceEstimatedUsd: multiplyRawByUnitPrice({
      raw: sourceAmount.raw,
      decimals: 6,
      unitPriceUsd: "1",
    }),
    // Non-gas fees, including derived pUSD conversion cost, use exact source
    // stablecoin units. Provider amountUsd cannot loosen common USD/BPS caps.
    // ETH/POL gas retains the existing separate valuation semantics.
    feeUsd: validated.fees.map((fee) =>
      fee.kind === "gas"
        ? (wire.fees?.gas?.amountUsd ?? null)
        : multiplyRawByUnitPrice({
            raw: fee.amount.raw,
            decimals: fee.amount.asset.decimals,
            unitPriceUsd: "1",
          }),
    ),
    nativeRefundLocation: structuredClone(refund),
  };
}

/** Native protocol validation feeds the same planner candidate, reservation
 * and commit path as every other Relay route. Input ownership/addresses are
 * resolved by the server, never taken from the provider's presentation text. */
export function normalizeRelayHypercoreWalletQuote(input: {
  validation: RelayHypercoreQuoteInput;
  source: Extract<FundingSourceRef, { kind: "owned_location" }>;
  destination: ResolvedRouteDestination;
  nativeRefundLocation: AssetLocation;
  actorWalletId: string;
  quoteCorrelationId: string;
}): NormalizedRelayWalletQuote {
  const source = input.source.location;
  const target = input.destination.target;
  const destination =
    target.kind === "owned_location" ? target.location : target.recipient;
  const outputAsset = {
    networkId: `evm:${input.validation.contracts.destinationChainId}`,
    assetId: input.validation.destinationCurrency.toLowerCase(),
    decimals: 6,
  };
  if (
    source.kind !== "venue_account" ||
    !isHypercoreMainnetUsdc(source.asset) ||
    source.details.venueId !== "hyperliquid" ||
    source.details.environment !== "mainnet" ||
    hypercoreLocationDex(source) !== input.validation.sourceDex ||
    source.details.controllerWalletId !== input.actorWalletId ||
    typeof source.details.address !== "string" ||
    !sameAccountAddress(
      source.asset.networkId,
      source.details.address,
      input.validation.owner,
    ) ||
    source.accountId !== destination.accountId ||
    !sameAsset(outputAsset, destination.asset) ||
    !sameAsset(outputAsset, input.destination.requiredAsset) ||
    (target.kind === "external_recipient" &&
      (input.destination.externalRecipientId !== target.recipient.recipientId ||
        !input.destination.recipientAddress ||
        target.recipient.networkId !== outputAsset.networkId ||
        !Number.isFinite(Date.parse(target.recipient.expiresAt)) ||
        Date.parse(target.recipient.expiresAt) <=
          input.validation.now.getTime() ||
        !sameAccountAddress(
          outputAsset.networkId,
          input.destination.recipientAddress,
          input.validation.recipient,
        ))) ||
    (target.kind === "owned_location" &&
      (typeof target.location.details.address !== "string" ||
        !sameAccountAddress(
          outputAsset.networkId,
          target.location.details.address,
          input.validation.recipient,
        )))
  )
    throw new Error("native_quote_owned_location_mismatch");
  const validated = validateRelayHypercoreQuote(input.validation);
  const minimumOutput = {
    asset: outputAsset,
    raw: validated.minimumOutputRaw.toString(),
  };
  const actions = relayHypercoreNormalizedActions({
    validated,
    minimumOutput,
    actorWalletId: input.actorWalletId,
    quoteCorrelationId: input.quoteCorrelationId,
    destinationTarget: target,
    recipientAddress: input.validation.recipient,
  });
  const requestId = validated.actions.binding.requestId;
  const estimate = Math.max(
    0,
    Math.ceil(
      relayQuoteResponseSchema.parse(input.validation.quote).details
        .timeEstimate ?? 0,
    ),
  );
  const usd = (amount: Money) =>
    multiplyRawByUnitPrice({
      raw: amount.raw,
      decimals: amount.asset.decimals,
      unitPriceUsd: "1",
    });
  const sourceAmount = {
    asset: HYPERCORE_MAINNET_USDC,
    raw: validated.sourceAmountRaw.toString(),
  };
  return {
    candidate: {
      providerId: "relay",
      adapterVersion: 1,
      capability: relayRouteCapability({
        source: HYPERCORE_MAINNET_USDC,
        destination: outputAsset,
      }),
      amountMode:
        input.validation.amountMode === "expected_output"
          ? "exact_output"
          : "exact_input",
      source: structuredClone(input.source),
      destination: structuredClone(target),
      expectedOutput: {
        asset: outputAsset,
        raw: validated.expectedOutputRaw.toString(),
      },
      minimumOutput,
      fees: validated.fees,
      eta: { minSeconds: estimate, maxSeconds: Math.max(estimate, 1) * 3 },
      expiresAt: validated.expiresAt.toISOString(),
      // Mapping authorization is a wallet signature, not a second transfer.
      actionKinds: ["signature", "external_handoff"],
      refundSemantics: "relay_provider_refund_requires_owned_observation_v1",
      opaqueQuoteRef: `relay:${validated.fingerprint}`,
    },
    actions,
    requestId,
    requestFingerprint: canonicalJsonHash({ provider: "relay", requestId }),
    routeShape: "hypercore_send_asset_v1",
    sourceAmount,
    sourceEstimatedUsd: usd(sourceAmount),
    feeUsd: validated.fees.map((fee) => usd(fee.amount)),
    nativeRefundLocation: structuredClone(input.nativeRefundLocation),
    nativeFeeBreakdownVarianceRaw: validated.feeBreakdownVarianceRaw,
  };
}

export class RelayQuoteEconomicsError extends Error {
  readonly code = "relay_quote_economics_rejected";

  constructor(
    readonly reason: "source_cap_exceeded" | "minimum_floor",
    message: string,
  ) {
    super(message);
    this.name = "RelayQuoteEconomicsError";
  }
}

export class RelayQuoteValidationError extends Error {
  readonly code = "relay_quote_validation_failed";

  constructor(message: string) {
    super(message);
    this.name = "RelayQuoteValidationError";
  }
}

function relayQuoteValidationError(error: unknown): RelayQuoteValidationError {
  return new RelayQuoteValidationError(
    error instanceof Error ? error.message : "Relay quote validation failed",
  );
}

function requiredLocationDetail(
  details: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = details[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Relay owned location ${key} is missing`);
  }
  return value;
}

function assertOwnedRouteBindings(
  input: RelayWalletQuoteInput,
): asserts input is RelayWalletQuoteInput & {
  source: Extract<FundingSourceRef, { kind: "owned_location" }>;
} {
  if (input.source.kind !== "owned_location") {
    throw new Error("Relay wallet quote requires an owned wallet source");
  }
  if (input.source.location.kind !== "wallet") {
    throw new Error("Relay wallet quote source must be a wallet location");
  }
  const sourceDetails = input.source.location.details;
  if (
    requiredLocationDetail(sourceDetails, "walletId") !== input.senderWalletId
  ) {
    throw new Error("Relay sender wallet does not match the owned source");
  }
  if (
    normalizeRelayAccountAddress(
      input.route.source.networkId,
      requiredLocationDetail(sourceDetails, "address"),
    ) !==
    normalizeRelayAccountAddress(
      input.route.source.networkId,
      input.userAddress,
    )
  ) {
    throw new Error("Relay user address does not match the owned source");
  }

  const destinationAccountId =
    input.destination.kind === "owned_location"
      ? input.destination.location.accountId
      : input.destination.recipient.accountId;
  if (destinationAccountId !== input.source.location.accountId) {
    throw new Error("Relay source and destination ownership do not match");
  }
  if (
    input.destination.kind === "owned_location" &&
    normalizeRelayAccountAddress(
      input.route.destination.networkId,
      requiredLocationDetail(input.destination.location.details, "address"),
    ) !==
      normalizeRelayAccountAddress(
        input.route.destination.networkId,
        input.recipientAddress,
      )
  ) {
    throw new Error(
      "Relay recipient address does not match the resolved destination",
    );
  }
  if (
    input.destination.kind === "external_recipient" &&
    input.destination.recipient.addressFingerprint.length < 8
  ) {
    throw new Error("Relay external recipient fingerprint is missing");
  }
}

function quoteExpiry(
  deadline: Date,
  now: Date,
  maximumQuoteTtlMs = 60_000,
): Date {
  if (
    !Number.isSafeInteger(maximumQuoteTtlMs) ||
    maximumQuoteTtlMs <= 0 ||
    maximumQuoteTtlMs > 15 * 60_000
  ) {
    throw new Error("Relay quote TTL is outside hard policy");
  }
  const adapterLimit = new Date(now.getTime() + maximumQuoteTtlMs);
  return deadline < adapterLimit ? deadline : adapterLimit;
}

function assertRelaySlippageLimit(maximumSlippageBps: number): void {
  if (
    !Number.isInteger(maximumSlippageBps) ||
    maximumSlippageBps < 0 ||
    maximumSlippageBps > 500
  ) {
    throw new Error("Relay slippage limit is outside hard policy");
  }
}

function bufferedExpectedOutput(
  raw: string,
  maximumSlippageBps: number,
  rawUnit = 1n,
): string {
  assertRelaySlippageLimit(maximumSlippageBps);
  const denominator = 10_000n - BigInt(maximumSlippageBps);
  const value = (BigInt(raw) + rawUnit - 1n) / rawUnit;
  return (
    ((value * 10_000n + denominator - 1n) / denominator) *
    rawUnit
  ).toString();
}

export class RelayWalletQuoteAdapter {
  constructor(
    readonly client: RelayClient,
    readonly clock: () => Date = () => new Date(),
    readonly nativeTransferCapability?: (
      binding: NativeTransferFeeBinding,
    ) => Promise<NativeTransferFeeObservation>,
  ) {}

  /** The inbound EVM leg uses the existing client transaction executor. Only
   * the protocol/receipt contract differs from a normal EVM destination. */
  async quoteHypercoreInbound(
    input: RelayWalletQuoteInput &
      Readonly<{
        resolvedDestination: ResolvedRouteDestination;
        nativeRefundLocation: AssetLocation;
        maximumFeeRaw: string;
        maximumContractAgeMs: number;
      }>,
  ): Promise<NormalizedRelayWalletQuote> {
    assertRelayRouteAssets(
      input.route,
      input.sourceAmount.asset,
      input.minimumOutput.asset,
    );
    assertOwnedRouteBindings(input);
    assertRelayRouteAssets(
      input.route,
      input.source.location.asset,
      input.resolvedDestination.requiredAsset,
    );
    const target = input.destination;
    if (
      input.route.sourceVm !== "evm" ||
      input.route.destinationVm !== "hypercore" ||
      target.kind !== "owned_location" ||
      hypercoreLocationDex(target.location) !== "spot" ||
      !sameAsset(target.location.asset, input.minimumOutput.asset) ||
      !canonicalJsonEqual(target, input.resolvedDestination.target)
    )
      throw new RelayQuoteValidationError("Invalid native inbound binding");
    relayRefundLocation({
      sourceLocation: target.location,
      sourceAmount: input.minimumOutput,
      nativeRefundLocation: input.nativeRefundLocation,
    });
    const sourceChainId = relayChainIdForNetwork(input.route.source.networkId);
    if (sourceChainId !== 137 && sourceChainId !== 8453)
      throw new RelayQuoteValidationError("Unsupported native inbound source");
    const now = input.now ?? this.clock();
    const ttl = input.maximumQuoteTtlMs ?? 60_000;
    const deadline = quoteExpiry(input.deadline, now, ttl);
    if (deadline <= now)
      throw new RelayQuoteValidationError(
        "Native inbound quote deadline expired",
      );
    if (
      input.quoteCorrelationId.trim().length < 8 ||
      input.quoteCorrelationId.length > 512
    )
      throw new RelayQuoteValidationError(
        "Relay quote correlation ID is outside policy",
      );
    const owner = normalizeRelayAccountAddress(
      input.route.source.networkId,
      input.userAddress,
    );
    const recipient = normalizeRelayAccountAddress(
      input.route.destination.networkId,
      input.recipientAddress,
    );
    const maximumSlippageBps = input.maximumSlippageBps ?? 100;
    assertRelaySlippageLimit(maximumSlippageBps);
    // Size registered stablecoin inbound requests in their coarser asset unit,
    // then express the request in native output atoms. Native-only rounding
    // can leave a provider-rounded minimum microscopically below the floor.
    // The original floor, source cap and fee limits remain validation inputs.
    const rawUnit =
      10n **
      BigInt(
        Math.max(
          0,
          input.minimumOutput.asset.decimals -
            input.sourceAmount.asset.decimals,
        ),
      );
    const floor = BigInt(input.minimumOutput.raw);
    if (floor <= 0n)
      throw new RelayQuoteValidationError(
        "Native inbound output floor must be positive",
      );
    // Reserve at most one coarser unit of provider minimum rounding inside
    // the requested slippage. The common planner retains the original exact
    // native-unit limit and rejects any unexpected provider behavior.
    const roundingReserveBps = ((rawUnit - 1n) * 10_000n + floor - 1n) / floor;
    const slippage =
      roundingReserveBps >= BigInt(maximumSlippageBps)
        ? 0
        : maximumSlippageBps - Number(roundingReserveBps);
    const buffered = bufferedExpectedOutput(
      input.minimumOutput.raw,
      slippage,
      rawUnit,
    );
    const expectedOutputTargetRaw =
      input.route.quoteMode === "expected_output"
        ? buffered
        : input.minimumOutput.raw;
    const [contracts, quote] = await Promise.all([
      this.client.hypercoreContracts(sourceChainId),
      this.client.quote({
        user: owner,
        recipient,
        originChainId: sourceChainId,
        destinationChainId: 1337,
        originCurrency: relayCurrencyForAsset(input.route.source),
        destinationCurrency: relayCurrencyForAsset(input.route.destination),
        amount:
          input.route.quoteMode === "expected_output"
            ? expectedOutputTargetRaw
            : input.sourceAmount.raw,
        tradeType:
          input.route.quoteMode === "expected_output"
            ? "EXPECTED_OUTPUT"
            : "EXACT_INPUT",
        protocolVersion: "v2",
        includeProtocolData: true,
        refundTo: owner,
        useDepositAddress: false,
        slippageTolerance: slippage.toString(),
      }),
    ]);
    const completedAt = this.clock();
    if (deadline <= completedAt)
      throw new RelayQuoteValidationError(
        "Native inbound quote deadline expired",
      );
    try {
      return normalizeRelayHypercoreInboundWalletQuote({
        validation: {
          quote,
          contracts,
          contractsObservedAt: new Date(contracts.observedAt),
          maximumContractAgeMs: input.maximumContractAgeMs,
          owner,
          recipient,
          sourceCurrency: relayCurrencyForAsset(input.route.source),
          amountMode: input.route.quoteMode,
          authorizedSourceRaw: input.sourceAmount.raw,
          minimumOutputRaw: input.minimumOutput.raw,
          expectedOutputTargetRaw,
          maximumFeeRaw: input.maximumFeeRaw,
          now: completedAt,
          deadline,
          maximumQuoteTtlMs: ttl,
        },
        source: input.source,
        destination: input.resolvedDestination,
        nativeRefundLocation: input.nativeRefundLocation,
        actorWalletId: input.senderWalletId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "native_inbound_source_cap_mismatch" &&
        input.route.quoteMode === "expected_output" &&
        BigInt(quote.details.currencyIn.amount) > BigInt(input.sourceAmount.raw)
      )
        throw new RelayQuoteEconomicsError(
          "source_cap_exceeded",
          "Native inbound quote exceeds source capacity",
        );
      if (
        error instanceof Error &&
        error.message === "native_inbound_output_floor_mismatch"
      )
        throw new RelayQuoteEconomicsError(
          "minimum_floor",
          "Native inbound quote misses output floor",
        );
      throw new RelayQuoteValidationError(
        "Native inbound quote failed protocol validation",
      );
    }
  }

  /** Native signing is protocol-specific; quote budgets, economics, normalized
   * candidates and the downstream commit/recovery path remain common. */
  async quoteHypercore(
    input: RelayWalletQuoteInput &
      Readonly<{
        resolvedDestination: ResolvedRouteDestination;
        nativeRefundLocation: AssetLocation;
        maximumFeeRaw: string;
        maximumContractAgeMs: number;
      }>,
  ): Promise<NormalizedRelayWalletQuote> {
    assertRelayRouteAssets(
      input.route,
      input.sourceAmount.asset,
      input.minimumOutput.asset,
    );
    const sourceDex =
      input.source.kind === "owned_location"
        ? hypercoreLocationDex(input.source.location)
        : null;
    if (
      input.route.sourceVm !== "hypercore" ||
      input.source.kind !== "owned_location" ||
      sourceDex === null ||
      sourceDex !== (input.route.nativeSourceDex ?? "spot") ||
      !canonicalJsonEqual(input.destination, input.resolvedDestination.target)
    )
      throw new RelayQuoteValidationError("Invalid native quote binding");
    const destinationChainId = relayChainIdForNetwork(
      input.route.destination.networkId,
    );
    if (destinationChainId !== 137 && destinationChainId !== 8453)
      throw new RelayQuoteValidationError("Unsupported native destination");
    const now = input.now ?? this.clock();
    const ttl = input.maximumQuoteTtlMs ?? 60_000;
    const deadline = quoteExpiry(input.deadline, now, ttl);
    if (deadline <= now)
      throw new RelayQuoteValidationError("Native quote deadline expired");
    const owner = normalizeRelayAccountAddress(
      input.route.source.networkId,
      input.userAddress,
    );
    const recipient = normalizeRelayAccountAddress(
      input.route.destination.networkId,
      input.recipientAddress,
    );
    const source = input.source.location;
    const targetAccountId =
      input.destination.kind === "owned_location"
        ? input.destination.location.accountId
        : input.destination.recipient.accountId;
    if (
      source.accountId !== targetAccountId ||
      source.details.controllerWalletId !== input.senderWalletId ||
      typeof source.details.address !== "string" ||
      !sameAccountAddress(
        source.asset.networkId,
        source.details.address,
        owner,
      ) ||
      !sameAsset(source.asset, input.route.source)
    )
      throw new RelayQuoteValidationError("Invalid native source owner");
    const slippage = input.maximumSlippageBps ?? 100;
    // Validate the existing hard envelope in both amount modes.
    const buffered = bufferedExpectedOutput(input.minimumOutput.raw, slippage);
    const expectedOutputTargetRaw =
      input.route.quoteMode === "expected_output"
        ? buffered
        : input.minimumOutput.raw;
    const [contracts, quote] = await Promise.all([
      this.client.hypercoreContracts(destinationChainId),
      this.client.quote({
        user: owner,
        recipient,
        originChainId: 1337,
        destinationChainId,
        originCurrency:
          sourceDex === ""
            ? RELAY_HYPERCORE_PERPS_CURRENCY
            : relayCurrencyForAsset(input.route.source),
        destinationCurrency: relayCurrencyForAsset(input.route.destination),
        amount:
          input.route.quoteMode === "expected_output"
            ? expectedOutputTargetRaw
            : input.sourceAmount.raw,
        tradeType:
          input.route.quoteMode === "expected_output"
            ? "EXPECTED_OUTPUT"
            : "EXACT_INPUT",
        protocolVersion: "v2",
        includeProtocolData: true,
        refundTo: owner,
        useDepositAddress: false,
        slippageTolerance: slippage.toString(),
      }),
    ]);
    const completedAt = this.clock();
    if (deadline <= completedAt)
      throw new RelayQuoteValidationError("Native quote deadline expired");
    if (!this.nativeTransferCapability)
      throw new NativeTransferFeeCapabilityError();
    const nativeBinding = {
      owner,
      depository: contracts.depository,
      sourceDex,
      destinationDex: "" as const,
    };
    const feeCapability = await this.nativeTransferCapability(nativeBinding);
    assertNativeTransferFeeObservation(
      feeCapability,
      nativeBinding,
      this.clock().getTime(),
    );
    try {
      return normalizeRelayHypercoreWalletQuote({
        validation: {
          quote,
          contracts,
          contractsObservedAt: new Date(contracts.observedAt),
          maximumContractAgeMs: input.maximumContractAgeMs,
          owner,
          recipient,
          destinationRefundRecipient: owner,
          destinationCurrency: input.route.destination.assetId,
          sourceDex,
          amountMode: input.route.quoteMode,
          authorizedSourceRaw: input.sourceAmount.raw,
          minimumOutputRaw: input.minimumOutput.raw,
          expectedOutputTargetRaw,
          maximumFeeRaw: input.maximumFeeRaw,
          now: this.clock(),
          deadline,
          maximumQuoteTtlMs: ttl,
        },
        source: input.source,
        destination: input.resolvedDestination,
        nativeRefundLocation: input.nativeRefundLocation,
        actorWalletId: input.senderWalletId,
        quoteCorrelationId: input.quoteCorrelationId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "native_quote_source_cap_mismatch" &&
        input.route.quoteMode === "expected_output" &&
        BigInt(quote.details.currencyIn.amount) > BigInt(input.sourceAmount.raw)
      )
        throw new RelayQuoteEconomicsError(
          "source_cap_exceeded",
          "Native quote exceeds source capacity",
        );
      if (
        error instanceof Error &&
        error.message === "native_quote_output_floor_mismatch"
      )
        throw new RelayQuoteEconomicsError(
          "minimum_floor",
          "Native quote misses output floor",
        );
      // Zod errors can embed provider values. Keep diagnostics bounded/safe.
      throw new RelayQuoteValidationError(
        "Native quote failed protocol validation",
      );
    }
  }

  async quote(
    input: RelayWalletQuoteInput,
  ): Promise<NormalizedRelayWalletQuote> {
    if (
      input.route.sourceVm === "hypercore" ||
      input.route.destinationVm === "hypercore"
    )
      throw new RelayQuoteValidationError(
        "Native route requires its exact protocol adapter",
      );
    assertRelayRouteAssets(
      input.route,
      input.sourceAmount.asset,
      input.minimumOutput.asset,
    );
    assertOwnedRouteBindings(input);
    assertRelayRouteAssets(
      input.route,
      input.source.location.asset,
      input.destination.kind === "owned_location"
        ? input.destination.location.asset
        : input.destination.recipient.asset,
    );
    if (BigInt(input.sourceAmount.raw) <= 0n) {
      throw new Error("Relay source amount must be positive");
    }
    if (BigInt(input.minimumOutput.raw) <= 0n) {
      throw new Error("Relay minimum output must be positive");
    }
    const now = input.now ?? this.clock();
    if (input.deadline <= now) throw new Error("Relay quote deadline expired");
    if (
      input.quoteCorrelationId.trim().length < 8 ||
      input.quoteCorrelationId.length > 512
    ) {
      throw new Error("Relay quote correlation ID is outside policy");
    }
    const quoteCorrelationId = input.quoteCorrelationId.trim();
    const userAddress = normalizeRelayAccountAddress(
      input.route.source.networkId,
      input.userAddress,
    );
    const recipientAddress = normalizeRelayAccountAddress(
      input.route.destination.networkId,
      input.recipientAddress,
    );

    const expectedOutputTargetRaw =
      input.route.quoteMode === "expected_output"
        ? bufferedExpectedOutput(
            input.minimumOutput.raw,
            input.maximumSlippageBps ?? 100,
          )
        : input.minimumOutput.raw;
    const request = {
      user: userAddress,
      recipient: recipientAddress,
      originChainId: relayChainIdForNetwork(input.route.source.networkId),
      destinationChainId: relayChainIdForNetwork(
        input.route.destination.networkId,
      ),
      originCurrency: relayCurrencyForAsset(input.route.source),
      destinationCurrency: relayCurrencyForAsset(input.route.destination),
      amount:
        input.route.quoteMode === "expected_output"
          ? expectedOutputTargetRaw
          : input.sourceAmount.raw,
      tradeType:
        input.route.quoteMode === "expected_output"
          ? ("EXPECTED_OUTPUT" as const)
          : ("EXACT_INPUT" as const),
      slippageTolerance: (input.maximumSlippageBps ?? 100).toString(),
      useDepositAddress: false,
      // Same-chain quotes otherwise contain self-executed aggregator swaps.
      // Request the solver deposit flow we validate; never relax calldata checks.
      ...(input.route.sourceVm === "evm" &&
      input.route.source.networkId === input.route.destination.networkId
        ? { forceSolverExecution: true, explicitDeposit: true }
        : {}),
    };
    const quote = await this.client.quote(request);
    const completedAt = this.clock();
    if (input.deadline <= completedAt) {
      throw new Error("Relay quote expired before validation completed");
    }
    rejectDisabledRelayCapabilities(quote);

    let requestId: string;
    let expectedOutputRaw: bigint;
    let minimumOutputRaw: bigint;
    let sourceAmountRaw = BigInt(input.sourceAmount.raw);
    let sourceEstimatedUsd: string | null =
      quote.details.currencyIn.amountUsd ?? null;
    let routeShape: string;
    let actions: readonly NormalizedAction[];
    if (input.route.sourceVm === "evm") {
      const scenario = input.route.rehearsalScenario;
      if (!scenario) throw new Error("Relay EVM route scenario missing");
      let validated;
      try {
        validated = validateRelayRehearsalQuote({
          amount: BigInt(input.sourceAmount.raw),
          amountMode: input.route.quoteMode,
          minimumOutputFloor: BigInt(input.minimumOutput.raw),
          quote,
          recipient: recipientAddress,
          scenario,
          user: userAddress,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("authorized cap")) {
            throw new RelayQuoteEconomicsError(
              "source_cap_exceeded",
              error.message,
            );
          }
          if (error.message.includes("authorized floor")) {
            throw new RelayQuoteEconomicsError("minimum_floor", error.message);
          }
        }
        throw relayQuoteValidationError(error);
      }
      requestId = validated.requestId;
      sourceAmountRaw = validated.sourceAmountRaw;
      expectedOutputRaw = validated.expectedOutputRaw;
      minimumOutputRaw = validated.minimumOutputRaw;
      routeShape = validated.routeShape;
      actions = normalizedEvmActions({
        actions: validated.actions,
        requestId,
        networkId: input.route.source.networkId,
        senderWalletId: input.senderWalletId,
      });
    } else {
      const sourceCurrency =
        input.route.source.assetId === SOLANA_NATIVE
          ? SOLANA_NATIVE
          : input.route.source.assetId === SOLANA_USDC
            ? SOLANA_USDC
            : null;
      if (!sourceCurrency) {
        throw new Error("Relay SVM source asset is not allowlisted");
      }
      const destination = resolveRelaySolanaDirectDestinationContract(
        input.route,
      );
      let validated;
      try {
        validated = validateRelaySolanaDirectQuote({
          amountMode: input.route.quoteMode,
          authorizedSourceAmountRaw: BigInt(input.sourceAmount.raw),
          destination,
          expectedOutputTargetRaw: BigInt(expectedOutputTargetRaw),
          minimumOutputFloorRaw: BigInt(input.minimumOutput.raw),
          quote,
          recipient: recipientAddress,
          sourceCurrency,
          user: userAddress,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("authorized source cap")) {
            throw new RelayQuoteEconomicsError(
              "source_cap_exceeded",
              error.message,
            );
          }
          if (error.message.includes("authorized floor")) {
            throw new RelayQuoteEconomicsError("minimum_floor", error.message);
          }
        }
        throw relayQuoteValidationError(error);
      }
      requestId = validated.requestId;
      sourceAmountRaw = validated.sourceAmountRaw;
      sourceEstimatedUsd = validated.sourceEstimatedUsd;
      expectedOutputRaw = validated.expectedOutputRaw;
      minimumOutputRaw = validated.minimumOutputRaw;
      routeShape =
        sourceCurrency === SOLANA_NATIVE
          ? "relay-solana-native-direct-depository-v1"
          : "relay-solana-spl-direct-depository-v1";
      const requestFingerprint = canonicalJsonHash({
        provider: "relay",
        requestId,
      });
      actions = [
        {
          kind: "svm_transaction",
          actionId: `relay:${requestFingerprint}:deposit`,
          networkId: input.route.source.networkId,
          signerWalletId: input.senderWalletId,
          instructions: [
            {
              programId: validated.instruction.programId,
              accounts: validated.instruction.keys.map((key) => ({
                address: key.pubkey,
                signer: key.isSigner,
                writable: key.isWritable,
              })),
              data: Buffer.from(validated.instruction.data).toString("hex"),
              dataEncoding: "hex",
            },
          ],
          addressLookupTables:
            validated.instruction.addressLookupTableAddresses,
        },
      ];
    }

    const requestFingerprint = canonicalJsonHash({
      provider: "relay",
      requestId,
    });
    const quoteFingerprint = canonicalJsonHash({
      provider: "relay",
      quoteCorrelationId,
      requestId,
    });
    const expiresAt = quoteExpiry(
      input.deadline,
      completedAt,
      input.maximumQuoteTtlMs,
    );
    const estimate = Math.max(0, Math.ceil(quote.details.timeEstimate ?? 0));
    const fees = normalizeRelayFees(quote);
    return {
      candidate: {
        providerId: "relay",
        adapterVersion: 1,
        capability: relayRouteCapability(input.route),
        amountMode:
          input.route.quoteMode === "expected_output"
            ? "exact_output"
            : "exact_input",
        source: input.source,
        destination: input.destination,
        expectedOutput: {
          asset: input.route.destination,
          raw: expectedOutputRaw.toString(),
        },
        minimumOutput: {
          asset: input.route.destination,
          raw: minimumOutputRaw.toString(),
        },
        fees,
        eta: { minSeconds: estimate, maxSeconds: Math.max(estimate, 1) * 3 },
        expiresAt: expiresAt.toISOString(),
        actionKinds: actions.map((action) => action.kind),
        refundSemantics: "relay_provider_refund_requires_owned_observation_v1",
        opaqueQuoteRef: `relay:${quoteFingerprint}`,
      },
      actions,
      requestId,
      requestFingerprint,
      routeShape,
      sourceAmount: {
        asset: input.route.source,
        raw: sourceAmountRaw.toString(),
      },
      sourceEstimatedUsd,
      feeUsd: normalizeRelayFeeUsd(quote, fees),
    };
  }
}
