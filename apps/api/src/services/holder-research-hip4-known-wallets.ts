// Read-only known-wallet source for the existing holder-research scheduler.
// No API env, provider, account ownership, financial worker or model imports.
import { createHash } from "node:crypto";
import {
  hip4Identity,
  hip4ReadMarketSchema,
  type Hip4Environment,
} from "@hunch/shared";
import type { PoolClient } from "pg";
import {
  addUnsignedDecimals,
  normalizeUnsignedDecimal,
} from "../account-value/decimal.js";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
  type Hip4TrackedFillActivity,
} from "./hip4-wallet-intel.js";
import { hip4TrackedActivityFlowProof } from "./hip4-wallet-intel-recheck.js";
import type { HolderResearchMarketInput } from "./holder-research.js";

type Queryable = Pick<PoolClient, "query">;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const iso = (value: unknown): string | null => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const decimal = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    return null;
  return normalizeUnsignedDecimal(value);
};

export type Hip4HolderKnownWalletEvidence = {
  version: 1;
  environment: Hip4Environment;
  scope: "known_wallet_only";
  globalHolders: "unavailable";
  historicalPerformance: "unavailable";
  costBasis: "unknown";
  completeHistory: false;
  contract: {
    marketId: string;
    outcome: number;
    expiry: string | null;
    sourceDescription: string;
    sides: { side: "YES" | "NO"; tokenId: string; label: string }[];
  };
  positions: {
    evidenceId: string;
    walletId: string;
    accountAddress: string;
    tokenId: string;
    side: "YES" | "NO";
    shares: string;
    positionUsd: string | null;
    snapshotAt: string;
    coverage: "complete_wallet_snapshot";
  }[];
  fills: (Hip4TrackedFillActivity & { evidenceId: string; walletId: string })[];
  /** Sum only priced rows in this bounded observed cohort; not market volume. */
  pricedFlowUsd: string;
  unknownUsdPositions: number;
  unknownUsdFills: number;
  diagnostics: string[];
};

/** Source-first page and exact correlated lookups match wallet-intel's existing
 * indexed source contract. OFFSET 0 prevents global hash decorrelation. */
export const HIP4_HOLDER_RESEARCH_SOURCE_SQL = `with source_page as materialized (
  select id,address,chain from wallets where chain=$1 and chain<>'solana'
    and lower(address)>$2 order by lower(address) limit $3
) select source_row.id::text as wallet_id,source_row.address,source_row.chain,
  coalesce(follow_presence.is_followed,false) as followed,
  coalesce(subject_presence.is_tracked,false) as tracked,venue_row.metadata
  from source_page source_row
  left join lateral (
    select true as is_followed from wallet_follows follow_row
    where follow_row.wallet_id=source_row.id limit 1 offset 0
  ) follow_presence on true
  left join lateral (
    select true as is_tracked from wallet_tracking_subjects subject_row
    where subject_row.wallet_id=source_row.id and subject_row.venue='hyperliquid'
      and subject_row.status='active' and ($5::int<=0 or subject_row.last_selected_at>=$4::timestamptz-$5*interval '1 day')
    limit 1 offset 0
  ) subject_presence on true
  left join lateral (
    select native_venue.metadata from wallet_venues native_venue
    where native_venue.wallet_id=source_row.id and native_venue.venue='hyperliquid'
    limit 1 offset 0
  ) venue_row on true order by lower(source_row.address)`;

export const HIP4_HOLDER_RESEARCH_POSITIONS_SQL = `select source_row.wallet_id::text,
  position_row.market_id,position_row.outcome_side,position_row.shares::text,
  position_row.size_usd::text,position_row.price::text,position_row.metadata,position_row.snapshot_at
  from unnest($1::uuid[],$2::timestamptz[]) source_row(wallet_id,snapshot_at)
  cross join lateral (
    select market_id,outcome_side,shares,size_usd,price,metadata,snapshot_at
    from wallet_position_snapshots snapshot_row
    where snapshot_row.wallet_id=source_row.wallet_id and snapshot_row.venue='hyperliquid'
      and snapshot_row.snapshot_at=source_row.snapshot_at limit $3 offset 0
  ) position_row`;

/** Bound all recent wallet events first. Sparse venue/source/validity filters
 * run in the pure projection, not before LIMIT over a potentially long history. */
export const HIP4_HOLDER_RESEARCH_ACTIVITY_SQL = `select source_row.wallet_id::text,
  activity_row.venue,activity_row.market_id,activity_row.outcome_side,activity_row.action,
  activity_row.delta_shares::text,activity_row.size_usd::text,activity_row.price::text,
  activity_row.activity_type,activity_row.source,activity_row.source_event_key,
  activity_row.metadata,activity_row.occurred_at
  from unnest($1::uuid[]) source_row(wallet_id)
  cross join lateral (
    select venue,market_id,outcome_side,action,delta_shares,size_usd,price,
      activity_type,source,source_event_key,metadata,occurred_at
    from wallet_activity_events event_row where event_row.wallet_id=source_row.wallet_id
      and event_row.occurred_at<=$2::timestamptz
      and event_row.occurred_at>=$2::timestamptz-$3::numeric*interval '1 hour'
    order by event_row.occurred_at desc limit $4 offset 0
  ) activity_row`;

export const HIP4_HOLDER_RESEARCH_MARKETS_SQL = `select market_row.id,market_row.event_id,market_row.venue,
  market_row.title,market_row.slug,market_row.description,market_row.metadata,market_row.outcomes,
  market_row.status,market_row.resolved_outcome,market_row.close_time,market_row.expiration_time,
  market_row.category,market_row.volume_24h,market_row.liquidity,
  event_row.title as event_title,event_row.slug as event_slug,event_row.description as event_description,
  event_row.status as event_status,event_row.end_date as event_end_date
  from unnest($1::text[]) source_row(market_id)
  cross join lateral (
    select id,event_id,venue,title,slug,description,metadata,outcomes,status,resolved_outcome,
      close_time,expiration_time,category,volume_24h,liquidity
    from unified_markets market_source where market_source.id=source_row.market_id limit 1 offset 0
  ) market_row
  left join lateral (
    select title,slug,description,status,end_date from unified_events event_source
    where event_source.id=market_row.event_id limit 1 offset 0
  ) event_row on true`;

export type Hip4HolderSourceRow = {
  wallet_id: string;
  address: string;
  chain: string;
  followed: boolean;
  tracked: boolean;
  metadata: unknown;
};
export type Hip4HolderFactRow = Record<string, unknown> & {
  wallet_id: string;
  market_id: string;
};

/** Re-run the existing native normalizer and immutable fingerprint rather than
 * trusting a metadata object merely because it is present. */
function verifiedFill(input: {
  subject: Hip4HolderSourceRow;
  row: Hip4HolderFactRow;
  environment: Hip4Environment;
  asOf: Date;
  quoteToken: string | null;
}): Hip4TrackedFillActivity | null {
  const { row, subject, environment } = input;
  const metadata = record(row.metadata);
  const fill = record(metadata.nativeFill);
  const nativeIdentity = record(fill.identity);
  if (
    row.venue !== "hyperliquid" ||
    row.source !== "hyperliquid_user_fills" ||
    row.activity_type !== "trade" ||
    metadata.scope !== "known_wallet_only" ||
    metadata.completeHistory !== false ||
    metadata.costBasis !== "unknown" ||
    fill.sourceEventKey !== row.source_event_key ||
    fill.marketId !== row.market_id ||
    fill.outcomeSide !== row.outcome_side ||
    fill.action !== row.action ||
    nativeIdentity.environment !== environment ||
    nativeIdentity.address !== subject.address.toLowerCase() ||
    nativeIdentity.chain !== subject.chain ||
    typeof fill.deltaShares !== "string" ||
    typeof fill.tokenId !== "string" ||
    !["BUY", "SELL"].includes(String(fill.action))
  )
    return null;
  try {
    const identity = hip4WalletIntelIdentity(environment, subject.address);
    const tokenParts = fill.tokenId.split(":");
    const encoded = tokenParts.at(-1) ?? "";
    if (
      tokenParts.length !== 3 ||
      tokenParts[0] !== "hyperliquid" ||
      tokenParts[1] !== environment ||
      !/^\d+$/.test(encoded)
    )
      return null;
    const parsed = normalizeHip4KnownWalletFill({
      identity,
      observedAt: input.asOf.toISOString(),
      quoteTokensByMarket: input.quoteToken
        ? new Map([[row.market_id, input.quoteToken]])
        : undefined,
      value: {
        coin: `#${encoded}`,
        px: fill.price,
        sz: fill.deltaShares.replace(/^-/, ""),
        side: fill.action === "BUY" ? "B" : "A",
        dir: fill.action === "BUY" ? "Buy" : "Sell",
        time: Date.parse(String(fill.occurredAt)),
        startPosition: fill.startPosition,
        closedPnl: fill.reportedClosedPnl,
        hash: fill.transactionHash,
        oid: Number(fill.orderId),
        tid: Number(fill.tradeId),
        crossed: fill.isTaker,
        fee: fill.fee,
        feeToken: fill.feeToken,
        ...(fill.builderFee == null ? {} : { builderFee: fill.builderFee }),
        cloid: fill.clientOrderId ?? null,
        ...(fill.twapId == null ? {} : { twapId: Number(fill.twapId) }),
      },
    });
    if (parsed.kind !== "trade") return null;
    const activity = parsed.activity;
    const signed = (value: unknown) =>
      typeof value === "string"
        ? `${value.startsWith("-") ? "-" : ""}${decimal(value.replace(/^-/, ""))}`
        : null;
    if (
      hip4TrackedFillFingerprint(activity) !== metadata.nativeFingerprint ||
      activity.sourceEventKey !== row.source_event_key ||
      activity.marketId !== row.market_id ||
      activity.tokenId !== fill.tokenId ||
      activity.outcomeSide !== row.outcome_side ||
      signed(row.delta_shares) !== activity.deltaShares ||
      decimal(row.price) !== activity.price ||
      iso(row.occurred_at) !== activity.occurredAt ||
      (row.size_usd != null && decimal(row.size_usd) !== activity.sizeUsd)
    )
      return null;
    // A stored unknown valuation stays unknown, even if the catalog was repaired
    // later. This source is evidence of exactly what was observed/persisted.
    return {
      ...activity,
      sizeUsd: row.size_usd == null ? null : activity.sizeUsd,
    };
  } catch {
    return null;
  }
}

export function projectHip4HolderKnownWalletMarkets(input: {
  environment: Hip4Environment;
  asOf: Date;
  subjects: Hip4HolderSourceRow[];
  positions: Hip4HolderFactRow[];
  activities: Hip4HolderFactRow[];
  markets: Record<string, unknown>[];
  diagnostics?: string[];
}): HolderResearchMarketInput[] {
  const subjects = new Map(input.subjects.map((row) => [row.wallet_id, row]));
  const result: HolderResearchMarketInput[] = [];
  for (const row of input.markets) {
    const parsed = hip4ReadMarketSchema.safeParse(record(row.metadata).hip4);
    if (!parsed.success) continue;
    const native = parsed.data;
    const identity = hip4Identity(input.environment, native.outcome);
    const expired = (value: unknown) =>
      value != null &&
      (!iso(value) || Date.parse(String(value)) <= input.asOf.getTime());
    if (
      native.environment !== input.environment ||
      row.venue !== "hyperliquid" ||
      native.marketId !== row.id ||
      row.id !== identity.marketId ||
      native.eventId !== row.event_id ||
      native.expiry !== iso(row.expiration_time) ||
      new Set(native.sides.map((side) => side.sideIndex)).size !== 2 ||
      native.sides.some((side) => {
        const expected = identity.sides[side.sideIndex];
        return (
          side.tokenId !== expected.tokenId ||
          side.coin !== expected.coin ||
          side.assetId !== expected.assetId
        );
      }) ||
      native.status !== "observed" ||
      row.status !== "ACTIVE" ||
      row.resolved_outcome != null ||
      expired(row.close_time) ||
      expired(row.expiration_time) ||
      (row.event_status != null && row.event_status !== "ACTIVE") ||
      expired(row.event_end_date)
    )
      continue;
    const evidence: Hip4HolderKnownWalletEvidence = {
      version: 1,
      environment: input.environment,
      scope: "known_wallet_only",
      globalHolders: "unavailable",
      historicalPerformance: "unavailable",
      costBasis: "unknown",
      completeHistory: false,
      contract: {
        marketId: native.marketId,
        outcome: native.outcome,
        expiry: native.expiry,
        sourceDescription: native.description,
        sides: native.sides.map((side) => ({
          side: side.sideIndex === 0 ? "YES" : "NO",
          tokenId: side.tokenId,
          label: side.label,
        })),
      },
      positions: [],
      fills: [],
      pricedFlowUsd: "0",
      unknownUsdPositions: 0,
      unknownUsdFills: 0,
      diagnostics: [...(input.diagnostics ?? [])],
    };
    for (const position of input.positions.filter(
      (item) => item.market_id === row.id,
    )) {
      const subject = subjects.get(position.wallet_id);
      const metadata = record(position.metadata);
      const coverage = record(metadata.coverage);
      const endpoint = record(coverage.positions);
      const sideIndex =
        position.outcome_side === "YES"
          ? 0
          : position.outcome_side === "NO"
            ? 1
            : null;
      const shares = decimal(position.shares);
      const snapshotAt = iso(position.snapshot_at);
      if (
        !subject ||
        sideIndex == null ||
        shares == null ||
        !snapshotAt ||
        Date.parse(snapshotAt) > input.asOf.getTime() ||
        metadata.source !== "hip4_known_wallet" ||
        metadata.costBasis !== "unknown" ||
        coverage.scope !== "known_wallet_only" ||
        coverage.environment !== input.environment ||
        coverage.chain !== subject.chain ||
        coverage.accountAddress !== subject.address.toLowerCase() ||
        endpoint.status !== "available" ||
        iso(endpoint.observedAt) !== snapshotAt ||
        metadata.tokenId !== identity.sides[sideIndex].tokenId
      ) {
        evidence.diagnostics.push("invalid_native_position_provenance");
        continue;
      }
      const usd =
        position.size_usd == null || native.quoteToken !== "USDC"
          ? null
          : decimal(position.size_usd);
      if (usd == null) evidence.unknownUsdPositions++;
      evidence.positions.push({
        evidenceId: `native_position:${subject.wallet_id}:${identity.sides[sideIndex].tokenId}`,
        walletId: subject.wallet_id,
        accountAddress: subject.address.toLowerCase(),
        tokenId: identity.sides[sideIndex].tokenId,
        side: sideIndex === 0 ? "YES" : "NO",
        shares,
        positionUsd: usd,
        snapshotAt,
        coverage: "complete_wallet_snapshot",
      });
    }
    const fills = new Map<
      string,
      Hip4TrackedFillActivity & { evidenceId: string; walletId: string }
    >();
    const fillFingerprints = new Map<string, string>();
    const conflictingFillKeys = new Set<string>();
    for (const activityRow of input.activities.filter(
      (item) => item.market_id === row.id,
    )) {
      const subject = subjects.get(activityRow.wallet_id);
      const proof = hip4TrackedActivityFlowProof({
        metadata: record(activityRow.metadata),
        sourceEventKey: String(activityRow.source_event_key ?? ""),
      });
      if (proof !== "eligible") {
        evidence.diagnostics.push(
          proof === "disputed"
            ? "disputed_native_activity_source_identity"
            : proof === "legacy_ambiguous"
              ? "legacy_native_activity_requires_exact_recheck"
              : "invalid_native_activity_recheck_proof",
        );
        continue;
      }
      const activity = subject
        ? verifiedFill({
            subject,
            row: activityRow,
            environment: input.environment,
            asOf: input.asOf,
            quoteToken: native.quoteToken,
          })
        : null;
      if (!activity) {
        evidence.diagnostics.push("invalid_native_activity_provenance");
        continue;
      }
      const fingerprint = hip4TrackedFillFingerprint(activity);
      const priorFingerprint = fillFingerprints.get(activity.sourceEventKey);
      if (priorFingerprint && priorFingerprint !== fingerprint) {
        conflictingFillKeys.add(activity.sourceEventKey);
        evidence.diagnostics.push(
          "conflicting_native_activity_source_identity",
        );
      }
      fillFingerprints.set(activity.sourceEventKey, fingerprint);
      fills.set(activity.sourceEventKey, {
        ...activity,
        walletId: activityRow.wallet_id,
        evidenceId: `native_fill:${activityRow.wallet_id}:${createHash("sha256").update(activity.sourceEventKey).digest("hex")}`,
      });
    }
    for (const key of conflictingFillKeys) fills.delete(key);
    evidence.fills = [...fills.values()];
    evidence.pricedFlowUsd = addUnsignedDecimals(
      evidence.fills.flatMap((fill) =>
        fill.sizeUsd == null ? [] : [fill.sizeUsd],
      ),
    );
    evidence.unknownUsdFills = evidence.fills.filter(
      (fill) => fill.sizeUsd == null,
    ).length;
    evidence.diagnostics = [...new Set(evidence.diagnostics)];
    if (!evidence.positions.length && !evidence.fills.length) continue;
    const emptySide = (side: "YES" | "NO") => ({
      side,
      usd: 0,
      wallets: 0,
      openPnlUsd: null,
      sharpHolders: 0,
      sharpUsd: 0,
      bestEdge: null,
      bestZScore: null,
      bestSampleCount: null,
      bestResolvedStakeUsd: null,
      bestTrades30d: null,
    });
    const numeric = (value: unknown) =>
      value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const activityAt =
      evidence.fills
        .map((fill) => fill.occurredAt)
        .sort()
        .at(-1) ?? null;
    result.push({
      marketId: native.marketId,
      eventId: native.eventId,
      venue: "hyperliquid",
      marketTitle: String(row.title ?? native.title),
      marketSlug: typeof row.slug === "string" ? row.slug : null,
      marketDescription:
        typeof row.description === "string" ? row.description : null,
      metadata: row.metadata,
      outcomes: native.sides.map((side) => side.label),
      eventTitle:
        typeof row.event_title === "string"
          ? row.event_title
          : native.eventTitle,
      eventSlug: typeof row.event_slug === "string" ? row.event_slug : null,
      eventDescription:
        typeof row.event_description === "string"
          ? row.event_description
          : null,
      seriesKey: null,
      seriesTitle: null,
      resolutionSource: null,
      category: typeof row.category === "string" ? row.category : null,
      closeTime: iso(row.close_time),
      expirationTime: iso(row.expiration_time),
      yesProbability: null,
      volume24h: numeric(row.volume_24h),
      liquidity: numeric(row.liquidity),
      marketMovementContext: {
        yesProbabilityNow: null,
        yesDeltaProbability24h: null,
        volume24h: numeric(row.volume_24h),
        volumeChange24h: null,
        volumeChangePct24h: null,
        liquidity: numeric(row.liquidity),
        liquidityChange24h: null,
        liquidityChangePct24h: null,
        openInterestChange24h: null,
        openInterestChangePct24h: null,
        updatedAt: null,
        previousDecisionYesProbability: null,
        yesChangeSincePreviousDecision: null,
        previousDecisionCheckedAt: null,
      },
      livePriceCheck: null,
      sides: { YES: emptySide("YES"), NO: emptySide("NO") },
      holders: [],
      recentActivityUsd: numeric(evidence.pricedFlowUsd) ?? 0,
      recentActivityAt: activityAt,
      crossMarketWalletCount: 0,
      previousNote: null,
      nativeKnownWalletEvidence: evidence,
    });
  }
  return result;
}

export async function loadHip4HolderResearchKnownWalletPage(
  db: Queryable,
  input: {
    environment: Hip4Environment;
    afterAddress: string;
    asOf: Date;
    sourceLimit: number;
    positionsPerWallet: number;
    fillsPerWallet: number;
    candidateLookbackHours: number;
    activityLookbackHours: number;
    trackedSubjectTtlDays: number;
    includeAutoTracked: boolean;
  },
) {
  const diagnostics: string[] = [];
  const chain = hip4Identity(input.environment, 0).network;
  const source = await db.query<Hip4HolderSourceRow>(
    HIP4_HOLDER_RESEARCH_SOURCE_SQL,
    [
      chain,
      input.afterAddress,
      input.sourceLimit,
      input.asOf,
      input.trackedSubjectTtlDays,
    ],
  );
  const subjects = source.rows.filter(
    (row) =>
      (row.followed || (input.includeAutoTracked && row.tracked)) &&
      row.chain === chain,
  );
  const current = subjects.flatMap((subject) => {
    const state = record(record(subject.metadata).hip4Intel);
    const coverage = record(state.coverage);
    const snapshotAt = iso(state.lastCompletePositionsAt);
    if (
      coverage.scope !== "known_wallet_only" ||
      coverage.environment !== input.environment ||
      coverage.accountAddress !== subject.address.toLowerCase() ||
      coverage.chain !== chain
    )
      return [];
    if (
      !snapshotAt ||
      Date.parse(snapshotAt) > input.asOf.getTime() ||
      Date.parse(snapshotAt) <
        input.asOf.getTime() - input.candidateLookbackHours * 3_600_000
    )
      return [];
    return [{ walletId: subject.wallet_id, snapshotAt }];
  });
  const positionResult =
    current.length && input.positionsPerWallet > 0
      ? await db.query<Hip4HolderFactRow>(HIP4_HOLDER_RESEARCH_POSITIONS_SQL, [
          current.map((row) => row.walletId),
          current.map((row) => row.snapshotAt),
          input.positionsPerWallet + 1,
        ])
      : { rows: [] };
  let activityRows: Hip4HolderFactRow[] = [];
  if (subjects.length && input.fillsPerWallet > 0)
    try {
      activityRows = (
        await db.query<Hip4HolderFactRow>(HIP4_HOLDER_RESEARCH_ACTIVITY_SQL, [
          subjects.map((row) => row.wallet_id),
          input.asOf,
          input.activityLookbackHours,
          input.fillsPerWallet + 1,
        ])
      ).rows;
    } catch (error) {
      if (record(error).code !== "42703") throw error;
      diagnostics.push("native_activity_schema_unavailable");
    }
  const cap = (rows: Hip4HolderFactRow[], limit: number, kind: string) => {
    const counts = new Map<string, number>();
    return rows.filter((row) => {
      const count = (counts.get(row.wallet_id) ?? 0) + 1;
      counts.set(row.wallet_id, count);
      if (count > limit) {
        diagnostics.push(`${kind}_source_page_truncated`);
        return false;
      }
      return true;
    });
  };
  const positions = cap(
    positionResult.rows,
    input.positionsPerWallet,
    "positions",
  );
  const activities = cap(activityRows, input.fillsPerWallet, "activity");
  const ids = [
    ...new Set([...positions, ...activities].map((row) => row.market_id)),
  ].filter(
    (id) =>
      typeof id === "string" &&
      id.startsWith(`hyperliquid:${input.environment}:outcome:`),
  );
  const markets = ids.length
    ? (await db.query(HIP4_HOLDER_RESEARCH_MARKETS_SQL, [ids])).rows
    : [];
  const projected = projectHip4HolderKnownWalletMarkets({
    environment: input.environment,
    asOf: input.asOf,
    subjects,
    positions,
    activities,
    markets,
    diagnostics,
  });
  for (const market of projected)
    diagnostics.push(...(market.nativeKnownWalletEvidence?.diagnostics ?? []));
  return {
    markets: projected,
    sourceRowsRead: source.rows.length,
    nextAddress: source.rows.at(-1)?.address.toLowerCase() ?? "",
    exhausted: source.rows.length < input.sourceLimit,
    diagnostics: [
      ...new Set([
        ...diagnostics,
        ...(projected.length
          ? []
          : ["no_usable_known_wallet_evidence_in_source_page"]),
      ]),
    ],
  };
}
