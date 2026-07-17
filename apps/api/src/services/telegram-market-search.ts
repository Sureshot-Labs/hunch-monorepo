import type { Pool } from "@hunch/infra";

import {
  fetchFeedMarketSearchCandidateIds,
  fetchFeedMarketsDirect,
  type FeedMarketRow,
} from "../repos/unified-read.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";

export type TelegramMarketSearchResult = {
  eventId: string;
  eventTitle: string | null;
  lastPrice: number | null;
  marketId: string;
  marketTitle: string;
  noAsk: number | null;
  venue: string;
  venueOptions?: TelegramMarketSearchVenueOption[];
  yesAsk: number | null;
};

export type TelegramMarketSearchVenueOption = Omit<
  TelegramMarketSearchResult,
  "venueOptions"
>;

const TELEGRAM_SEARCH_DISPLAY_LIMIT = 5;
const TELEGRAM_SEARCH_BASE_RESULT_LIMIT = 10;
const TELEGRAM_SEARCH_AGG_SEED_LIMIT = 5;
const TELEGRAM_SEARCH_DOMINANT_VENUE_RATIO = 0.6;

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTelegramMarketSearchResult(
  row: FeedMarketRow,
): TelegramMarketSearchResult {
  return {
    eventId: row.event_id,
    eventTitle: row.event_title,
    lastPrice: finiteNumber(row.last_price),
    marketId: row.market_uuid,
    marketTitle: row.market_title?.trim() || "Prediction market",
    noAsk: finiteNumber(row.best_ask_no),
    venue: row.venue,
    yesAsk: finiteNumber(row.best_ask_yes ?? row.best_ask),
  };
}

type SearchResultGroup = {
  baseRank: number;
  members: Map<string, TelegramMarketSearchVenueOption>;
  representative: TelegramMarketSearchVenueOption;
};

function resultOption(
  result: TelegramMarketSearchResult,
): TelegramMarketSearchVenueOption {
  const { venueOptions: _venueOptions, ...option } = result;
  return option;
}

function groupIntersects(group: SearchResultGroup, ids: Set<string>): boolean {
  for (const id of ids) {
    if (group.members.has(id)) return true;
  }
  return false;
}

function rankedVenueOptions(
  group: SearchResultGroup,
): TelegramMarketSearchVenueOption[] {
  const byVenue = new Map<string, TelegramMarketSearchVenueOption>();
  const representativeVenue = group.representative.venue.trim().toLowerCase();
  if (representativeVenue) {
    byVenue.set(representativeVenue, group.representative);
  }
  for (const member of group.members.values()) {
    const venue = member.venue.trim().toLowerCase();
    if (!venue || byVenue.has(venue)) continue;
    byVenue.set(venue, member);
  }
  const representative = byVenue.get(representativeVenue);
  const rest = [...byVenue.entries()]
    .filter(([venue]) => venue !== representativeVenue)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, option]) => option);
  return representative ? [representative, ...rest] : rest;
}

export function groupTelegramMarketSearchResults(input: {
  alternativesByMarketId: ReadonlyMap<
    string,
    TelegramMarketSearchVenueOption[]
  >;
  results: TelegramMarketSearchResult[];
}): TelegramMarketSearchResult[] {
  const baseById = new Map(
    input.results.map((result) => [result.marketId, resultOption(result)]),
  );
  const groups: SearchResultGroup[] = [];
  for (const [baseRank, baseResult] of input.results.entries()) {
    const representative = resultOption(baseResult);
    const family = [
      representative,
      ...(input.alternativesByMarketId.get(baseResult.marketId) ?? []),
    ];
    const normalizedFamily = new Map<string, TelegramMarketSearchVenueOption>();
    for (const member of family) {
      if (!member.marketId) continue;
      normalizedFamily.set(
        member.marketId,
        baseById.get(member.marketId) ?? member,
      );
    }
    const familyIds = new Set(normalizedFamily.keys());
    const matching = groups.filter((group) =>
      groupIntersects(group, familyIds),
    );
    const merged: SearchResultGroup = {
      baseRank,
      members: new Map(normalizedFamily),
      representative,
    };
    for (const group of matching) {
      if (group.baseRank < merged.baseRank) {
        merged.baseRank = group.baseRank;
        merged.representative = group.representative;
      }
      for (const [marketId, member] of group.members) {
        if (!merged.members.has(marketId)) merged.members.set(marketId, member);
      }
    }
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (matching.includes(groups[index])) groups.splice(index, 1);
    }
    groups.push(merged);
  }

  return groups
    .sort((left, right) => left.baseRank - right.baseRank)
    .map((group) => {
      const options = rankedVenueOptions(group);
      return {
        ...group.representative,
        ...(options.length > 1 ? { venueOptions: options } : {}),
      };
    });
}

export function diversifyTelegramMarketSearchResults(input: {
  limit: number;
  primary: TelegramMarketSearchResult[];
  secondary: TelegramMarketSearchResult[];
}): TelegramMarketSearchResult[] {
  const output: TelegramMarketSearchResult[] = [];
  const seen = new Set<string>();
  const maxLength = Math.max(input.primary.length, input.secondary.length);
  for (let index = 0; index < maxLength; index += 1) {
    for (const candidate of [input.primary[index], input.secondary[index]]) {
      if (!candidate || seen.has(candidate.marketId)) continue;
      seen.add(candidate.marketId);
      output.push(candidate);
      if (output.length >= input.limit) return output;
    }
  }
  return output;
}

function dominantVenue(results: TelegramMarketSearchResult[]): string | null {
  if (results.length === 0) return null;
  const counts = new Map<string, number>();
  for (const result of results) {
    const venue = result.venue.trim().toLowerCase();
    if (!venue) continue;
    counts.set(venue, (counts.get(venue) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  const [venue, count] = ranked[0] ?? [];
  return venue &&
    count != null &&
    count / results.length >= TELEGRAM_SEARCH_DOMINANT_VENUE_RATIO
    ? venue
    : null;
}

export function resolveTelegramSearchSecondaryVenues(input: {
  results: TelegramMarketSearchResult[];
  venues: string[];
}): string[] {
  const dominant = dominantVenue(input.results);
  return dominant
    ? input.venues.filter((venue) => venue.trim().toLowerCase() !== dominant)
    : [];
}

async function enrichTelegramMarketSearchResults(input: {
  results: TelegramMarketSearchResult[];
  resolveCrossVenueAlternatives?: (input: {
    marketId: string;
    venues: string[];
  }) => Promise<TelegramMarketSearchVenueOption[]>;
  venues: string[];
}): Promise<TelegramMarketSearchResult[]> {
  if (!input.resolveCrossVenueAlternatives || input.results.length === 0) {
    return input.results.slice(0, TELEGRAM_SEARCH_DISPLAY_LIMIT);
  }
  const seeds = input.results.slice(0, TELEGRAM_SEARCH_AGG_SEED_LIMIT);
  const settled = await Promise.allSettled(
    seeds.map(async (result) => ({
      alternatives: await input.resolveCrossVenueAlternatives!({
        marketId: result.marketId,
        venues: input.venues,
      }),
      marketId: result.marketId,
    })),
  );
  const alternativesByMarketId = new Map<
    string,
    TelegramMarketSearchVenueOption[]
  >();
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    alternativesByMarketId.set(
      outcome.value.marketId,
      outcome.value.alternatives,
    );
  }
  return groupTelegramMarketSearchResults({
    alternativesByMarketId,
    results: input.results,
  }).slice(0, TELEGRAM_SEARCH_DISPLAY_LIMIT);
}

export async function searchTelegramMarkets(input: {
  pool: Pool;
  query?: string | null;
  resolveCrossVenueAlternatives?: (input: {
    marketId: string;
    venues: string[];
  }) => Promise<TelegramMarketSearchVenueOption[]>;
}): Promise<TelegramMarketSearchResult[]> {
  const query = input.query?.trim() ?? "";
  const now = new Date();
  const lifecycle = await filterVenuesForLifecycleCapability(
    input.pool,
    null,
    "discovery",
  );
  if (lifecycle.venues.length === 0) return [];
  const baseInputs = {
    limit: query
      ? TELEGRAM_SEARCH_BASE_RESULT_LIMIT
      : TELEGRAM_SEARCH_DISPLAY_LIMIT,
    offset: 0,
    minVol: 0,
    minLiquidity: 0,
    view: "markets",
    venues: lifecycle.venues,
    sort: "trending_v2",
    sortDir: "desc",
    nowParam: now.toISOString(),
    sevenDaysAgo: new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    sevenDaysFromNow: new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
  } as const;
  if (!query) {
    const rows = await fetchFeedMarketsDirect(input.pool, baseInputs);
    return rows
      .slice(0, TELEGRAM_SEARCH_DISPLAY_LIMIT)
      .map(mapTelegramMarketSearchResult);
  }
  const fetchRankedResults = async (
    venues: string[],
    resultLimit: number,
  ): Promise<TelegramMarketSearchResult[]> => {
    for (const candidateLimit of [25, 100]) {
      const candidateIds = await fetchFeedMarketSearchCandidateIds(input.pool, {
        limit: candidateLimit,
        now: now.toISOString(),
        query,
        venues,
      });
      if (candidateIds.length === 0) return [];
      const rows = await fetchFeedMarketsDirect(
        input.pool,
        {
          ...baseInputs,
          limit: candidateIds.length,
          sort: undefined,
          venues: undefined,
        },
        candidateIds,
      );
      if (rows.length >= resultLimit || candidateIds.length < candidateLimit) {
        return rows.slice(0, resultLimit).map(mapTelegramMarketSearchResult);
      }
    }
    return [];
  };

  const primary = await fetchRankedResults(
    lifecycle.venues,
    TELEGRAM_SEARCH_BASE_RESULT_LIMIT,
  );
  const secondaryVenues = resolveTelegramSearchSecondaryVenues({
    results: primary,
    venues: lifecycle.venues,
  });
  const secondary =
    secondaryVenues.length > 0
      ? await fetchRankedResults(secondaryVenues, TELEGRAM_SEARCH_DISPLAY_LIMIT)
      : [];
  const diversified =
    secondary.length > 0
      ? diversifyTelegramMarketSearchResults({
          limit: TELEGRAM_SEARCH_BASE_RESULT_LIMIT,
          primary,
          secondary,
        })
      : primary;
  return enrichTelegramMarketSearchResults({
    resolveCrossVenueAlternatives: input.resolveCrossVenueAlternatives,
    results: diversified,
    venues: lifecycle.venues,
  });
}
