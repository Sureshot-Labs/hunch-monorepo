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
  | {
      holderPositionState?: "increased" | "reduced" | "unchanged" | "unknown";
      kind: "price_move";
      priceMoveCents: number;
    }
  | { kind: "wallet_count_change" };

export function isRepresentativeTraderResearchDelta(
  value: EditorialResearchDelta | null,
): boolean {
  return (
    value?.kind !== "position_change" || value.scope === "representative_wallet"
  );
}

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
  if (!label || /^(?:(?:a|the)\s+)?(?:trader|wallet)$/i.test(label))
    return null;
  return label;
}

function sentenceActor(value: string): string {
  return value === "the trader" ? "The trader" : value;
}

function possessiveActor(value: string): string {
  if (value === "the trader") return "the trader's";
  return /s$/i.test(value) ? `${value}'` : `${value}'s`;
}

function negativeMoveSubject(marketLabel: string): string {
  const cleaned = cleanPublicMarketText(marketLabel) ?? marketLabel.trim();
  if (/^\d+(?:\.\d+)?\s*bps\s+increase\b/i.test(cleaned)) {
    return `The probability of no ${cleaned}`;
  }
  return `The NO price on ${cleaned}`;
}

export function normalizeSignalBotPublicLanguage(value: string): string {
  return value
    .replace(/\bfading\b/gi, "betting against")
    .replace(/\bfades\b/gi, "bets against")
    .replace(/\bfaded\b/gi, "backed away from")
    .replace(/\bfade\b/gi, "bet against")
    .replace(/\bthis wallet\b/gi, "this trader")
    .replace(/\bthe wallet\b/gi, "the trader")
    .replace(/\ba wallet\b/gi, "a trader");
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

function resolveMatchupNarrative(
  value: string,
): { favorite: string; opponent: string } | null {
  const cleaned = cleanPublicMarketText(value)?.trim();
  const match = cleaned?.match(/^(.+?)\s+over\s+(.+)$/i);
  if (!match?.[1] || !match[2]) return null;
  return { favorite: match[1].trim(), opponent: match[2].trim() };
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
    ) ?? "the trader";
  const priceTarget = resolvePriceTargetNarrative(input.marketLabel);
  const matchup = resolveMatchupNarrative(input.marketLabel);

  if (
    input.messageKind === "research_update" &&
    (input.headlineTemplateKey === "research_position_added_v7" ||
      input.headlineTemplateKey === "research_position_reduced_v7") &&
    input.researchDelta?.kind === "position_change" &&
    input.researchDelta.scope === "selected_side_cluster" &&
    input.side != null &&
    input.price != null
  ) {
    const added = input.researchDelta.positionChangeUsd > 0;
    const amount = formatSignalBotPreciseCompactUsd(
      Math.abs(input.researchDelta.positionChangeUsd),
    );
    const combined = formatSignalBotPreciseCompactUsd(
      input.researchDelta.afterUsd,
    );
    const probability =
      input.editorialProbability == null
        ? null
        : formatCents(input.editorialProbability);
    const marketSubject =
      /^\d+(?:\.\d+)?\s+(?:bps?|basis points?)\s+(?:increase|decrease)\b/i.test(
        input.marketLabel,
      )
        ? `A ${input.marketLabel}`
        : capitalize(input.marketLabel);
    return [
      probability
        ? `${marketSubject} is priced near ${probability}, leaving ${input.side} around ${formatCents(input.price)}.`
        : `${input.side} is trading around ${formatCents(input.price)}.`,
      `Tracked traders ${added ? "added" : "cut"} ${amount} ${
        added ? "to" : "from"
      } ${input.side}, ${
        added
          ? `bringing their combined position to ${combined}`
          : `leaving their combined position at ${combined}`
      }.`,
    ];
  }

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
      `The trader is now holding ${formatSignalBotPreciseCompactUsd(input.researchDelta.afterUsd)} on NO`,
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
    input.headlineTemplateKey === "research_profitable_trader_hold_v13" &&
    input.researchDelta?.kind === "price_move" &&
    input.researchDelta.priceMoveCents > 0 &&
    input.side != null &&
    input.price != null &&
    trackRecordUsd != null &&
    input.note.holderPositionUsd != null &&
    input.note.holderPositionUsd > 0 &&
    input.note.holderOpenPnlUsd != null &&
    input.note.holderOpenPnlUsd > 0
  ) {
    const move = `${Math.max(1, Math.round(input.researchDelta.priceMoveCents))}¢`;
    const position = formatSignalBotPreciseCompactUsd(
      input.note.holderPositionUsd,
    );
    const openProfit = formatSignalBotPreciseCompactUsd(
      input.note.holderOpenPnlUsd,
      true,
    );
    const traderState =
      input.researchDelta.holderPositionState === "unchanged"
        ? `Rather than locking in gains, ${holderName} continues to hold ${position}`
        : input.researchDelta.holderPositionState === "reduced"
          ? `${sentenceActor(holderName)} has trimmed the position but still holds ${position}`
          : input.researchDelta.holderPositionState === "increased"
            ? `${sentenceActor(holderName)} has added after the move and now holds ${position}`
            : `${sentenceActor(holderName)} is still holding ${position}`;
    return [
      `Since the original call, ${input.side} has climbed ${move} to ${formatCents(input.price)}.`,
      `${traderState} on ${input.side}, with ${openProfit} in open profit after making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`,
    ];
  }

  if (
    input.messageKind === "research_update" &&
    (input.headlineTemplateKey ===
      "research_profitable_price_target_hold_v11" ||
      input.headlineTemplateKey ===
        "research_profitable_price_target_hold_v12") &&
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
    const sharp = Math.abs(input.researchDelta.priceMoveCents) >= 10;
    const profitable =
      input.note.holderOpenPnlUsd != null && input.note.holderOpenPnlUsd > 0;
    const firstParagraph = favorable
      ? `The market has moved ${sharp ? "sharply " : ""}in the trader's favor, with ${input.side} rising from ${formatCents(beforePrice)} to ${formatCents(input.price)} since the original call.`
      : `The market has moved against the trader, with ${input.side} falling from ${formatCents(beforePrice)} to ${formatCents(input.price)} since the original call.`;
    const actor = sentenceActor(holderName);
    const position = formatSignalBotPreciseCompactUsd(
      input.note.holderPositionUsd,
    );
    const pnl =
      input.note.holderOpenPnlUsd != null &&
      Math.abs(input.note.holderOpenPnlUsd) >= 1
        ? input.note.holderOpenPnlUsd > 0
          ? formatSignalBotPreciseCompactUsd(input.note.holderOpenPnlUsd, true)
          : formatSignalBotPreciseCompactUsd(
              Math.abs(input.note.holderOpenPnlUsd),
            )
        : null;
    return [
      firstParagraph,
      profitable && pnl
        ? `Despite sitting on ${pnl} in open profit, ${holderName} is still holding ${position} on ${input.side} after making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`
        : `${actor} is still holding ${position} on ${input.side}${pnl ? ` despite an open loss of ${pnl}` : ""} after making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`,
    ];
  }

  if (
    input.messageKind === "research_update" &&
    input.headlineTemplateKey === "research_profitable_trader_underwater_v12" &&
    input.researchDelta?.kind === "price_move" &&
    input.side === "NO" &&
    input.price != null &&
    trackRecordUsd != null &&
    input.note.holderPositionUsd != null &&
    input.note.holderPositionUsd > 0 &&
    input.note.holderOpenPnlUsd != null &&
    input.note.holderOpenPnlUsd < 0
  ) {
    const beforePrice = Math.max(
      0,
      Math.min(1, input.price - input.researchDelta.priceMoveCents / 100),
    );
    const position = formatSignalBotPreciseCompactUsd(
      input.note.holderPositionUsd,
    );
    const loss = formatSignalBotPreciseCompactUsd(
      Math.abs(input.note.holderOpenPnlUsd),
    );
    return [
      `${negativeMoveSubject(input.marketLabel)} has dropped from ${formatCents(beforePrice)} to ${formatCents(input.price)}, but ${holderName} continues to hold a ${position} position despite being down ${loss}.`,
      `After making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days, ${possessiveActor(holderName)} continued conviction is what makes this position worth watching.`,
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
      `${input.sideLabel} is already a heavy favorite, but this trader has still built a ${position} position while making ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} over the last ${horizonDays} days.`,
      `At ${formatCents(input.price)}, there is little room left for error, so risking ${position} is a strong statement of conviction.`,
    ];
  }

  if (
    input.messageKind === "initial" &&
    input.headlineTemplateKey === "initial_actor_stakes_v10" &&
    matchup &&
    input.sideLabel &&
    input.price != null &&
    input.note.holderPositionUsd != null &&
    input.note.holderPositionUsd > 0 &&
    trackRecordUsd != null
  ) {
    const position = formatSignalBotPreciseCompactUsd(
      input.note.holderPositionUsd,
    );
    const positionSubject =
      input.sideLabel.toLocaleLowerCase("en-US") ===
      matchup.favorite.toLocaleLowerCase("en-US")
        ? `${matchup.favorite} against ${matchup.opponent}`
        : input.sideLabel;
    return [
      `${input.sideLabel} is priced around ${formatCents(input.price)}, and ${holderName} is holding ${position} on ${positionSubject}.`,
      `Over the last ${horizonDays} days, they are up ${formatSignalBotPreciseCompactUsd(trackRecordUsd)} and still hold the position.`,
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
