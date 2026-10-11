import { randomUUID } from "node:crypto";
import {
  hip4MetadataSchema,
  hip4SettlementSchema,
  hip4SpotMetadataSchema,
  hip4TradeSchema,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import type { Pool } from "pg";
import { applyHip4Book, mapHip4Market } from "./hip4-mapping.js";
import {
  createHip4ReadClient,
  Hip4ReadError,
  type Hip4InfoRequest,
} from "./hip4-client.js";
import {
  admitHip4Request,
  advanceHip4Cursor,
  persistHip4Market,
  readHip4Cursor,
  readHip4Policy,
  readHip4StoredMarket,
} from "./hip4-repository.js";

export function selectHip4Outcomes(policy: Hip4ReadPolicy, after: number) {
  const sorted = [...new Set(policy.outcomeAllowlist)].sort((a, b) => a - b);
  return [
    ...sorted.filter((id) => id > after),
    ...sorted.filter((id) => id <= after),
  ].slice(0, policy.maxOutcomesPerCycle);
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
  if (!policy.enabled || policy.outcomeAllowlist.length === 0)
    return diagnostics;
  const sourceRead =
    readOverride ??
    createHip4ReadClient(policy, (weight) =>
      admitHip4Request(
        pool,
        policy.environment,
        weight,
        policy.requestWeightPerMinute,
      ),
    );
  const read = async (request: Hip4InfoRequest) => {
    const start = Date.now();
    try {
      return await sourceRead(request);
    } finally {
      diagnostics.fetchMs += Date.now() - start;
    }
  };
  // Two bounded requests, before starting any write transaction. Failure is not
  // an empty generation and never closes/tombstones existing outcomes.
  const metadata = hip4MetadataSchema.parse(
    await read({ type: "outcomeMeta" }),
  );
  const spotMetadata = hip4SpotMetadataSchema.parse(
    await read({ type: "spotMeta" }),
  );
  const generation = randomUUID();
  const fetchedAt = new Date().toISOString();
  const after = await readHip4Cursor(pool, policy.environment);
  for (const outcome of selectHip4Outcomes(policy, after)) {
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
      let settlement = stored?.raw?.settlement ?? null;
      if (!active && !settlement) {
        const response = await read({ type: "settledOutcome", outcome });
        if (response != null) settlement = hip4SettlementSchema.parse(response);
      }
      if (!active && !settlement) {
        diagnostics.skipped++;
        diagnostics.failures.push({
          outcome,
          reason: "metadata_missing_pending_settlement",
        });
        await advanceHip4Cursor(pool, policy.environment, outcome);
        continue;
      }
      // Preserve the question association when the settled endpoint only
      // returns its outcome spec, not the former question membership.
      const preservedQuestion = stored?.raw?.question;
      const source =
        preservedQuestion &&
        !metadata.questions.some(
          (q) =>
            q.question === preservedQuestion.question ||
            q.fallbackOutcome === outcome ||
            q.namedOutcomes.includes(outcome),
        )
          ? {
              ...metadata,
              questions: [...metadata.questions, preservedQuestion],
            }
          : metadata;
      const mapStart = Date.now();
      const mappingInput = {
        environment: policy.environment,
        outcome,
        metadata: source,
        spotMetadata,
        fetchedAt,
        generation,
        settlement,
      };
      let mapped = mapHip4Market(mappingInput);
      diagnostics.mapMs += Date.now() - mapStart;
      // Some terminal outcomes can remain listed in metadata. Expiry triggers
      // an official lookup, never a synthetic WIN/LOSS from time or book price.
      if (!settlement && mapped.market.status === "expired") {
        try {
          const response = await read({ type: "settledOutcome", outcome });
          if (response != null) {
            settlement = hip4SettlementSchema.parse(response);
            mapped = mapHip4Market({ ...mappingInput, settlement });
          }
        } catch (error) {
          if (
            error instanceof Hip4ReadError &&
            error.reason === "budget_exhausted"
          )
            throw error;
          diagnostics.failures.push({
            outcome,
            reason: "settlement_unavailable",
          });
        }
      }
      const trades = [];
      if (!settlement) {
        for (const sideIndex of [0, 1] as const) {
          try {
            const payload = await read({
              type: "l2Book",
              coin: mapped.market.sides[sideIndex].coin,
            });
            mapped = {
              ...mapped,
              market: applyHip4Book(
                mapped.market,
                sideIndex,
                payload,
                Date.now(),
                policy.bookMaxAgeMs,
              ),
            };
          } catch (error) {
            if (
              error instanceof Hip4ReadError &&
              error.reason === "budget_exhausted"
            )
              throw error;
            mapped.market.sides[sideIndex].bookState = "error";
            diagnostics.failures.push({
              outcome,
              reason: `book_${sideIndex}_unavailable`,
            });
          }
        }
        // Observe only the primary (side 0) merged book. Mirrored dual records
        // must not become two economic trades or inflated market USD volume.
        try {
          const payload = await read({
            type: "recentTrades",
            coin: mapped.market.sides[0].coin,
          });
          if (
            !Array.isArray(payload) ||
            payload.length > policy.maxTradesPerResponse
          )
            throw new Error("trade_response_bound");
          const normalized = payload.map((row) => hip4TradeSchema.parse(row));
          if (
            normalized.some(
              (row) =>
                row.coin !== mapped.market.sides[0].coin ||
                row.time > Date.now(),
            )
          )
            throw new Error("trade_identity_or_time_mismatch");
          trades.push(...normalized);
          const times = normalized.map((row) => row.time);
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
          };
        } catch {
          mapped.market.coverage.trades = "error";
          diagnostics.failures.push({ outcome, reason: "trades_unavailable" });
        }
      }
      // Recheck policy before publication. Disabling never requires a restart.
      const current = await readHip4Policy(pool);
      if (!current.policy.enabled || current.revision !== revision) break;
      const writeStart = Date.now();
      if (await persistHip4Market(pool, { ...mapped, trades }))
        diagnostics.indexed++;
      diagnostics.writeMs += Date.now() - writeStart;
    } catch (error) {
      diagnostics.failures.push({
        outcome,
        reason:
          error instanceof Hip4ReadError
            ? error.reason
            : "invalid_or_unavailable_outcome",
      });
      if (error instanceof Hip4ReadError && error.reason === "budget_exhausted")
        break;
      await advanceHip4Cursor(pool, policy.environment, outcome);
    }
  }
  return diagnostics;
}
