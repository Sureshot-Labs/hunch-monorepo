import { holderResearchReportCategory } from "./holder-research-report-category.js";

export function marketMapTopic(
  category: string | null | undefined,
  slug: string | null,
  metadata: unknown,
): string | null {
  const topic = category
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const providerClass =
    metadata && typeof metadata === "object" ? metadata : {};
  const sport = holderResearchReportCategory({
    marketType: topic === "sports" ? "single_game_sports" : "",
    marketSegment: topic ?? "",
    eventMetadata: { ...providerClass, ticker: slug ?? "" },
  });
  if (sport.startsWith("sports_") && sport !== "sports_unknown") return sport;
  return topic &&
    !["other", "unknown", "uncategorized", "sports"].includes(topic)
    ? topic
    : null;
}

export function mapTopicComposition<T extends { topic?: string | null }>(
  points: readonly T[],
) {
  const counts = new Map<string, number>();
  for (const { topic } of points)
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  const ordered = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const known = ordered.reduce((n, [, count]) => n + count, 0);
  const enoughCoverage = known * 2 >= points.length;
  const dominant =
    enoughCoverage && ordered[0] && ordered[0][1] * 2 > known
      ? ordered[0][0]
      : null;
  return {
    dominant,
    mixed: enoughCoverage && counts.size > 1,
    known,
    prefer: dominant ? points.filter((p) => p.topic === dominant) : [...points],
    label:
      ordered
        .slice(0, 2)
        .map(([key]) =>
          key
            .replace(/^sports_/, "")
            .replace(/_game$/, "")
            .replaceAll("_", " "),
        )
        .join(" / ") + (counts.size > 2 ? " + more" : ""),
  };
}
