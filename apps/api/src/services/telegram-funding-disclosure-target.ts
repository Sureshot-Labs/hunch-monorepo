import type { Pool } from "@hunch/infra";

import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import {
  isTelegramFundingManagedSolanaWalletCurrent,
  isTelegramFundingReceiveControllerCurrent,
} from "../funding/execution/telegram-funding-managed-wallet.js";
import { fetchFundingReceiveSessionForUser } from "../funding/persistence/funding-receive-session-repository.js";
import { parseDirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";
import { fetchActiveTelegramFundingConsent } from "./telegram-funding-sessions.js";

/**
 * Revalidates every wallet identity whose address can appear in a Telegram
 * funding card. Most routes disclose only the EVM destination controller. A
 * retained-SOL route additionally discloses the selected owned Solana source,
 * so its exact consent target must still be current at projection and again
 * immediately before delivery.
 */
export async function isTelegramFundingReceiveDisclosureTargetCurrent(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    expectedReceiveAddress?: string | null;
    fundingContextId: string;
    receiveSessionId: string;
    retainedSolanaTarget: boolean;
    telegramAccountId: string;
    telegramUserId: string;
    userId: string;
  }>,
): Promise<boolean> {
  if (!(await isTelegramFundingReceiveControllerCurrent(pool, input))) {
    return false;
  }
  if (!input.retainedSolanaTarget) return true;
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
    !sameAsset(consent.asset, SOLANA_NATIVE_ASSET) ||
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
    target.networkId !== SOLANA_NATIVE_ASSET.networkId ||
    target.acceptedAssets.filter(
      (candidate) =>
        candidate.handling === "direct" &&
        sameAsset(candidate.asset, SOLANA_NATIVE_ASSET),
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
      sameAsset(candidate.asset, SOLANA_NATIVE_ASSET) &&
      sameAccountAddress(
        SOLANA_NATIVE_ASSET.networkId,
        candidate.destinationAddress,
        target.destinationAddress,
      ),
  );
  if (
    retainedVariants.length !== 1 ||
    (input.expectedReceiveAddress != null &&
      !sameAccountAddress(
        SOLANA_NATIVE_ASSET.networkId,
        input.expectedReceiveAddress,
        target.destinationAddress,
      ))
  ) {
    return false;
  }
  return isTelegramFundingManagedSolanaWalletCurrent(pool, {
    telegramAccountId: input.telegramAccountId,
    telegramUserId: input.telegramUserId,
    userId: input.userId,
    walletAddress: target.destinationAddress,
  });
}
