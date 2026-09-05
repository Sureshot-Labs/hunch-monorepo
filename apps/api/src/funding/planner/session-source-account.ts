import type { AccountValueReadModel } from "../../account-value/runtime-service.js";

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
