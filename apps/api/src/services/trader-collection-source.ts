import { assetKey, type Asset } from "../repos/trader-collections.js";
import { fetchPolymarketDataApiV2Page } from "./polymarket-data-api-v2.js";
import {
  DAY,
  UNIT,
  replay,
  units,
  type Action,
  type Position,
  type Market,
  type Resolution,
} from "./trader-collection-ledger.js";
import type {
  Owner,
  Evidence,
  Supplemental,
} from "./trader-collection-ranking.js";

type Row = Record<string, unknown>;
const record = (r: unknown): Row => {
  if (!r || typeof r !== "object" || Array.isArray(r))
    throw Error("invalid_provider_row");
  return r as Row;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const secs = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
const cond = (v: unknown) =>
  /^0x[0-9a-f]{64}$/i.test(str(v)) ? str(v).toLowerCase() : "";
const token = (v: unknown) => (/^\d{1,78}$/.test(str(v)) ? str(v) : "");
const idx = (v: unknown) => (v === 0 || v === 1 ? v : null);
const cashOnly = new Set([
  "REWARD",
  "YIELD",
  "MAKER_REBATE",
  "TAKER_REBATE",
  "DEPOSIT",
  "WITHDRAWAL",
  "REFERRAL_REWARD",
]);
type Endpoint = "positions" | "activity" | "resolutions";
export type ReadPage = (
  ep: Endpoint,
  params: Record<string, string>,
  cursor: string | null,
  signal: AbortSignal,
) => Promise<{ data: Row[]; nextCursor: string | null }>;
export const providerPages =
  (baseUrl: string, fetchImpl?: typeof fetch): ReadPage =>
  (endpoint, params, cursor, signal) =>
    fetchPolymarketDataApiV2Page({
      endpoint,
      baseUrl,
      params,
      cursor,
      signal,
      parseRow: record,
      fetchImpl,
      timeoutMs: 6000,
      lane: "background",
    });
export type ActivityCache = {
  end: number;
  rows: Row[];
  pending?: {
    start: number;
    end: number;
    rows: Row[];
    cursor: string | null;
    seen: string[];
  };
  carry?: Map<string, { through: number; rows: Row[] }>;
  capacityUntil?: number;
};
// Keep only public economic fields in bounded background checkpoints, never bios/profile media.
const compact = (r: Row): Row =>
  Object.fromEntries(
    [
      "type",
      "timestamp",
      "condition_id",
      "token_id",
      "outcome_index",
      "side",
      "size",
      "usdc_size",
      "outcome",
      "transaction_hash",
      "is_combo",
    ].map((k) => [k, r[k]]),
  );
// Fees can prevent us from allocating net profit across individual sales even
// when the bought capital and the exact size of every closed episode are known.
function closedStakes(
  actions: Action[],
  p: Position,
  end: number,
  res?: Resolution,
) {
  if (
    !actions.length ||
    actions[0].time !== p.first ||
    actions.at(-1)?.time !== p.last ||
    (res && res.at <= end && p.shares > 0n)
  )
    return null;
  let q = 0n,
    stake = 0n,
    last = 0;
  const closes: { at: number; stake: bigint }[] = [];
  for (const a of actions) {
    if (
      a.kind !== "TRADE" ||
      a.time < last ||
      a.time > end ||
      a.shares <= 0n ||
      a.cash < 0n ||
      (res && a.time >= res.at)
    )
      return null;
    last = a.time;
    if (a.side === "BUY" && a.cash > 0n) {
      q += a.shares;
      stake += a.cash;
    } else if (a.side === "SELL" && q >= a.shares) {
      q -= a.shares;
      if (q === 0n) {
        closes.push({ at: a.time, stake });
        stake = 0n;
      }
    } else return null;
  }
  return q - p.shares <= 100n && p.shares - q <= 100n ? closes : null;
}
/** No page is treated as the full wallet while it has a successor. A bounded
 * carry-in backfill is local to one condition; failure cannot fabricate a basis. */
export async function collectEvidence(
  owner: Owner,
  end: number,
  read: ReadPage,
  lookup: (
    a: Asset[],
    end: number,
    signal: AbortSignal,
  ) => Promise<Map<string, Market>>,
  signal: AbortSignal,
  cache?: Map<string, ActivityCache>,
): Promise<Evidence> {
  const floor = end - 30 * DAY,
    seenConditions = new Set<string>(),
    claimConditions = new Set<string>(),
    uncertainTimes = new Map<string, number>();
  let requestCount = 0;
  async function page(
    ep: Endpoint,
    params: Record<string, string>,
    cursor: string | null,
  ) {
    signal.throwIfAborted();
    if (++requestCount > 90) throw Error("wallet_request_budget");
    return read(ep, params, cursor, signal);
  }
  async function walk(ep: Endpoint, params: Record<string, string>, max = 20) {
    let cursor: string | null = null;
    const cursors = new Set<string>(),
      rows: Row[] = [];
    for (let i = 0; i < max; i++) {
      const p = await page(
        ep,
        { user: owner.address, limit: "250", ...params },
        cursor,
      );
      if (
        !p.data.every(
          (r) =>
            str(r.proxy_wallet).toLowerCase() === owner.address.toLowerCase(),
        )
      )
        throw Error("owner_mismatch");
      rows.push(...p.data);
      if (!p.nextCursor) return rows;
      if (cursors.has(p.nextCursor)) throw Error("repeated_cursor");
      cursors.add(p.nextCursor);
      cursor = p.nextCursor;
    }
    throw Error("incomplete_pages");
  }
  const timeParams = { start: String(floor + 1), end: String(end) };
  // Replace, don't append/dedupe, a complete overlap: identical fills in a tx
  // retain their multiplicity. Periodic cold reads also reconcile older corrections.
  const prev: ActivityCache = cache?.get(owner.address) ?? { end: 0, rows: [] };
  cache?.set(owner.address, prev);
  if (prev.pending && prev.pending.end <= floor) delete prev.pending;
  // Continue the SAME frozen window and opaque cursor; completion is still not
  // a current snapshot until the overlap through the new end has been read.
  async function advance() {
    const p = prev.pending;
    if (!p) throw Error("missing_activity_checkpoint");
    for (let i = 0; i < 8; i++) {
      const b = await page(
        "activity",
        {
          user: owner.address,
          limit: "250",
          start: String(p.start),
          end: String(p.end),
          exclude_deposits_withdrawals: "false",
        },
        p.cursor,
      );
      if (
        !b.data.every(
          (r) =>
            str(r.proxy_wallet).toLowerCase() === owner.address.toLowerCase(),
        )
      )
        throw Error("owner_mismatch");
      if (b.nextCursor && p.seen.includes(b.nextCursor)) {
        delete prev.pending;
        throw Error("repeated_cursor");
      }
      p.rows.push(...b.data.map(compact));
      if (p.rows.length > 12000) {
        delete prev.pending;
        prev.capacityUntil = end + 1800;
        throw Error("wallet_activity_capacity");
      }
      if (!b.nextCursor) {
        prev.rows = [
          ...p.rows,
          ...prev.rows.filter(
            (r) =>
              secs(r.timestamp) > p.end - 30 * DAY &&
              secs(r.timestamp) < p.start,
          ),
        ];
        if (prev.rows.length > 12000) {
          prev.rows = [];
          prev.end = 0;
          delete prev.pending;
          prev.capacityUntil = end + 1800;
          throw Error("wallet_activity_capacity");
        }
        prev.end = p.end;
        delete prev.pending;
        return;
      }
      p.cursor = b.nextCursor;
      p.seen.push(b.nextCursor);
    }
    throw Error("activity_checkpoint");
  }
  let activityFloor = floor,
    recent: Row[];
  try {
    if ((prev.capacityUntil ?? 0) > end)
      throw Error("wallet_activity_capacity");
    if (prev.pending) await advance();
    const reuse =
      prev.end > 0 &&
      prev.end <= end &&
      prev.end > floor &&
      Math.floor(prev.end / DAY) === Math.floor(end / DAY);
    const cut = reuse ? Math.max(floor + 1, prev.end - 600) : floor + 1;
    if (prev.end !== end) {
      prev.pending = { start: cut, end, rows: [], cursor: null, seen: [] };
      await advance();
    }
    recent = prev.rows;
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !["activity_checkpoint", "wallet_activity_capacity"].includes(err.message)
    )
      throw err;
    // Independent, COMPLETE short window plus the complete 30-day closed/current
    // position inventory. Never substitute a truncated 30-day page for either.
    activityFloor = end - DAY;
    recent = (
      await walk(
        "activity",
        {
          start: String(activityFloor + 1),
          end: String(end),
          exclude_deposits_withdrawals: "false",
        },
        8,
      )
    ).map(compact);
  }
  const opens = await walk("positions", {
    status: "OPEN",
    include_archived: "true",
    filter_amount: "0",
  });
  const lost = await walk("positions", {
    status: "REDEEMABLE_LOST",
    include_archived: "true",
    filter_amount: "0",
  });
  const closes = await walk("positions", {
    status: "CLOSED",
    start: timeParams.start,
  });
  // Snapshot routes reflect now, not historical inventory: post-cut changes
  // invalidate only the affected segment. Never filter them out as zero.
  const pos = new Map<string, Position>(),
    neverSold = new Set<string>(),
    bad = new Set<string>(),
    invalidNative = new Set<string>(),
    outcomeOf = new Map<string, number>(),
    assets: Asset[] = [];
  function rememberOutcome(condition: string, tokenId: string, index: number) {
    const k = condition + ":" + tokenId;
    const previous = outcomeOf.get(k);
    if (previous !== undefined && previous !== index)
      invalidNative.add(condition);
    outcomeOf.set(k, index);
  }
  for (const row of [...opens, ...lost, ...closes]) {
    const c = cond(row.condition_id),
      t = token(row.token_id),
      i = idx(row.outcome_index);
    if (!c || !t || i === null) {
      bad.add(c || "*");
      if (c) invalidNative.add(c);
      continue;
    }
    rememberOutcome(c, t, i);
    const p = {
      condition: c,
      token: t,
      index: i,
      label: str(row.outcome),
      shares: units(row.current_size),
      pnl: units(row.realized_pnl),
      unrealized: units(row.unrealized_pnl),
      remainingCost:
        row.total_cost_usdc != null &&
        row.entry_cost_usdc != null &&
        row.entry_fees_usdc != null
          ? {
              total: units(row.total_cost_usdc),
              entry: units(row.entry_cost_usdc),
              fees: units(row.entry_fees_usdc),
            }
          : undefined,
      first: secs(row.first_entry_at),
      last: secs(row.last_event_at),
      redeemable:
        row.redeemable === true ||
        row.status === "REDEEMABLE" ||
        row.status === "REDEEMABLE_LOST",
    };
    const previous = pos.get(assetKey(p));
    if (
      p.shares > 0n &&
      p.pnl === 0n &&
      !p.redeemable &&
      row.total_size != null &&
      units(row.total_size) === p.shares
    )
      neverSold.add(assetKey(p));
    else neverSold.delete(assetKey(p));
    if (
      previous &&
      (previous.shares !== p.shares ||
        previous.pnl !== p.pnl ||
        previous.last !== p.last ||
        previous.first !== p.first ||
        previous.unrealized !== p.unrealized ||
        previous.remainingCost?.total !== p.remainingCost?.total ||
        previous.remainingCost?.fees !== p.remainingCost?.fees ||
        previous.remainingCost?.entry !== p.remainingCost?.entry)
    ) {
      bad.add(c);
      invalidNative.add(c);
    }
    pos.set(assetKey(p), p);
    assets.push(p);
    seenConditions.add(c);
  }
  const grouped = new Map<string, Action[]>();
  function parse(rows: Row[], lower: number, expected?: string) {
    for (const row of [...rows].reverse()) {
      const kind = str(row.type);
      if (cashOnly.has(kind)) continue;
      const c = cond(row.condition_id),
        t = token(row.token_id),
        i = idx(row.outcome_index),
        time = secs(row.timestamp);
      if (expected && c !== expected) throw Error("condition_mismatch");
      if (kind === "REDEEM" && c) claimConditions.add(c);
      if (
        !c ||
        !t ||
        i === null ||
        row.is_combo === true ||
        !["TRADE", "REDEEM"].includes(kind) ||
        time < lower ||
        time > end ||
        (kind === "TRADE" &&
          !/^0x[\da-f]{64}$/i.test(str(row.transaction_hash)))
      ) {
        bad.add(c || "*");
        uncertainTimes.set(
          c,
          Math.max(uncertainTimes.get(c) ?? 0, time || end),
        );
        continue;
      }
      rememberOutcome(c, t, i);
      const x: Action = {
        kind,
        condition: c,
        token: t,
        index: i,
        label: str(row.outcome),
        time,
        shares: units(row.size),
        cash: units(row.usdc_size),
        side: str(row.side),
        tx: str(row.transaction_hash),
      };
      assets.push({ ...x, index: i });
      seenConditions.add(c);
      const k = assetKey(x),
        g = grouped.get(k) ?? [];
      g.push(x);
      grouped.set(k, g);
    }
  }
  parse(recent, activityFloor + 1);
  const markets = await lookup(assets, end, signal);
  const resolutions = new Map<string, Resolution>();
  const conditions = [
    ...new Set([...markets.values()].map((m) => m.condition)),
  ];
  for (let i = 0; i < conditions.length; i += 20) {
    const batch = conditions.slice(i, i + 20);
    const p = await page("resolutions", { condition: batch.join(",") }, null);
    if (p.nextCursor) throw Error("invalid_resolution_batch");
    for (const r of p.data) {
      const c = cond(r.condition_id);
      if (!batch.includes(c)) throw Error("resolution_mismatch");
      if (r.status !== "resolved") continue;
      const at = Math.floor(Date.parse(str(r.resolved_at)) / 1000),
        v = r.payouts;
      if (
        !Number.isSafeInteger(at) ||
        at <= 0 ||
        !Array.isArray(v) ||
        v.length !== 2 ||
        !(
          (v[0] === 1000000 && v[1] === 0) ||
          (v[0] === 0 && v[1] === 1000000)
        ) ||
        resolutions.has(c)
      ) {
        bad.add(c);
        continue;
      }
      resolutions.set(c, {
        at,
        payout: [v[0] === 0 ? 0n : UNIT, v[1] === 0 ? 0n : UNIT],
      });
    }
  }
  const ledgers: Evidence["ledgers"] = [],
    supplemental: Supplemental[] = [],
    uncertainExposureConditions = new Set<string>(),
    gaps = new Set<string>(),
    backfilled = new Set<string>();
  const carry = (prev.carry ??= new Map());
  let extraReads = 0;
  // Chronology before the window is not assumed: recover carry-in for touched
  // or terminal positions. Completely dormant open positions have zero realized
  // movement, but their open losses still affect the quality filter.
  for (const p of [...pos.values()].sort((a, b) => b.last - a.last)) {
    const k = assetKey(p),
      m = markets.get(k);
    if (!m) continue;
    const res = resolutions.get(p.condition);
    if (
      p.first > 0 &&
      p.first <= activityFloor &&
      ((grouped.get(k)?.length ?? 0) > 0 ||
        p.last > floor ||
        (res && res.at > floor && res.at <= end))
    ) {
      if (backfilled.has(p.condition)) continue;
      const saved = carry.get(p.condition);
      const usableSaved =
        saved && saved.through >= activityFloor && saved.through <= end;
      if (!usableSaved && extraReads >= 12) {
        bad.add(p.condition);
        continue;
      }
      backfilled.add(p.condition);
      try {
        let history: Row[];
        if (usableSaved) {
          history = [
            ...recent.filter((r) => cond(r.condition_id) === p.condition),
            ...saved.rows.filter(
              (r: Row) => secs(r.timestamp) <= activityFloor,
            ),
          ];
        } else {
          extraReads++;
          history = (
            await walk(
              "activity",
              {
                condition: p.condition,
                start: "1",
                end: String(end),
                exclude_deposits_withdrawals: "false",
              },
              4,
            )
          ).map(compact);
        }
        if (carry.size < 40 || saved)
          carry.set(p.condition, { through: end, rows: history.slice() });
        for (const [key, rows] of grouped)
          if (rows[0].condition === p.condition) grouped.delete(key);
        parse(history, 1, p.condition);
      } catch (err) {
        if (err instanceof Error && err.message === "incomplete_pages") {
          bad.add(p.condition);
          continue;
        }
        throw err;
      }
    }
  }
  for (const [key, p] of pos) {
    const m = markets.get(key);
    if (!m) {
      gaps.add("outside_catalog");
      if (p.shares > 0n || !p.last || p.last > end - DAY)
        uncertainExposureConditions.add(p.condition);
      continue;
    }
    const acts = grouped.get(key) || [],
      res = resolutions.get(p.condition);
    if (invalidNative.has(p.condition)) {
      gaps.add(m.category);
      uncertainExposureConditions.add(p.condition);
      continue;
    }
    if (
      !acts.length &&
      !bad.has(p.condition) &&
      (!(p.redeemable || m.terminal) || res) &&
      p.last > 0 &&
      p.last <= floor &&
      (!res || res.at <= floor || res.at > end)
    ) {
      const holds = (!res || res.at > end) && p.shares > 0n;
      // No entry/close is inferred; a dormant known native balance still
      // matters when testing whether a new purchase was already hedged.
      ledgers.push({
        market: m,
        ledger: {
          first: p.first,
          current: holds ? p.shares : 0n,
          exposure: holds ? [{ at: p.last, shares: p.shares }] : [],
          openLoss:
            (!res || res.at > end) && p.unrealized < 0n ? -p.unrealized : 0n,
          closes: [],
          moves: [],
          income: [],
        },
      });
      continue;
    }
    // Equal final quantity/cost are not chronological proof: an unseen exit
    // and same-price re-entry can net to zero. Native observations and activity
    // must share a latest event, or that clock must be the exact final payout.
    const latestAction = acts.reduce((at, x) => Math.max(at, x.time), 0);
    const clocksMatch =
      p.last > 0 &&
      latestAction <= p.last &&
      (p.last === latestAction || (res && res.at === p.last && res.at <= end));
    const l = clocksMatch
      ? replay(
          acts,
          p,
          m,
          res,
          backfilled.has(p.condition) ? 1 : activityFloor + 1,
          end,
        )
      : null;
    if (!l || bad.has(p.condition)) {
      if (
        p.shares > 0n ||
        !p.last ||
        p.last > end - DAY ||
        (res && res.at > end - DAY && res.at <= end)
      )
        uncertainExposureConditions.add(
          p.condition + ":" + m.instrument.generation,
        );
      // Lifetime P&L is a valid window total if the whole economic life lies
      // inside that window. It cannot place partial sells on the daily clock.
      // Unclaimed settlements, missing clocks and later mutations need replay.
      const referenceCloses =
        clocksMatch &&
        !bad.has(p.condition) &&
        (p.first > activityFloor || backfilled.has(p.condition))
          ? closedStakes(acts, p, end, res)
          : null;
      const exits =
        referenceCloses && p.shares === 0n
          ? acts.filter((x) => x.side === "SELL")
          : [];
      const netFor = (start: number) => {
        if (
          !p.first ||
          !p.last ||
          p.last > end ||
          p.first > p.last ||
          Math.max(latestAction, uncertainTimes.get(p.condition) ?? 0) > p.last
        )
          return null;
        // The venue may already credit a claim whose official resolution is
        // outside the frozen window. A cumulative P&L cannot date that cash.
        if (
          claimConditions.has(p.condition) &&
          (!res ||
            res.at > end ||
            res.at < p.first ||
            (res.at <= start && p.last > start))
        )
          return null;
        if (m.terminal && !res && !acts.length) return null;
        if (
          (m.terminal || p.redeemable || (res && res.at <= end)) &&
          p.shares > 0n
        )
          return null;
        if (p.last <= start && (!res || res.at <= start || res.at > end))
          return 0n;
        if (p.first > start) return p.pnl;
        // The whole native realized total (including fees) belongs to this
        // window if the complete balance walk ended flat and every sale was
        // inside it, even when the original buy predates the window.
        if (exits.length && exits.every((x) => x.time > start)) return p.pnl;
        if (
          (start >= activityFloor || backfilled.has(p.condition)) &&
          neverSold.has(key) &&
          !bad.has(p.condition) &&
          acts.some((x) => x.time === p.last) &&
          acts.every(
            (x) => x.time <= start || (x.kind === "TRADE" && x.side === "BUY"),
          ) &&
          (!res || res.at <= start || res.at > end)
        )
          return 0n;
        return null;
      };
      const completeBuyOnlyTail =
        clocksMatch &&
        neverSold.has(key) &&
        !m.terminal &&
        !p.redeemable &&
        !bad.has(p.condition) &&
        (!res || res.at > end) &&
        acts.length > 0;
      // When all known recent activity consists of ordinary buys, it cannot
      // create a completed position. A native clock ahead of activity is
      // different: in that case leave the close breakdown unknown.
      const possibleClose = completeBuyOnlyTail
        ? acts.reduce(
            (at, x) =>
              x.kind === "TRADE" && x.side === "BUY"
                ? at
                : Math.max(at, x.time),
            backfilled.has(p.condition) || p.first > activityFloor
              ? 0
              : activityFloor,
          )
        : p.last || end;
      supplemental.push({
        referenceCloses,
        nativeClosedInWindow:
          p.shares === 0n && p.first > 0 && p.last > floor && p.last <= end,
        earliestPossibleClose: Math.max(floor + 1, p.first || floor + 1),
        category: m.category,
        net30: netFor(floor),
        net24: netFor(end - DAY),
        openLoss:
          (!res || res.at > end) && p.unrealized < 0n ? -p.unrealized : 0n,
        uncertainClose: Math.min(
          end,
          Math.max(
            possibleClose,
            res && res.at <= end ? res.at : 0,
            uncertainTimes.get(p.condition) ?? 0,
          ),
        ),
      });
      continue;
    }
    ledgers.push({ market: m, ledger: l });
  }
  const missing = new Set<string>();
  for (const [key, rows] of grouped)
    if (!pos.has(key)) {
      missing.add(rows[0].condition);
      if (rows.some((r) => r.time > end - DAY))
        uncertainExposureConditions.add(rows[0].condition);
    }
  const categoryByCondition = new Map(
    [...markets.values()].map((m) => [m.condition, m.category]),
  );
  const posConds = new Set([...pos.values()].map((v) => v.condition));
  for (const c of [...missing, ...[...bad].filter((c) => !posConds.has(c))])
    gaps.add(
      c === "*"
        ? "*"
        : (categoryByCondition.get(c) ??
            (seenConditions.has(c) ? "outside_catalog" : "*")),
    );
  const oldest = await page(
    "activity",
    {
      user: owner.address,
      type: "TRADE",
      start: "1",
      end: String(end),
      limit: "1",
      sort_direction: "ASC",
    },
    null,
  );
  const row = oldest.data[0];
  if (
    row &&
    str(row.proxy_wallet).toLowerCase() !== owner.address.toLowerCase()
  )
    throw Error("owner_mismatch");
  const first = secs(row?.timestamp) || end;
  return {
    owner,
    ledgers,
    supplemental,
    uncertainExposureConditions,
    distinctClosed: new Set(
      closes
        .filter(
          (r) =>
            secs(r.last_event_at) <= end &&
            secs(r.first_entry_at) > 0 &&
            Number(r.current_size) === 0 &&
            markets.has(
              assetKey({
                condition: cond(r.condition_id),
                token: token(r.token_id),
                index: idx(r.outcome_index),
              }),
            ),
        )
        .map((r) => str(r.token_id)),
    ).size,
    positionWindowFallback: activityFloor !== floor,
    gaps,
    historyStart: first,
    completeLifetime: first > floor,
  };
}
