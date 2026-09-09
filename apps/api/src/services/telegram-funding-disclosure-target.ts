import type { Pool } from "@hunch/infra";

import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import { isRetainedOwnedSourceAsset } from "../funding/receive/retained-solana-assets.js";
import {
  isTelegramFundingManagedReceiveWalletCurrent,
  isTelegramFundingReceiveControllerCurrent,
} from "../funding/execution/telegram-funding-managed-wallet.js";
import { fetchFundingReceiveSessionForUser } from "../funding/persistence/funding-receive-session-repository.js";
import { parseDirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";
import { fetchActiveTelegramFundingConsent } from "./telegram-funding-sessions.js";

/**
 * Revalidates every wallet identity whose address can appear in a Telegram
 * funding card. Most routes disclose only the EVM destination controller. A
 * retained-source route additionally discloses the selected owned source wallet,
 * so its exact consent target must still be current at projection and again
 * immediately before delivery.
 */
export async function isTelegramFundingReceiveDisclosureTargetCurrent(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    expectedReceiveAddress?: string | null;
    fundingContextId: string;
    receiveSessionId: string;
    retainedSourceTarget: boolean;
    telegramAccountId: string;
    telegramUserId: string;
    userId: string;
  }>,
): Promise<boolean> {
  if (!(await isTelegramFundingReceiveControllerCurrent(pool, input))) {
    return false;
  }
  if (!input.retainedSourceTarget) return true;
  const receive = await fetchFundingReceiveSessionForUser(pool, {
    receiveSessionId: input.receiveSessionId,
    userId: input.userId,
  });
  const consent = await fetchActiveTelegramFundingConsent(
    pool,
    input.fundingContextId,
  );
  if (
    !receive ||
    receive.ownerChannel !== "telegram" ||
    !consent ||
    consent.automationEnabled ||
    !isRetainedOwnedSourceAsset(consent.asset) ||
    consent.variantIds.length !== 1
  ) {
    return false;
  }
  const targets = receive.session.receiveTargets.filter(
    (candidate) => candidate.receiveTargetId === consent.receiveTargetId,
  );
  const target = targets.length === 1 ? targets[0] : null;
  if (
    !target ||
    target.networkId !== consent.asset.networkId ||
    target.acceptedAssets.filter(
      (candidate) =>
        candidate.handling === "direct" &&
        sameAsset(candidate.asset, consent.asset),
    ).length !== 1
  ) {
    return false;
  }
  let variants;
  try {
    variants = receive.observationVariants.map(
      parseDirectIngressObservationVariant,
    );
  } catch {
    return false;
  }
  const retainedVariants = variants.filter(
    (candidate) =>
      candidate.variantId === consent.variantIds[0] &&
      candidate.completion.kind === "retained_owned_source_credit" &&
      sameAsset(candidate.asset, consent.asset) &&
      sameAccountAddress(
        consent.asset.networkId,
        candidate.destinationAddress,
        target.destinationAddress,
      ),
  );
  if (
    retainedVariants.length !== 1 ||
    (input.expectedReceiveAddress != null &&
      !sameAccountAddress(
        consent.asset.networkId,
        input.expectedReceiveAddress,
        target.destinationAddress,
      ))
  ) {
    return false;
  }
  return isTelegramFundingManagedReceiveWalletCurrent(pool, {
    networkId: consent.asset.networkId,
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    userId: input.userId,
    walletAddress: target.destinationAddress,
  });
}
