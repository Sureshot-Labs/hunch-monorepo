import type { MarketSideCopy } from "./market-side-copy.js";

export type SignalNotificationSubject = {
  preservedFields: Array<"deadline" | "outcome" | "predicate" | "threshold">;
  source: "market_side_copy" | "safe_full_title";
  text: string;
  version: "signal_notification_subject_v1";
};

export type SignalNotificationStoryKind =
  | "initial"
  | "price_move"
  | "flow"
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

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function quote(value: string): string {
  return `“${value.replace(/[“”]/g, '"')}”`;
}

function fullMarketTitle(input: {
  eventTitle?: string | null;
  marketTitle?: string | null;
}): string {
  const eventTitle = cleanText(input.eventTitle);
  const marketTitle = cleanText(input.marketTitle);
  if (eventTitle && marketTitle && eventTitle !== marketTitle) {
    return `${eventTitle} · ${marketTitle}`;
  }
  return marketTitle ?? eventTitle ?? "this market";
}

export function buildSignalNotificationSubject(input: {
  eventTitle?: string | null;
  marketTitle?: string | null;
  side: "NO" | "YES";
  sideCopy: MarketSideCopy;
}): SignalNotificationSubject {
  const marketLine = cleanText(input.sideCopy.marketLine);
  const fallback = fullMarketTitle(input);
  const generic = input.sideCopy.copyKind === "generic";
  const text = generic
    ? `${input.side} on ${quote(fallback)}`
    : input.side === "NO" && input.sideCopy.copyKind === "team_yes_no"
      ? `NO on ${quote(fallback)}`
      : (marketLine ?? `${input.side} on ${quote(fallback)}`);
  const preservedFields: SignalNotificationSubject["preservedFields"] = [
    "predicate",
    "outcome",
  ];
  if (/\b\d+(?:\.\d+)?\b/.test(text)) preservedFields.push("threshold");
  if (/\b(?:by|before|on)\s+[A-Z][a-z]{2,}|\b20\d{2}\b/.test(text)) {
    preservedFields.push("deadline");
  }
  return {
    preservedFields,
    source: generic ? "safe_full_title" : "market_side_copy",
    text,
    version: "signal_notification_subject_v1",
  };
}

function formatCents(probability: number): string {
  const cents = probability * 100;
  return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
}

function formatMove(cents: number): string {
  const absolute = Math.abs(cents);
  return `${Number.isInteger(absolute) ? absolute.toFixed(0) : absolute.toFixed(1)}¢`;
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
  cooling?: boolean;
  currentPrice: number | null;
  joinedWallets?: number;
  kind:
    | "initial"
    | "research_update"
    | "stats"
    | "resolved_win"
    | "resolved_loss";
  netCopyFlowUsd?: number;
  priceMoveCents?: number | null;
  subject: SignalNotificationSubject;
}): SignalNotificationHeadline {
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

  let storyKind: SignalNotificationStoryKind;
  let templateKey: string;
  let primaryMetric: string | null = null;
  let supportingMetric: string | null = null;
  let textWithoutSupportingClause: string | null = null;
  let text: string;

  if (input.kind === "resolved_win" || input.kind === "resolved_loss") {
    const won = input.kind === "resolved_win";
    storyKind = won ? "resolved_win" : "resolved_loss";
    templateKey = won ? "resolution_win_v1" : "resolution_loss_v1";
    text = `🏁 ${input.subject.text} ${won ? "wins" : "loses"}`;
  } else if (input.cooling) {
    storyKind = "cooling";
    templateKey = "cooling_v1";
    primaryMetric = netFlow !== 0 ? formatCompactUsd(netFlow) : null;
    text = `⚠️ ${input.subject.text} flow is cooling`;
  } else if (priceMove != null && priceMove <= -2 && netFlow > 0) {
    storyKind = "divergence";
    templateKey = "divergence_inflow_price_down_v1";
    primaryMetric = formatMove(priceMove);
    supportingMetric = formatCompactUsd(netFlow);
    text = `⚠️ ${input.subject.text} slips ${formatMove(priceMove)} despite ${formatCompactUsd(netFlow)} inflow`;
    textWithoutSupportingClause = `⚠️ ${input.subject.text} slips ${formatMove(priceMove)}`;
  } else if (
    priceMove != null &&
    Math.abs(priceMove) >= 2 &&
    currentPrice != null
  ) {
    storyKind = "price_move";
    templateKey = `price_move_${priceMoveVerb(priceMove).replace(/\s+/g, "_")}_v1`;
    primaryMetric = formatMove(priceMove);
    supportingMetric = formatCents(currentPrice);
    text = `${priceMove > 0 ? "🔥" : "⚠️"} ${input.subject.text} ${priceMoveVerb(priceMove)} ${formatMove(priceMove)} to ${formatCents(currentPrice)}`;
  } else if (netFlow !== 0) {
    storyKind = "flow";
    templateKey = priceMove != null ? "flow_flat_price_v1" : "flow_v1";
    primaryMetric = formatCompactUsd(netFlow);
    supportingMetric = currentPrice == null ? null : formatCents(currentPrice);
    text = `🔥 ${input.subject.text} draws ${formatCompactUsd(netFlow)} in net copy flow`;
  } else if (joinedWallets > 0) {
    storyKind = "participation";
    templateKey = "participation_v1";
    primaryMetric = String(joinedWallets);
    text = `👀 ${joinedWallets} wallets build ${input.subject.text} positions`;
  } else {
    storyKind = "initial";
    templateKey =
      input.kind === "research_update"
        ? "research_update_v1"
        : "initial_call_v1";
    primaryMetric = currentPrice == null ? null : formatCents(currentPrice);
    text =
      input.kind === "research_update"
        ? currentPrice == null
          ? `🔎 ${input.subject.text} research update`
          : `🔎 ${input.subject.text} research update at ${formatCents(currentPrice)}`
        : currentPrice == null
          ? `👀 Hunch flags ${input.subject.text}`
          : `🔥 Hunch calls ${input.subject.text} at ${formatCents(currentPrice)}`;
  }

  if (visibleLength(text) > 80 && textWithoutSupportingClause != null) {
    text = textWithoutSupportingClause;
  }
  const length = visibleLength(text);
  return {
    lintExceeded: length > 80,
    primaryMetric,
    storyKind,
    subjectVersion: input.subject.version,
    supportingMetric,
    templateKey,
    text,
    visibleLength: length,
  };
}
