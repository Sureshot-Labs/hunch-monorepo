import type { HolderResearchPerformanceAuditResult } from "./holder-research-performance.js";
import type { SignalBotStatsPeriod } from "./signal-bot-command-parsers.js";
import {
  formatMarketSegmentLabel,
  formatMarketTypeLabel,
} from "./market-type-classifier.js";

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

  const measuredSignals = overall.positive + overall.negative + overall.flat;
  const totalPnlUsd = overall.totalPnlPerDollar * input.buyAmountUsd;
  const totalStakeUsd = measuredSignals * input.buyAmountUsd;
  const roi = totalStakeUsd > 0 ? totalPnlUsd / totalStakeUsd : null;
  const knownResolved = overall.correct + overall.wrong;
  const resolvedLine =
    knownResolved > 0
      ? `🎯 Resolved: ${overall.correct}W / ${overall.wrong}L (${formatPercent(overall.correct / knownResolved)})`
      : "🎯 Resolved: not enough yet";
  const pnlLine =
    measuredSignals > 0
      ? `💰 $${input.buyAmountUsd} each: ${formatSignedUsd(totalPnlUsd)} (${formatSignedPercent(roi)})`
      : `💰 $${input.buyAmountUsd} each: waiting for price data`;
  const lines = [
    `📊 Hunch signals · ${periodLabel}`,
    "",
    pnlLine,
    resolvedLine,
    `📈 Marked up: ${overall.positive} · down: ${overall.negative}`,
    `⏳ Open: ${overall.open} · 🏁 Resolved: ${overall.resolved}${overall.unknown > 0 ? ` · Pending: ${overall.unknown}` : ""}`,
  ];
  if (measuredSignals < overall.notes) {
    lines.push(
      `Coverage: ${measuredSignals}/${overall.notes} priced and marked · missing entry: ${overall.missingEntry} · missing mark: ${Math.max(0, overall.withEntry - measuredSignals)}`,
    );
  }
  if (input.result.truncated)
    lines.push(`Partial report: newest ${overall.notes} signals shown.`);

  if (input.detail) {
    const detailLines = buildSignalBotStatsDetailLines(input.result, {
      buyAmountUsd: input.buyAmountUsd,
    });
    if (detailLines.length > 0) {
      lines.push("", ...detailLines);
    }
  }

  lines.push(
    "",
    "Hypothetical gross returns. Open signals use current market marks.",
  );
  return lines.join("\n");
}

function buildSignalBotStatsDetailLines(
  result: HolderResearchPerformanceAuditResult,
  input: { buyAmountUsd: number },
): string[] {
  const lines: string[] = ["Details"];
  for (const [key, label] of [
    ["resolved", "Settled PnL"],
    ["open", "Open marks"],
  ] as const) {
    const aggregate = result.aggregates.byState[key];
    if (aggregate) {
      const measured = aggregate.positive + aggregate.negative + aggregate.flat;
      lines.push(
        `${label}: ${measured > 0 ? formatSignedUsd(aggregate.totalPnlPerDollar * input.buyAmountUsd) : "unmeasured"} · ${measured}/${aggregate.notes} measured`,
      );
    }
  }
  const knownEvents = new Set(
    result.items.map((item) => item.eventId).filter(Boolean),
  );
  lines.push(
    `Events: ${knownEvents.size}${result.items.some((item) => !item.eventId) ? " · incomplete event coverage" : ""}`,
  );
  const omittedLosses = result.items.filter(
    (item) => item.outcome === "wrong" && item.entryPrice == null,
  ).length;
  if (omittedLosses > 0)
    lines.push(
      `Sensitivity: buying ${omittedLosses} unpriced confirmed losing signal(s) for $${input.buyAmountUsd} each adds ${formatSignedUsd(-omittedLosses * input.buyAmountUsd)}. Entry execution is unverified.`,
    );
  const segmentLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatMarketSegmentLabel,
    group: result.aggregates.byMarketSegment,
    title: "By category",
  });
  if (segmentLines.length > 0) lines.push(...segmentLines);
  const typeLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatMarketTypeLabel,
    group: result.aggregates.byMarketType,
    title: "By market type",
  });
  if (typeLines.length > 0) lines.push(...typeLines);
  const bucketLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatStatsBucketLabel,
    group: result.aggregates.byBucket,
    title: "By setup",
  });
  if (bucketLines.length > 0) lines.push(...bucketLines);
  const actorLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatStatsActorLabel,
    group: result.aggregates.byActorMode,
    title: "By wallet read",
  });
  if (actorLines.length > 0) lines.push(...actorLines);
  return lines.length > 1 ? lines : [];
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
      const measured = aggregate.positive + aggregate.negative + aggregate.flat;
      return `• ${input.formatter(key)}: ${measured > 0 ? formatSignedUsd(pnlUsd) : "unmeasured"} · ${resolved} · ${aggregate.notes} signals${measured < aggregate.notes ? ` · ${measured}/${aggregate.notes} measured` : ""}`;
    }),
  ];
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
