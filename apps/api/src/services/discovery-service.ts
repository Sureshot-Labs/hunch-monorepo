import { randomUUID } from "node:crypto";
import {
  discoverySections,
  type DiscoveryItem,
  type DiscoveryQuery,
  type DiscoveryResponse,
  type DiscoverySection,
} from "../schemas/discovery.js";
import { DiscoveryBuilder, type DiscoveryScope } from "./discovery-builder.js";
import { DiscoveryStore } from "./discovery-store.js";
import {
  DISCOVERY_MAX_AGE_MS,
  DISCOVERY_REFRESH_MS,
  DiscoveryError,
  decodeDiscoveryCursor,
  discoveryFilterHash,
  encodeDiscoveryCursor,
  decimal,
  marketCard,
  matchesDiscovery,
  quickEligible,
  quickReason,
  researchFromRow,
  sameInstrument,
  type DiscoverySnapshot,
} from "./discovery-domain.js";

export class DiscoveryService {
  private running = new Map<DiscoverySection, Promise<void>>();
  private retryAt = new Map<DiscoverySection, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    readonly builder: DiscoveryBuilder,
    readonly store: () => Promise<DiscoveryStore>,
    readonly scope: () => Promise<DiscoveryScope>,
    readonly clock: () => number = Date.now,
    readonly warn: (section: DiscoverySection) => void = () => {},
  ) {}
  start() {
    this.stopped = false;
    this.schedule(0);
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled(this.running.values());
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(5000));
    }, delay);
    this.timer.unref();
  }
  private async tick() {
    for (const section of discoverySections) {
      if (this.stopped) break;
      await this.refresh(section);
    }
  }
  refresh(section: DiscoverySection): Promise<void> {
    const running = this.running.get(section);
    if (running) return running;
    if (this.stopped || (this.retryAt.get(section) ?? 0) > this.clock())
      return Promise.resolve();
    const task = this.build(section)
      .catch(() => {
        this.retryAt.set(section, this.clock() + 15000);
        this.warn(section);
      })
      .finally(() => {
        this.running.delete(section);
      });
    this.running.set(section, task);
    return task;
  }
  private async build(section: DiscoverySection) {
    const store = await this.store(),
      scope = await this.scope(),
      now = this.clock();
    const current = await store.current(section);
    if (
      current &&
      current.lifecycleRevision === scope.revision &&
      now - Date.parse(current.sourceAsOf) < DISCOVERY_REFRESH_MS[section]
    )
      return;
    const owner = randomUUID();
    if (!(await store.acquire(section, owner))) return;
    let leaseLost = false,
      renewing = false;
    const renew = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void store
        .renew(section, owner)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, 15000);
    renew.unref();
    try {
      let progress = await store.progress(section);
      if (
        !progress ||
        progress.version !== 1 ||
        progress.lifecycleRevision !== scope.revision ||
        now - Date.parse(progress.startedAt) > DISCOVERY_MAX_AGE_MS[section]
      )
        progress = await this.builder.start(
          section,
          scope,
          await store.quickPool(),
        );
      // Bound each worker turn; the persisted keyset checkpoint resumes on the next tick/restart.
      const deadline = now + 20000;
      do {
        if (leaseLost || this.stopped) break;
        const step = await this.builder.step(progress, scope);
        progress = step.progress;
        if (leaseLost) throw Error("discovery_lease_lost");
        if (step.snapshot) {
          if ((await this.scope()).revision !== scope.revision)
            throw Error("discovery_lifecycle_changed");
          if (
            this.clock() - Date.parse(step.snapshot.sourceAsOf) >
            DISCOVERY_MAX_AGE_MS[section]
          )
            throw Error("discovery_build_expired");
          await store.publish(section, owner, step.snapshot);
          return;
        }
        await store.checkpoint(section, owner, progress, step.quickPool);
      } while (this.clock() < deadline);
    } finally {
      clearInterval(renew);
      await store.release(section, owner).catch(() => {});
    }
  }
  async read(
    section: DiscoverySection,
    query: DiscoveryQuery,
  ): Promise<DiscoveryResponse> {
    const hash = discoveryFilterHash(section, query),
      cursor = decodeDiscoveryCursor(query.cursor, section, hash);
    try {
      const store = await this.store(),
        scope = await this.scope(),
        now = this.clock();
      const snapshot = cursor
        ? await store.snapshot(cursor.snapshotId)
        : await store.current(section);
      if (!snapshot) {
        void this.refresh(section);
        throw new DiscoveryError(
          cursor ? "discovery_cursor_expired" : "discovery_unavailable",
          cursor ? 409 : 503,
        );
      }
      if (snapshot.version !== 1 || snapshot.section !== section)
        throw new DiscoveryError("discovery_invalid_cursor", 400);
      // A frozen traversal lasts 15 minutes, while current source availability keeps its shorter SLA.
      const latest = cursor ? await store.current(section) : snapshot;
      if (cursor && now - Date.parse(snapshot.generatedAt) >= 900000)
        throw new DiscoveryError("discovery_cursor_expired", 409);
      if (
        !latest ||
        now - Date.parse(latest.sourceAsOf) > DISCOVERY_MAX_AGE_MS[section]
      ) {
        void this.refresh(section);
        throw new DiscoveryError("discovery_unavailable", 503);
      }
      const grouped = new Map<string, DiscoveryItem[]>();
      for (const item of snapshot.items) {
        // Keep cursor group indices stable; live venue policy is checked during hydration.
        if (!matchesDiscovery(item, query, Date.parse(snapshot.sourceAsOf)))
          continue;
        const key = item.market.eventId;
        const group = grouped.get(key) ?? [];
        group.push(item);
        grouped.set(key, group);
      }
      const groups = [...grouped.values()];
      let position = cursor?.position ?? 0,
        member = cursor?.member ?? 0;
      if (
        position > groups.length ||
        (position === groups.length && member !== 0) ||
        (position < groups.length && member >= groups[position].length)
      )
        throw new DiscoveryError("discovery_invalid_cursor", 400);
      const items: DiscoveryItem[] = [];
      let scanned = 0;
      const hydrated = new Map<string, DiscoveryItem | null>();
      const batchSize = Math.max(40, 2 * query.limit);
      while (position < groups.length && items.length < query.limit) {
        const candidate = groups[position][member];
        if (!hydrated.has(candidate.id)) {
          if (scanned >= 200) break;
          const batch: DiscoveryItem[] = [];
          for (
            let gi = position;
            gi < groups.length &&
            batch.length < Math.min(batchSize, 200 - scanned);
            gi++
          ) {
            for (
              let mi = gi === position ? member : 0;
              mi < groups[gi].length &&
              batch.length < Math.min(batchSize, 200 - scanned);
              mi++
            )
              if (!hydrated.has(groups[gi][mi].id)) batch.push(groups[gi][mi]);
          }
          if (!batch.length) break;
          const live = await this.hydrate(batch, query, snapshot, scope);
          for (let i = 0; i < batch.length; i++)
            hydrated.set(batch[i].id, live[i]);
          scanned += batch.length;
        }
        const live = hydrated.get(candidate.id);
        if (live) {
          items.push(live);
          position++;
          member = 0;
        } else if (++member >= groups[position].length) {
          position++;
          member = 0;
        }
      }
      const more = position < groups.length;
      const stale =
        now - Date.parse(snapshot.sourceAsOf) > DISCOVERY_REFRESH_MS[section];
      if (stale || snapshot.lifecycleRevision !== scope.revision)
        void this.refresh(section);
      return {
        section,
        items,
        nextCursor: more
          ? encodeDiscoveryCursor({
              v: 1,
              section,
              hash,
              snapshotId: snapshot.id,
              position,
              member,
            })
          : null,
        snapshotId: snapshot.id,
        generatedAt: snapshot.generatedAt,
        freshness: {
          status: stale ? "stale" : "fresh",
          sourceAsOf: snapshot.sourceAsOf,
          projectionRefreshedAt: snapshot.projectionRefreshedAt,
          quoteMaxAgeSeconds: 300,
          warnings: snapshot.warnings,
        },
        page: {
          scannedCandidates: scanned,
          scanBudgetReached:
            more && scanned >= 200 && items.length < query.limit,
        },
      };
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      void this.refresh(section);
      throw new DiscoveryError("discovery_unavailable", 503);
    }
  }
  private async hydrate(
    batch: DiscoveryItem[],
    query: DiscoveryQuery,
    snapshot: DiscoverySnapshot,
    scope: DiscoveryScope,
  ): Promise<(DiscoveryItem | null)[]> {
    const ids = [...new Set(batch.map((i) => i.market.marketId))],
      now = this.clock();
    const rows = await this.builder.marketCards(ids, scope, false, "read");
    const researchRows = await this.builder.repo.currentResearch(
      ids,
      new Date(now).toISOString(),
    );
    const researchById = new Map(
      researchRows.map((row) => [String(row.source_id), researchFromRow(row)]),
    );
    const cards = new Map(
      rows.map((row) => [
        `${row.id}:${row.side}`,
        {
          row,
          card: marketCard(row, now, this.builder.limitlessPositionContract),
        },
      ]),
    );
    return batch.map((item) => {
      const current = cards.get(
          `${item.market.marketId}:${item.selection.side}`,
        ),
        card = current?.card;
      if (!card || !scope.venues.includes(card.market.venue)) return null;
      const research = researchById.get(item.market.marketId) ?? null;
      if (query.withResearch === "true" && !research) return null;
      let result: DiscoveryItem = {
        ...card,
        id: item.id,
        reason: item.reason,
        research,
      };
      if (item.reason.kind === "hidden-gems") {
        if (
          !research ||
          research.noteId !== item.research?.noteId ||
          research.side !== item.selection.side
        )
          return null;
        result.copyAvailable =
          card.copyAvailable &&
          sameInstrument(research.instrument, card.selection.instrument);
        if (card.quote.status !== "fresh")
          result.quote = {
            ...card.quote,
            bid: null,
            ask: null,
            midpoint: null,
          };
        if (!sameInstrument(research.instrument, card.selection.instrument))
          result.quote = {
            status: "unavailable",
            bid: null,
            ask: null,
            midpoint: null,
            asOf: card.quote.asOf,
          };
      } else {
        if (
          !sameInstrument(
            item.selection.instrument,
            card.selection.instrument,
          ) ||
          !card.copyAvailable
        )
          return null;
        if (item.reason.kind === "quick-wins") {
          const liquidity = decimal(current?.row.liquidity_usd),
            volume = decimal(current?.row.volume_24h_usd);
          if (
            !liquidity ||
            !volume ||
            !quickEligible(
              card,
              liquidity,
              volume,
              now,
              query.horizonHours ?? 72,
            ) ||
            !card.quote.ask
          )
            return null;
          result = {
            ...result,
            reason: quickReason(card.quote.ask, liquidity, volume),
          };
        }
      }
      return matchesDiscovery(result, query, Date.parse(snapshot.sourceAsOf))
        ? result
        : null;
    });
  }
}
