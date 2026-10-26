import { randomUUID } from "node:crypto";
import type {
  DiscoveryItem,
  DiscoveryResearch,
  DiscoverySection,
  DiscoveryParticipant,
} from "../schemas/discovery.js";
import {
  DiscoveryRepository,
  DISCOVERY_PROJECTION_SQL,
  DISCOVERY_QUICK_POOL_SQL,
  DISCOVERY_RESEARCH_PAGE_SQL,
  DISCOVERY_SMART_INPUTS_SQL,
  DISCOVERY_WALLET_PAGE_SQL,
  DISCOVERY_OWNER_FAMILY_SQL,
  DISCOVERY_OWNER_METADATA_SQL,
} from "../repos/discovery.js";
import {
  aggregateSmartMoney,
  compareDiscovery,
  decimal,
  iso,
  marketCard,
  quickEligible,
  quickPriceEligible,
  quickReason,
  record,
  researchFromRow,
  sameInstrument,
  smartWalletFromRow,
  type DiscoverySnapshot,
  type RawDiscoveryRow,
  type SmartChange,
  type SmartPosition,
  type SmartSelection,
  type SmartWallet,
} from "./discovery-domain.js";
import {
  applyDiscoveryEstimate,
  enrichDiscoveryResearch,
  estimateInputsFromRow,
  type DiscoveryEstimateInputs,
} from "./discovery-estimate.js";

export type DiscoveryScope = {
  venues: string[];
  revision: string;
  whaleUsd: number;
  whaleUsdSolana: number;
};
export type DiscoveryQuoteDemand = (
  tokens: { tokenId: string; venue: string }[],
  mode: "background" | "read",
) => void | Promise<void>;
export type QuickPoolEntry = {
  marketId: string;
  volumeUsd: string;
  liquidityUsd: string;
};
export type DiscoveryQuickPool = {
  createdAt: string;
  lifecycleRevision: string;
  projectionRefreshedAt: string;
  entries: QuickPoolEntry[];
};
export type DiscoveryBuildProgress = {
  version: 1;
  section: DiscoverySection;
  startedAt: string;
  lifecycleRevision: string;
  phase:
    | "source"
    | "families"
    | "owner-metadata"
    | "positions"
    | "quotes"
    | "cards";
  after: string | null;
  afterId: string | null;
  position: number;
  pool: QuickPoolEntry[];
  eligibleIds: string[];
  research: DiscoveryResearch[];
  wallets: SmartWallet[];
  positions: SmartPosition[];
  changes: SmartChange[];
  smart: SmartSelection[];
  items: DiscoveryItem[];
  estimateInputs?: Record<string, DiscoveryEstimateInputs>;
  smartParticipants?: Record<string, DiscoveryParticipant[]>;
  projectionRefreshedAt: string | null;
  ownerLookups?: { key: string; address: string; chain: string }[];
};
export type DiscoveryBuildStep = {
  progress: DiscoveryBuildProgress;
  snapshot?: DiscoverySnapshot;
  quickPool?: DiscoveryQuickPool;
};

function publicResearch(
  rows: RawDiscoveryRow[],
): Map<string, DiscoveryResearch> {
  const mapped = new Map<string, DiscoveryResearch>();
  for (const row of rows) {
    const research = researchFromRow(row);
    if (research) mapped.set(String(row.source_id), research);
  }
  return mapped;
}
/** Each step has bounded source pages and can be checkpointed without publishing partial results. */
export class DiscoveryBuilder {
  constructor(
    readonly repo: DiscoveryRepository,
    readonly limitlessPositionContract: string,
    readonly clock: () => number = Date.now,
    readonly quoteDemand: DiscoveryQuoteDemand = () => {},
  ) {}
  async marketCards(
    ids: string[],
    scope: DiscoveryScope,
    light = false,
    mode: "background" | "read" = "background",
  ): Promise<RawDiscoveryRow[]> {
    const rows = await this.repo.marketCards(ids, light);
    const tokens = new Map<string, { tokenId: string; venue: string }>();
    for (const row of rows) {
      const card = marketCard(
        row,
        this.clock(),
        this.limitlessPositionContract,
      );
      const tokenId =
        typeof row.token_id === "string" ? row.token_id.trim() : "";
      if (!card || !scope.venues.includes(card.market.venue) || !tokenId)
        continue;
      // A stale candidate must be able to recover even when it never reaches a page.
      // Do not keep the entire background pool hot or refresh already-fresh quotes.
      if (mode === "background" && card.quote.status === "fresh") continue;
      tokens.set(`${card.market.venue}:${tokenId}`, {
        tokenId,
        venue: card.market.venue,
      });
      if (tokens.size >= 200) break; // Two canonical sides per bounded 100-market batch.
    }
    if (tokens.size) {
      try {
        // Queue demand is best effort. Never wait for a quote or relax freshness.
        void Promise.resolve(
          this.quoteDemand([...tokens.values()], mode),
        ).catch(() => {
          console.warn("[discovery] quote refresh enqueue failed");
        });
      } catch {
        console.warn("[discovery] quote refresh enqueue failed");
      }
    }
    return rows;
  }
  async start(
    section: DiscoverySection,
    scope: DiscoveryScope,
    base: DiscoveryQuickPool | null,
  ): Promise<DiscoveryBuildProgress> {
    const now = this.clock();
    const progress: DiscoveryBuildProgress = {
      version: 1,
      section,
      startedAt: new Date(now).toISOString(),
      lifecycleRevision: scope.revision,
      phase: "source",
      after: null,
      afterId: null,
      position: 0,
      pool: [],
      eligibleIds: [],
      research: [],
      wallets: [],
      positions: [],
      changes: [],
      smart: [],
      items: [],
      projectionRefreshedAt: null,
    };
    if (section === "quick-wins") {
      const rows = await this.repo.query(DISCOVERY_PROJECTION_SQL, []);
      progress.projectionRefreshedAt = iso(rows[0]?.refreshed_at);
      // The incremental refresh runs every 10 minutes; don't invent recent volume if it has stopped.
      if (
        !progress.projectionRefreshedAt ||
        now - Date.parse(progress.projectionRefreshedAt) > 1800000
      )
        throw Error("discovery_activity_projection_stale");
      if (
        base &&
        base.lifecycleRevision === scope.revision &&
        now - Date.parse(base.createdAt) < 300000
      ) {
        progress.pool = base.entries;
        progress.phase = "quotes";
      }
    }
    return progress;
  }
  async step(
    progress: DiscoveryBuildProgress,
    scope: DiscoveryScope,
  ): Promise<DiscoveryBuildStep> {
    if (progress.lifecycleRevision !== scope.revision)
      throw Error("discovery_lifecycle_changed");
    const now = this.clock(),
      asOf = progress.startedAt;
    if (!scope.venues.length) return this.finish(progress);
    if (progress.phase === "source") {
      if (progress.section === "quick-wins") {
        const rows = await this.repo.query(DISCOVERY_QUICK_POOL_SQL, [
          scope.venues,
          progress.after,
          progress.afterId,
          asOf,
        ]);
        for (const row of rows) {
          const volume = decimal(row.volume_24h_usd),
            liquidity = decimal(row.liquidity_usd);
          if (row.market_id && volume && liquidity)
            progress.pool.push({
              marketId: String(row.market_id),
              volumeUsd: volume,
              liquidityUsd: liquidity,
            });
        }
        if (rows.length) {
          progress.after = String(rows.at(-1)?.volume_24h_usd);
          progress.afterId = String(rows.at(-1)?.source_market_id);
        }
        if (rows.length === 500) return { progress };
        progress.phase = "quotes";
        return {
          progress,
          quickPool: {
            createdAt: asOf,
            lifecycleRevision: scope.revision,
            projectionRefreshedAt: progress.projectionRefreshedAt ?? asOf,
            entries: progress.pool,
          },
        };
      }
      if (progress.section === "hidden-gems") {
        const rows = await this.repo.query(DISCOVERY_RESEARCH_PAGE_SQL, [
          asOf,
          progress.after,
          progress.afterId,
        ]);
        const seen = new Set(progress.eligibleIds);
        for (const row of rows) {
          const research = researchFromRow(row);
          const marketId = String(row.source_id);
          if (research && !seen.has(marketId)) {
            progress.research.push(research);
            progress.eligibleIds.push(marketId);
            seen.add(marketId);
          }
        }
        if (rows.length) {
          progress.after = iso(rows.at(-1)?.created_at);
          progress.afterId = String(rows.at(-1)?.id);
        }
        if (rows.length === 300) return { progress };
        progress.phase = "cards";
        return { progress };
      }
      const rows = await this.repo.query(DISCOVERY_WALLET_PAGE_SQL, [
        asOf,
        progress.after,
        progress.afterId,
        scope.whaleUsd,
        scope.whaleUsdSolana,
      ]);
      const wallets = rows
        .map(smartWalletFromRow)
        .filter((v): v is SmartWallet => v !== null);
      const seenWallets = new Set(
        progress.wallets.map((wallet) => wallet.walletId),
      );
      progress.wallets.push(
        ...wallets.filter((wallet) => !seenWallets.has(wallet.walletId)),
      );
      if (rows.length) {
        progress.after = iso(rows.at(-1)?.source_activity_at);
        progress.afterId = String(rows.at(-1)?.source_wallet_id);
      }
      if (rows.length === 500) return { progress };
      progress.phase = "families";
      progress.position = 0;
      return { progress };
    }
    if (progress.phase === "families") {
      const representatives = new Map(
        progress.wallets
          .filter((w) => w.qualified !== false)
          .map((w) => [w.ownerKey, w]),
      );
      const ownerIds = [...representatives.keys()].slice(
        progress.position,
        progress.position + 500,
      );
      const known = new Set(progress.wallets.map((w) => w.walletId));
      if (ownerIds.length)
        for (const row of await this.repo.query(DISCOVERY_OWNER_FAMILY_SQL, [
          ownerIds,
        ])) {
          const representative = representatives.get(String(row.owner_key));
          if (row.wallet_id === row.owner_key) {
            progress.ownerLookups ??= [];
            progress.ownerLookups.push({
              key: String(row.owner_key),
              address: String(row.owner_address),
              chain: String(row.owner_chain),
            });
          }
          if (representative && !known.has(String(row.wallet_id))) {
            progress.wallets.push({
              ...representative,
              walletId: String(row.wallet_id),
              qualified: false,
            });
            known.add(String(row.wallet_id));
          }
        }
      progress.position += ownerIds.length;
      if (progress.position >= representatives.size) {
        progress.phase = representatives.size ? "owner-metadata" : "positions";
        progress.afterId = null;
        progress.position = 0;
      }
      return { progress };
    }
    if (progress.phase === "owner-metadata") {
      const lookupKey = (chain: string, address: string) =>
        `${chain}:${chain === "solana" ? address : address.toLowerCase()}`;
      const representatives = new Map(
        progress.wallets
          .filter((w) => w.qualified !== false)
          .map((w) => [w.ownerKey, w]),
      );
      const owners = new Map(
        (progress.ownerLookups ?? []).map((o) => [
          lookupKey(o.chain, o.address),
          o.key,
        ]),
      );
      const known = new Set(progress.wallets.map((w) => w.walletId));
      const rows = await this.repo.query(DISCOVERY_OWNER_METADATA_SQL, [
        progress.afterId,
      ]);
      for (const row of rows) {
        const ownerKey =
          typeof row.owner_address === "string"
            ? owners.get(lookupKey(String(row.chain), row.owner_address))
            : null;
        const representative = ownerKey ? representatives.get(ownerKey) : null;
        if (representative && !known.has(String(row.id))) {
          progress.wallets.push({
            ...representative,
            walletId: String(row.id),
            qualified: false,
          });
          known.add(String(row.id));
        }
      }
      if (rows.length) progress.afterId = String(rows.at(-1)?.id);
      if (rows.length < 2000) {
        progress.phase = "positions";
        progress.position = 0;
        progress.ownerLookups = [];
      }
      return { progress };
    }
    if (progress.phase === "positions") {
      const batch = progress.wallets.slice(
        progress.position,
        progress.position + 500,
      );
      if (batch.length) {
        const input = (
          await this.repo.query(DISCOVERY_SMART_INPUTS_SQL, [
            batch.map((w) => w.walletId),
            asOf,
            scope.venues,
          ])
        )[0];
        for (const raw of Array.isArray(input?.positions)
          ? input.positions
          : []) {
          const row = record(raw),
            shares = decimal(row.shares),
            value = decimal(row.value_usd),
            at = iso(row.snapshot_at);
          if (shares && value && at)
            progress.positions.push({
              walletId: String(row.wallet_id),
              venue: String(row.venue),
              marketId: String(row.market_id),
              side: String(row.side),
              shares,
              valueUsd: value,
              snapshotAt: at,
            });
        }
        for (const raw of Array.isArray(input?.changes) ? input.changes : []) {
          const row = record(raw),
            shares = decimal(row.net_shares),
            at = iso(row.observed_at);
          if (shares && at)
            progress.changes.push({
              walletId: String(row.wallet_id),
              venue: String(row.venue),
              marketId: String(row.market_id),
              side: String(row.side),
              netShares: shares,
              observedAt: at,
            });
        }
      }
      progress.position += batch.length;
      if (progress.position < progress.wallets.length) return { progress };
      progress.smart = aggregateSmartMoney(
        progress.wallets,
        progress.positions,
        progress.changes,
      );
      progress.eligibleIds = [
        ...new Set(progress.smart.map((s) => s.marketId)),
      ];
      progress.wallets = [];
      progress.positions = [];
      progress.changes = [];
      progress.phase = "cards";
      progress.position = 0;
      return { progress };
    }
    if (progress.phase === "quotes") {
      const batch = progress.pool.slice(
        progress.position,
        progress.position + 100,
      );
      const pool = new Map(batch.map((p) => [p.marketId, p]));
      const rows = await this.marketCards(
        batch.map((p) => p.marketId),
        scope,
        true,
      );
      const ids = new Set(progress.eligibleIds);
      for (const row of rows) {
        const candidate = pool.get(String(row.id)),
          card = marketCard(row, now, this.limitlessPositionContract);
        if (
          card &&
          candidate &&
          quickPriceEligible(
            card,
            candidate.liquidityUsd,
            candidate.volumeUsd,
            now,
          )
        )
          ids.add(candidate.marketId);
      }
      progress.eligibleIds = [...ids];
      progress.position += batch.length;
      if (progress.position >= progress.pool.length) {
        progress.phase = "cards";
        progress.position = 0;
      }
      return { progress };
    }
    const ids = progress.eligibleIds.slice(
      progress.position,
      progress.position + 100,
    );
    const rows = await this.marketCards(ids, scope);
    const latestRows = await this.repo.currentResearch(
      ids,
      new Date(now).toISOString(),
    );
    const latest = publicResearch(latestRows);
    for (const row of latestRows) {
      const research = latest.get(String(row.source_id));
      if (research)
        latest.set(
          String(row.source_id),
          enrichDiscoveryResearch(research, row, now),
        );
    }
    if (progress.section === "hidden-gems") {
      progress.estimateInputs ??= {};
      for (const row of await this.repo.estimateInputs(
        [...latest.values()].map((r) => r.noteId),
      ))
        progress.estimateInputs[String(row.note_id)] =
          estimateInputsFromRow(row);
    }
    const smart = new Map(
      progress.smart.map((s) => [`${s.marketId}:${s.side}`, s]),
    );
    const noteByMarket = new Map(
      progress.eligibleIds.map((id, index) => [id, progress.research[index]]),
    );
    for (const row of rows) {
      const card = marketCard(row, now, this.limitlessPositionContract);
      if (!card || !scope.venues.includes(card.market.venue)) continue;
      const research = latest.get(card.market.marketId) ?? null;
      const id = `${progress.section}:${card.market.marketId}:${card.selection.side}`;
      if (progress.section === "quick-wins") {
        const liquidity = decimal(row.liquidity_usd),
          volume = decimal(row.volume_24h_usd);
        if (
          liquidity &&
          volume &&
          quickEligible(card, liquidity, volume, now) &&
          card.quote.ask
        )
          progress.items.push({
            ...card,
            id,
            research,
            reason: quickReason(card.quote.ask, liquidity, volume),
          });
      } else if (progress.section === "smart-money") {
        const selected = smart.get(
          `${card.market.marketId}:${card.selection.side}`,
        );
        if (selected && card.copyAvailable) {
          progress.smartParticipants ??= {};
          if (selected.participants)
            progress.smartParticipants[id] = selected.participants;
          progress.items.push({
            ...card,
            id,
            research,
            reason: selected.reason,
          });
        }
      } else {
        const selected = noteByMarket.get(card.market.marketId);
        if (
          !research ||
          research.noteId !== selected?.noteId ||
          research.side !== card.selection.side
        )
          continue;
        progress.items.push(
          applyDiscoveryEstimate(
            {
              ...card,
              id,
              research,
              copyAvailable:
                card.copyAvailable &&
                sameInstrument(research.instrument, card.selection.instrument),
              reason: {
                kind: "hidden-gems",
                strength: research.strength,
                basis: "public_approved_research_not_proven_mispricing",
              },
            },
            progress.estimateInputs?.[research.noteId],
            now,
          ),
        );
      }
    }
    progress.position += ids.length;
    return progress.position >= progress.eligibleIds.length
      ? this.finish(progress)
      : { progress };
  }
  private finish(progress: DiscoveryBuildProgress): DiscoveryBuildStep {
    progress.items.sort(compareDiscovery);
    return {
      progress,
      snapshot: {
        version: 1,
        id: randomUUID(),
        section: progress.section,
        generatedAt: new Date(this.clock()).toISOString(),
        sourceAsOf: progress.startedAt,
        projectionRefreshedAt: progress.projectionRefreshedAt,
        lifecycleRevision: progress.lifecycleRevision,
        items: progress.items,
        estimateInputs: progress.estimateInputs,
        smartParticipants: progress.smartParticipants,
        warnings:
          progress.section === "quick-wins"
            ? [
                "Requires known liquidity and a valid 24h volume window; venue coverage may differ.",
              ]
            : progress.section === "smart-money"
              ? [
                  "Snapshot changes are observations, not confirmed purchases. Historical PnL includes approximate marks.",
                ]
              : [],
      },
    };
  }
}
