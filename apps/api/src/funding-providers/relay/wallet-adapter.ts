import type {
  ProviderQuoteCandidate,
  ProviderDescriptor,
} from "../../funding/domain/contracts.js";
import type {
  FundingSourceRef,
  FundingTarget,
  Money,
  NormalizedAction,
} from "../../funding/domain/types.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import { RelayClient } from "./client.js";
import {
  assertRelayRouteAssets,
  normalizeRelayAssetId,
  relayChainIdForNetwork,
  relayCurrencyForAsset,
  type RelayRouteSpec,
} from "./mappings.js";
import { normalizeRelayFees } from "./fees.js";
import { rejectDisabledRelayCapabilities } from "./schemas.js";
import { validateRelayRehearsalQuote } from "./rehearsal.js";
import { validateRelaySolanaRehearsalQuote } from "./solana-rehearsal.js";

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
  now?: Date;
}>;

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
    normalizeRelayAssetId(
      input.route.source.networkId,
      requiredLocationDetail(sourceDetails, "address"),
    ) !== normalizeRelayAssetId(input.route.source.networkId, input.userAddress)
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
    normalizeRelayAssetId(
      input.route.destination.networkId,
      requiredLocationDetail(input.destination.location.details, "address"),
    ) !==
      normalizeRelayAssetId(
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

function assertEvmActionGasWithinHardPolicy(
  input: Readonly<{
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>,
): void {
  if (input.gasLimit <= 0n || input.gasLimit > 3_000_000n) {
    throw new Error("Relay EVM action gas limit is outside hard policy");
  }
  if (
    input.maxFeePerGas <= 0n ||
    input.maxFeePerGas > 800_000_000_000n ||
    input.maxPriorityFeePerGas < 0n ||
    input.maxPriorityFeePerGas > input.maxFeePerGas
  ) {
    throw new Error("Relay EVM action fee fields are outside hard policy");
  }
}

function routeCapability(
  route: RelayRouteSpec,
): ProviderQuoteCandidate["capability"] {
  if (route.source.networkId === route.destination.networkId) {
    return "same_network_swap";
  }
  return route.source.assetId === route.destination.assetId
    ? "cross_network_transfer"
    : "cross_network_swap";
}

function quoteExpiry(deadline: Date, now: Date): Date {
  const adapterLimit = new Date(now.getTime() + 60_000);
  return deadline < adapterLimit ? deadline : adapterLimit;
}

export class RelayWalletQuoteAdapter {
  constructor(
    readonly client: RelayClient,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async quote(
    input: RelayWalletQuoteInput,
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
    const userAddress = normalizeRelayAssetId(
      input.route.source.networkId,
      input.userAddress,
    );
    const recipientAddress = normalizeRelayAssetId(
      input.route.destination.networkId,
      input.recipientAddress,
    );

    const request = {
      user: userAddress,
      recipient: recipientAddress,
      originChainId: relayChainIdForNetwork(input.route.source.networkId),
      destinationChainId: relayChainIdForNetwork(
        input.route.destination.networkId,
      ),
      originCurrency: relayCurrencyForAsset(input.route.source),
      destinationCurrency: relayCurrencyForAsset(input.route.destination),
      amount: input.sourceAmount.raw,
      tradeType: "EXACT_INPUT" as const,
      useDepositAddress: false,
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
    let routeShape: string;
    let actions: readonly NormalizedAction[];
    if (input.route.sourceVm === "evm") {
      const scenario = input.route.rehearsalScenario;
      if (!scenario) throw new Error("Relay EVM route scenario missing");
      const validated = validateRelayRehearsalQuote({
        amount: BigInt(input.sourceAmount.raw),
        minimumOutputFloor: BigInt(input.minimumOutput.raw),
        quote,
        recipient: recipientAddress,
        scenario,
        user: userAddress,
      });
      requestId = validated.requestId;
      expectedOutputRaw = validated.expectedOutputRaw;
      minimumOutputRaw = validated.minimumOutputRaw;
      routeShape = validated.routeShape;
      const requestFingerprint = canonicalJsonHash({
        provider: "relay",
        requestId,
      });
      actions = validated.actions.map((action) => {
        assertEvmActionGasWithinHardPolicy(action);
        return {
          kind: "evm_transaction" as const,
          actionId: `relay:${requestFingerprint}:${action.stepId}`,
          networkId: input.route.source.networkId,
          senderWalletId: input.senderWalletId,
          to: action.to,
          data: action.data,
          valueRaw: action.value.toString(),
          gasLimitRaw: action.gasLimit.toString(),
        };
      });
    } else {
      const validated = validateRelaySolanaRehearsalQuote({
        amount: BigInt(input.sourceAmount.raw),
        minimumOutputFloor: BigInt(input.minimumOutput.raw),
        quote,
        recipient: recipientAddress,
        user: userAddress,
      });
      requestId = validated.requestId;
      expectedOutputRaw = validated.expectedOutputRaw;
      minimumOutputRaw = validated.minimumOutputRaw;
      routeShape = "relay-solana-depository-v1";
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
    const expiresAt = quoteExpiry(input.deadline, completedAt);
    const estimate = Math.max(0, Math.ceil(quote.details.timeEstimate ?? 0));
    return {
      candidate: {
        providerId: "relay",
        adapterVersion: 1,
        capability: routeCapability(input.route),
        amountMode: "exact_input",
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
        fees: normalizeRelayFees(quote),
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
    };
  }
}
