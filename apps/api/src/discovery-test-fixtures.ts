import { randomUUID } from "node:crypto";
import { DiscoveryRepository } from "./repos/discovery.js";
import {
  DiscoveryBuilder,
  type DiscoveryScope,
} from "./services/discovery-builder.js";
import {
  marketCard,
  quickReason,
  type DiscoverySnapshot,
  type RawDiscoveryRow,
  type SmartWallet,
} from "./services/discovery-domain.js";
import {
  DiscoveryStore,
  DISCOVERY_CHECKPOINT_SCRIPT,
  DISCOVERY_PUBLISH_SCRIPT,
  type DiscoveryRedis,
} from "./services/discovery-store.js";
import type { DiscoveryItem } from "./schemas/discovery.js";

export const discoveryTestNow = Date.parse("2026-10-25T12:00:00Z");
export const discoveryTestScope: DiscoveryScope = {
  venues: ["limitless", "polymarket"],
  revision: "test-1",
  whaleUsd: 10000,
  whaleUsdSolana: 10000,
};
export function discoveryTestRow(
  id = "limitless:1",
  extra: RawDiscoveryRow = {},
): RawDiscoveryRow {
  return {
    id,
    event_id: `event:${id}`,
    venue: "limitless",
    title: "30–34",
    event_title: "Café election seats",
    category: "politics",
    status: "ACTIVE",
    event_status: "ACTIVE",
    outcomes: '["30–34 seats","Not 30–34"]',
    side: "YES",
    token_id: `token:${id}`,
    best_bid: "0.93",
    best_ask: "0.95",
    quote_at: new Date(discoveryTestNow).toISOString(),
    expiration_time: new Date(discoveryTestNow + 3600000).toISOString(),
    event_end_time: new Date(discoveryTestNow + 7200000).toISOString(),
    description: "Official result resolves this exact range.",
    liquidity_usd: "10000",
    volume_24h_usd: "2000",
    metadata: {},
    ...extra,
  };
}
export function discoveryTestItem(
  id = "limitless:1",
  extra: RawDiscoveryRow = {},
): DiscoveryItem {
  const card = marketCard(
    discoveryTestRow(id, extra),
    discoveryTestNow,
    "0xctf",
  );
  if (!card) throw Error("invalid test card");
  return {
    ...card,
    id: `quick-wins:${id}:YES`,
    research: null,
    reason: quickReason(card.quote.ask ?? "0.95", "10000", "2000"),
  };
}
export function discoveryTestSnapshot(
  items: DiscoveryItem[],
): DiscoverySnapshot {
  return {
    version: 1,
    id: randomUUID(),
    section: "quick-wins",
    generatedAt: new Date(discoveryTestNow).toISOString(),
    sourceAsOf: new Date(discoveryTestNow).toISOString(),
    projectionRefreshedAt: new Date(discoveryTestNow).toISOString(),
    lifecycleRevision: "test-1",
    warnings: [],
    items,
  };
}
export function discoveryTestWallet(id: string, ownerKey = id): SmartWallet {
  return {
    walletId: id,
    ownerKey,
    trader: {
      walletId: id,
      displayName: null,
      pnl30dUsd: "1000",
      pnlIsApproximate: true,
      resolvedObservations30d: 30,
      edge30d: "0.1",
      metricsAsOf: new Date(discoveryTestNow).toISOString(),
    },
  };
}
export class DiscoveryMemoryRedis implements DiscoveryRedis {
  values = new Map<string, { value: string; expires: number }>();
  constructor(readonly clock: () => number = () => discoveryTestNow) {}
  async get(key: string) {
    const entry = this.values.get(key);
    return entry && entry.expires > this.clock() ? entry.value : null;
  }
  async set(key: string, value: string, options: { PX: number; NX?: boolean }) {
    if (options.NX && (await this.get(key)) !== null) return null;
    this.values.set(key, { value, expires: this.clock() + options.PX });
    return "OK";
  }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const { keys, arguments: args } = options;
    if ((await this.get(keys[0])) !== args[0]) return 0;
    if (script === DISCOVERY_CHECKPOINT_SCRIPT) {
      await this.set(keys[1], args[1], { PX: 3600000 });
      if (args[2]) await this.set(keys[2], args[2], { PX: 1800000 });
    } else if (script === DISCOVERY_PUBLISH_SCRIPT) {
      await this.set(keys[1], args[1], { PX: 900000 });
      await this.set(keys[2], args[1], { PX: 900000 });
      this.values.delete(keys[3]);
    } else if (script.includes("PEXPIRE")) {
      await this.set(keys[0], args[0], { PX: Number(args[1]) });
    } else this.values.delete(keys[0]);
    return 1;
  }
}
export class DiscoveryFixtureRepository extends DiscoveryRepository {
  batches: string[][] = [];
  research: RawDiscoveryRow[] = [];
  estimateRows: RawDiscoveryRow[] = [];
  constructor(readonly rows: Map<string, RawDiscoveryRow>) {
    super({
      connect: async () => {
        throw Error("unexpected SQL");
      },
    });
  }
  override async marketCards(ids: string[]) {
    this.batches.push(ids);
    return ids.flatMap((id) =>
      this.rows.has(id) ? [this.rows.get(id) as RawDiscoveryRow] : [],
    );
  }
  override async currentResearch(ids: string[]) {
    return this.research.filter((row) => ids.includes(String(row.source_id)));
  }
  override async estimateInputs(noteIds: string[]) {
    return this.estimateRows.filter((row) =>
      noteIds.includes(String(row.note_id)),
    );
  }
}
export function discoveryTestComponents(
  items: DiscoveryItem[],
  clock: () => number = () => discoveryTestNow,
) {
  const repo = new DiscoveryFixtureRepository(
    new Map(
      items.map((i) => [
        i.market.marketId,
        discoveryTestRow(i.market.marketId),
      ]),
    ),
  );
  const redis = new DiscoveryMemoryRedis(clock),
    store = new DiscoveryStore(redis, "test-discovery");
  return {
    repo,
    redis,
    store,
    builder: new DiscoveryBuilder(repo, "0xctf", clock),
  };
}
