import { getAddress, ZeroAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

import type { Money } from "../../funding/domain/types.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import { RelayClient } from "./client.js";
import { normalizeRelayFees } from "./fees.js";
import {
  assertRelayRouteAssets,
  normalizeRelayAssetId,
  relayChainIdForNetwork,
  relayCurrencyForAsset,
  type RelayRouteSpec,
} from "./mappings.js";
import { rejectDisabledRelayCapabilities } from "./schemas.js";

export type RelayDepositAddressPolicyInput = Readonly<{
  mode: "strict" | "open";
  sourceKind: "controlled_wallet" | "exchange" | "privy" | "manual";
  controlledSender: boolean;
  refundOwnership: "user_owned" | "app_controlled";
  privyIngress: boolean;
  destinationCalldata: string | null;
}>;

export type StrictRelayDepositAddressInput = Readonly<{
  route: RelayRouteSpec;
  sourceAmount: Money;
  minimumOutput: Money;
  senderAddress: string;
  recipientAddress: string;
  refundAddress: string;
  policy: RelayDepositAddressPolicyInput;
  deadline: Date;
  now?: Date;
}>;

export type StrictRelayDepositAddressPlan = Readonly<{
  mode: "strict";
  amountMode: "exact_input";
  depositAddress: string;
  exactAmount: Money;
  expectedOutput: Money;
  minimumOutput: Money;
  requestId: string;
  requestFingerprint: string;
  expiresAt: string;
  requestTracking: "request_and_children";
  wrongAssetBehavior: "stop_and_manual_recovery_not_guaranteed";
  wrongChainBehavior: "stop_and_manual_recovery_not_guaranteed";
  underpaymentBehavior: "fail_closed_and_reconcile_refund";
  overpaymentBehavior: "execute_exact_and_reconcile_excess_refund";
}>;

export function assertStrictRelayDepositAddressPolicy(
  policy: RelayDepositAddressPolicyInput,
): void {
  if (policy.mode !== "strict") {
    throw new Error("Relay open/variable Deposit Address mode is disabled");
  }
  if (policy.sourceKind === "exchange") {
    throw new Error("Relay Deposit Address CEX sender mode is disabled");
  }
  if (policy.sourceKind === "privy" || policy.privyIngress) {
    throw new Error("Privy-to-Relay Deposit Address composition is disabled");
  }
  if (policy.sourceKind !== "controlled_wallet" || !policy.controlledSender) {
    throw new Error(
      "Relay Deposit Address requires a controlled wallet source",
    );
  }
  if (policy.refundOwnership !== "user_owned") {
    throw new Error("Relay refund location must be user-owned");
  }
  if (policy.destinationCalldata != null) {
    throw new Error("Relay Deposit Address destination calldata is disabled");
  }
}

function normalizeAddress(value: string, vm: "evm" | "svm"): string {
  return vm === "evm"
    ? getAddress(value).toLowerCase()
    : new PublicKey(value).toBase58();
}

export class StrictRelayDepositAddressAdapter {
  constructor(
    readonly client: RelayClient,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async create(
    input: StrictRelayDepositAddressInput,
  ): Promise<StrictRelayDepositAddressPlan> {
    assertStrictRelayDepositAddressPolicy(input.policy);
    assertRelayRouteAssets(
      input.route,
      input.sourceAmount.asset,
      input.minimumOutput.asset,
    );
    if (
      input.route.sourceVm !== "evm" ||
      normalizeRelayAssetId(
        input.route.source.networkId,
        input.route.source.assetId,
      ) !== ZeroAddress
    ) {
      throw new Error(
        "Relay strict Deposit Address v1 is pinned to native EVM input",
      );
    }
    if (
      BigInt(input.sourceAmount.raw) <= 0n ||
      BigInt(input.minimumOutput.raw) <= 0n
    ) {
      throw new Error("Relay Deposit Address amounts must be positive");
    }
    const now = input.now ?? this.clock();
    if (input.deadline <= now) {
      throw new Error("Relay Deposit Address deadline expired");
    }
    const refundAddress = normalizeAddress(
      input.refundAddress,
      input.route.sourceVm,
    );
    const senderAddress = normalizeAddress(
      input.senderAddress,
      input.route.sourceVm,
    );
    const recipientAddress = normalizeAddress(
      input.recipientAddress,
      input.route.destinationVm,
    );
    if (refundAddress !== senderAddress) {
      throw new Error(
        "Relay refund address must be the verified controlled source in v1",
      );
    }
    const quote = await this.client.quote({
      user: senderAddress,
      recipient: recipientAddress,
      originChainId: relayChainIdForNetwork(input.route.source.networkId),
      destinationChainId: relayChainIdForNetwork(
        input.route.destination.networkId,
      ),
      originCurrency: relayCurrencyForAsset(input.route.source),
      destinationCurrency: relayCurrencyForAsset(input.route.destination),
      amount: input.sourceAmount.raw,
      tradeType: "EXACT_INPUT",
      useDepositAddress: true,
      strict: true,
      refundTo: refundAddress,
    });
    const completedAt = this.clock();
    if (input.deadline <= completedAt) {
      throw new Error(
        "Relay Deposit Address quote expired before validation completed",
      );
    }
    rejectDisabledRelayCapabilities(quote);
    normalizeRelayFees(quote);
    const currencyIn = quote.details.currencyIn;
    const currencyOut = quote.details.currencyOut;
    if (
      currencyIn.currency.chainId !==
        relayChainIdForNetwork(input.route.source.networkId) ||
      normalizeRelayAssetId(
        input.route.source.networkId,
        currencyIn.currency.address,
      ) !==
        normalizeRelayAssetId(
          input.route.source.networkId,
          input.route.source.assetId,
        ) ||
      currencyIn.amount !== input.sourceAmount.raw ||
      currencyIn.minimumAmount !== input.sourceAmount.raw ||
      (currencyIn.currency.decimals !== undefined &&
        currencyIn.currency.decimals !== input.route.source.decimals)
    ) {
      throw new Error("Relay strict Deposit Address source mismatch");
    }
    if (
      currencyOut.currency.chainId !==
        relayChainIdForNetwork(input.route.destination.networkId) ||
      normalizeRelayAssetId(
        input.route.destination.networkId,
        currencyOut.currency.address,
      ) !==
        normalizeRelayAssetId(
          input.route.destination.networkId,
          input.route.destination.assetId,
        ) ||
      (currencyOut.currency.decimals !== undefined &&
        currencyOut.currency.decimals !== input.route.destination.decimals)
    ) {
      throw new Error("Relay strict Deposit Address destination mismatch");
    }
    if (
      quote.details.sender !== undefined &&
      normalizeAddress(quote.details.sender, input.route.sourceVm) !==
        senderAddress
    ) {
      throw new Error("Relay strict Deposit Address sender mismatch");
    }
    if (
      quote.details.recipient !== undefined &&
      normalizeAddress(quote.details.recipient, input.route.destinationVm) !==
        recipientAddress
    ) {
      throw new Error("Relay strict Deposit Address recipient mismatch");
    }
    const steps = quote.steps;
    if (steps.length !== 1 || steps[0]?.id !== "deposit") {
      throw new Error(
        "Relay strict Deposit Address must have one deposit step",
      );
    }
    const step = steps[0];
    if (step.items.length !== 1) {
      throw new Error(
        "Relay strict Deposit Address must contain one transfer item",
      );
    }
    const item = step.items[0];
    if (!item || item.status !== "incomplete" || step.kind !== "transaction") {
      throw new Error("Relay strict Deposit Address step is not executable");
    }
    const depositAddress = step.depositAddress ?? quote.depositAddress;
    if (!depositAddress) {
      throw new Error("Relay strict Deposit Address response has no address");
    }
    const normalizedDepositAddress = normalizeAddress(
      depositAddress,
      input.route.sourceVm,
    );
    if (
      step.depositAddress &&
      quote.depositAddress &&
      normalizeAddress(quote.depositAddress, input.route.sourceVm) !==
        normalizeAddress(step.depositAddress, input.route.sourceVm)
    ) {
      throw new Error("Relay Deposit Address fields disagree");
    }
    const dataKeys = Object.keys(item.data).sort();
    if (
      dataKeys.join(",") !==
      ["chainId", "data", "from", "to", "value"].join(",")
    ) {
      throw new Error(
        "Relay Deposit Address transfer contains an unknown capability",
      );
    }
    if (item.data.data !== "0x") {
      throw new Error(
        "Relay Deposit Address may not contain destination calldata",
      );
    }
    if (
      typeof item.data.to !== "string" ||
      normalizeAddress(item.data.to, input.route.sourceVm) !==
        normalizedDepositAddress
    ) {
      throw new Error("Relay Deposit Address transfer target mismatch");
    }
    if (
      Number(item.data.chainId) !==
        relayChainIdForNetwork(input.route.source.networkId) ||
      typeof item.data.from !== "string" ||
      normalizeAddress(item.data.from, input.route.sourceVm) !== senderAddress
    ) {
      throw new Error("Relay Deposit Address transfer source mismatch");
    }
    if (String(item.data.value) !== input.sourceAmount.raw) {
      throw new Error("Relay strict Deposit Address amount mismatch");
    }
    const correlated = item.check
      ? new URL(item.check.endpoint, "https://api.relay.link").searchParams.get(
          "requestId",
        )
      : null;
    if (item.check?.method !== "GET" || correlated !== step.requestId) {
      throw new Error("Relay Deposit Address request correlation mismatch");
    }
    const output = quote.details.currencyOut;
    if (
      BigInt(output.amount) <= 0n ||
      BigInt(output.minimumAmount) <= 0n ||
      BigInt(output.minimumAmount) > BigInt(output.amount) ||
      BigInt(output.minimumAmount) < BigInt(input.minimumOutput.raw)
    ) {
      throw new Error("Relay Deposit Address minimum output below floor");
    }
    const requestFingerprint = canonicalJsonHash({
      provider: "relay",
      requestId: step.requestId,
    });
    return {
      mode: "strict",
      amountMode: "exact_input",
      depositAddress: normalizedDepositAddress,
      exactAmount: input.sourceAmount,
      expectedOutput: {
        asset: input.route.destination,
        raw: output.amount,
      },
      minimumOutput: {
        asset: input.route.destination,
        raw: output.minimumAmount,
      },
      requestId: step.requestId,
      requestFingerprint,
      expiresAt: new Date(
        Math.min(input.deadline.getTime(), completedAt.getTime() + 60_000),
      ).toISOString(),
      requestTracking: "request_and_children",
      wrongAssetBehavior: "stop_and_manual_recovery_not_guaranteed",
      wrongChainBehavior: "stop_and_manual_recovery_not_guaranteed",
      underpaymentBehavior: "fail_closed_and_reconcile_refund",
      overpaymentBehavior: "execute_exact_and_reconcile_excess_refund",
    };
  }
}
