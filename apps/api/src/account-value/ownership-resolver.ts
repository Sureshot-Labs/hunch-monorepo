import { createHash } from "node:crypto";

import type {
  OwnershipGraph,
  WalletOwnershipResolver,
} from "../funding/domain/contracts.js";
import type {
  AssetRef,
  VenueAccountBinding,
  WalletExecutionProfile,
} from "../funding/domain/types.js";
import { stableOpaqueId } from "./canonical.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../funding/execution/sponsorship-policy.js";

export type ExistingWalletOwnershipFact = Readonly<{
  address: string;
  walletType: "ethereum" | "solana";
  source: "embedded" | "smart" | "external";
  linkedAddress: string;
  serverWalletRef: string | null;
}>;

export type ExistingVenueBindingFact = Readonly<{
  venueId: string;
  controllerAddress: string;
  executionAddress: string;
  accountRef: string;
  settlementAsset: AssetRef;
  signingMode: "web_client" | "privy_authorization" | "privy_delegated";
}>;

function walletProfile(
  fact: ExistingWalletOwnershipFact,
  networkId: string,
): WalletExecutionProfile {
  const internallyManaged =
    fact.source !== "external" && Boolean(fact.serverWalletRef);
  return {
    walletId: stableOpaqueId(
      "wallet",
      `${fact.walletType}:${networkId}:${fact.address.toLowerCase()}`,
    ),
    networkId,
    address: fact.address,
    source: fact.source,
    signingModes:
      fact.source === "external"
        ? ["web_client"]
        : fact.serverWalletRef
          ? ["web_client", "privy_authorization"]
          : ["web_client"],
    serverWalletRef: fact.serverWalletRef,
    sponsorshipPolicyIds:
      internallyManaged && networkId.startsWith("evm:")
        ? [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID]
        : [],
  };
}

export class ExistingFactsOwnershipResolver implements WalletOwnershipResolver {
  readonly #facts: readonly ExistingWalletOwnershipFact[];
  readonly #bindingFacts: readonly ExistingVenueBindingFact[];
  readonly #now: () => Date;

  constructor(inputs: {
    wallets: readonly ExistingWalletOwnershipFact[];
    venueBindings: readonly ExistingVenueBindingFact[];
    now?: () => Date;
  }) {
    this.#facts = inputs.wallets;
    this.#bindingFacts = inputs.venueBindings;
    this.#now = inputs.now ?? (() => new Date());
  }

  async resolve(accountId: string): Promise<OwnershipGraph> {
    const profiles: WalletExecutionProfile[] = [];
    for (const fact of this.#facts) {
      if (fact.walletType === "solana") {
        profiles.push(walletProfile(fact, "solana:mainnet"));
      } else {
        profiles.push(walletProfile(fact, "evm:137"));
        profiles.push(walletProfile(fact, "evm:8453"));
      }
    }
    const profileByAddressAndNetwork = new Map(
      profiles.map((profile) => [
        `${profile.networkId}:${profile.address.toLowerCase()}`,
        profile,
      ]),
    );
    const venueBindings = this.#bindingFacts.flatMap(
      (fact): VenueAccountBinding[] => {
        const controller =
          profileByAddressAndNetwork.get(
            `${fact.settlementAsset.networkId}:${fact.controllerAddress.toLowerCase()}`,
          ) ?? null;
        const execution =
          profileByAddressAndNetwork.get(
            `${fact.settlementAsset.networkId}:${fact.executionAddress.toLowerCase()}`,
          ) ?? null;
        if (!controller || !execution) return [];
        const bindingId = stableOpaqueId(
          "binding",
          `${accountId}:${fact.venueId}:${fact.accountRef.toLowerCase()}`,
        );
        return [
          {
            bindingId,
            venueId: fact.venueId,
            controllerWalletId: controller.walletId,
            executionWalletId: execution.walletId,
            accountRef: fact.accountRef,
            settlementLocation: {
              kind: "venue_account",
              locationId: stableOpaqueId(
                "location",
                `${bindingId}:${fact.settlementAsset.networkId}:${fact.settlementAsset.assetId.toLowerCase()}`,
              ),
              accountId,
              asset: fact.settlementAsset,
              details: {
                venueId: fact.venueId,
                accountRef: fact.accountRef,
                controllerWalletId: controller.walletId,
                address: fact.accountRef,
              },
            },
            signingMode: fact.signingMode,
          },
        ];
      },
    );
    const revisionInput = JSON.stringify({
      accountId,
      profiles: profiles.map((profile) => ({
        walletId: profile.walletId,
        networkId: profile.networkId,
        address: profile.address.toLowerCase(),
        source: profile.source,
        signingModes: profile.signingModes,
        serverWalletRef: profile.serverWalletRef,
        sponsorshipPolicyIds: profile.sponsorshipPolicyIds,
      })),
      venueBindings: venueBindings.map((binding) => ({
        bindingId: binding.bindingId,
        venueId: binding.venueId,
        accountRef: binding.accountRef.toLowerCase(),
        controllerWalletId: binding.controllerWalletId,
        executionWalletId: binding.executionWalletId,
        signingMode: binding.signingMode,
      })),
    });
    return {
      accountId,
      wallets: profiles,
      venueBindings,
      evidenceRevision: createHash("sha256")
        .update(revisionInput)
        .digest("hex"),
      asOf: this.#now().toISOString(),
    };
  }
}
