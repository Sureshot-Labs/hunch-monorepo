import type { PoolClient } from "pg";

import {
  buildHolderResearchDecisionFeaturesV2,
  isSharpHolder,
  scoreHolderResearchCandidateShadowV2,
  type HolderResearchCandidate,
  type HolderResearchObservationCandidate,
} from "./holder-research.js";
import type { HolderResearchPolicy } from "./runtime-policies.js";
import {
  HOLDER_RESEARCH_CALIBRATION_CAUTION_MIN_SAMPLES,
  HOLDER_RESEARCH_CALIBRATION_POSITIVE_MIN_SAMPLES,
  HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z,
  resolveHolderResearchFinalYesProbability,
} from "./holder-research-performance.js";

type Queryable = Pick<PoolClient, "query">;

export type HolderResearchObservationStageUpdate = {
  thesisKey: string;
  triageAction?: "investigate" | "skip" | "watch" | null;
  researchVerdict?:
    | "already_public"
    | "mixed"
    | "supports_holder_side"
    | "supports_opposite_side"
    | "unexplained"
    | "unknown"
    | null;
  finalVerdict?: "context" | "publish" | "skip" | null;
  publishedNoteId?: string | null;
};

export type HolderResearchSupplyHealth = {
  days: Array<{ day: string; candidates: number }>;
  coverageDays: number;
  medianCandidatesPerDay: number;
  consecutiveZeroDays: number;
  status: "warming_up" | "healthy" | "degraded";
  healthy: boolean;
};

export type HolderResearchObservationCalibrationSample = {
  thesisKey: string;
  tradeKey: string;
  observedAt: string;
  marketId: string;
  side: "NO" | "YES";
  bucket: string;
  marketSegment: string;
  actorStrength: string;
  entryPrice: number;
  hoursToClose: number;
  payout: number;
  roi: number;
  excessProbability: number;
};

export type HolderResearchObservationCalibrationAggregate = {
  samples: number;
  actualWins: number;
  expectedWins: number;
  meanRoi: number | null;
  medianRoi: number | null;
  totalPnlPerDollar: number;
  excessProbability: number;
  excessZ: number | null;
  positivePattern: boolean;
  negativeCaution: boolean;
  statisticallySupportedNegative: boolean;
};

export type HolderResearchObservationCalibrationReport = {
  samples: number;
  overall: HolderResearchObservationCalibrationAggregate;
  bySegment: Record<string, HolderResearchObservationCalibrationAggregate>;
  byPriceBand: Record<string, HolderResearchObservationCalibrationAggregate>;
  byHorizon: Record<string, HolderResearchObservationCalibrationAggregate>;
  byActor: Record<string, HolderResearchObservationCalibrationAggregate>;
  byBucket: Record<string, HolderResearchObservationCalibrationAggregate>;
};

type ObservationCalibrationRow = {
  thesis_key: string;
  observed_at: Date | string;
  source_market_id: string;
  side: "NO" | "YES";
  candidate_bucket: string;
  market_segment: string | null;
  actor_strength: string | null;
  entry_price: string | number;
  hours_to_close: string | number | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
};

export type HolderResearchObservationRankingTelemetryV2 = {
  selectedStakeWeightedEdge30d: number | null;
  oppositeStakeWeightedEdge30d: number | null;
  selectedAbsolutePnlWeightedEdge30d: number | null;
  oppositeAbsolutePnlWeightedEdge30d: number | null;
  exposureWeightedEdgeDifference30d: number | null;
};

function sideWeightedEdge(
  candidate: HolderResearchCandidate,
  policy: HolderResearchPolicy,
  side: "NO" | "YES",
  weight: (
    holder: HolderResearchCandidate["market"]["holders"][number],
  ) => number | null,
): number | null {
  const weighted = candidate.market.holders.flatMap((holder) => {
    if (
      holder.side !== side ||
      holder.positionUsd <= 0 ||
      holder.resolvedWinRateEdge30d == null ||
      !isSharpHolder(holder, policy)
    ) {
      return [];
    }
    const holderWeight = weight(holder);
    return holderWeight != null && holderWeight > 0
      ? [{ edge: holder.resolvedWinRateEdge30d, weight: holderWeight }]
      : [];
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;
  return (
    weighted.reduce((sum, entry) => sum + entry.edge * entry.weight, 0) /
    totalWeight
  );
}

export function buildHolderResearchObservationRankingTelemetryV2(
  candidate: HolderResearchCandidate,
  policy: HolderResearchPolicy,
  features: ReturnType<
    typeof buildHolderResearchDecisionFeaturesV2
  > = buildHolderResearchDecisionFeaturesV2(candidate, policy),
): HolderResearchObservationRankingTelemetryV2 {
  const side = candidate.side;
  if (!side) {
    return {
      selectedStakeWeightedEdge30d: null,
      oppositeStakeWeightedEdge30d: null,
      selectedAbsolutePnlWeightedEdge30d: null,
      oppositeAbsolutePnlWeightedEdge30d: null,
      exposureWeightedEdgeDifference30d: null,
    };
  }
  const opposite = side === "YES" ? "NO" : "YES";
  const selectedExposureEdge =
    features.selectedSide?.exposureWeightedEdge30d ?? null;
  const oppositeExposureEdge =
    features.oppositeSide?.exposureWeightedEdge30d ?? null;
  const stakeWeight = (
    holder: HolderResearchCandidate["market"]["holders"][number],
  ) => holder.resolvedStakeUsd30d;
  const absolutePnlWeight = (
    holder: HolderResearchCandidate["market"]["holders"][number],
  ) => (holder.pnl30dUsd == null ? null : Math.abs(holder.pnl30dUsd));
  return {
    selectedStakeWeightedEdge30d: sideWeightedEdge(
      candidate,
      policy,
      side,
      stakeWeight,
    ),
    oppositeStakeWeightedEdge30d: sideWeightedEdge(
      candidate,
      policy,
      opposite,
      stakeWeight,
    ),
    selectedAbsolutePnlWeightedEdge30d: sideWeightedEdge(
      candidate,
      policy,
      side,
      absolutePnlWeight,
    ),
    oppositeAbsolutePnlWeightedEdge30d: sideWeightedEdge(
      candidate,
      policy,
      opposite,
      absolutePnlWeight,
    ),
    exposureWeightedEdgeDifference30d:
      selectedExposureEdge != null && oppositeExposureEdge != null
        ? selectedExposureEdge - oppositeExposureEdge
        : null,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function calibrationAggregate(
  samples: HolderResearchObservationCalibrationSample[],
): HolderResearchObservationCalibrationAggregate {
  const actualWins = samples.reduce((sum, sample) => sum + sample.payout, 0);
  const expectedWins = samples.reduce(
    (sum, sample) => sum + sample.entryPrice,
    0,
  );
  const excessProbability = actualWins - expectedWins;
  const variance = samples.reduce(
    (sum, sample) => sum + sample.entryPrice * (1 - sample.entryPrice),
    0,
  );
  const meanRoi =
    samples.length > 0
      ? samples.reduce((sum, sample) => sum + sample.roi, 0) / samples.length
      : null;
  const excessZ = variance > 0 ? excessProbability / Math.sqrt(variance) : null;
  return {
    samples: samples.length,
    actualWins,
    expectedWins,
    meanRoi,
    medianRoi:
      samples.length > 0 ? median(samples.map((sample) => sample.roi)) : null,
    totalPnlPerDollar: samples.reduce((sum, sample) => sum + sample.roi, 0),
    excessProbability,
    excessZ,
    positivePattern:
      samples.length >= HOLDER_RESEARCH_CALIBRATION_POSITIVE_MIN_SAMPLES &&
      (meanRoi ?? 0) > 0 &&
      (excessZ ?? Number.NEGATIVE_INFINITY) >=
        HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z,
    negativeCaution:
      samples.length >= HOLDER_RESEARCH_CALIBRATION_CAUTION_MIN_SAMPLES &&
      (meanRoi ?? 0) < 0,
    statisticallySupportedNegative:
      samples.length >= HOLDER_RESEARCH_CALIBRATION_CAUTION_MIN_SAMPLES &&
      (excessZ ?? Number.POSITIVE_INFINITY) <=
        -HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z,
  };
}

function groupCalibration(
  samples: HolderResearchObservationCalibrationSample[],
  key: (sample: HolderResearchObservationCalibrationSample) => string,
) {
  const groups = new Map<
    string,
    HolderResearchObservationCalibrationSample[]
  >();
  for (const sample of samples) {
    const groupKey = key(sample);
    const group = groups.get(groupKey) ?? [];
    group.push(sample);
    groups.set(groupKey, group);
  }
  return Object.fromEntries(
    Array.from(groups.entries()).map(([groupKey, group]) => [
      groupKey,
      calibrationAggregate(group),
    ]),
  );
}

function priceBand(price: number): string {
  if (price < 0.2) return "0.10-0.20";
  if (price < 0.4) return "0.20-0.40";
  if (price < 0.6) return "0.40-0.60";
  if (price < 0.8) return "0.60-0.80";
  return "0.80-1.00";
}

function horizonBand(hours: number): string {
  if (hours <= 24) return "0-24h";
  if (hours <= 168) return "1-7d";
  return "7-30d";
}

export function buildHolderResearchObservationCalibrationReport(
  samples: HolderResearchObservationCalibrationSample[],
): HolderResearchObservationCalibrationReport {
  return {
    samples: samples.length,
    overall: calibrationAggregate(samples),
    bySegment: groupCalibration(samples, (sample) => sample.marketSegment),
    byPriceBand: groupCalibration(samples, (sample) =>
      priceBand(sample.entryPrice),
    ),
    byHorizon: groupCalibration(samples, (sample) =>
      horizonBand(sample.hoursToClose),
    ),
    byActor: groupCalibration(samples, (sample) => sample.actorStrength),
    byBucket: groupCalibration(samples, (sample) => sample.bucket),
  };
}

export function summarizeHolderResearchSupply(
  days: Array<{ candidates: number; day: string; observed?: boolean }>,
): HolderResearchSupplyHealth {
  const normalized = [...days].sort((left, right) =>
    left.day.localeCompare(right.day),
  );
  const firstObservedIndex = normalized.findIndex(
    (entry) => entry.observed === true || entry.candidates > 0,
  );
  const coverageDays =
    firstObservedIndex < 0 ? 0 : normalized.length - firstObservedIndex;
  let consecutiveZeroDays = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if ((normalized[index]?.candidates ?? 0) > 0) break;
    consecutiveZeroDays += 1;
  }
  const medianCandidatesPerDay = median(
    normalized.map((entry) => entry.candidates),
  );
  const meetsSupplyCriteria =
    medianCandidatesPerDay >= 3 && consecutiveZeroDays <= 2;
  const status =
    coverageDays < 7
      ? "warming_up"
      : meetsSupplyCriteria
        ? "healthy"
        : "degraded";
  return {
    days: normalized.map(({ candidates, day }) => ({ candidates, day })),
    coverageDays,
    medianCandidatesPerDay,
    consecutiveZeroDays,
    status,
    healthy: status === "healthy",
  };
}

export async function persistHolderResearchCandidateObservations(
  db: Queryable,
  input: {
    runId: string;
    observedAt: Date;
    observations: HolderResearchObservationCandidate[];
    policy: HolderResearchPolicy;
  },
): Promise<{ written: number }> {
  const observations = input.observations
    .map(({ candidate, candidateRank }) => {
      const features = buildHolderResearchDecisionFeaturesV2(
        candidate,
        input.policy,
        input.observedAt,
      );
      return {
        candidate,
        candidateRank,
        features,
        shadowScore: scoreHolderResearchCandidateShadowV2(
          features,
          input.policy,
        ),
      };
    })
    .filter(
      (entry) =>
        entry.features.identity.side != null &&
        !entry.features.gates.supportOnly,
    );
  const shadowRanks = new Map(
    [...observations]
      .sort(
        (left, right) =>
          right.shadowScore - left.shadowScore ||
          left.candidateRank - right.candidateRank,
      )
      .map((entry, index) => [entry.candidate.thesisKey, index + 1]),
  );
  if (observations.length === 0) return { written: 0 };

  const payload = observations.map((entry) => ({
    run_id: input.runId,
    observed_at: input.observedAt.toISOString(),
    thesis_key: entry.candidate.thesisKey,
    source_market_id: entry.candidate.market.marketId,
    side: entry.features.identity.side,
    candidate_bucket: entry.candidate.bucket,
    input_digest: entry.candidate.inputDigest,
    feature_version: entry.features.version,
    decision_features: {
      ...entry.features,
      telemetryOnly: buildHolderResearchObservationRankingTelemetryV2(
        entry.candidate,
        input.policy,
        entry.features,
      ),
    },
    candidate_rank: entry.candidateRank,
    shadow_score: entry.shadowScore,
    shadow_rank:
      shadowRanks.get(entry.candidate.thesisKey) ?? entry.candidateRank,
  }));
  const result = await db.query(
    `
      insert into holder_research_candidate_observations (
        run_id,
        observed_at,
        thesis_key,
        source_market_id,
        side,
        candidate_bucket,
        input_digest,
        feature_version,
        decision_features,
        candidate_rank,
        shadow_score,
        shadow_rank
      )
      select
        row.run_id,
        row.observed_at,
        row.thesis_key,
        row.source_market_id,
        row.side,
        row.candidate_bucket,
        row.input_digest,
        row.feature_version,
        row.decision_features,
        row.candidate_rank,
        row.shadow_score,
        row.shadow_rank
      from jsonb_to_recordset($1::jsonb) as row(
        run_id text,
        observed_at timestamptz,
        thesis_key text,
        source_market_id text,
        side text,
        candidate_bucket text,
        input_digest text,
        feature_version smallint,
        decision_features jsonb,
        candidate_rank integer,
        shadow_score double precision,
        shadow_rank integer
      )
      on conflict (run_id, thesis_key) do update set
        observed_at = excluded.observed_at,
        source_market_id = excluded.source_market_id,
        side = excluded.side,
        candidate_bucket = excluded.candidate_bucket,
        input_digest = excluded.input_digest,
        feature_version = excluded.feature_version,
        decision_features = excluded.decision_features,
        candidate_rank = excluded.candidate_rank,
        shadow_score = excluded.shadow_score,
        shadow_rank = excluded.shadow_rank,
        updated_at = now()
    `,
    [JSON.stringify(payload)],
  );
  return { written: result.rowCount ?? observations.length };
}

export async function updateHolderResearchObservationStages(
  db: Queryable,
  input: {
    runId: string;
    updates: HolderResearchObservationStageUpdate[];
  },
): Promise<{ updated: number }> {
  if (input.updates.length === 0) return { updated: 0 };
  const payload = input.updates.map((entry) => ({
    thesis_key: entry.thesisKey,
    triage_action: entry.triageAction === undefined ? null : entry.triageAction,
    has_triage_action: entry.triageAction !== undefined,
    research_verdict:
      entry.researchVerdict === undefined ? null : entry.researchVerdict,
    has_research_verdict: entry.researchVerdict !== undefined,
    final_verdict: entry.finalVerdict === undefined ? null : entry.finalVerdict,
    has_final_verdict: entry.finalVerdict !== undefined,
    published_note_id:
      entry.publishedNoteId === undefined ? null : entry.publishedNoteId,
    has_published_note_id: entry.publishedNoteId !== undefined,
  }));
  const result = await db.query(
    `
      update holder_research_candidate_observations observation
      set
        triage_action = case
          when stage.has_triage_action then stage.triage_action
          else observation.triage_action
        end,
        research_verdict = case
          when stage.has_research_verdict then stage.research_verdict
          else observation.research_verdict
        end,
        final_verdict = case
          when stage.has_final_verdict then stage.final_verdict
          else observation.final_verdict
        end,
        published_note_id = case
          when stage.has_published_note_id then stage.published_note_id
          else observation.published_note_id
        end,
        updated_at = now()
      from jsonb_to_recordset($2::jsonb) as stage(
        thesis_key text,
        triage_action text,
        has_triage_action boolean,
        research_verdict text,
        has_research_verdict boolean,
        final_verdict text,
        has_final_verdict boolean,
        published_note_id uuid,
        has_published_note_id boolean
      )
      where observation.run_id = $1
        and observation.thesis_key = stage.thesis_key
    `,
    [input.runId, JSON.stringify(payload)],
  );
  return { updated: result.rowCount ?? 0 };
}

export async function loadHolderResearchSupplyHealth(
  db: Queryable,
  now: Date = new Date(),
): Promise<HolderResearchSupplyHealth> {
  const { rows } = await db.query<{
    candidates: string;
    day: string;
    observed: boolean;
  }>(
    `
      with bounds as (
        select timezone('UTC', $1::timestamptz)::date as utc_today
      ), days as (
        select generate_series(
          bounds.utc_today - 7,
          bounds.utc_today - 1,
          interval '1 day'
        )::date as day
        from bounds
      ), daily as (
        select
          timezone('UTC', observation.observed_at)::date as day,
          count(distinct observation.thesis_key) filter (
            where coalesce((observation.decision_features #>> '{gates,publishEligible}')::boolean, false)
              and nullif(observation.decision_features #>> '{market,priceCheckedAt}', '') is not null
          )::text as candidates,
          true as observed
        from holder_research_candidate_observations observation
        cross join bounds
        where observation.observed_at >= ((bounds.utc_today - 7)::timestamp at time zone 'UTC')
          and observation.observed_at < (bounds.utc_today::timestamp at time zone 'UTC')
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(daily.candidates, '0') as candidates,
        coalesce(daily.observed, false) as observed
      from days
      left join daily using (day)
      order by days.day
    `,
    [now.toISOString()],
  );
  return summarizeHolderResearchSupply(
    rows.map((row) => ({
      day: row.day,
      candidates: Number(row.candidates),
      observed: row.observed,
    })),
  );
}

export async function loadHolderResearchObservationCalibration(
  db: Queryable,
  input: { lookbackDays?: number; limit?: number } = {},
): Promise<HolderResearchObservationCalibrationReport> {
  const lookbackDays = Math.max(
    1,
    Math.min(365, Math.trunc(input.lookbackDays ?? 90)),
  );
  const limit = Math.max(
    1,
    Math.min(100_000, Math.trunc(input.limit ?? 25_000)),
  );
  const { rows } = await db.query<ObservationCalibrationRow>(
    `
      with earliest_eligible as materialized (
        select distinct on (observation.thesis_key)
          observation.thesis_key,
          observation.observed_at,
          observation.source_market_id,
          observation.side,
          observation.candidate_bucket,
          nullif(observation.decision_features #>> '{market,marketSegment}', '') as market_segment,
          nullif(observation.decision_features #>> '{actor,strength}', '') as actor_strength,
          nullif(observation.decision_features #>> '{market,entryPrice}', '')::numeric as entry_price,
          nullif(observation.decision_features #>> '{market,hoursToClose}', '')::numeric as hours_to_close
        from holder_research_candidate_observations observation
        where observation.observed_at >= now() - make_interval(days => $1::int)
          and observation.feature_version = 2
          and coalesce(
            (observation.decision_features #>> '{gates,publishEligible}')::boolean,
            false
          )
          and nullif(
            observation.decision_features #>> '{market,priceCheckedAt}',
            ''
          ) is not null
          and nullif(observation.decision_features #>> '{market,entryPrice}', '')::numeric > 0
          and nullif(observation.decision_features #>> '{market,entryPrice}', '')::numeric < 1
        order by observation.thesis_key, observation.observed_at, observation.id
        limit $2::int
      )
      select
        earliest.thesis_key,
        earliest.observed_at,
        earliest.source_market_id,
        earliest.side,
        earliest.candidate_bucket,
        earliest.market_segment,
        earliest.actor_strength,
        earliest.entry_price,
        earliest.hours_to_close,
        market.best_bid,
        market.best_ask,
        market.last_price,
        market.resolved_outcome,
        market.resolved_outcome_pct
      from earliest_eligible earliest
      join unified_markets market on market.id = earliest.source_market_id
      order by earliest.observed_at, earliest.thesis_key
    `,
    [lookbackDays, limit],
  );
  const samples = rows.flatMap((row) => {
    const entryPrice = Number(row.entry_price);
    const hoursToClose = Number(row.hours_to_close);
    if (
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0 ||
      entryPrice >= 1 ||
      !Number.isFinite(hoursToClose)
    ) {
      return [];
    }
    const resolved = resolveHolderResearchFinalYesProbability(row);
    if (resolved.finalYesProbability == null) return [];
    const payout =
      row.side === "YES"
        ? resolved.finalYesProbability
        : 1 - resolved.finalYesProbability;
    return [
      {
        thesisKey: row.thesis_key,
        tradeKey: `${row.thesis_key}:${row.source_market_id}:${row.side}`,
        observedAt: new Date(row.observed_at).toISOString(),
        marketId: row.source_market_id,
        side: row.side,
        bucket: row.candidate_bucket,
        marketSegment: row.market_segment ?? "unknown",
        actorStrength: row.actor_strength ?? "unknown",
        entryPrice,
        hoursToClose,
        payout,
        roi: (payout - entryPrice) / entryPrice,
        excessProbability: payout - entryPrice,
      } satisfies HolderResearchObservationCalibrationSample,
    ];
  });
  return buildHolderResearchObservationCalibrationReport(samples);
}

export async function linkHolderResearchObservationNotes(
  db: Queryable,
  runId: string,
): Promise<{ linked: number }> {
  const result = await db.query(
    `
      update holder_research_candidate_observations observation
      set published_note_id = note.id,
          updated_at = now()
      from ai_notes note
      where observation.run_id = $1
        and note.producer_type = 'holder_research'
        and note.producer_run_id = $1
        and note.lineage->>'thesis_key' = observation.thesis_key
        and observation.published_note_id is distinct from note.id
    `,
    [runId],
  );
  return { linked: result.rowCount ?? 0 };
}

export async function pruneHolderResearchCandidateObservations(
  db: Queryable,
  input: { retentionDays?: number; limit?: number } = {},
): Promise<{ deleted: number }> {
  const retentionDays = Math.max(1, Math.trunc(input.retentionDays ?? 90));
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 5_000)));
  const result = await db.query(
    `
      with stale as (
        select id
        from holder_research_candidate_observations
        where observed_at < now() - make_interval(days => $1::int)
        order by observed_at, id
        limit $2::int
      )
      delete from holder_research_candidate_observations observation
      using stale
      where observation.id = stale.id
    `,
    [retentionDays, limit],
  );
  return { deleted: result.rowCount ?? 0 };
}
