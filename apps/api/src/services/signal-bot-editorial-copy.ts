import type { SignalEvidenceMetricV1 } from "./holder-research-signal-evidence.js";
import { cleanPublicMarketText } from "./market-side-copy.js";
import type { SignalNotificationHeadline } from "./signal-notification-headline.js";
import {
  telegramRichBold,
  telegramRichText,
  type TelegramRichText,
} from "./telegram-rich-message.js";

type EditorialNote = {
  holderDisplayName?: string | null;
  holderIdentityDisplayName?: string | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
};

type EditorialResearchDelta =
  | {
      afterUsd: number;
      kind: "position_change";
      positionChangeUsd: number;
      scope: "representative_wallet" | "selected_side_cluster";
    }
  | { kind: "price_move"; priceMoveCents: number }
  | { kind: "wallet_count_change" };

function formatCents(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}¢`;
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
}

function capitalize(value: string): string {
  return value.length > 0
    ? `${value[0]?.toLocaleUpperCase("en-US")}${value.slice(1)}`
    : value;
}

function publicHolderLabel(value: string | null | undefined): string | null {
  const label = value?.trim().replace(/\s+/g, " ").replace(/^@+/, "").trim();
  return label || null;
}

function scalarEvidenceValue(
  rows: SignalEvidenceMetricV1[],
  kind: SignalEvidenceMetricV1["kind"],
  unit: "usd" | "wallets",
): SignalEvidenceMetricV1 | null {
  return (
    rows.find(
      (row) =>
        row.kind === kind &&
        row.quality === "verified" &&
        row.measurement.kind === "scalar" &&
        row.measurement.unit === unit &&
        Number.isFinite(row.measurement.value),
    ) ?? null
  );
}

function resolvePriceTargetNarrative(
  value: string,
): { market: string; subject: string } | null {
  const cleaned = cleanPublicMarketText(value)
    ?.replace(/^(?:YES|NO)\s+on\s+/i, "")
    .replace(/^BTC\b/i, "Bitcoin")
    .replace(/^ETH\b/i, "Ethereum");
  const match = cleaned?.match(/^(Bitcoin|Ethereum)\s+hitting\s+(.+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const subject = `${capitalize(match[1])} hitting ${match[2]}`;
  return { market: subject, subject: capitalize(match[1]) };
}

export function formatSignalBotPreciseCompactUsd(
  value: number,
  signed = false,
): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : signed && value > 0 ? "+" : "";
  const compact = (amount: number, suffix: "B" | "K" | "M") =>
    `${sign}$${amount.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (absolute >= 1_000_000_000) return compact(absolute / 1_000_000_000, "B");
  if (absolute >= 1_000_000) return compact(absolute / 1_000_000, "M");
  if (absolute >= 1_000) return compact(absolute / 1_000, "K");
  return `${sign}$${Math.round(absolute)}`;
}

export function buildSignalBotStructuredNarrative(input: {
  editorialProbability: number | null;
  evidenceRows: SignalEvidenceMetricV1[];
  headlineTemplateKey: string;
  marketLabel: string;
  messageKind: "initial" | "research_update";
  note: EditorialNote;
  price: number | null;
  researchDelta: EditorialResearchDelta | null;
  side: "NO" | "YES" | null;
  sideLabel: string | null;
}): string[] | null {
  const trackRecord = scalarEvidenceValue(
    input.evidenceRows,
    "track_record",
    "usd",
  );
  const trackRecordUsd =
    trackRecord?.measurement.kind === "scalar"
      ? trackRecord.measurement.value
      : null;
  const horizonDays = trackRecord?.horizonDays ?? 30;
  const holderName =
    publicHolderLabel(
      input.note.holderIdentityDisplayName ?? input.note.holderDisplayName,
    ) ?? "the wallet";
  const priceTarget = resolvePriceTargetNarrative(input.marketLabel);

  if (
    input.messageKind === "research_update" &&
    input.headlineTemplateKey === "research_profitable_wallet_added_v11" &&
    input.researchDelta?.kind === "position_change" &&
    input.researchDelta.scope === "representative_wallet" &&
    input.researchDelta.positionChangeUsd > 0 &&
    input.side === "NO" &&
    input.price != null &&
    priceTarget &&
    trackRecordUsd != null
  ) {
    const probability = formatPercent(
      input.editorialProbability ?? 1 - input.price,
    );
    const profitAction =
      input.note.holderOpenPnlUsd != null && input.note.holderOpenPnlUsd > 0
        ? " instead of taking profit"
        : "";
    const state = [
      `The wallet is now holding ${formatSignalBotPreciseCompactUsd(input.researchDelta.afterUsd)} on NO`,
      input.note.holderOpenPnlUsd != null &&
      Math.abs(input.note.holderOpenPnlUsd) >= 1
        ? `is sitting on ${formatSignalBotPreciseCompactUsd(input.note.holderOpenPnlUsd, true)} open PnL`
        : null,
      `has made ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days`,
    ].filter((value): value is string => Boolean(value));
    return [
      `${priceTarget.market} is priced at ${probability}, but ${holderName} has increased its NO position${profitAction}.`,
      `${state.slice(0, -1).join(", ")}${state.length > 1 ? ", and " : ""}${state.at(-1)}.`,
    ];
  }

  if (
    input.messageKind === "research_update" &&
    input.headlineTemplateKey === "research_profitable_price_target_hold_v11" &&
    input.researchDelta?.kind === "price_move" &&
    input.side != null &&
    input.price != null &&
    priceTarget &&
    trackRecordUsd != null &&
    input.note.holderPositionUsd != null &&
    input.note.holderPositionUsd > 0
  ) {
    const beforePrice = Math.max(
      0,
      Math.min(1, input.price - input.researchDelta.priceMoveCents / 100),
    );
    const favorable = input.researchDelta.priceMoveCents > 0;
    const profitable =
      input.note.holderOpenPnlUsd != null && input.note.holderOpenPnlUsd > 0;
    const firstParagraph = profitable
      ? `The market has moved in the wallet's ${favorable ? "favor" : "opposite direction"}, with ${input.side} moving from ${formatCents(beforePrice)} to ${formatCents(input.price)}, but ${holderName} hasn't taken profit.`
      : `${input.side} moved from ${formatCents(beforePrice)} to ${formatCents(input.price)}, but ${holderName} is still holding.`;
    const openPnl =
      input.note.holderOpenPnlUsd != null &&
      Math.abs(input.note.holderOpenPnlUsd) >= 1
        ? ` and is now sitting on ${formatSignalBotPreciseCompactUsd(input.note.holderOpenPnlUsd, true)} open ${input.note.holderOpenPnlUsd > 0 ? "profit" : "loss"}`
        : "";
    return [
      firstParagraph,
      `${profitable ? "Instead, the" : "The"} wallet is still holding ${formatSignalBotPreciseCompactUsd(input.note.holderPositionUsd)} on ${input.side}${openPnl} after making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`,
    ];
  }

  if (
    input.messageKind === "initial" &&
    input.headlineTemplateKey === "initial_expensive_favorite_v11" &&
    input.sideLabel &&
    input.price != null &&
    input.note.holderPositionUsd != null &&
    input.note.holderPositionUsd > 0 &&
    trackRecordUsd != null
  ) {
    const position = formatSignalBotPreciseCompactUsd(
      input.note.holderPositionUsd,
    );
    return [
      `${input.sideLabel} is already a heavy favorite, but this wallet has still built a ${position} position while making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`,
      `At ${formatCents(input.price)}, there is little room left for error, so risking ${position} is a strong statement of conviction.`,
    ];
  }

  return null;
}

export function formatSignalNotificationHeadlineRichText(
  headline: SignalNotificationHeadline,
): TelegramRichText {
  return telegramRichText(
    `${headline.emoji} `,
    telegramRichBold(headline.hook),
    headline.continuation ? ` ${headline.continuation}` : null,
  );
}

function emphasizeNarrativeString(value: string): TelegramRichText {
  const metricPattern =
    /([+−-]?\$\d[\d,.]*(?:\.\d+)?[KMB]?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?¢)/g;
  const parts = value.split(metricPattern);
  return telegramRichText(
    ...parts.map((part, index) =>
      index % 2 === 1 ? telegramRichBold(part) : part,
    ),
  );
}

export function emphasizeSignalBotNarrativeText(
  value: TelegramRichText,
): TelegramRichText {
  if (typeof value === "string") return emphasizeNarrativeString(value);
  if (Array.isArray(value)) return value.map(emphasizeSignalBotNarrativeText);
  if ("text" in value) {
    return { ...value, text: emphasizeSignalBotNarrativeText(value.text) };
  }
  return value;
}

export function splitSignalBotNarrative(value: string): string[] {
  const sentences =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter("en", { granularity: "sentence" }).segment(value),
          (segment) => segment.segment.trim(),
        ).filter(Boolean)
      : value
          .split(/(?<=[.!?])\s+/)
          .map((sentence) => sentence.trim())
          .filter(Boolean);
  if (sentences.length <= 2) return sentences;
  return [sentences[0] ?? value, sentences.slice(1).join(" ")];
}
