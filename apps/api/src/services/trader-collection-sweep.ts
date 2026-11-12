import {
  collections,
  rejectionCodes,
  sourceFailureCodes,
  type CollectionResponse,
  type SourceFailure,
} from "../schemas/trader-collections.js";
import {
  assemble,
  priorityOrder,
  type Evaluation,
  type Owner,
} from "./trader-collection-ranking.js";
import { SNAPSHOT_TTL } from "./trader-collection-service.js";

export type Sweep = {
  pageJournal?: 1;
  end: number;
  owners: Owner[];
  queue: number[];
  attempts: number[];
  retries: number[];
  needsFullSlice: Record<number, true>;
  evaluated: Record<number, Evaluation>;
  failed: Record<number, SourceFailure>;
  categories: string[];
  publishedAt: number;
  previousSnapshotExpiresAt: number;
};
export function createSweep(
  owners: Owner[],
  end: number,
  offset = 0,
  previous?: Sweep,
): Sweep {
  const carry = new Map(
    previous?.queue.map((i, n) => [previous.owners[i].id, n]),
  );
  const queue = owners.map((_, i) => (offset + i) % owners.length);
  queue.sort(
    (a, b) =>
      (carry.get(owners[a].id) ?? Infinity) -
      (carry.get(owners[b].id) ?? Infinity),
  );
  return {
    pageJournal: 1,
    end,
    owners,
    queue,
    attempts: owners.map(() => 0),
    retries: owners.map(() => 0),
    needsFullSlice: {},
    evaluated: {},
    failed: {},
    categories: [],
    publishedAt: 0,
    previousSnapshotExpiresAt: 0,
  };
}
// No financial result crosses window boundaries. After an outage, give still
// eligible unfinished owners first turn at the new (servable) reference time.
export function sweepExpired(s: Sweep, now: number) {
  return now - s.end >= SNAPSHOT_TTL;
}
export const encodeSweep = (s: Sweep) =>
  JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const decodeSweep = (raw: string): Sweep => {
  const state: Sweep = JSON.parse(raw, (k, v) => {
    // An older writer can fall back to the full categories list on rollback.
    // Never re-save its stale first-50 list after resuming a legacy checkpoint.
    if (k === "streakCategories") return undefined;
    return k === "priority" && Array.isArray(v) ? v.map(BigInt) : v;
  });
  // A pre-release live checkpoint still knows these identities. Re-open only
  // the two former per-visit hard stops, once, after fresh owners get a turn.
  // Completed, already-discarded historic rosters cannot be reconstructed.
  if (state.pageJournal !== 1) {
    for (const [ordinal, why] of Object.entries(state.failed)) {
      if (why !== "incomplete_pages" && why !== "wallet_request_budget")
        continue;
      const i = Number(ordinal);
      delete state.failed[i];
      delete state.needsFullSlice[i];
      state.retries[i] = 0;
      state.queue.push(i);
    }
    state.pageJournal = 1;
  }
  return state;
};

export function recordEvaluation(s: Sweep, i: number, ev: Evaluation) {
  for (const k of collections) {
    const byCategory = new Map<string, (typeof ev.choices)[typeof k][number]>();
    for (const choice of ev.choices[k]) {
      const old = byCategory.get(choice.category);
      if (!old || priorityOrder(choice.priority, old.priority) < 0)
        byCategory.set(choice.category, choice);
    }
    ev.choices[k] = [...byCategory.values()];
  }
  s.evaluated[i] = ev;
}
// Limit *wallet-specific* technical retries per sweep. Shared cancellation,
// local slice boundaries and genuine venue cooldown do not spend this budget.
export function walletFailure(
  s: Sweep,
  i: number,
  why: SourceFailure,
  transient: boolean,
) {
  if (transient && ++s.retries[i] < 3) return true;
  s.failed[i] = why;
  return false;
}
export function finishSlice(s: Sweep, consumed: number, deferred: number[]) {
  s.queue = [...s.queue.slice(consumed), ...deferred];
}
// Two portfolios may each fit the wallet limit (90 calls) but never finish if
// they repeatedly race one another for the same 128-call slice. Give a wallet
// cut off by that shared budget one fresh slice; don't spend any extra calls.
export function slicePlan(s: Sweep) {
  const firstReserved = s.queue.findIndex((i) => s.needsFullSlice[i]);
  return firstReserved === 0
    ? { concurrency: 1, count: 1 }
    : {
        concurrency: 2,
        count: firstReserved < 0 ? s.queue.length : firstReserved,
      };
}
export async function visitSweepSlice(
  s: Sweep,
  hasBudget: () => boolean,
  visit: (i: number) => Promise<"done" | "retry" | "shared_budget">,
) {
  const plan = slicePlan(s),
    deferred: number[] = [];
  let index = 0;
  const consume = async () => {
    while (index < plan.count && hasBudget()) {
      const i = s.queue[index++];
      s.attempts[i]++;
      const action = await visit(i);
      if (action === "shared_budget") s.needsFullSlice[i] = true;
      if (action !== "done") deferred.push(i);
    }
  };
  await Promise.all(Array.from({ length: plan.concurrency }, consume));
  finishSlice(s, index, deferred);
  return index;
}
export function progress(s: Sweep) {
  return {
    selectedWallets: s.owners.length,
    attemptedWallets: s.attempts.filter((n) => n > 0).length,
    pendingWallets: s.queue.length,
    observedWallets: Object.keys(s.evaluated).length,
    sourceFailures: sourceFailureCodes
      .map((code) => ({
        code,
        wallets: Object.values(s.failed).filter((v) => v === code).length,
      }))
      .filter((v) => v.wallets),
  };
}
export function sweepSnapshots(s: Sweep, id: string, now: number) {
  const evals = Object.values(s.evaluated),
    coverage = progress(s);
  const sets = evals.map((ev) => ({
    ...ev.choices,
    "big-moves": ev.choices["big-moves"].filter((v) => {
      const a = v.item.achievement;
      return (
        a.kind === "big_move" && Date.parse(a.quote.validUntil) > now * 1000
      );
    }),
  }));
  const out = assemble(sets, s.end, id, s.owners.length, s.categories, now);
  for (const k of collections) {
    const reasons = new Map<string, number>();
    let qualifiedWallets = 0;
    for (const [i, ev] of evals.entries()) {
      if (sets[i][k].length) {
        qualifiedWallets++;
        continue;
      }
      const code = ev.rejected[k] ?? "quote_expired_before_publication";
      reasons.set(code, (reasons.get(code) ?? 0) + 1);
    }
    const diagnostic: CollectionResponse["diagnostics"] = {
      scope: "whole_shortlist_at_ranking",
      ...coverage,
      qualifiedWallets,
      exclusions: rejectionCodes
        .map((code) => ({ code, wallets: reasons.get(code) ?? 0 }))
        .filter((v) => v.wallets > 0),
    };
    out[k].diagnostics = diagnostic;
  }
  return out;
}
