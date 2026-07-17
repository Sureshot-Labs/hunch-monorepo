import type { MarketSideCopy } from "./market-side-copy.js";
import type { TelegramMarketPresentationV1 } from "./telegram-market-presentation.js";
import {
  DEFAULT_SIGNAL_POST_COPY_POLICY,
  type SignalPostCopyPolicyV1,
} from "./signal-post-copy-policy.js";

export type SignalNotificationSubject = {
  preservedFields: Array<"deadline" | "outcome" | "predicate" | "threshold">;
  source:
    | "canonical_market_presentation"
    | "market_side_copy"
    | "natural_market_proposition"
    | "safe_full_title";
  text: string;
  version: "signal_notification_subject_v3";
};

export type SignalNotificationStoryKind =
  | "initial"
  | "price_move"
  | "flow"
  | "confluence"
  | "participation"
  | "divergence"
  | "cooling"
  | "resolved_win"
  | "resolved_loss";

export type SignalNotificationHeadline = {
  lintExceeded: boolean;
  primaryMetric: string | null;
  storyKind: SignalNotificationStoryKind;
  subjectVersion: SignalNotificationSubject["version"];
  supportingMetric: string | null;
  templateKey: string;
  text: string;
  visibleLength: number;
};

export type SignalNotificationResearchDelta =
  | {
      currentPrice: number;
      kind: "price_move";
      priceMoveCents: number;
    }
  | {
      kind: "position_change";
      positionChangeUsd: number;
    }
  | {
      kind: "wallet_count_change";
      walletChange: number;
    };

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function fullMarketTitle(input: {
  eventTitle?: string | null;
  marketTitle?: string | null;
}): string {
  const eventTitle = cleanText(input.eventTitle);
  const marketTitle = cleanText(input.marketTitle);
  if (eventTitle && marketTitle && eventTitle !== marketTitle) {
    return `${eventTitle} — ${marketTitle}`;
  }
  return marketTitle ?? eventTitle ?? "this market";
}

function formatCompactThreshold(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function buildPriceTargetProposition(input: {
  eventTitle: string | null;
  marketTitle: string | null;
}): string | null {
  if (!input.eventTitle || !input.marketTitle) return null;
  const eventMatch = input.eventTitle.match(
    /^what price will\s+(bitcoin|btc)\s+hit\s+(in|by)\s+(.+?)[?]?$/i,
  );
  const targetMatch = input.marketTitle.match(
    /^[↑↓]\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)$/,
  );
  if (!eventMatch?.[2] || !eventMatch[3] || !targetMatch?.[1]) return null;
  const threshold = Number(targetMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  return `BTC hitting ${formatCompactThreshold(threshold)} ${eventMatch[2].toLowerCase()} ${eventMatch[3]}`;
}

function buildNaturalSubject(input: {
  eventTitle: string | null;
  marketTitle: string | null;
  side: "NO" | "YES";
  sideCopy: MarketSideCopy;
}): string | null {
  const priceTarget = buildPriceTargetProposition(input);
  if (priceTarget) return `${input.side} on ${priceTarget}`;

  const eventTitle = input.eventTitle;
  const marketTitle = input.marketTitle;
  const sideLabel = cleanText(input.sideCopy.sideLabel) ?? input.side;

  if (input.sideCopy.copyKind === "total" && eventTitle) {
    return `${sideLabel} in ${eventTitle}`;
  }
  if (input.sideCopy.copyKind === "named_outcome") {
    if (
      eventTitle &&
      !eventTitle.toLowerCase().includes(sideLabel.toLowerCase())
    ) {
      return `${sideLabel} in ${eventTitle}`;
    }
    return sideLabel;
  }
  if (input.sideCopy.copyKind === "team_yes_no" && marketTitle) {
    const team = marketTitle
      .replace(/^will\s+/i, "")
      .replace(/\s+win[?]?$/i, "")
      .trim();
    const eventWinner = eventTitle?.match(/^(.+?)\s+winner$/i)?.[1]?.trim();
    if (team && eventWinner) {
      return `${input.side} on ${team} winning ${eventWinner}`;
    }
    if (team && /^will\s+/i.test(marketTitle)) {
      return `${input.side} on ${team} winning`;
    }
    if (eventTitle && eventTitle.toLowerCase() !== marketTitle.toLowerCase()) {
      return `${input.side} on ${team} in ${eventTitle}`;
    }
    return `${input.side} on ${team}`;
  }
  if (eventTitle && marketTitle && eventTitle !== marketTitle) {
    return `${input.side} on ${marketTitle} in ${eventTitle}`;
  }
  return null;
}

export function buildSignalNotificationSubject(input: {
  eventTitle?: string | null;
  marketTitle?: string | null;
  side: "NO" | "YES";
  sideCopy: MarketSideCopy;
  presentation?: TelegramMarketPresentationV1 | null;
}): SignalNotificationSubject {
  const eventTitle = cleanText(input.eventTitle);
  const marketTitle = cleanText(input.marketTitle);
  const priceTarget = buildPriceTargetProposition({ eventTitle, marketTitle });
  if (
    priceTarget &&
    (!input.presentation || input.presentation.source !== "approved_override")
  ) {
    return {
      preservedFields: ["predicate", "outcome", "threshold", "deadline"],
      source: "natural_market_proposition",
      text: `${input.side} on ${priceTarget}`,
      version: "signal_notification_subject_v3",
    };
  }
  if (input.presentation) {
    const position = input.presentation.positions[input.side];
    const subject = cleanText(input.presentation.subject) ?? "this market";
    const text =
      input.presentation.source === "approved_override"
        ? subject
        : position.canonicalLabel !== input.side &&
            !subject
              .toLocaleLowerCase("en-US")
              .includes(position.canonicalLabel.toLocaleLowerCase("en-US"))
          ? `${position.canonicalLabel} in ${subject}`
          : `${input.side} on ${input.presentation.predicate}`;
    return {
      preservedFields: [
        "predicate",
        "outcome",
        ...(input.presentation.threshold ? (["threshold"] as const) : []),
        ...(input.presentation.deadline ? (["deadline"] as const) : []),
      ],
      source: "canonical_market_presentation",
      text,
      version: "signal_notification_subject_v3",
    };
  }
  const natural = buildNaturalSubject({
    eventTitle,
    marketTitle,
    side: input.side,
    sideCopy: input.sideCopy,
  });
  const marketLine = cleanText(input.sideCopy.marketLine);
  const genericFallback = `${input.side} on ${fullMarketTitle(input)}`;
  const text = natural ?? marketLine ?? genericFallback;
  const preservedFields: SignalNotificationSubject["preservedFields"] = [
    "predicate",
    "outcome",
  ];
  if (/\b\d+(?:\.\d+)?\b/.test(text)) preservedFields.push("threshold");
  if (/\b(?:by|before|on|in)\s+[A-Z][a-z]{2,}|\b20\d{2}\b/.test(text)) {
    preservedFields.push("deadline");
  }
  return {
    preservedFields,
    source: natural
      ? "natural_market_proposition"
      : marketLine
        ? "market_side_copy"
        : "safe_full_title",
    text,
    version: "signal_notification_subject_v3",
  };
}

function formatCents(probability: number): string {
  return `${Math.round(probability * 100)}¢`;
}

function formatMove(cents: number): string {
  return `${Math.max(1, Math.round(Math.abs(cents)))}¢`;
}

function formatCompactUsd(value: number): string {
  const absolute = Math.abs(value);
  const formatted =
    absolute >= 1_000_000
      ? `$${(absolute / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
      : absolute >= 1_000
        ? `$${(absolute / 1_000).toFixed(1).replace(/\.0$/, "")}K`
        : `$${Math.round(absolute)}`;
  return value < 0 ? `-${formatted}` : formatted;
}

function visibleLength(value: string): number {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
    ).length;
  }
  return Array.from(value).length;
}

function priceMoveVerb(cents: number): string {
  const absolute = Math.abs(cents);
  if (cents > 0) {
    if (absolute >= 10) return "jumps";
    if (absolute >= 5) return "rises";
    return "edges up";
  }
  if (absolute >= 10) return "drops";
  if (absolute >= 5) return "falls";
  return "edges down";
}

export function buildSignalNotificationHeadline(input: {
  actorMode?: "none" | "sharp_cluster" | "single_holder" | null;
  cooling?: boolean;
  currentPrice: number | null;
  exitedWallets?: number;
  holderPositionUsd?: number | null;
  joinedWallets?: number;
  kind:
    | "initial"
    | "research_update"
    | "stats"
    | "resolved_win"
    | "resolved_loss";
  netCopyFlowUsd?: number;
  positionLabel?: string | null;
  priceMoveCents?: number | null;
  researchDelta?: SignalNotificationResearchDelta | null;
  strongWallets?: number | null;
  subject: SignalNotificationSubject;
  trimmedWallets?: number;
  policy?: SignalPostCopyPolicyV1;
}): SignalNotificationHeadline {
  const policy = input.policy ?? DEFAULT_SIGNAL_POST_COPY_POLICY;
  const currentPrice =
    input.currentPrice != null &&
    Number.isFinite(input.currentPrice) &&
    input.currentPrice >= 0 &&
    input.currentPrice <= 1
      ? input.currentPrice
      : null;
  const priceMove =
    input.priceMoveCents != null && Number.isFinite(input.priceMoveCents)
      ? input.priceMoveCents
      : null;
  const netFlow = Number.isFinite(input.netCopyFlowUsd)
    ? (input.netCopyFlowUsd ?? 0)
    : 0;
  const joinedWallets = Math.max(0, Math.trunc(input.joinedWallets ?? 0));
  const trimmedWallets = Math.max(0, Math.trunc(input.trimmedWallets ?? 0));
  const exitedWallets = Math.max(0, Math.trunc(input.exitedWallets ?? 0));
  const strongWallets = Math.max(0, Math.trunc(input.strongWallets ?? 0));
  const holderPositionUsd =
    input.holderPositionUsd != null && Number.isFinite(input.holderPositionUsd)
      ? Math.max(0, input.holderPositionUsd)
      : 0;
  const positionLabel = cleanText(input.positionLabel) ?? input.subject.text;
  const contradictoryBreadth =
    exitedWallets > 0 || trimmedWallets > joinedWallets;
  const materialPositiveFlow = netFlow >= policy.materialNetFlowUsd;
  const strongPositiveMove =
    priceMove != null && priceMove >= policy.strongPriceMoveCents;

  let storyKind: SignalNotificationStoryKind;
  let templateKey: string;
  let primaryMetric: string | null = null;
  let supportingMetric: string | null = null;
  let textWithoutSupportingClause: string | null = null;
  let text: string;

  if (input.kind === "resolved_win" || input.kind === "resolved_loss") {
    const won = input.kind === "resolved_win";
    storyKind = won ? "resolved_win" : "resolved_loss";
    templateKey = won ? "resolution_win_v2" : "resolution_loss_v2";
    text = `🏁 ${input.subject.text} ${won ? "wins" : "loses"}`;
  } else if (input.kind === "initial" || input.kind === "research_update") {
    storyKind = "initial";
    if (input.kind === "research_update") {
      const delta = input.researchDelta;
      if (delta?.kind === "price_move") {
        storyKind = "price_move";
        templateKey = "research_price_move_v5";
        primaryMetric = formatMove(delta.priceMoveCents);
        supportingMetric = formatCents(delta.currentPrice);
        text = `${delta.priceMoveCents > 0 ? "📈" : "📉"} ${input.subject.text} ${priceMoveVerb(delta.priceMoveCents)} ${formatMove(delta.priceMoveCents)} to ${formatCents(delta.currentPrice)}`;
      } else if (delta?.kind === "position_change") {
        const added = delta.positionChangeUsd > 0;
        storyKind = added ? "flow" : "cooling";
        templateKey = added
          ? "research_position_added_v5"
          : "research_position_reduced_v5";
        primaryMetric = formatCompactUsd(Math.abs(delta.positionChangeUsd));
        text = `${added ? "💰" : "⚠️"} ${formatCompactUsd(
          Math.abs(delta.positionChangeUsd),
        )} ${added ? "added to" : "leaves"} ${input.subject.text}`;
      } else if (delta?.kind === "wallet_count_change") {
        const added = delta.walletChange > 0;
        const wallets = Math.abs(delta.walletChange);
        storyKind = added ? "participation" : "cooling";
        templateKey = added
          ? "research_wallets_added_v5"
          : "research_wallets_left_v5";
        primaryMetric = String(wallets);
        text = `${added ? "🎯" : "⚠️"} ${wallets} strong ${
          wallets === 1 ? "wallet" : "wallets"
        } ${added ? "join" : "leave"} ${input.subject.text}`;
      } else {
        templateKey = "research_update_suppressed_v5";
        primaryMetric = null;
        text = `🔎 Update: ${input.subject.text}`;
      }
    } else if (input.actorMode === "sharp_cluster" && strongWallets >= 2) {
      templateKey = "initial_strong_wallet_cluster_v2";
      primaryMetric = String(strongWallets);
      supportingMetric =
        currentPrice == null ? null : formatCents(currentPrice);
      text = `🎯 ${strongWallets} strong wallets back ${positionLabel}${
        currentPrice == null ? "" : ` at ${formatCents(currentPrice)}`
      }`;
    } else if (
      input.actorMode === "single_holder" &&
      holderPositionUsd >= policy.materialSingleWalletUsd
    ) {
      templateKey = "initial_position_size_v2";
      primaryMetric = formatCompactUsd(holderPositionUsd);
      supportingMetric =
        currentPrice == null ? null : formatCents(currentPrice);
      text = `💰 ${formatCompactUsd(holderPositionUsd)} backs ${positionLabel}${
        currentPrice == null ? "" : ` at ${formatCents(currentPrice)}`
      }`;
    } else {
      templateKey = "initial_watch_v2";
      primaryMetric = currentPrice == null ? null : formatCents(currentPrice);
      text = `👀 ${input.subject.text}${
        currentPrice == null
          ? " is on the radar"
          : ` trades at ${formatCents(currentPrice)}`
      }`;
    }
  } else if (input.cooling) {
    storyKind = "cooling";
    templateKey = exitedWallets > 0 ? "cooling_exits_v5" : "cooling_v5";
    primaryMetric = netFlow !== 0 ? formatCompactUsd(netFlow) : null;
    text =
      exitedWallets > 0
        ? `⚠️ ${exitedWallets} ${
            exitedWallets === 1 ? "wallet exits" : "wallets exit"
          } ${input.subject.text}`
        : `⚠️ ${input.subject.text} is losing wallet support`;
  } else if (
    priceMove != null &&
    priceMove <= -policy.minimumPriceMoveCents &&
    netFlow > 0
  ) {
    storyKind = "divergence";
    templateKey = "divergence_inflow_price_down_v2";
    primaryMetric = formatMove(priceMove);
    supportingMetric = formatCompactUsd(netFlow);
    text = `⚠️ ${input.subject.text} slips ${formatMove(priceMove)} despite ${formatCompactUsd(netFlow)} inflow`;
    textWithoutSupportingClause = `⚠️ ${input.subject.text} slips ${formatMove(priceMove)}`;
  } else if (
    materialPositiveFlow &&
    strongPositiveMove &&
    !contradictoryBreadth
  ) {
    storyKind = "confluence";
    templateKey = "capital_price_confluence_v2";
    primaryMetric = formatCompactUsd(netFlow);
    supportingMetric = formatMove(priceMove ?? 0);
    text = `🔥 ${formatCompactUsd(netFlow)} backs ${input.subject.text} after a ${formatMove(priceMove ?? 0)} move`;
    textWithoutSupportingClause = `🔥 ${formatCompactUsd(netFlow)} backs ${input.subject.text}`;
  } else if (materialPositiveFlow) {
    storyKind = "flow";
    templateKey = "material_net_flow_v2";
    primaryMetric = formatCompactUsd(netFlow);
    supportingMetric = currentPrice == null ? null : formatCents(currentPrice);
    text = `💰 ${formatCompactUsd(netFlow)} net flow backs ${input.subject.text}`;
  } else if (
    priceMove != null &&
    Math.abs(priceMove) >= policy.minimumPriceMoveCents &&
    currentPrice != null
  ) {
    storyKind = "price_move";
    templateKey = `price_move_${priceMoveVerb(priceMove).replace(/\s+/g, "_")}_v2`;
    primaryMetric = formatMove(priceMove);
    supportingMetric = formatCents(currentPrice);
    text = `${priceMove > 0 ? "📈" : "📉"} ${input.subject.text} ${priceMoveVerb(priceMove)} ${formatMove(priceMove)} to ${formatCents(currentPrice)}`;
  } else if (netFlow !== 0) {
    storyKind = "flow";
    primaryMetric = formatCompactUsd(netFlow);
    supportingMetric = currentPrice == null ? null : formatCents(currentPrice);
    if (netFlow > 0) {
      templateKey = "early_net_flow_v2";
      text = `👀 ${formatCompactUsd(netFlow)} net flow builds behind ${input.subject.text}`;
    } else {
      templateKey = "net_outflow_v2";
      text = `⚠️ ${formatCompactUsd(Math.abs(netFlow))} net outflow hits ${input.subject.text}`;
    }
  } else if (joinedWallets > 0) {
    storyKind = "participation";
    templateKey = "participation_v2";
    primaryMetric = String(joinedWallets);
    text = `👀 ${joinedWallets} wallets build positions in ${input.subject.text}`;
  } else {
    storyKind = "initial";
    templateKey = "watch_v2";
    primaryMetric = currentPrice == null ? null : formatCents(currentPrice);
    text = `👀 ${input.subject.text} is on the radar`;
  }

  if (
    visibleLength(text) > policy.headlineMaxGraphemes &&
    textWithoutSupportingClause != null
  ) {
    text = textWithoutSupportingClause;
  }
  const length = visibleLength(text);
  return {
    lintExceeded: length > policy.headlineMaxGraphemes,
    primaryMetric,
    storyKind,
    subjectVersion: input.subject.version,
    supportingMetric,
    templateKey,
    text,
    visibleLength: length,
  };
}
