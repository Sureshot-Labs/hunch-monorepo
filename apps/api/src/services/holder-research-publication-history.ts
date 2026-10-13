import type { DbQuery } from "../db.js";
import type { HolderPublicationComparison } from "../schemas/holder-publication-comparison.js";
import {
  buildHolderResearchExternalFactReason,
  type HolderResearchUpdateSnapshot,
} from "./signal-publication-contract.js";

type Side = "YES" | "NO";
export type HolderPublicPosition = {
  walletId: string;
  side: Side;
  positionShares: number | null;
  observedAt: string | null;
  currentPrice: number | null;
  strong: boolean;
};
export type HolderPublicNote = {
  noteId: string;
  marketId: string;
  side: Side;
  publishedAt: string;
  title: string;
  summary: string;
  sideLabel: string | null;
  priceSnapshot: unknown;
  decisionSnapshot: unknown;
  externalResearch: unknown;
};
export type HolderContractHistory = {
  status: "ok" | "unavailable";
  items: HolderPublicNote[];
};

export function latestHolderComparisonPositions(
  positions: HolderPublicPosition[],
): HolderPublicPosition[] {
  const latest = new Map<string, HolderPublicPosition>();
  for (const position of positions) {
    if (
      position.positionShares == null ||
      !position.observedAt ||
      !Number.isFinite(Date.parse(position.observedAt))
    )
      continue;
    const key = `${position.walletId}:${position.side}`;
    const previous = latest.get(key);
    if (
      !previous ||
      Date.parse(position.observedAt) >= Date.parse(previous.observedAt ?? "")
    )
      latest.set(key, position);
  }
  return [...latest.values()];
}

/** Exact candidate markets only. One row per note, earliest ordinary delivery. */
export const HOLDER_PUBLIC_HISTORY_SQL = `
  select history_row.*
  from unnest($1::text[]) as requested_market(market_id)
  cross join lateral (
    select n.id::text as "noteId", n.source_id as "marketId",
      case n.direction when 'up' then 'YES' else 'NO' end as side,
      delivery_row.sent_at::text as "publishedAt", n.title, n.description as summary,
      n.metrics #>> '{sideCopy,label}' as "sideLabel",
      delivery_row.metrics->'publicationSnapshotV1' as "priceSnapshot",
      n.lineage->'decision_snapshot' as "decisionSnapshot",
      n.model_meta->'external_research' as "externalResearch"
    from ai_note_targets market_target
    join ai_notes n on n.id = market_target.note_id
    cross join lateral (
      select sent.sent_at, sent.metrics
      from signal_bot_messages sent
      where sent.note_id = n.id
        and sent.message_kind in ('initial', 'research_update')
        and sent.telegram_message_id is not null
        and coalesce(sent.metrics->>'status', 'sent') = 'sent'
        and coalesce(sent.metrics->>'contentProfile', '') <> 'x_editorial_draft_v1'
        and sent.sent_at <= $2::timestamptz
      order by sent.sent_at, sent.id limit 1
    ) delivery_row
    where market_target.target_kind = 'market'
      and market_target.target_id = requested_market.market_id
      and market_target.is_primary = true
      and n.source_id = requested_market.market_id
      and ($3::uuid is null or n.id <> $3::uuid)
      and n.note_type = 'signal' and n.producer_type = 'holder_research'
      and n.status in ('active', 'superseded') and n.direction in ('up', 'down')
    order by delivery_row.sent_at desc, n.id desc limit 4
  ) history_row
  order by "marketId", "publishedAt"::timestamptz desc, "noteId" desc
`;

export async function loadHolderPublicHistory(
  db: DbQuery,
  marketIds: string[],
  asOf = new Date(),
  excludeNoteId: string | null = null,
): Promise<Map<string, HolderContractHistory>> {
  const ids = [...new Set(marketIds)];
  const result = new Map<string, HolderContractHistory>(
    ids.map((id) => [id, { status: "ok", items: [] }]),
  );
  if (!ids.length) return result;
  const { rows } = await db.query<HolderPublicNote>(HOLDER_PUBLIC_HISTORY_SQL, [
    ids,
    asOf.toISOString(),
    excludeNoteId,
  ]);
  for (const row of rows)
    result.get(row.marketId)?.items.push(normalizeHolderPublicNote(row));
  return result;
}

/** Public text remains a source-contract thesis even if a legacy CTA routed
 * elsewhere. Keep that thesis, but never attach the other contract's price. */
export function normalizeHolderPublicNote<T extends HolderPublicNote>(
  note: T,
): T {
  const snapshot = record(note.priceSnapshot);
  return {
    ...note,
    priceSnapshot:
      snapshot.marketId === note.marketId && snapshot.side === note.side
        ? note.priceSnapshot
        : null,
  };
}

// Exact keys from the bounded candidate/public-history set, never a wallet scan.
// An absent row is unknown; only an observed zero proves an exit.
export const HOLDER_COMPARISON_POSITIONS_SQL = `
  select requested_position.*, snapshot_row.shares::text, snapshot_row.price::text,
    snapshot_row.snapshot_at::text
  from jsonb_to_recordset($1::jsonb) as requested_position(
    wallet_id uuid, venue text, market_id text, outcome_side text
  )
  cross join lateral (
    select position_row.shares, position_row.price, position_row.snapshot_at
    from wallet_position_snapshots position_row
    where position_row.wallet_id = requested_position.wallet_id
      and position_row.venue = requested_position.venue
      and position_row.market_id = requested_position.market_id
      and position_row.outcome_side = requested_position.outcome_side
      and position_row.snapshot_at <= $2::timestamptz
    order by position_row.snapshot_at desc limit 1
  ) snapshot_row
`;

export async function loadHolderComparisonPositions(
  db: DbQuery,
  keys: Array<{
    walletId: string;
    venue: string;
    marketId: string;
    side: Side;
  }>,
  asOf = new Date(),
): Promise<Map<string, HolderPublicPosition>> {
  const unique = [
    ...new Map(
      keys.map((key) => [
        `${key.walletId}:${key.venue}:${key.marketId}:${key.side}`,
        key,
      ]),
    ).values(),
  ];
  if (!unique.length) return new Map();
  const { rows } = await db.query<{
    wallet_id: string;
    venue: string;
    market_id: string;
    outcome_side: Side;
    shares: string | null;
    price: string | null;
    snapshot_at: string;
  }>(HOLDER_COMPARISON_POSITIONS_SQL, [
    JSON.stringify(
      unique.map((key) => ({
        wallet_id: key.walletId,
        venue: key.venue,
        market_id: key.marketId,
        outcome_side: key.side,
      })),
    ),
    asOf.toISOString(),
  ]);
  return new Map(
    rows.map((row) => [
      `${row.wallet_id}:${row.venue}:${row.market_id}:${row.outcome_side}`,
      {
        walletId: row.wallet_id,
        side: row.outcome_side,
        positionShares: number(row.shares),
        currentPrice: number(row.price),
        observedAt: row.snapshot_at,
        strong: false,
      },
    ]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function publicSnapshotPositions(
  value: unknown,
): HolderPublicPosition[] {
  const positions = record(value).publicComparisonPositions;
  if (!Array.isArray(positions)) return [];
  return positions.flatMap((entry) => {
    const row = record(entry);
    if (
      typeof row.walletId !== "string" ||
      !["YES", "NO"].includes(String(row.side))
    )
      return [];
    return [
      {
        walletId: row.walletId,
        side: row.side as Side,
        positionShares: number(row.positionShares),
        observedAt: typeof row.observedAt === "string" ? row.observedAt : null,
        currentPrice: number(row.currentPrice),
        strong: row.strong === true,
      },
    ];
  });
}

export type HolderPublicationChange = {
  id: string;
  kind: "position_change" | "external_fact";
  side: Side;
  observedAt: string;
  description: string;
  walletId?: string;
  beforeShares?: number;
  afterShares?: number;
  sourceUrl?: string;
};

/** USD repricing, missing rows and a rating change are not position changes. */
export function holderPublicPositionChanges(input: {
  baseline: HolderPublicNote;
  current: HolderPublicPosition[];
  minUsd: number;
  minPct: number;
  now?: Date;
}): HolderPublicationChange[] {
  return compareHolderPositionQuantities({
    previous: publicSnapshotPositions(input.baseline.decisionSnapshot),
    current: input.current,
    after: input.baseline.publishedAt,
    minUsd: input.minUsd,
    minPct: input.minPct,
    now: input.now,
  });
}

export function compareHolderPositionQuantities(input: {
  previous: HolderPublicPosition[];
  current: HolderPublicPosition[];
  after?: string;
  minUsd: number;
  minPct: number;
  now?: Date;
}): HolderPublicationChange[] {
  const before = input.previous;
  const now = (input.now ?? new Date()).getTime();
  const baselineMs = input.after ? Date.parse(input.after) : null;
  if (baselineMs != null && !Number.isFinite(baselineMs)) return [];
  return input.current.flatMap((position) => {
    const previous = before.find(
      (row) => row.walletId === position.walletId && row.side === position.side,
    );
    if (
      !previous ||
      !previous.strong ||
      previous.positionShares == null ||
      position.positionShares == null ||
      previous.positionShares < 0 ||
      position.positionShares < 0 ||
      !previous.observedAt ||
      !position.observedAt ||
      previous.currentPrice == null ||
      previous.currentPrice <= 0 ||
      previous.currentPrice >= 1
    )
      return [];
    const observedMs = Date.parse(position.observedAt);
    const previousMs = Date.parse(previous.observedAt);
    if (
      !Number.isFinite(observedMs) ||
      !Number.isFinite(previousMs) ||
      (baselineMs != null &&
        (previousMs > baselineMs || observedMs <= baselineMs)) ||
      observedMs <= previousMs ||
      observedMs > now
    )
      return [];
    const delta = position.positionShares - previous.positionShares;
    // A verified reduction/exit of a formerly strong holder stays informative
    // even after its size drops below the qualification threshold.
    if (delta > 0 && !position.strong) return [];
    if (
      Math.abs(delta) <= 1e-9 ||
      Math.abs(delta) < Math.abs(previous.positionShares) * input.minPct ||
      Math.abs(delta) * previous.currentPrice < input.minUsd
    )
      return [];
    return [
      {
        id: `position:${position.walletId}:${position.side}:${position.observedAt}`,
        kind: "position_change" as const,
        side: position.side,
        observedAt: position.observedAt,
        walletId: position.walletId,
        beforeShares: previous.positionShares,
        afterShares: position.positionShares,
        description: `Observed ${position.side} quantity changed from ${previous.positionShares} to ${position.positionShares}; this is not proof of a specific trade or intent.`,
      },
    ];
  });
}

export function holderPublicationPromptContext(input: {
  history: HolderContractHistory;
  positions: HolderPublicPosition[];
  minUsd: number;
  minPct: number;
}) {
  const latest = input.history.items[0];
  return {
    role: "editorial_comparison_only",
    status: input.history.status,
    latestNoteId: latest?.noteId ?? null,
    // Explicitly ordered; do not collapse YES -> NO -> YES into two rows.
    chronology: [...input.history.items]
      .reverse()
      .map(
        ({
          decisionSnapshot: _snapshot,
          externalResearch: _research,
          ...note
        }) => note,
      ),
    verifiedPositionChanges: latest
      ? holderPublicPositionChanges({
          baseline: latest,
          current: input.positions,
          minUsd: input.minUsd,
          minPct: input.minPct,
        })
      : [],
  };
}

export function assessHolderSideChange(input: {
  enabled: boolean;
  side: Side;
  history: HolderContractHistory;
  comparison: HolderPublicationComparison;
  positions: HolderPublicPosition[];
  externalResearch?: unknown;
  externalFactEvidence?: unknown;
  minUsd: number;
  minPct: number;
  now?: Date;
}): {
  allowed: boolean;
  reason: string;
  baselineNoteId: string | null;
  evidence: HolderPublicationChange[];
} {
  const baseline = input.history.items[0];
  const result = {
    baselineNoteId: baseline?.noteId ?? null,
    evidence: [] as HolderPublicationChange[],
  };
  if (!input.enabled)
    return { ...result, allowed: true, reason: "policy_disabled" };
  if (input.history.status !== "ok")
    return {
      ...result,
      allowed: false,
      reason: "publication_history_unavailable",
    };
  if (!baseline || baseline.side === input.side)
    return {
      ...result,
      allowed: true,
      reason: baseline ? "same_side" : "first_publication",
    };
  const comparison = input.comparison;
  if (
    !comparison ||
    comparison.baselineNoteId !== baseline.noteId ||
    comparison.kind !== "opposing" ||
    !comparison.materialChange
  )
    return {
      ...result,
      allowed: false,
      reason: "side_change_comparison_missing",
    };
  const positions = holderPublicPositionChanges({
    baseline,
    current: input.positions,
    minUsd: input.minUsd,
    minPct: input.minPct,
    now: input.now,
  });
  const now = input.now ?? new Date();
  const fact = buildHolderResearchExternalFactReason({
    baselineAsOf: baseline.publishedAt,
    changedAt: now.toISOString(),
    externalFactEvidence: input.externalFactEvidence,
    externalResearch: input.externalResearch,
    previousExternalResearch: baseline.externalResearch,
    selectedSide: input.side,
  });
  const changes: HolderPublicationChange[] = [
    ...positions,
    ...(fact
      ? [
          {
            id: `external:${fact.sourceUrl}`,
            kind: "external_fact" as const,
            side: input.side,
            observedAt: fact.eventAt,
            description: fact.fact,
            sourceUrl: fact.sourceUrl,
          },
        ]
      : []),
  ];
  const selected = changes.filter((change) =>
    comparison.evidenceIds.includes(change.id),
  );
  return {
    ...result,
    evidence: selected,
    allowed: selected.length > 0,
    reason: selected.length
      ? "verified_material_change"
      : "side_change_no_verified_change",
  };
}

export function publicHistoryBaselineMatches(
  evaluated: HolderContractHistory,
  current: HolderContractHistory,
): boolean {
  return (
    evaluated.status === "ok" &&
    current.status === "ok" &&
    (evaluated.items[0]?.noteId ?? null) === (current.items[0]?.noteId ?? null)
  );
}

// Structural assertion: the existing update contract can consume extended snapshots.
export type HolderPublicComparisonSnapshot = HolderResearchUpdateSnapshot & {
  publicComparisonPositions?: HolderPublicPosition[];
};
