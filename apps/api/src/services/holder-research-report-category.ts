/** Reporting only. Never used by candidate selection or publication gates. */
export function holderResearchReportCategory(input: {
  marketType: string;
  marketSegment: string;
  marketMetadata?: unknown;
  eventMetadata?: unknown;
}): string {
  const records = [input.marketMetadata, input.eventMetadata].map((value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {},
  );
  const explicit = records
    .flatMap((row) => [
      row.sport,
      row.league,
      row.sportSlug,
      typeof row.ticker === "string" ? row.ticker.split("-")[0] : null,
    ])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const categories: Array<[string, string[]]> = [
    ["sports_american_football", ["nfl", "ncaaf", "cfb", "american-football"]],
    ["sports_tennis_game", ["atp", "wta", "tennis"]],
    ["sports_baseball_game", ["mlb", "baseball"]],
    ["sports_basketball_game", ["nba", "wnba", "ncaab", "basketball"]],
    [
      "sports_esports_game",
      ["cs2", "csgo", "dota2", "dota", "lol", "valorant", "esports"],
    ],
    [
      "sports_soccer_game",
      ["soccer", "epl", "laliga", "seriea", "bundesliga", "mls", "ucl"],
    ],
    ["sports_cricket_game", ["cricket", "ipl", "t20"]],
  ];
  for (const [category, aliases] of categories)
    if (explicit.some((value) => aliases.includes(value))) return category;
  return input.marketType === "single_game_sports" ||
    input.marketSegment.startsWith("sports_")
    ? "sports_unknown"
    : input.marketSegment;
}

export function formatHolderReportCategory(value: string): string | null {
  if (value === "sports_american_football") return "American football";
  if (value === "sports_unknown") return "Sport unspecified";
  return null;
}
