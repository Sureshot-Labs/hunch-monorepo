import { stableOpaqueId } from "../../account-value/canonical.js";
import { isRelayPinnedStableAsset } from "../../funding-providers/relay/mappings.js";
import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingReceiveHandling,
} from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

export type ReceiveTargetVariant = Readonly<{
  networkId: string;
  asset: AssetRef;
  destinationAddress: string;
  completion: Readonly<{ kind: string }>;
}>;

export function fundingReceiveVariantHandling(
  variant: ReceiveTargetVariant,
): FundingReceiveHandling {
  if (variant.completion.kind === "direct_destination_credit") {
    return "direct";
  }
  return isRelayPinnedStableAsset(variant.asset)
    ? "automatic_conversion"
    : "review_required";
}

export function buildFundingReceiveTargets(
  variants: readonly ReceiveTargetVariant[],
): NonNullable<ExternalIngressInstruction["receiveTargets"]> {
  const grouped = new Map<
    string,
    {
      networkId: string;
      destinationAddress: string;
      acceptedAssets: {
        asset: AssetRef;
        handling: FundingReceiveHandling;
      }[];
    }
  >();
  for (const variant of variants) {
    const key = `${variant.networkId}:${variant.destinationAddress.toLowerCase()}`;
    const target = grouped.get(key) ?? {
      networkId: variant.networkId,
      destinationAddress: variant.destinationAddress,
      acceptedAssets: [],
    };
    target.acceptedAssets.push({
      asset: variant.asset,
      handling: fundingReceiveVariantHandling(variant),
    });
    grouped.set(key, target);
  }
  return [...grouped.values()].map((target) => ({
    receiveTargetId: stableOpaqueId(
      "receive_target",
      canonicalJsonHash(target),
    ),
    ...target,
    safeInstructions: [
      "Use only this network and one listed asset.",
      "You can send any amount.",
      "Do not mix different assets in one transfer.",
    ],
  }));
}
