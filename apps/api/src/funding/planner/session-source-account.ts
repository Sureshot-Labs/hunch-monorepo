import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { sameAccountAddress } from "../domain/asset-identity.js";

export function externalWalletSourceLocationIds(
  account: AccountValueReadModel,
  session?: Readonly<{ connectedExternalWalletRefs: readonly string[] }>,
): readonly string[] {
  const connected = new Set(session?.connectedExternalWalletRefs ?? []);
  const externalProfiles = (account.ownership?.wallets ?? []).filter(
    (profile) =>
      profile.source === "external" &&
      (!session ||
        !profile.controllerWalletRef ||
        !connected.has(profile.controllerWalletRef)),
  );
  const externalWalletIds = new Set(
    externalProfiles.map((profile) => profile.walletId),
  );
  if (externalWalletIds.size === 0) return [];
  return account.projection.components.flatMap((component) => {
    // Owned Safe cash is venue inventory, not external-wallet ingress.
    if (
      !session &&
      component.location.kind === "venue_account" &&
      component.location.details.venueId === "polymarket" &&
      component.location.details.polymarketFunderKind === "safe"
    )
      return [];
    const walletId =
      component.location.kind === "wallet"
        ? component.location.details.walletId
        : component.location.kind === "venue_account"
          ? component.location.details.controllerWalletId
          : null;
    const linkedAddress = component.location.details.linkedAddress;
    const externallyControlled =
      component.location.kind === "venue_account" &&
      typeof linkedAddress === "string" &&
      externalProfiles.some(
        (profile) =>
          profile.source === "external" &&
          profile.networkId === component.amount.asset.networkId &&
          sameAccountAddress(profile.networkId, profile.address, linkedAddress),
      );
    return (typeof walletId === "string" && externalWalletIds.has(walletId)) ||
      externallyControlled
      ? [component.location.locationId]
      : [];
  });
}

/** An omitted connection list grants no external signing capability. Unlike
 * accounting scope, execution scope also gates Safe cash on its owner. */
export function unavailableSessionSourceLocationIds(
  account: AccountValueReadModel,
  connectedExternalWalletRefs: readonly string[] | undefined,
): readonly string[] {
  return externalWalletSourceLocationIds(account, {
    connectedExternalWalletRefs: connectedExternalWalletRefs ?? [],
  });
}

/** Connectivity is not ownership or authority. Keep accounting unchanged and
 * narrow only the execution profiles used to discover funding sources. */
export function sessionSourceAccount(
  account: AccountValueReadModel,
  connectedExternalWalletRefs: readonly string[] | undefined,
): AccountValueReadModel {
  if (connectedExternalWalletRefs === undefined || !account.ownership)
    return account;
  const connected = new Set(connectedExternalWalletRefs);
  return {
    ...account,
    connectedExternalWalletRefs,
    ownership: {
      ...account.ownership,
      wallets: account.ownership.wallets.filter(
        (profile) =>
          profile.source !== "external" ||
          (profile.controllerWalletRef != null &&
            connected.has(profile.controllerWalletRef)),
      ),
    },
  };
}
