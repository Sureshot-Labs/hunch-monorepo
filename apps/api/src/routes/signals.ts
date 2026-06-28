import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { eventParamsSchema } from "../schemas/event.js";
import { marketParamsSchema } from "../schemas/market.js";
import {
  holderResearchWalletNotesBodySchema,
  scopedSignalsQuerySchema,
  type SignalsQuery,
  signalsQuerySchema,
} from "../schemas/signals.js";
import { requestMarketRefreshForMarketRefs } from "../lib/market-refresh.js";
import { buildWalletIntelAcceptingOrdersSql } from "../services/wallet-intel-market-eligibility.js";

type SignalStatus = "active" | "superseded" | "retracted";
type SignalType = "catalyst" | "risk" | "update";
type SignalDirection = "up" | "down" | "mixed";
type SignalScope = "all" | "market" | "event" | "node" | "wallet";
type SignalTargetKind = "market" | "event" | "node" | "wallet";
type SignalProducerType = "map_signals" | "holder_research";

type SignalRow = {
  id: string;
  note_key: string;
  status: SignalStatus;
  title: string;
  description: string;
  rationale: string | null;
  source_kind: string | null;
  source_id: string | null;
  producer_type: string;
  producer_run_id: string;
  lineage: unknown;
  signal_type: SignalType | null;
  direction: SignalDirection | null;
  confidence: unknown;
  reason_codes: unknown;
  metrics: unknown;
  model_meta: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  primary_target_kind: SignalTargetKind | null;
  primary_target_id: string | null;
  primary_affinity_score: unknown;
  primary_target_meta: unknown;
  target_market_id: string | null;
  target_market_event_id: string | null;
  target_market_title: string | null;
  target_market_venue: string | null;
  target_market_best_bid: unknown;
  target_market_best_ask: unknown;
  target_market_last_price: unknown;
  target_market_accepting_orders: boolean | null;
  target_market_volume_24h: unknown;
  target_market_volume_total: unknown;
  target_market_liquidity: unknown;
  target_market_open_interest: unknown;
  target_market_image: string | null;
  target_market_icon: string | null;
  target_event_id: string | null;
  target_event_title: string | null;
  target_event_category: string | null;
  target_event_slug: string | null;
  target_event_image: string | null;
  target_event_icon: string | null;
};

type SignalTargetRow = {
  note_id: string;
  target_kind: SignalTargetKind;
  target_id: string;
  is_primary: boolean;
  target_rank: number;
  affinity_score: unknown;
  target_meta: unknown;
};

type SignalEvidenceCountRow = {
  note_id: string;
  evidence_count: unknown;
};

type SimilarMarketRow = {
  event_id: string;
  market_id: string;
  venue: string | null;
  market_title: string | null;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  accepting_orders: boolean | null;
  volume_24h: unknown;
  volume_total: unknown;
  liquidity: unknown;
  open_interest: unknown;
  image: string | null;
  icon: string | null;
};

type SignalTraderRow = {
  note_id: string;
  wallet_id: string;
  address: string | null;
  chain: string | null;
  label: string | null;
  profile_label: string | null;
  target_rank: number;
  target_meta: unknown;
  wallet_kind: string | null;
  owner_address: string | null;
  owner_wallet_id: string | null;
};

type SignalTrader = {
  walletId: string;
  address: string | null;
  chain: string | null;
  label: string | null;
  profileLabel: string | null;
  rank: number;
  side: string | null;
  positionUsd: number | null;
  pnl: number | null;
  edge: number | null;
  edgeZScore: number | null;
  samples: number | null;
  trades: number | null;
  winRate: number | null;
  walletKind: string | null;
  ownerAddress: string | null;
  ownerWalletId: string | null;
};

type HolderResearchWalletNoteRow = {
  wallet_id: string;
  note_id: string;
  note_key: string;
  status: SignalStatus;
  title: string;
  description: string;
  signal_type: SignalType | null;
  direction: SignalDirection | null;
  confidence: unknown;
  created_at: Date | string;
  target_meta: unknown;
  total_count: unknown;
  latest_at: Date | string | null;
  market_id: string | null;
  market_title: string | null;
  event_id: string | null;
  event_title: string | null;
  yes_probability: unknown;
};

type HolderResearchWalletNote = {
  noteId: string;
  noteKey: string;
  status: SignalStatus;
  createdAt: string;
  title: string;
  summary: string;
  signalType: SignalType | null;
  direction: SignalDirection | null;
  confidence: number | null;
  marketId: string | null;
  marketTitle: string | null;
  eventId: string | null;
  eventTitle: string | null;
  yesProbability: number | null;
  side: string | null;
  positionUsd: number | null;
  pnl: number | null;
  edge: number | null;
};

type HolderResearchWalletNotesResponse = {
  ok: true;
  wallets: Record<
    string,
    {
      hasNotes: boolean;
      count: number;
      latestAt: string | null;
      notes: HolderResearchWalletNote[];
    }
  >;
};

type SignalListItem = {
  id: string;
  noteKey: string;
  status: SignalStatus;
  title: string;
  description: string;
  rationale: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  producerType: string;
  producerRunId: string;
  lineage: Record<string, unknown>;
  signalType: SignalType | null;
  direction: SignalDirection | null;
  confidence: number | null;
  reasonCodes: string[];
  metrics: Record<string, unknown>;
  modelMeta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  primaryTarget: {
    kind: SignalTargetKind | null;
    id: string | null;
    affinityScore: number | null;
    meta: Record<string, unknown>;
  };
  targets: Array<{
    kind: SignalTargetKind;
    id: string;
    isPrimary: boolean;
    rank: number;
    affinityScore: number | null;
    meta: Record<string, unknown>;
  }>;
  evidence: Array<{
    evidenceId: string;
    relevance: number | null;
    headline: string | null;
    sourceUrl: string | null;
    sourceDomain: string | null;
    publishedAt: string | null;
    confirmation: "confirmed" | "developing" | "unconfirmed" | null;
  }>;
  evidenceCount: number;
  market: {
    marketId: string;
    eventId: string | null;
    venue: string | null;
    marketTitle: string | null;
    bestBid: number | null;
    bestAsk: number | null;
    lastPrice: number | null;
    acceptingOrders: boolean | null;
    volume24h: number;
    volumeTotal: number;
    liquidity: number;
    openInterest: number;
    image: string | null;
    icon: string | null;
  } | null;
  event: {
    eventId: string;
    eventTitle: string | null;
    category: string | null;
    eventSlug: string | null;
    image: string | null;
    icon: string | null;
  } | null;
  similarMarkets: Array<{
    marketId: string;
    eventId: string;
    venue: string | null;
    marketTitle: string | null;
    bestBid: number | null;
    bestAsk: number | null;
    lastPrice: number | null;
    acceptingOrders: boolean | null;
    volume24h: number;
    volumeTotal: number;
    liquidity: number;
    openInterest: number;
    image: string | null;
    icon: string | null;
  }>;
  traders?: SignalTrader[];
};

type SignalListResponse = {
  items: SignalListItem[];
  scope: SignalScope;
  targetId: string | null;
  limit: number;
  offset: number;
  hasMore: boolean;
};

function requestSignalsMarketRefresh(items: SignalListItem[]): void {
  const marketIds = new Set<string>();
  const eventIds = new Set<string>();

  for (const item of items) {
    if (item.market?.marketId) marketIds.add(item.market.marketId);
    if (item.market?.eventId) eventIds.add(item.market.eventId);
    if (item.event?.eventId) eventIds.add(item.event.eventId);
    for (const target of item.targets) {
      if (target.kind === "market") marketIds.add(target.id);
      if (target.kind === "event") eventIds.add(target.id);
    }
    for (const market of item.similarMarkets) {
      if (market.marketId) marketIds.add(market.marketId);
      if (market.eventId) eventIds.add(market.eventId);
    }
  }

  requestMarketRefreshForMarketRefs({
    db: pool,
    marketIds: Array.from(marketIds),
    eventIds: Array.from(eventIds),
    logLabel: "signals",
  });
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNonNegativeNumber(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed == null || parsed < 0) return 0;
  return parsed;
}

function toInt(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed == null) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asEvidenceConfirmation(
  value: unknown,
): "confirmed" | "developing" | "unconfirmed" | null {
  if (
    value === "confirmed" ||
    value === "developing" ||
    value === "unconfirmed"
  ) {
    return value;
  }
  return null;
}

type ModelEvidenceRef = {
  evidence_id?: unknown;
  headline?: unknown;
  source_url?: unknown;
  source_domain?: unknown;
  published_at?: unknown;
  confirmation?: unknown;
  relevance?: unknown;
};

function parseModelEvidenceRefs(modelMeta: unknown): Array<{
  evidenceId: string;
  relevance: number | null;
  headline: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  publishedAt: string | null;
  confirmation: "confirmed" | "developing" | "unconfirmed" | null;
}> {
  const meta = asObject(modelMeta);
  const refsRaw = meta.evidence_refs;
  if (!Array.isArray(refsRaw)) return [];

  return refsRaw
    .map((entry) => {
      const ref = (
        entry && typeof entry === "object" ? (entry as ModelEvidenceRef) : {}
      ) as ModelEvidenceRef;
      return {
        evidenceId: asTrimmedString(ref.evidence_id) ?? "",
        relevance: toNumber(ref.relevance),
        headline: asTrimmedString(ref.headline),
        sourceUrl: asTrimmedString(ref.source_url),
        sourceDomain: asTrimmedString(ref.source_domain),
        publishedAt: asTrimmedString(ref.published_at),
        confirmation: asEvidenceConfirmation(ref.confirmation),
      };
    })
    .filter((ref) => ref.evidenceId.length > 0)
    .slice(0, 6);
}

function buildSignalTrader(row: SignalTraderRow): SignalTrader {
  const meta = asObject(row.target_meta);
  return {
    walletId: row.wallet_id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    profileLabel: row.profile_label,
    rank: row.target_rank,
    side: asTrimmedString(meta.side),
    positionUsd: toNumber(meta.positionUsd),
    pnl: toNumber(meta.openPnlUsd),
    edge: toNumber(meta.resolvedWinRateEdge30d),
    edgeZScore: toNumber(meta.resolvedEdgeZScore30d),
    samples: toNumber(meta.resolvedEdgeSampleCount30d),
    trades: toNumber(meta.trades30d),
    winRate: toNumber(meta.winRate30d),
    walletKind: row.wallet_kind ?? asTrimmedString(meta.walletKind),
    ownerAddress: row.owner_address ?? asTrimmedString(meta.ownerAddress),
    ownerWalletId: row.owner_wallet_id,
  };
}

async function loadHolderResearchSignalTraders(params: {
  noteIds: string[];
  limitPerNote: number;
}): Promise<Map<string, SignalTrader[]>> {
  const byNoteId = new Map<string, SignalTrader[]>();
  if (params.noteIds.length === 0 || params.limitPerNote <= 0) {
    return byNoteId;
  }

  const { rows } = await pool.query<SignalTraderRow>(
    `
      with ranked as (
        select
          t.note_id,
          t.target_id as wallet_id,
          w.address,
          w.chain,
          w.label,
          wp.profile->>'label_short' as profile_label,
          t.target_rank,
          t.target_meta,
          ons.wallet_kind,
          ons.owner_address,
          owner.id::text as owner_wallet_id,
          row_number() over (
            partition by t.note_id
            order by t.target_rank asc, t.target_id asc
          ) as trader_rank
        from ai_note_targets t
        left join wallets w on w.id::text = t.target_id
        left join wallet_profiles wp on wp.wallet_id = w.id
        left join wallet_onchain_state ons on ons.wallet_id = w.id
        left join wallets owner
          on owner.chain = w.chain
         and lower(owner.address) = lower(ons.owner_address)
        where t.note_id = any($1::uuid[])
          and t.target_kind = 'wallet'
      )
      select
        note_id,
        wallet_id,
        address,
        chain,
        label,
        profile_label,
        target_rank,
        target_meta,
        wallet_kind,
        owner_address,
        owner_wallet_id
      from ranked
      where trader_rank <= $2::integer
      order by note_id asc, target_rank asc, wallet_id asc
    `,
    [params.noteIds, params.limitPerNote],
  );

  for (const row of rows) {
    const list = byNoteId.get(row.note_id) ?? [];
    list.push(buildSignalTrader(row));
    byNoteId.set(row.note_id, list);
  }

  return byNoteId;
}

async function fetchHolderResearchWalletNotes(params: {
  walletIds: string[];
  limitPerWallet: number;
}): Promise<HolderResearchWalletNotesResponse> {
  const uniqueWalletIds = Array.from(new Set(params.walletIds));
  const limitPerWallet = Math.min(10, Math.max(0, params.limitPerWallet));
  const wallets: HolderResearchWalletNotesResponse["wallets"] =
    Object.fromEntries(
      uniqueWalletIds.map((walletId) => [
        walletId,
        {
          hasNotes: false,
          count: 0,
          latestAt: null,
          notes: [],
        },
      ]),
    );

  if (uniqueWalletIds.length === 0) {
    return { ok: true, wallets };
  }
  const queryLimitPerWallet = Math.max(1, limitPerWallet);

  const { rows } = await pool.query<HolderResearchWalletNoteRow>(
    `
      with input_wallets as (
        select unnest($1::uuid[])::text as wallet_id
      ),
      matched as (
        select
          input.wallet_id,
          n.id as note_id,
          n.note_key,
          n.status,
          n.title,
          n.description,
          n.signal_type,
          n.direction,
          n.confidence,
          n.created_at,
          wallet_target.target_meta,
          count(*) over (partition by input.wallet_id) as total_count,
          max(n.created_at) over (partition by input.wallet_id) as latest_at,
          row_number() over (
            partition by input.wallet_id
            order by n.created_at desc, n.id desc
          ) as note_rank
        from input_wallets input
        join ai_note_targets wallet_target
          on wallet_target.target_kind = 'wallet'
         and wallet_target.target_id = input.wallet_id
        join ai_notes n on n.id = wallet_target.note_id
        where n.note_type = 'signal'
          and n.producer_type = 'holder_research'
          and n.status = 'active'
      ),
      page as (
        select *
        from matched
        where note_rank <= $2::integer
      ),
      market_targets as (
        select distinct on (t.note_id)
          t.note_id,
          t.target_id as market_id
        from ai_note_targets t
        where t.note_id in (select note_id from page)
          and t.target_kind = 'market'
        order by t.note_id, t.is_primary desc, t.target_rank asc
      )
      select
        page.wallet_id,
        page.note_id,
        page.note_key,
        page.status,
        page.title,
        page.description,
        page.signal_type,
        page.direction,
        page.confidence,
        page.created_at,
        page.target_meta,
        page.total_count,
        page.latest_at,
        m.id as market_id,
        m.title as market_title,
        m.event_id,
        e.title as event_title,
        case
          when m.best_bid is not null and m.best_ask is not null
            then (m.best_bid + m.best_ask) / 2
          else m.last_price
        end as yes_probability
      from page
      left join market_targets mt on mt.note_id = page.note_id
      left join unified_markets m on m.id = mt.market_id
      left join unified_events e on e.id = m.event_id
      order by page.wallet_id asc, page.created_at desc, page.note_id desc
    `,
    [uniqueWalletIds, queryLimitPerWallet],
  );

  for (const row of rows) {
    const entry = wallets[row.wallet_id];
    if (!entry) continue;
    const meta = asObject(row.target_meta);
    entry.hasNotes = true;
    entry.count = toInt(row.total_count);
    entry.latestAt = row.latest_at ? toIsoString(row.latest_at) : null;
    if (limitPerWallet <= 0) continue;
    entry.notes.push({
      noteId: row.note_id,
      noteKey: row.note_key,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      title: row.title,
      summary: row.description,
      signalType: row.signal_type,
      direction: row.direction,
      confidence: toNumber(row.confidence),
      marketId: row.market_id,
      marketTitle: row.market_title,
      eventId: row.event_id,
      eventTitle: row.event_title,
      yesProbability: toNumber(row.yes_probability),
      side: asTrimmedString(meta.side),
      positionUsd: toNumber(meta.positionUsd),
      pnl: toNumber(meta.openPnlUsd),
      edge: toNumber(meta.resolvedWinRateEdge30d),
    });
  }

  return { ok: true, wallets };
}

function buildSignalsWhereClause(params: {
  scope: SignalScope;
  targetId: string | null;
  status: SignalsQuery["status"];
  signalType: SignalsQuery["signalType"];
  direction: SignalsQuery["direction"];
  venue: SignalsQuery["venue"];
  producerType: SignalProducerType;
}): { whereSql: string; values: unknown[] } {
  const values: unknown[] = [];
  const clauses: string[] = [
    "n.note_type = 'signal'",
    `n.producer_type = '${params.producerType}'`,
    `not exists (
      select 1
      from ai_note_targets am_target
      left join unified_markets am
        on am.id = am_target.target_id
       and am_target.target_kind = 'market'
      left join unified_events ae on ae.id = am.event_id
      where am_target.note_id = n.id
        and am_target.target_kind = 'market'
        and (
          am.id is null
          or not ${buildWalletIntelAcceptingOrdersSql({
            marketAlias: "am",
            eventAlias: "ae",
          })}
        )
    )`,
  ];

  if (params.status && params.status !== "all") {
    values.push(params.status);
    clauses.push(`n.status = $${values.length}`);
  }
  if (params.signalType) {
    values.push(params.signalType);
    clauses.push(`n.signal_type = $${values.length}`);
  }
  if (params.direction) {
    values.push(params.direction);
    clauses.push(`n.direction = $${values.length}`);
  }

  if (params.scope !== "all") {
    if (!params.targetId) {
      throw new Error("targetId is required when scope != all");
    }
    values.push(params.targetId);
    const valueRef = `$${values.length}`;
    clauses.push(
      `exists (
        select 1
        from ai_note_targets ts
        where ts.note_id = n.id
          and ts.target_kind = '${params.scope}'
          and ts.target_id = ${valueRef}
      )`,
    );
  }

  if (params.venue) {
    values.push(params.venue);
    const valueRef = `$${values.length}`;
    clauses.push(
      `exists (
        select 1
        from ai_note_targets tv
        join unified_markets vm
          on vm.id = tv.target_id
         and tv.target_kind = 'market'
        where tv.note_id = n.id
          and vm.venue = ${valueRef}
      )`,
    );
  }

  return { whereSql: clauses.join(" and "), values };
}

async function fetchSignals(params: {
  query: SignalsQuery;
  forcedScope?: SignalScope;
  forcedTargetId?: string;
  producerType?: SignalProducerType;
}): Promise<SignalListResponse> {
  const scope = params.forcedScope ?? params.query.scope ?? "all";
  const targetId =
    (params.forcedTargetId ?? params.query.targetId ?? "").trim() || null;
  const limit = Math.min(100, Math.max(1, params.query.limit ?? 20));
  const offset = Math.max(0, params.query.offset ?? 0);
  const includeSimilarMarkets = params.query.includeSimilarMarkets ?? false;
  const similarLimit = Math.min(
    12,
    Math.max(1, params.query.similarLimit ?? 4),
  );
  const producerType = params.producerType ?? "map_signals";
  const includeTraders =
    producerType === "holder_research" &&
    (params.query.includeTraders ?? false);
  const traderLimit = Math.min(10, Math.max(1, params.query.traderLimit ?? 3));

  const statusFilter = params.query.status ?? "active";
  const { whereSql, values } = buildSignalsWhereClause({
    scope,
    targetId,
    status: statusFilter,
    signalType: params.query.signalType,
    direction: params.query.direction,
    venue: params.query.venue,
    producerType,
  });

  values.push(limit + 1);
  const limitRef = `$${values.length}`;
  values.push(offset);
  const offsetRef = `$${values.length}`;

  const { rows } = await pool.query<SignalRow>(
    `
      with base as (
        select
          n.id,
          n.note_key,
          n.status,
          n.title,
          n.description,
          n.rationale,
          n.source_kind,
          n.source_id,
          n.producer_type,
          n.producer_run_id,
          n.lineage,
          n.signal_type,
          n.direction,
          n.confidence,
          n.reason_codes,
          n.metrics,
          n.model_meta,
          n.created_at,
          n.updated_at,
          pt.target_kind as primary_target_kind,
          pt.target_id as primary_target_id,
          pt.affinity_score as primary_affinity_score,
          pt.target_meta as primary_target_meta
        from ai_notes n
        left join ai_note_targets pt
          on pt.note_id = n.id
         and pt.is_primary = true
        where ${whereSql}
        order by n.created_at desc, n.id desc
        limit ${limitRef}
        offset ${offsetRef}
      )
      select
        b.*,
        m.id as target_market_id,
        m.event_id as target_market_event_id,
        m.title as target_market_title,
        m.venue as target_market_venue,
        m.best_bid as target_market_best_bid,
        m.best_ask as target_market_best_ask,
        m.last_price as target_market_last_price,
        case
          when m.id is not null then ${buildWalletIntelAcceptingOrdersSql({
            marketAlias: "m",
            eventAlias: "me",
          })}
          else null
        end as target_market_accepting_orders,
        m.volume_24h as target_market_volume_24h,
        m.volume_total as target_market_volume_total,
        m.liquidity as target_market_liquidity,
        m.open_interest as target_market_open_interest,
        m.image as target_market_image,
        m.icon as target_market_icon,
        coalesce(me.id, ee.id) as target_event_id,
        coalesce(me.title, ee.title) as target_event_title,
        coalesce(me.category, ee.category) as target_event_category,
        coalesce(me.slug, ee.slug) as target_event_slug,
        coalesce(me.image, ee.image) as target_event_image,
        coalesce(me.icon, ee.icon) as target_event_icon
      from base b
      left join unified_markets m
        on b.primary_target_kind = 'market'
       and m.id = b.primary_target_id
      left join unified_events me
        on me.id = m.event_id
      left join unified_events ee
        on b.primary_target_kind = 'event'
       and ee.id = b.primary_target_id
      order by b.created_at desc, b.id desc
    `,
    values,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const noteIds = pageRows.map((row) => row.id);

  const [targetsResult, evidenceCountsResult] = noteIds.length
    ? await Promise.all([
        pool.query<SignalTargetRow>(
          `
            select
              note_id,
              target_kind,
              target_id,
              is_primary,
              target_rank,
              affinity_score,
              target_meta
            from ai_note_targets
            where note_id = any($1::uuid[])
            order by note_id asc, is_primary desc, target_rank asc, target_kind asc, target_id asc
          `,
          [noteIds],
        ),
        pool.query<SignalEvidenceCountRow>(
          `
            select note_id, count(*)::int as evidence_count
            from ai_note_evidence
            where note_id = any($1::uuid[])
            group by note_id
          `,
          [noteIds],
        ),
      ])
    : [{ rows: [] }, { rows: [] }];

  const targetsByNoteId = new Map<string, SignalTargetRow[]>();
  for (const row of targetsResult.rows) {
    if (!targetsByNoteId.has(row.note_id)) {
      targetsByNoteId.set(row.note_id, []);
    }
    targetsByNoteId.get(row.note_id)?.push(row);
  }

  const evidenceCountByNoteId = new Map<string, number>();
  for (const row of evidenceCountsResult.rows) {
    evidenceCountByNoteId.set(row.note_id, toInt(row.evidence_count));
  }

  const eventIdsForSimilar = includeSimilarMarkets
    ? Array.from(
        new Set(
          pageRows
            .map((row) => row.target_event_id)
            .filter((eventId): eventId is string => Boolean(eventId)),
        ),
      )
    : [];

  let similarByEventId = new Map<string, SimilarMarketRow[]>();
  if (eventIdsForSimilar.length > 0) {
    const similarRows = await pool.query<SimilarMarketRow>(
      `
        select
          m.event_id,
          m.id as market_id,
          m.venue,
          m.title as market_title,
          m.best_bid,
          m.best_ask,
          m.last_price,
          ${buildWalletIntelAcceptingOrdersSql({
            marketAlias: "m",
            eventAlias: "e",
          })} as accepting_orders,
          m.volume_24h,
          m.volume_total,
          m.liquidity,
          m.open_interest,
          m.image,
          m.icon
        from unified_markets m
        left join unified_events e on e.id = m.event_id
        where m.event_id = any($1::text[])
          and ${buildWalletIntelAcceptingOrdersSql({
            marketAlias: "m",
            eventAlias: "e",
          })}
      `,
      [eventIdsForSimilar],
    );

    similarByEventId = similarRows.rows.reduce((acc, row) => {
      if (!acc.has(row.event_id)) {
        acc.set(row.event_id, []);
      }
      acc.get(row.event_id)?.push(row);
      return acc;
    }, new Map<string, SimilarMarketRow[]>());

    for (const [eventId, eventRows] of similarByEventId.entries()) {
      eventRows.sort((a, b) => {
        const volumeA = Math.max(
          toNonNegativeNumber(a.volume_24h),
          toNonNegativeNumber(a.volume_total),
        );
        const volumeB = Math.max(
          toNonNegativeNumber(b.volume_24h),
          toNonNegativeNumber(b.volume_total),
        );
        if (volumeB !== volumeA) return volumeB - volumeA;
        const liqA = Math.max(
          toNonNegativeNumber(a.liquidity),
          toNonNegativeNumber(a.open_interest),
        );
        const liqB = Math.max(
          toNonNegativeNumber(b.liquidity),
          toNonNegativeNumber(b.open_interest),
        );
        if (liqB !== liqA) return liqB - liqA;
        return rowSortKey(a).localeCompare(rowSortKey(b));
      });
      similarByEventId.set(eventId, eventRows);
    }
  }

  const tradersByNoteId = includeTraders
    ? await loadHolderResearchSignalTraders({
        noteIds,
        limitPerNote: traderLimit,
      })
    : new Map<string, SignalTrader[]>();

  const items: SignalListItem[] = pageRows.map((row) => {
    const targets = (targetsByNoteId.get(row.id) ?? []).map((target) => ({
      kind: target.target_kind,
      id: target.target_id,
      isPrimary: target.is_primary,
      rank: target.target_rank,
      affinityScore: toNumber(target.affinity_score),
      meta: asObject(target.target_meta),
    }));

    const eventId = row.target_event_id;
    const primaryMarketId = row.target_market_id;
    const similarRows =
      includeSimilarMarkets && eventId
        ? (similarByEventId.get(eventId) ?? [])
            .filter((candidate) => candidate.market_id !== primaryMarketId)
            .slice(0, similarLimit)
        : [];

    return {
      id: row.id,
      noteKey: row.note_key,
      status: row.status,
      title: row.title,
      description: row.description,
      rationale: row.rationale,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      producerType: row.producer_type,
      producerRunId: row.producer_run_id,
      lineage: asObject(row.lineage),
      signalType: row.signal_type,
      direction: row.direction,
      confidence: toNumber(row.confidence),
      reasonCodes: asStringArray(row.reason_codes),
      metrics: asObject(row.metrics),
      modelMeta: asObject(row.model_meta),
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      primaryTarget: {
        kind: row.primary_target_kind,
        id: row.primary_target_id,
        affinityScore: toNumber(row.primary_affinity_score),
        meta: asObject(row.primary_target_meta),
      },
      targets,
      evidence: parseModelEvidenceRefs(row.model_meta),
      evidenceCount: evidenceCountByNoteId.get(row.id) ?? 0,
      market: row.target_market_id
        ? {
            marketId: row.target_market_id,
            eventId: row.target_market_event_id,
            venue: row.target_market_venue,
            marketTitle: row.target_market_title,
            bestBid: toNumber(row.target_market_best_bid),
            bestAsk: toNumber(row.target_market_best_ask),
            lastPrice: toNumber(row.target_market_last_price),
            acceptingOrders: row.target_market_accepting_orders,
            volume24h: toNonNegativeNumber(row.target_market_volume_24h),
            volumeTotal: toNonNegativeNumber(row.target_market_volume_total),
            liquidity: toNonNegativeNumber(row.target_market_liquidity),
            openInterest: toNonNegativeNumber(row.target_market_open_interest),
            image: row.target_market_image,
            icon: row.target_market_icon,
          }
        : null,
      event: row.target_event_id
        ? {
            eventId: row.target_event_id,
            eventTitle: row.target_event_title,
            category: row.target_event_category,
            eventSlug: row.target_event_slug,
            image: row.target_event_image,
            icon: row.target_event_icon,
          }
        : null,
      similarMarkets: similarRows.map((candidate) => ({
        marketId: candidate.market_id,
        eventId: candidate.event_id,
        venue: candidate.venue,
        marketTitle: candidate.market_title,
        bestBid: toNumber(candidate.best_bid),
        bestAsk: toNumber(candidate.best_ask),
        lastPrice: toNumber(candidate.last_price),
        acceptingOrders: candidate.accepting_orders,
        volume24h: toNonNegativeNumber(candidate.volume_24h),
        volumeTotal: toNonNegativeNumber(candidate.volume_total),
        liquidity: toNonNegativeNumber(candidate.liquidity),
        openInterest: toNonNegativeNumber(candidate.open_interest),
        image: candidate.image,
        icon: candidate.icon,
      })),
      ...(includeTraders ? { traders: tradersByNoteId.get(row.id) ?? [] } : {}),
    };
  });

  requestSignalsMarketRefresh(items);

  return {
    items,
    scope,
    targetId,
    limit,
    offset,
    hasMore,
  };
}

function rowSortKey(row: SimilarMarketRow): string {
  return `${row.market_id}|${row.market_title ?? ""}|${row.venue ?? ""}`;
}

export const signalsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/signals",
    { schema: { querystring: signalsQuerySchema } },
    async (request, reply) => {
      try {
        return await fetchSignals({ query: request.query });
      } catch (error) {
        if (error instanceof Error && error.message.includes("targetId")) {
          return reply.code(400).send({ error: error.message });
        }
        request.log.error({ err: error }, "Failed to load signals feed");
        return reply.code(500).send({ error: "Failed to load signals feed" });
      }
    },
  );

  z.get(
    "/signals/holder-research",
    { schema: { querystring: signalsQuerySchema } },
    async (request, reply) => {
      try {
        return await fetchSignals({
          query: request.query,
          producerType: "holder_research",
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("targetId")) {
          return reply.code(400).send({ error: error.message });
        }
        request.log.error(
          { err: error },
          "Failed to load holder research feed",
        );
        return reply
          .code(500)
          .send({ error: "Failed to load holder research feed" });
      }
    },
  );

  z.post(
    "/signals/holder-research/wallets",
    { schema: { body: holderResearchWalletNotesBodySchema } },
    async (request, reply) => {
      try {
        return await fetchHolderResearchWalletNotes({
          walletIds: request.body.walletIds,
          limitPerWallet:
            request.body.limitPerWallet ?? (request.body.compact ? 0 : 3),
        });
      } catch (error) {
        request.log.error(
          { err: error },
          "Failed to load holder research wallet notes",
        );
        return reply
          .code(500)
          .send({ error: "Failed to load holder research wallet notes" });
      }
    },
  );

  z.get(
    "/events/:eventId/signals",
    {
      schema: {
        params: eventParamsSchema,
        querystring: scopedSignalsQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        return await fetchSignals({
          query: request.query,
          forcedScope: "event",
          forcedTargetId: request.params.eventId,
        });
      } catch (error) {
        request.log.error(
          { err: error, eventId: request.params.eventId },
          "Failed to load event signals",
        );
        return reply.code(500).send({ error: "Failed to load event signals" });
      }
    },
  );

  z.get(
    "/markets/:marketId/signals",
    {
      schema: {
        params: marketParamsSchema,
        querystring: scopedSignalsQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        return await fetchSignals({
          query: request.query,
          forcedScope: "market",
          forcedTargetId: request.params.marketId,
        });
      } catch (error) {
        request.log.error(
          { err: error, marketId: request.params.marketId },
          "Failed to load market signals",
        );
        return reply.code(500).send({ error: "Failed to load market signals" });
      }
    },
  );
};
