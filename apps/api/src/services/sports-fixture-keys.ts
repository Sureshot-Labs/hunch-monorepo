export function slugifySportsKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TEAM_KEY_ALIASES: Record<string, string> = {
  usa: "united-states",
  us: "united-states",
  "u-s": "united-states",
  "united-states-of-america": "united-states",
  turkey: "turkiye",
  turkiye: "turkiye",
  "korea-republic": "south-korea",
  "republic-of-korea": "south-korea",
  "ir-iran": "iran",
  "dr-congo": "congo-dr",
  "democratic-republic-of-congo": "congo-dr",
  "cote-d-ivoire": "ivory-coast",
  "cabo-verde": "cape-verde",
  "bosnia-herzegovina": "bosnia-and-herzegovina",
  "czech-republic": "czechia",
};

export function canonicalSportsTeamKey(value: string): string {
  const key = slugifySportsKey(value);
  return TEAM_KEY_ALIASES[key] ?? key;
}

export function buildMatchFixtureKey(input: {
  localDate: string;
  homeTeam: string;
  awayTeam: string;
}): string {
  return `match:${input.localDate}:${canonicalSportsTeamKey(input.homeTeam)}:${canonicalSportsTeamKey(input.awayTeam)}`;
}

export function parseSportsMatchTeamsFromTitle(
  title: string | null | undefined,
): {
  homeTeam: string | null;
  awayTeam: string | null;
} {
  if (!title) return { homeTeam: null, awayTeam: null };
  const clean = title
    .replace(
      /\s+-\s+(More Markets|Exact Score|First Team to Score|First to Score|Player Props|Total Corners|Corners|Halftime Result|Halftime|First Half Result|First Half|Second Half Result|Second Half)$/i,
      "",
    )
    .split(":")[0]
    ?.trim();
  const match = clean.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
  if (!match) return { homeTeam: null, awayTeam: null };
  return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
}
