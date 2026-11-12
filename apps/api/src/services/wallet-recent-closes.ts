import type { ObservedClose } from "../schemas/trader-collections.js";
import type { TraderRepository } from "../repos/trader-collections.js";
import {
  advanceLocalCalc,
  localEvidence,
  startLocalCalc,
} from "./trader-collection-local.js";
import type { Close } from "./trader-collection-ledger.js";
import {
  DEFAULT_TRADER_POLICY,
  type Evidence,
} from "./trader-collection-ranking.js";
import {
  recentObservedCloses,
  topObservedCloses,
} from "./trader-recent-closes.js";

type Ready = {
  status: "ready";
  windowStart: string | null;
  windowEnd: string;
  coverage: "known_gaps" | "observed_only";
  items: ObservedClose[];
};
type View =
  | Ready
  | {
      status: "preparing" | "busy" | "unavailable" | "unsupported";
      items: null;
    };
type Reader = AsyncGenerator<void, Ready, void>;
export function closeView(
  e: Pick<
    Evidence,
    "historyStart" | "estimatedIncomplete" | "gaps" | "ledgers"
  >,
  end: number,
): Ready {
  return {
    status: "ready",
    windowStart:
      e.ledgers.length || e.historyStart < end
        ? new Date(e.historyStart * 1000).toISOString()
        : null,
    windowEnd: new Date(end * 1000).toISOString(),
    coverage:
      e.gaps.size || e.estimatedIncomplete ? "known_gaps" : "observed_only",
    items: recentObservedCloses(
      e.ledgers.map((l) => l.ledger.closes),
      end,
      DEFAULT_TRADER_POLICY.dust,
      0,
    ),
  };
}

// The profile covers retained public activity, not the ranking's 30-day
// roster window. In particular, carry a known old holding into recent settlement.
// Each yield is a fair scheduling point (one indexed page or one catalog batch).
export async function* calculateWalletCloses(
  repo: Pick<TraderRepository, "localPage" | "markets">,
  id: string,
  end: number,
  signal: AbortSignal,
): Reader {
  const calc = startLocalCalc(end);
  calc.profileOnly = true;
  calc.stamp = new Date(0).toISOString();
  for (;;) {
    signal.throwIfAborted();
    const rows = await repo.localPage(id, calc.stamp, calc.id, end);
    advanceLocalCalc(calc, rows);
    if (
      Object.keys(calc.legs).length > 6000 &&
      Buffer.byteLength(JSON.stringify(calc)) > 24 * 1024 * 1024
    )
      throw Error("profile_close_capacity");
    if (rows.length < 1000) break;
    yield;
  }
  const keys = Object.keys(calc.legs);
  let top: Close[] = [],
    gap = !!calc.unmapped.length;
  for (let i = 0; i < keys.length; i += 250) {
    yield;
    signal.throwIfAborted();
    const legs = Object.fromEntries(
      keys.slice(i, i + 250).map((k) => [k, calc.legs[k]]),
    );
    const e = await localEvidence(
      { ...calc, legs, unmapped: [] },
      { id, family: id, address: "", name: null },
      repo,
      signal,
    );
    gap ||= !!e.gaps.size || !!e.estimatedIncomplete;
    top = topObservedCloses(
      [top, ...e.ledgers.map((l) => l.ledger.closes)],
      end,
      0,
    );
    for (const k of Object.keys(legs)) delete calc.legs[k];
  }
  return {
    status: "ready",
    windowStart:
      keys.length || calc.first < end
        ? new Date(calc.first * 1000).toISOString()
        : null,
    windowEnd: new Date(end * 1000).toISOString(),
    coverage: gap ? "known_gaps" : "observed_only",
    items: recentObservedCloses([top], end, DEFAULT_TRADER_POLICY.dust, 0),
  };
}
function capEntries<T>(rows: Map<string, T>) {
  if (rows.size > 512) {
    const oldest = rows.keys().next();
    if (!oldest.done) rows.delete(oldest.value);
  }
}

export class RecentCloseCache {
  private ready = new Map<string, { data: Ready; completedAt: number }>();
  private failed = new Map<string, number>();
  // At most four in-memory folds (including the active one); at most ONE SQL
  // query in flight. Rotate readers between bounded pages, not whole wallets.
  private queue = new Map<string, Reader>();
  private work: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(
    private load: (id: string, end: number, signal: AbortSignal) => Reader,
    private clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private seed(id: string, data: Ready) {
    this.ready.delete(id);
    this.ready.set(id, { completedAt: this.clock(), data });
    capEntries(this.ready);
    this.failed.delete(id);
  }
  read(id: string, chain: string): View {
    if (chain !== "polygon") return { status: "unsupported", items: null };
    const now = this.clock(),
      old = this.ready.get(id);
    if (old && now - old.completedAt < 300) return old.data;
    const fallback = old && now - old.completedAt < 1800 ? old.data : null;
    if (this.controller.signal.aborted || (this.failed.get(id) ?? 0) > now)
      return fallback ?? { status: "unavailable", items: null };
    if (!this.queue.has(id)) {
      if (this.queue.size >= 4)
        return fallback ?? { status: "busy", items: null };
      this.queue.set(id, this.load(id, now, this.controller.signal));
    }
    if (!this.work) this.work = this.drain();
    return fallback ?? { status: "preparing", items: null };
  }
  private async drain() {
    try {
      while (!this.controller.signal.aborted && this.queue.size) {
        const head = this.queue.entries().next();
        if (head.done) break;
        const [id, task] = head.value;
        try {
          const step = await task.next();
          this.queue.delete(id);
          if (step.done) this.seed(id, step.value);
          else this.queue.set(id, task);
        } catch (err) {
          this.queue.delete(id);
          this.failed.set(
            id,
            this.clock() +
              (err instanceof Error && err.message === "profile_close_capacity"
                ? 300
                : 30),
          );
          capEntries(this.failed);
        }
      }
    } finally {
      this.work = null;
    }
  }
  async stop() {
    this.controller.abort();
    await this.work;
    this.queue.clear();
  }
}
