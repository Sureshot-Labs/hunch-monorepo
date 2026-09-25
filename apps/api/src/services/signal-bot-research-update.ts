import type { SignalBotNote } from "./signal-bot-contracts.js";
import type { SignalNotificationResearchDelta } from "./signal-notification-headline.js";
import { resolveHolderResearchPositionState } from "./signal-publication-contract.js";

export type SignalBotResearchDelta = SignalNotificationResearchDelta & {
  supportsBuy: boolean;
};

export function resolveSignalBotResearchDelta(
  note: Pick<
    SignalBotNote,
    | "holderResearchUpdateV1"
    | "revisionKind"
    | "decisionSnapshot"
    | "previousDecisionSnapshot"
    | "holderWalletId"
  >,
  side: "NO" | "YES" | null,
): SignalBotResearchDelta | null {
  const contract = note.holderResearchUpdateV1;
  if (
    note.revisionKind !== "research_update" ||
    !side ||
    !contract ||
    contract.selectedSide !== side
  )
    return null;
  const reason = contract.primaryReason;
  if (
    reason.kind === "price_moved_with_thesis" ||
    reason.kind === "price_moved_against_thesis"
  ) {
    return {
      currentPrice: reason.after,
      holderPositionState: resolveHolderResearchPositionState({
        current: note.decisionSnapshot,
        previous: note.previousDecisionSnapshot,
        side,
        update: contract,
        walletId: note.holderWalletId,
      }),
      kind: "price_move",
      priceMoveCents: reason.delta * 100,
      supportsBuy: contract.ctaIntent === "buy",
    };
  }
  if (
    reason.kind === "position_increased" ||
    reason.kind === "position_reduced"
  ) {
    return {
      afterUsd: reason.after,
      beforeUsd: reason.before,
      kind: "position_change",
      positionChangeUsd: reason.delta,
      scope: reason.scope,
      supportsBuy: contract.ctaIntent === "buy",
      walletId: reason.walletId,
    };
  }
  if (reason.kind === "wallet_confluence_changed") {
    return {
      afterWallets: reason.after,
      beforeWallets: reason.before,
      kind: "wallet_count_change",
      supportsBuy: contract.ctaIntent === "buy",
      walletChange: reason.delta,
    };
  }
  if (reason.kind === "opposing_wallet_confluence_changed") {
    return {
      afterWallets: reason.after,
      beforeWallets: reason.before,
      kind: "opposing_wallet_count_change",
      observedSide: reason.observedSide,
      supportsBuy: false,
      walletChange: reason.delta,
    };
  }
  if (
    reason.kind === "opposing_position_increased" ||
    reason.kind === "opposing_position_reduced"
  ) {
    return {
      afterUsd: reason.after,
      beforeUsd: reason.before,
      kind: "opposing_position_change",
      observedSide: reason.observedSide,
      positionChangeUsd: reason.delta,
      supportsBuy: false,
    };
  }
  if (reason.kind === "new_external_fact") {
    return {
      eventAt: reason.eventAt,
      fact: reason.fact,
      kind: reason.kind,
      sourcePublishedAt: reason.sourcePublishedAt,
      sourceTitle: reason.sourceTitle,
      sourceUrl: reason.sourceUrl,
      supportsBuy: false,
    };
  }
  return null;
}
