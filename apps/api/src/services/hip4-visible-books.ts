// Sidecar-safe: visible reads never import API env or financial execution.
import {
  hip4BackgroundRepairWeightLimit,
  hip4BackgroundRequestWeightLimit,
  hip4ReadOutcomeAllowed,
  parseHip4Coin,
  type Hip4ReadMarket,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import type { Pool } from "pg";
import { createHip4ReadClient, Hip4ReadError } from "./hip4-client.js";
import { ageHip4Market, applyHip4Book } from "./hip4-mapping.js";
import {
  admitHip4Request,
  persistHip4Market,
  readHip4Policy,
  readHip4StoredMarket,
} from "./hip4-repository.js";
import type { Hip4CanonicalObserver } from "./hip4-canonical-change.js";

export function hip4HotOutcomeIds(policy: Hip4ReadPolicy, tokens: string[]) {
  const outcomes = new Set<number>();
  for (const token of tokens.slice(0, policy.maxHotOutcomes * 2)) {
    const parts = token.split(":");
    if (
      parts.length !== 3 ||
      parts[0] !== "hyperliquid" ||
      parts[1] !== policy.environment
    )
      continue;
    try {
      const { outcome } = parseHip4Coin(`#${parts[2]}`);
      if (hip4ReadOutcomeAllowed(policy, outcome)) outcomes.add(outcome);
    } catch {
      // Untrusted demand cannot invent a provider identity.
    }
    if (outcomes.size >= policy.maxHotOutcomes) break;
  }
  return [...outcomes];
}

export async function readHip4HotMarkets(
  db: Pick<Pool, "query">,
  policy: Hip4ReadPolicy,
  tokens: string[],
) {
  const markets: Hip4ReadMarket[] = [];
  // Existing indexed environment/outcome point reads; no catalog scan, feed
  // query, or provider call is introduced by a larger visible demand set.
  for (const outcome of hip4HotOutcomeIds(policy, tokens)) {
    try {
      const stored = await readHip4StoredMarket(
        db,
        policy.environment,
        outcome,
      );
      if (stored) markets.push(stored.market);
    } catch (error) {
      // One malformed legacy snapshot must not disconnect every valid visible
      // market. DB/transport failures still take the existing recovery path.
      if (!(error instanceof Error) || error.name !== "ZodError") throw error;
    }
  }
  return markets;
}

const timestamp = (value?: string | null) => {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};
function eligible(policy: Hip4ReadPolicy, market: Hip4ReadMarket, now: number) {
  const missingAt =
    market.metadataAttempt?.result === "metadata_missing"
      ? timestamp(market.metadataAttempt.at)
      : 0;
  const currentMissing =
    missingAt >= timestamp(market.fetchedAt) &&
    missingAt <= now &&
    now - missingAt <= policy.metadataMaxAgeMs;
  return (
    market.environment === policy.environment &&
    hip4ReadOutcomeAllowed(policy, market.outcome) &&
    market.status === "observed" &&
    !market.settlement &&
    !currentMissing &&
    (!market.expiry || timestamp(market.expiry) > now)
  );
}
const oldestBookAt = (market: Hip4ReadMarket) =>
  Math.min(...market.sides.map((side) => timestamp(side.bookAt)));

export function selectHip4VisibleLiveOutcomes(
  policy: Hip4ReadPolicy,
  markets: Hip4ReadMarket[],
  selectedAt: ReadonlyMap<number, number>,
  now: number,
) {
  return markets
    .filter((market) => eligible(policy, market, now))
    .sort(
      (a, b) =>
        Math.max(oldestBookAt(a), selectedAt.get(a.outcome) ?? 0) -
        Math.max(oldestBookAt(b), selectedAt.get(b.outcome) ?? 0),
    )
    .slice(0, policy.maxLiveOutcomes)
    .map((market) => market.outcome);
}

export function hip4VisibleBookLeadMs(
  policy: Hip4ReadPolicy,
  candidateCount: number,
) {
  // Leave time to drain a cohort expiring together, plus one bounded request.
  // This advances repair scheduling; it never extends observation validity.
  return Math.min(
    policy.bookMaxAgeMs,
    Math.ceil(candidateCount / policy.maxVisibleBookOutcomesPerCycle) *
      policy.visibleBookRefreshMs +
      policy.requestTimeoutMs,
  );
}

export function selectHip4VisibleBookMarkets(
  policy: Hip4ReadPolicy,
  markets: Hip4ReadMarket[],
  attemptedAt: ReadonlyMap<number, number>,
  now: number,
) {
  const candidates = markets.filter((market) => eligible(policy, market, now));
  const leadMs = hip4VisibleBookLeadMs(policy, candidates.length);
  const lastAttempt = (market: Hip4ReadMarket) =>
    Math.max(
      attemptedAt.get(market.outcome) ?? 0,
      ...market.sides.map((side) => timestamp(side.bookAttempt?.at)),
    );
  return (
    candidates
      .filter(
        (market) => oldestBookAt(market) + policy.bookMaxAgeMs - leadMs <= now,
      )
      // Failures/empty WS subscriptions must yield to other visible markets.
      .sort(
        (a, b) =>
          Math.max(oldestBookAt(a), lastAttempt(a)) -
          Math.max(oldestBookAt(b), lastAttempt(b)),
      )
      .slice(0, policy.maxVisibleBookOutcomesPerCycle)
  );
}

type VisibleBookDependencies = {
  readPolicy: () => Promise<{ policy: Hip4ReadPolicy; revision: string }>;
  readStored: (outcome: number) => ReturnType<typeof readHip4StoredMarket>;
  readBook: ReturnType<typeof createHip4ReadClient>;
  persist: (input: Parameters<typeof persistHip4Market>[1]) => Promise<boolean>;
  now: () => number;
};

/** The real worker path has an injectable transport/storage boundary for tests. */
export async function refreshHip4VisibleBooks(
  policy: Hip4ReadPolicy,
  revision: string,
  markets: Hip4ReadMarket[],
  attemptedAt: Map<number, number>,
  publish: (market: Hip4ReadMarket) => Promise<void>,
  dependencies: VisibleBookDependencies,
) {
  const diagnostics = {
    selected: 0,
    attempts: 0,
    refreshed: 0,
    failures: 0,
    budgetDenied: 0,
    deadlineReached: false,
    policyChanged: false,
  };
  if (!policy.enabled || !policy.liveEnabled) return diagnostics;
  const deadlineMs = dependencies.now() + policy.visibleBookRefreshMs;
  const withinDeadline = () => {
    if (dependencies.now() < deadlineMs) return true;
    diagnostics.deadlineReached = true;
    return false;
  };
  const currentPolicy = async () => {
    const current = await dependencies.readPolicy();
    const allowed =
      current.policy.enabled &&
      current.policy.liveEnabled &&
      current.revision === revision;
    if (!allowed) diagnostics.policyChanged = true;
    return allowed;
  };
  const selected = selectHip4VisibleBookMarkets(
    policy,
    markets,
    attemptedAt,
    dependencies.now(),
  );
  diagnostics.selected = selected.length;
  const leadMs = hip4VisibleBookLeadMs(
    policy,
    markets.filter((market) => eligible(policy, market, dependencies.now()))
      .length,
  );
  for (const candidate of selected) {
    if (!withinDeadline()) break;
    if (!(await currentPolicy())) break;
    // Recheck canonical state after selection: concurrent WS/REST may already
    // have repaired it, or settlement may have made it ineligible.
    const stored = await dependencies.readStored(candidate.outcome);
    if (!stored || !eligible(policy, stored.market, dependencies.now()))
      continue;
    let market = stored.market;
    let attempted = false;
    for (const side of market.sides) {
      if (
        timestamp(side.bookAt) + policy.bookMaxAgeMs - leadMs >
        dependencies.now()
      )
        continue;
      if (!(await currentPolicy())) return diagnostics;
      if (!withinDeadline()) break;
      attempted = true;
      attemptedAt.set(market.outcome, dependencies.now());
      diagnostics.attempts++;
      try {
        const payload = await dependencies.readBook({
          type: "l2Book",
          coin: side.coin,
        });
        const previousAt = market.sides[side.sideIndex].bookAt;
        market = applyHip4Book(
          market,
          side.sideIndex,
          payload,
          dependencies.now(),
          policy.bookMaxAgeMs,
        );
        if (market.sides[side.sideIndex].bookAt !== previousAt)
          diagnostics.refreshed++;
      } catch (error) {
        const deadlineReached = !withinDeadline();
        const result = deadlineReached
          ? "timeout"
          : error instanceof Hip4ReadError
            ? error.reason
            : error instanceof Error && /identity/.test(error.message)
              ? "wrong_identity"
              : "invalid_response";
        market.sides = market.sides.map((entry) =>
          entry.sideIndex === side.sideIndex
            ? {
                ...entry,
                bookAttempt: {
                  at: new Date(dependencies.now()).toISOString(),
                  result,
                },
              }
            : entry,
        );
        diagnostics.failures++;
        if (result === "budget_exhausted") {
          diagnostics.budgetDenied++;
          break;
        }
      }
    }
    if (attempted) {
      if (!(await currentPolicy())) return diagnostics;
      await dependencies.persist({
        market: ageHip4Market(market, dependencies.now(), policy),
        raw: stored.raw,
        trades: [],
        advanceCursor: false,
        policy,
      });
      // Publish the merged commit, never the stale pre-request snapshot.
      const snapshot = await dependencies.readStored(market.outcome);
      if (snapshot && (await currentPolicy()))
        await publish(
          ageHip4Market(snapshot.market, dependencies.now(), policy),
        );
    } else if (await currentPolicy()) {
      // Repair the selector's cached candidate too when another writer won.
      await publish(ageHip4Market(market, dependencies.now(), policy));
    }
    if (diagnostics.budgetDenied || diagnostics.deadlineReached) break;
  }
  return diagnostics;
}

export function createHip4VisibleBookDependencies(
  pool: Pool,
  policy: Hip4ReadPolicy,
  onCanonicalChange?: Hip4CanonicalObserver,
  fetcher?: typeof fetch,
): VisibleBookDependencies {
  return {
    readPolicy: () => readHip4Policy(pool, "indexer"),
    readStored: (outcome) =>
      readHip4StoredMarket(pool, policy.environment, outcome),
    readBook: createHip4ReadClient(
      policy,
      (weight) =>
        admitHip4Request(
          pool,
          policy.environment,
          weight,
          policy.requestWeightPerMinute,
          {
            scope: "background_repair",
            maximum: hip4BackgroundRepairWeightLimit(policy),
            backgroundMaximum: hip4BackgroundRequestWeightLimit(policy),
          },
        ),
      fetcher,
      { deadlineMs: Date.now() + policy.visibleBookRefreshMs },
    ),
    persist: (input) => persistHip4Market(pool, input, onCanonicalChange),
    now: Date.now,
  };
}
