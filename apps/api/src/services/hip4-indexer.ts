import { randomUUID } from "node:crypto";
import {
  hip4MetadataSchema,
  hip4SettlementSchema,
  hip4SpotMetadataSchema,
  hip4TradeSchema,
  hip4BackgroundRequestWeightLimit,
  hip4BackgroundRepairWeightLimit,
  hip4Identity,
  type Hip4ReadPolicy,
  type Hip4Attempt,
} from "@hunch/shared";
import type { Pool } from "pg";
import type { Hip4CanonicalObserver } from "./hip4-canonical-change.js";
import { applyHip4Book, ageHip4Market, mapHip4Market } from "./hip4-mapping.js";
import { applyHip4Volume, indexHip4AssetContexts } from "./hip4-volume.js";
import {
  createHip4ReadClient,
  Hip4ReadError,
  HIP4_RECENT_TRADES_RESPONSE_BOUND,
  type Hip4InfoRequest,
} from "./hip4-client.js";
import {
  admitHip4Request,
  advanceHip4Cursor,
  persistHip4Market,
  readHip4Cursor,
  readHip4Policy,
  readHip4StoredMarket,
  recordHip4MetadataFailure,
  readHip4PendingOutcomes,
} from "./hip4-repository.js";

export function selectHip4Outcomes(policy: Hip4ReadPolicy, after: number) {
  const sorted = [...new Set(policy.outcomeAllowlist)].sort((a, b) => a - b);
  return [
    ...sorted.filter((id) => id > after),
    ...sorted.filter((id) => id <= after),
  ].slice(0, policy.maxOutcomesPerCycle);
}

export type Hip4RepairOrder = { priorityNext: boolean };

/** Visible removals get prompt official settlement checks, without taking the
 * whole normal repair batch or moving its durable catalog/history cursor. */
export function selectHip4RepairBatch(
  maximum: number,
  normal: number[],
  priority: number[],
  order: Hip4RepairOrder,
) {
  let priorityCount = Math.min(
    priority.length,
    Math.max(1, Math.ceil(maximum / 2)),
  );
  if (maximum === 1 && priority.length && normal.length) {
    priorityCount = Number(order.priorityNext);
    order.priorityNext = !order.priorityNext;
  }
  const prioritized = priority.slice(0, priorityCount);
  const prioritySet = new Set(prioritized);
  const ordinary = normal
    .filter((outcome) => !prioritySet.has(outcome))
    .slice(0, maximum - prioritized.length);
  // Interleave the lanes so a larger configured batch cannot spend the whole
  // shared repair quota on priority before ordinary work gets its first turn.
  const selected: number[] = [];
  for (
    let index = 0;
    index < Math.max(prioritized.length, ordinary.length);
    index++
  ) {
    if (index < prioritized.length) selected.push(prioritized[index]);
    if (index < ordinary.length) selected.push(ordinary[index]);
  }
  return { prioritized, ordinary, selected };
}
export function hip4Failure(error: unknown): Hip4Attempt["result"] {
  if (error instanceof Hip4ReadError) return error.reason;
  if (error instanceof Error && /identity/.test(error.message))
    return "wrong_identity";
  return "invalid_response";
}

export async function runHip4ReadCycle(
  pool: Pool,
  readOverride?: (request: Hip4InfoRequest) => Promise<unknown>,
  onCanonicalChange?: Hip4CanonicalObserver,
  options: {
    repair?: boolean;
    fetcher?: typeof fetch;
    demandedOutcomes?: number[];
    repairOrder?: Hip4RepairOrder;
  } = {},
) {
  const { policy, revision, lifecycle, disabledReason } = await readHip4Policy(
    pool,
    "indexer",
  );
  const maintenance = lifecycle.indexerMode === "maintenance";
  const diagnostics = {
    revision,
    indexerMode: lifecycle.indexerMode,
    disabledReason,
    environment: policy.environment,
    indexed: 0,
    catalogDiscovered: 0,
    catalogPublished: 0,
    skipped: 0,
    failures: [] as { outcome: number; reason: string }[],
    pollMs: policy.pollMs,
    fetchMs: 0,
    mapMs: 0,
    writeMs: 0,
    oldestSnapshotAgeMs: 0,
    repairAttempted: false,
  };
  if (
    !policy.enabled ||
    (!maintenance &&
      policy.catalogMode !== "all" &&
      !policy.outcomeAllowlist.length)
  )
    return diagnostics;
  const after = await readHip4Cursor(pool, policy.environment);
  let selected = selectHip4Outcomes(policy, after);
  if (maintenance) {
    selected = await readHip4PendingOutcomes(
      pool,
      policy.environment,
      after,
      policy.maxOutcomesPerCycle,
    );
    if (!selected.length) return diagnostics;
  }
  // Reserve the mandatory pair atomically. Never spend half a pair forever.
  let metadataCredits = 0;
  if (!readOverride) {
    if (
      !(await admitHip4Request(
        pool,
        policy.environment,
        40,
        policy.requestWeightPerMinute,
        {
          scope: "background_catalog",
          maximum: hip4BackgroundRequestWeightLimit(policy),
          backgroundMaximum: hip4BackgroundRequestWeightLimit(policy),
        },
      ))
    ) {
      diagnostics.failures.push({
        outcome: -1,
        reason: "metadata_budget_exhausted",
      });
      return diagnostics;
    }
    metadataCredits = 2;
  }
  const sourceRead =
    readOverride ??
    createHip4ReadClient(
      policy,
      (weight) => {
        if (metadataCredits > 0) {
          metadataCredits--;
          return Promise.resolve(true);
        }
        return admitHip4Request(
          pool,
          policy.environment,
          weight,
          policy.requestWeightPerMinute,
          {
            scope: "background_repair",
            maximum: hip4BackgroundRepairWeightLimit(policy),
            backgroundMaximum: hip4BackgroundRequestWeightLimit(policy),
          },
        );
      },
      options.fetcher,
    );
  const read = async (request: Hip4InfoRequest) => {
    const current = await readHip4Policy(pool, "indexer");
    if (!current.policy.enabled || current.revision !== revision)
      throw new Error("policy_changed");
    const start = Date.now();
    try {
      return await sourceRead(request);
    } finally {
      diagnostics.fetchMs += Date.now() - start;
    }
  };
  let metadata;
  let spotMetadata;
  let assetContexts: ReturnType<typeof indexHip4AssetContexts> = null;
  let volumeObservedAt: string;
  try {
    metadata = hip4MetadataSchema.parse(await read({ type: "outcomeMeta" }));
    volumeObservedAt = new Date().toISOString();
    const spotResponse = await read({ type: "spotMetaAndAssetCtxs" });
    spotMetadata = hip4SpotMetadataSchema.parse(
      Array.isArray(spotResponse) ? spotResponse[0] : null,
    );
    assetContexts = indexHip4AssetContexts(
      Array.isArray(spotResponse) ? spotResponse[1] : null,
    );
  } catch (error) {
    // Full-catalog selection normally happens after metadata. If that fetch
    // fails, record the attempt for a bounded set of previously indexed open
    // outcomes instead of silently leaving every previous attempt "ok".
    const failedOutcomes = selected.length
      ? selected
      : await readHip4PendingOutcomes(
          pool,
          policy.environment,
          after,
          policy.maxOutcomesPerCycle,
        );
    await recordHip4MetadataFailure(pool, policy.environment, failedOutcomes, {
      at: new Date().toISOString(),
      result: hip4Failure(error),
    });
    throw error;
  }
  const generation = randomUUID();
  const fetchedAt = new Date().toISOString();
  const catalogIds = new Set(metadata.outcomes.map((row) => row.outcome));
  const demandedMissing = [];
  const demandedRestored: number[] = [];
  if (!maintenance && policy.catalogMode === "all") {
    // Demand is an existing bounded Redis-derived hint, never authority to
    // invent identities or infer settlement. Only successful current metadata
    // can establish absence; failed metadata reads return before this block.
    for (const outcome of [...new Set(options.demandedOutcomes ?? [])].slice(
      0,
      policy.maxHotOutcomes,
    )) {
      if (!Number.isSafeInteger(outcome) || outcome < 0) continue;
      try {
        const stored = await readHip4StoredMarket(
          pool,
          policy.environment,
          outcome,
        );
        if (
          !stored ||
          stored.market.environment !== policy.environment ||
          stored.market.outcome !== outcome ||
          stored.market.marketId !==
            hip4Identity(policy.environment, outcome).marketId ||
          stored.market.settlement ||
          stored.market.status === "settled"
        )
          continue;
        if (catalogIds.has(outcome)) {
          if (stored.market.metadataAttempt?.result === "metadata_missing")
            demandedRestored.push(outcome);
        } else demandedMissing.push(stored.market);
      } catch (error) {
        diagnostics.failures.push({
          outcome,
          reason: `demand_${hip4Failure(error)}`,
        });
      }
    }
    if (demandedMissing.length || demandedRestored.length) {
      const current = await readHip4Policy(pool, "indexer");
      if (!current.policy.enabled || current.revision !== revision)
        return diagnostics;
      if (demandedMissing.length)
        await recordHip4MetadataFailure(
          pool,
          policy.environment,
          demandedMissing.map((market) => market.outcome),
          { at: fetchedAt, result: "metadata_missing" },
        );
      // A returning demanded member may be outside this publication batch.
      // Clear only the superseded absence hint now: current membership does
      // not refresh its cached metadata, quotes or generation provenance.
      if (demandedRestored.length)
        await recordHip4MetadataFailure(
          pool,
          policy.environment,
          demandedRestored,
          { at: fetchedAt, result: "ok" },
        );
    }
  }
  if (!maintenance && policy.catalogMode === "all") {
    diagnostics.catalogDiscovered = catalogIds.size;
    selected = selectHip4Outcomes(
      {
        ...policy,
        outcomeAllowlist: [
          ...catalogIds,
          ...(await readHip4PendingOutcomes(
            pool,
            policy.environment,
            after,
            policy.maxOutcomesPerCycle,
          )),
        ],
      },
      after,
    );
    // Metadata/contexts already arrived in two bulk requests. Publish the
    // catalog separately from the small, budgeted depth/history repair batch.
    const catalogBatch = selectHip4Outcomes(
      {
        ...policy,
        outcomeAllowlist: [...catalogIds],
        maxOutcomesPerCycle: policy.catalogBatchSize,
      },
      after,
    );
    for (const outcome of catalogBatch) {
      try {
        const previous = await readHip4StoredMarket(
          pool,
          policy.environment,
          outcome,
        );
        const mapped = mapHip4Market({
          environment: policy.environment,
          outcome,
          metadata,
          spotMetadata,
          fetchedAt,
          generation,
          previous,
          settlement: previous?.raw.settlement,
        });
        mapped.market.metadataAttempt = { at: fetchedAt, result: "ok" };
        mapped.market = applyHip4Volume(
          mapped.market,
          assetContexts,
          volumeObservedAt,
          policy.volumeMaxAgeMs,
          policy.bookMaxAgeMs,
        );
        const current = await readHip4Policy(pool, "indexer");
        if (!current.policy.enabled || current.revision !== revision) break;
        if (
          await persistHip4Market(
            pool,
            {
              ...mapped,
              trades: [],
              advanceCursor: false,
              policy,
            },
            onCanonicalChange,
          )
        )
          diagnostics.catalogPublished++;
      } catch (error) {
        diagnostics.failures.push({
          outcome,
          reason: `catalog_${hip4Failure(error)}`,
        });
      }
    }
  }
  // Cheap bulk context observations have their own freshness deadline. A
  // catalog-only pass never multiplies depth/history work or moves its cursor.
  if (options.repair === false) return diagnostics;
  const batch = selectHip4RepairBatch(
    policy.maxOutcomesPerCycle,
    selected,
    demandedMissing
      .sort(
        (left, right) =>
          (left.settlementAttempt?.at ?? "").localeCompare(
            right.settlementAttempt?.at ?? "",
          ) || left.outcome - right.outcome,
      )
      .map((market) => market.outcome),
    options.repairOrder ?? { priorityNext: true },
  );
  selected = batch.selected;
  const prioritized = new Set(batch.prioritized);
  diagnostics.repairAttempted = selected.length > 0;
  for (const outcome of selected) {
    try {
      const stored = await readHip4StoredMarket(
        pool,
        policy.environment,
        outcome,
      );
      const active = catalogIds.has(outcome);
      if (stored)
        diagnostics.oldestSnapshotAgeMs = Math.max(
          diagnostics.oldestSnapshotAgeMs,
          Date.now() - Date.parse(stored.market.fetchedAt),
        );
      let settlement = stored?.raw.settlement ?? null;
      let settlementCheckedAt: string | undefined;
      let settlementAttempt = stored?.market.settlementAttempt;
      const checkSettlement = async () => {
        try {
          const response = await read({ type: "settledOutcome", outcome });
          if (response != null) {
            const parsed = hip4SettlementSchema.parse(response);
            if (parsed.spec.outcome !== outcome)
              throw new Error("wrong_identity");
            settlement = parsed;
          }
          settlementCheckedAt = new Date().toISOString();
          settlementAttempt = { at: settlementCheckedAt, result: "ok" };
        } catch (error) {
          settlementAttempt = {
            at: new Date().toISOString(),
            result: hip4Failure(error),
          };
          diagnostics.failures.push({
            outcome,
            reason: `settlement_${settlementAttempt.result}`,
          });
        }
      };
      if (!active && !settlement) await checkSettlement();
      if (!active && !settlement && !stored) {
        diagnostics.skipped++;
        diagnostics.failures.push({
          outcome,
          reason: "metadata_missing_pending_settlement",
        });
        if (!prioritized.has(outcome))
          await advanceHip4Cursor(pool, policy.environment, outcome);
        continue;
      }
      if (!active && !settlement && stored) {
        // Absence is not settlement or fresh metadata. Retain original factual
        // provenance while recording the official check; don't spend more of
        // the shared repair quota on books/history for a removed instrument.
        const current = await readHip4Policy(pool, "indexer");
        if (!current.policy.enabled || current.revision !== revision) break;
        if (
          await persistHip4Market(
            pool,
            {
              ...stored,
              market: {
                ...stored.market,
                metadataAttempt: { at: fetchedAt, result: "metadata_missing" },
                settlementAttempt,
              },
              trades: [],
              advanceCursor: !prioritized.has(outcome),
              policy,
            },
            onCanonicalChange,
          )
        )
          diagnostics.indexed++;
        continue;
      }
      const mapStart = Date.now();
      const mappingInput = {
        environment: policy.environment,
        outcome,
        metadata,
        spotMetadata,
        fetchedAt,
        generation,
        previous: stored,
      };
      let mapped = mapHip4Market({
        ...mappingInput,
        settlement,
        settlementCheckedAt,
      });
      if (active && !settlement && mapped.market.status === "expired") {
        await checkSettlement();
        mapped = mapHip4Market({
          ...mappingInput,
          settlement,
          settlementCheckedAt,
        });
      }
      mapped.market.metadataAttempt = {
        at: fetchedAt,
        result: active ? "ok" : "metadata_missing",
      };
      mapped.market.settlementAttempt = settlementAttempt;
      mapped.market = applyHip4Volume(
        mapped.market,
        assetContexts,
        volumeObservedAt,
        policy.volumeMaxAgeMs,
        policy.bookMaxAgeMs,
      );
      if (mapped.market.volumeAttempt?.result !== "ok")
        diagnostics.failures.push({
          outcome,
          reason: `volume_${mapped.market.volumeAttempt?.result}`,
        });
      diagnostics.mapMs += Date.now() - mapStart;
      const trades = [];
      if (!settlement) {
        for (const sideIndex of [0, 1] as const) {
          try {
            mapped.market = applyHip4Book(
              mapped.market,
              sideIndex,
              await read({
                type: "l2Book",
                coin: mapped.market.sides[sideIndex].coin,
              }),
              Date.now(),
              policy.bookMaxAgeMs,
            );
          } catch (error) {
            const result = hip4Failure(error);
            mapped.market.sides[sideIndex].bookAttempt = {
              at: new Date().toISOString(),
              result,
            };
            diagnostics.failures.push({
              outcome,
              reason: `book_${sideIndex}_${result}`,
            });
          }
        }
        try {
          const payload = await read({
            type: "recentTrades",
            coin: mapped.market.sides[0].coin,
          });
          if (
            !Array.isArray(payload) ||
            payload.length > HIP4_RECENT_TRADES_RESPONSE_BOUND
          )
            throw new Hip4ReadError("response_too_large");
          const normalized = payload.map((row) => hip4TradeSchema.parse(row));
          if (
            normalized.some((row) => row.coin !== mapped.market.sides[0].coin)
          )
            throw new Error("wrong_identity");
          if (normalized.some((row) => row.time > Date.now()))
            throw new Error("future_trade");
          const limited = normalized
            .sort((a, b) => b.time - a.time || b.tid - a.tid)
            .slice(0, policy.maxTradesPerResponse);
          trades.push(...limited);
          const times = limited.map((row) => row.time);
          mapped.market.coverage = {
            ...mapped.market.coverage,
            trades: "recent_window",
            tradeObservedAt: new Date().toISOString(),
            tradeWindowStart: times.length
              ? new Date(Math.min(...times)).toISOString()
              : null,
            tradeWindowEnd: times.length
              ? new Date(Math.max(...times)).toISOString()
              : null,
            tradeAttempt: {
              at: new Date().toISOString(),
              result:
                limited.length < normalized.length ? "processing_limit" : "ok",
            },
          };
        } catch (error) {
          const result = hip4Failure(error);
          mapped.market.coverage.tradeAttempt = {
            at: new Date().toISOString(),
            result,
          };
          diagnostics.failures.push({ outcome, reason: `trades_${result}` });
        }
      }
      const current = await readHip4Policy(pool, "indexer");
      if (!current.policy.enabled || current.revision !== revision) break;
      const writeStart = Date.now();
      mapped.market = ageHip4Market(mapped.market, Date.now(), policy);
      const attempt = mapped.market.coverage.tradeAttempt;
      const intervals =
        attempt && attempt.at !== stored?.market.coverage.tradeAttempt?.at
          ? [
              {
                start: Date.parse(attempt.at),
                end: Date.parse(attempt.at),
                kind:
                  attempt.result === "ok"
                    ? ("observed" as const)
                    : ("gap" as const),
                reason:
                  attempt.result === "ok"
                    ? "rest_recent_window"
                    : attempt.result,
              },
            ]
          : [];
      if (
        await persistHip4Market(
          pool,
          {
            ...mapped,
            trades,
            intervals,
            policy,
            advanceCursor: !prioritized.has(outcome),
          },
          onCanonicalChange,
        )
      )
        diagnostics.indexed++;
      diagnostics.writeMs += Date.now() - writeStart;
    } catch (error) {
      diagnostics.failures.push({ outcome, reason: hip4Failure(error) });
      if (!prioritized.has(outcome))
        await advanceHip4Cursor(pool, policy.environment, outcome);
    }
  }
  // Persist all valid metadata, but lead the next cycle with work deferred by
  // budget. Advancing through every metadata write would starve the same tail
  // forever when the allowlist fills an exact number of batches.
  const deferredIndex = batch.ordinary.findIndex((outcome) =>
    diagnostics.failures.some(
      (failure) =>
        failure.outcome === outcome &&
        failure.reason.endsWith("budget_exhausted"),
    ),
  );
  if (deferredIndex >= 0) {
    const current = await readHip4Policy(pool, "indexer");
    if (current.policy.enabled && current.revision === revision)
      await advanceHip4Cursor(
        pool,
        policy.environment,
        batch.ordinary[Math.max(0, deferredIndex - 1)],
      );
  }
  return diagnostics;
}
