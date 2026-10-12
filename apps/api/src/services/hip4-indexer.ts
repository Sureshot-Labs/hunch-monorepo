import { randomUUID } from "node:crypto";
import {
  hip4MetadataSchema,
  hip4SettlementSchema,
  hip4SpotMetadataSchema,
  hip4TradeSchema,
  type Hip4ReadPolicy,
  type Hip4Attempt,
} from "@hunch/shared";
import type { Pool } from "pg";
import { applyHip4Book, ageHip4Market, mapHip4Market } from "./hip4-mapping.js";
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
} from "./hip4-repository.js";

export function selectHip4Outcomes(policy: Hip4ReadPolicy, after: number) {
  const sorted = [...new Set(policy.outcomeAllowlist)].sort((a, b) => a - b);
  return [
    ...sorted.filter((id) => id > after),
    ...sorted.filter((id) => id <= after),
  ].slice(0, policy.maxOutcomesPerCycle);
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
) {
  const { policy, revision } = await readHip4Policy(pool);
  const diagnostics = {
    revision,
    environment: policy.environment,
    indexed: 0,
    skipped: 0,
    failures: [] as { outcome: number; reason: string }[],
    pollMs: policy.pollMs,
    fetchMs: 0,
    mapMs: 0,
    writeMs: 0,
    oldestSnapshotAgeMs: 0,
  };
  if (!policy.enabled || !policy.outcomeAllowlist.length) return diagnostics;
  const after = await readHip4Cursor(pool, policy.environment);
  const selected = selectHip4Outcomes(policy, after);
  // Reserve the mandatory pair atomically. Never spend half a pair forever.
  let metadataCredits = 0;
  if (!readOverride) {
    if (
      !(await admitHip4Request(
        pool,
        policy.environment,
        40,
        policy.requestWeightPerMinute,
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
    createHip4ReadClient(policy, (weight) => {
      if (metadataCredits > 0) {
        metadataCredits--;
        return Promise.resolve(true);
      }
      return admitHip4Request(
        pool,
        policy.environment,
        weight,
        policy.requestWeightPerMinute,
      );
    });
  const read = async (request: Hip4InfoRequest) => {
    const current = await readHip4Policy(pool);
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
  try {
    metadata = hip4MetadataSchema.parse(await read({ type: "outcomeMeta" }));
    spotMetadata = hip4SpotMetadataSchema.parse(
      await read({ type: "spotMeta" }),
    );
  } catch (error) {
    await recordHip4MetadataFailure(pool, policy.environment, selected, {
      at: new Date().toISOString(),
      result: hip4Failure(error),
    });
    throw error;
  }
  const generation = randomUUID();
  const fetchedAt = new Date().toISOString();
  for (const outcome of selected) {
    try {
      const stored = await readHip4StoredMarket(
        pool,
        policy.environment,
        outcome,
      );
      const active = metadata.outcomes.some((row) => row.outcome === outcome);
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
        await advanceHip4Cursor(pool, policy.environment, outcome);
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
      const current = await readHip4Policy(pool);
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
      if (await persistHip4Market(pool, { ...mapped, trades, intervals }))
        diagnostics.indexed++;
      diagnostics.writeMs += Date.now() - writeStart;
    } catch (error) {
      diagnostics.failures.push({ outcome, reason: hip4Failure(error) });
      await advanceHip4Cursor(pool, policy.environment, outcome);
    }
  }
  // Persist all valid metadata, but lead the next cycle with work deferred by
  // budget. Advancing through every metadata write would starve the same tail
  // forever when the allowlist fills an exact number of batches.
  const deferredIndex = selected.findIndex((outcome) =>
    diagnostics.failures.some(
      (failure) =>
        failure.outcome === outcome &&
        failure.reason.endsWith("budget_exhausted"),
    ),
  );
  if (deferredIndex >= 0) {
    const current = await readHip4Policy(pool);
    if (current.policy.enabled && current.revision === revision)
      await advanceHip4Cursor(
        pool,
        policy.environment,
        selected[Math.max(0, deferredIndex - 1)],
      );
  }
  return diagnostics;
}
