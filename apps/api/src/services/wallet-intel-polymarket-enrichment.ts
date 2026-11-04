import type { Pool } from "@hunch/infra";
import { normalizePolymarketAssetId } from "@hunch/shared";
import {
  positionAssetKey,
  positionStorageContract,
} from "../lib/position-asset-context.js";
import { loadPolymarketHoldingLedgers } from "./polymarket-asset-context.js";
import { loadPolymarketHoldingMarkRows } from "./polymarket-holding-marks.js";

export const WALLET_INTEL_ENRICHMENT_BATCH = 1000;
type Db = Pick<Pool, "query">;
type Holding = Parameters<typeof loadPolymarketHoldingMarkRows>[1][number];
type Ledger = Awaited<ReturnType<typeof loadPolymarketHoldingLedgers>>[number];
type Diagnostic = {
  stage: "ledgers" | "marks";
  requested: number;
  durationMs: number;
  failed: boolean;
};
type Observe = (diagnostic: Diagnostic) => void;

export async function loadWalletIntelPolymarketLedgers(
  db: Db,
  ids: readonly string[],
  observe?: Observe,
) {
  const tokens = [
    ...new Set(
      ids
        .map(normalizePolymarketAssetId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const ledgers = new Map<string, Ledger>();
  for (
    let start = 0;
    start < tokens.length;
    start += WALLET_INTEL_ENRICHMENT_BATCH
  ) {
    const chunk = tokens.slice(start, start + WALLET_INTEL_ENRICHMENT_BATCH);
    const at = Date.now();
    let failed = true;
    try {
      for (const ledger of await loadPolymarketHoldingLedgers(db, chunk, {
        boundedTokenLookups: true,
      })) {
        const existing = ledgers.get(ledger.contractAddress);
        if (!existing) ledgers.set(ledger.contractAddress, ledger);
        else
          for (const [id, context] of ledger.tokenContexts) {
            if (
              existing.tokenContexts.has(id) &&
              JSON.stringify(existing.tokenContexts.get(id)) !==
                JSON.stringify(context)
            )
              throw new Error("Conflicting wallet Intel ledger contexts");
            existing.tokenContexts.set(id, context);
          }
      }
      failed = false;
    } finally {
      observe?.({
        stage: "ledgers",
        requested: chunk.length,
        durationMs: Date.now() - at,
        failed,
      });
    }
  }
  return [...ledgers.values()].sort((a, b) =>
    a.contractAddress.localeCompare(b.contractAddress),
  );
}

export async function loadWalletIntelPolymarketMarks(
  db: Db,
  holdings: readonly Holding[],
  options: { isolateBatchErrors?: boolean; observe?: Observe } = {},
) {
  const unique = new Map<string, Holding>();
  const conflicting = new Set<string>();
  for (const holding of holdings) {
    const contract = holding.assetContext
      ? positionStorageContract({ venue: "polymarket", ...holding })
      : (holding.positionContract ?? "");
    const key = positionAssetKey(holding.tokenId, contract);
    const previous = unique.get(key);
    if (
      previous &&
      JSON.stringify(previous.assetContext ?? null) !==
        JSON.stringify(holding.assetContext ?? null)
    ) {
      if (!options.isolateBatchErrors)
        throw new Error("Conflicting wallet Intel mark contexts");
      conflicting.add(key);
    }
    unique.set(key, holding);
  }
  for (const key of conflicting) unique.delete(key);
  const rows: Awaited<ReturnType<typeof loadPolymarketHoldingMarkRows>> =
    new Map();
  const wanted = [...unique.values()];
  for (
    let start = 0;
    start < wanted.length;
    start += WALLET_INTEL_ENRICHMENT_BATCH
  ) {
    const chunk = wanted.slice(start, start + WALLET_INTEL_ENRICHMENT_BATCH);
    const at = Date.now();
    let failed = true;
    try {
      const batch = await loadPolymarketHoldingMarkRows(db, chunk);
      for (const [key, row] of batch) rows.set(key, row);
      failed = false;
    } catch (error) {
      if (!options.isolateBatchErrors) throw error;
      // Missing marks keep all affected wallets pending in the collector.
      // No partial batch is accepted as complete; other batches can proceed.
    } finally {
      options.observe?.({
        stage: "marks",
        requested: chunk.length,
        durationMs: Date.now() - at,
        failed,
      });
    }
  }
  return rows;
}
