import type { HolderResearchPerformanceAuditResult } from "./holder-research-performance.js";
import {
  formatMarketSegmentLabel,
  formatMarketTypeLabel,
} from "./market-type-classifier.js";
import type { SignalBotStatsPeriod } from "./signal-bot-command-parsers.js";
import {
  telegramRichBold,
  telegramRichFooter,
  telegramRichMetricsTable,
  telegramRichParagraph,
  telegramRichText,
  type TelegramInputRichMessage,
} from "./telegram-rich-message.js";

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatStatsBucketLabel(value: string): string {
  switch (value) {
    case "followup_existing":
      return "Follow-ups";
    case "sharp_side":
      return "Strong same-side wallets";
    case "sharp_minority":
      return "Minority wallet reads";
    case "sharp_split":
      return "Split strong wallets";
    case "clean_disagreement":
      return "Clean disagreement";
    case "recent_flow":
      return "Recent flow";
    case "event_bridge":
      return "Event bridge";
    case "concentration_risk":
      return "Concentration risk";
    case "unknown":
      return "Unknown setup";
    default:
      return value.replace(/_/g, " ");
  }
}

function formatStatsActorLabel(value: string): string {
  switch (value) {
    case "sharp_cluster":
      return "Wallet clusters";
    case "single_holder":
      return "Single wallets";
    case "none":
      return "No clear wallet";
    case "unknown":
      return "Unknown read";
    default:
      return value.replace(/_/g, " ");
  }
}

function formatStatsAggregateGroup(input: {
  amountUsd: number;
  formatter: (key: string) => string;
  group: Record<
    string,
    HolderResearchPerformanceAuditResult["aggregates"]["overall"]
  >;
  title: string;
}): string[] {
  const rows = Object.entries(input.group)
    .filter(([, aggregate]) => aggregate.notes > 0)
    .sort((left, right) => {
      const leftPnl = Math.abs(left[1].totalPnlPerDollar);
      const rightPnl = Math.abs(right[1].totalPnlPerDollar);
      if (leftPnl !== rightPnl) return rightPnl - leftPnl;
      return right[1].notes - left[1].notes;
    })
    .slice(0, 4);
  if (rows.length === 0) return [];
  return [
    input.title,
    ...rows.map(([key, aggregate]) => {
      const pnlUsd = aggregate.totalPnlPerDollar * input.amountUsd;
      const knownResolved = aggregate.correct + aggregate.wrong;
      const resolved =
        knownResolved > 0
          ? `${aggregate.correct}W / ${aggregate.wrong}L`
          : "open only";
      return `• ${input.formatter(key)}: ${formatSignedUsd(pnlUsd)} · ${resolved} · ${aggregate.notes} signals`;
    }),
  ];
}

function buildSignalBotStatsDetailLines(
  result: HolderResearchPerformanceAuditResult,
  input: { buyAmountUsd: number },
): string[] {
  const lines: string[] = ["Details"];
  const groups = [
    {
      formatter: formatMarketSegmentLabel,
      group: result.aggregates.byMarketSegment,
      title: "By category",
    },
    {
      formatter: formatMarketTypeLabel,
      group: result.aggregates.byMarketType,
      title: "By market type",
    },
    {
      formatter: formatStatsBucketLabel,
      group: result.aggregates.byBucket,
      title: "By setup",
    },
    {
      formatter: formatStatsActorLabel,
      group: result.aggregates.byActorMode,
      title: "By wallet read",
    },
  ];
  for (const group of groups) {
    const groupLines = formatStatsAggregateGroup({
      amountUsd: input.buyAmountUsd,
      ...group,
    });
    if (groupLines.length > 0) lines.push(...groupLines);
  }
  return lines.length > 1 ? lines : [];
}

export function buildSignalBotStatsReport(input: {
  buyAmountUsd: number;
  detail?: boolean;
  period: SignalBotStatsPeriod;
  result: HolderResearchPerformanceAuditResult;
}): string {
  const periodLabel = input.period.toUpperCase();
  const overall = input.result.aggregates.overall;
  if (input.result.evaluated === 0 || overall.notes === 0) {
    return `No bot-eligible signals for ${periodLabel} yet.`;
  }
  const measuredSignals = overall.withEntry;
  const totalPnlUsd = overall.totalPnlPerDollar * input.buyAmountUsd;
  const totalStakeUsd = measuredSignals * input.buyAmountUsd;
  const roi = totalStakeUsd > 0 ? totalPnlUsd / totalStakeUsd : null;
  const knownResolved = overall.correct + overall.wrong;
  const lines = [
    `📊 Hunch signals · ${periodLabel}`,
    "",
    measuredSignals > 0
      ? `💰 $${input.buyAmountUsd} each: ${formatSignedUsd(totalPnlUsd)} (${formatSignedPercent(roi)})`
      : `💰 $${input.buyAmountUsd} each: waiting for price data`,
    knownResolved > 0
      ? `🎯 Resolved: ${overall.correct}W / ${overall.wrong}L (${formatPercent(overall.correct / knownResolved)})`
      : "🎯 Resolved: not enough yet",
    `📈 Marked up: ${overall.positive} · down: ${overall.negative}`,
    `⏳ Open: ${overall.open} · 🏁 Resolved: ${overall.resolved}`,
  ];
  if (input.detail) {
    const detailLines = buildSignalBotStatsDetailLines(input.result, {
      buyAmountUsd: input.buyAmountUsd,
    });
    if (detailLines.length > 0) lines.push("", ...detailLines);
  }
  lines.push("", "Open signals use current market marks.");
  return lines.join("\n");
}

export function buildSignalBotStatsRichReport(input: {
  buyAmountUsd: number;
  detail?: boolean;
  period: SignalBotStatsPeriod;
  result: HolderResearchPerformanceAuditResult;
}): TelegramInputRichMessage {
  const periodLabel = input.period.toUpperCase();
  const overall = input.result.aggregates.overall;
  if (input.result.evaluated === 0 || overall.notes === 0) {
    return {
      blocks: [
        telegramRichParagraph(
          telegramRichText(
            "📊 ",
            telegramRichBold(`Hunch signals · ${periodLabel}`),
          ),
        ),
        telegramRichParagraph(
          `No bot-eligible signals for ${periodLabel} yet.`,
        ),
      ],
    };
  }
  const measuredSignals = overall.withEntry;
  const totalPnlUsd = overall.totalPnlPerDollar * input.buyAmountUsd;
  const totalStakeUsd = measuredSignals * input.buyAmountUsd;
  const roi = totalStakeUsd > 0 ? totalPnlUsd / totalStakeUsd : null;
  const knownResolved = overall.correct + overall.wrong;
  const blocks: TelegramInputRichMessage["blocks"] = [
    telegramRichParagraph(
      telegramRichText(
        "📊 ",
        telegramRichBold(`Hunch signals · ${periodLabel}`),
      ),
    ),
    telegramRichMetricsTable({
      caption: telegramRichBold("Overview"),
      valueAlign: "right",
      rows: [
        {
          label: `$${input.buyAmountUsd} each`,
          value:
            measuredSignals > 0
              ? telegramRichBold(
                  `${formatSignedUsd(totalPnlUsd)} (${formatSignedPercent(roi)})`,
                )
              : "Waiting for price data",
        },
        {
          label: "Resolved",
          value:
            knownResolved > 0
              ? telegramRichBold(
                  `${overall.correct}W / ${overall.wrong}L (${formatPercent(
                    overall.correct / knownResolved,
                  )})`,
                )
              : "Not enough yet",
        },
        {
          label: "Marked",
          value: telegramRichBold(
            `${overall.positive} up · ${overall.negative} down`,
          ),
        },
        {
          label: "Lifecycle",
          value: telegramRichBold(
            `${overall.open} open · ${overall.resolved} resolved`,
          ),
        },
      ],
    }),
  ];
  if (input.detail) {
    const groups = [
      {
        formatter: formatMarketSegmentLabel,
        group: input.result.aggregates.byMarketSegment,
        title: "By category",
      },
      {
        formatter: formatMarketTypeLabel,
        group: input.result.aggregates.byMarketType,
        title: "By market type",
      },
      {
        formatter: formatStatsBucketLabel,
        group: input.result.aggregates.byBucket,
        title: "By setup",
      },
      {
        formatter: formatStatsActorLabel,
        group: input.result.aggregates.byActorMode,
        title: "By wallet read",
      },
    ];
    for (const group of groups) {
      const rows = Object.entries(group.group)
        .filter(([, aggregate]) => aggregate.notes > 0)
        .sort((left, right) => {
          const leftPnl = Math.abs(left[1].totalPnlPerDollar);
          const rightPnl = Math.abs(right[1].totalPnlPerDollar);
          if (leftPnl !== rightPnl) return rightPnl - leftPnl;
          return right[1].notes - left[1].notes;
        })
        .slice(0, 4)
        .map(([key, aggregate]) => {
          const pnlUsd = aggregate.totalPnlPerDollar * input.buyAmountUsd;
          const resolved =
            aggregate.correct + aggregate.wrong > 0
              ? `${aggregate.correct}W / ${aggregate.wrong}L`
              : "open only";
          return {
            label: group.formatter(key),
            value: telegramRichText(
              telegramRichBold(formatSignedUsd(pnlUsd)),
              ` · ${resolved} · ${aggregate.notes} signals`,
            ),
          };
        });
      if (rows.length > 0) {
        blocks.push(
          telegramRichMetricsTable({
            caption: telegramRichBold(group.title),
            rows,
            valueAlign: "right",
          }),
        );
      }
    }
  }
  blocks.push(telegramRichFooter("Open signals use current market marks."));
  return { blocks };
}
