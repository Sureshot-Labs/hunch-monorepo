#!/usr/bin/env node

import assert from "node:assert/strict";

import { fetchAllActive, type fetchActivePage } from "./limitlessClient.js";
import type { TLimitlessMarket } from "./types.js";

type ActivePage = Awaited<ReturnType<typeof fetchActivePage>>;

function market(id: number): TLimitlessMarket {
  return { id } as TLimitlessMarket;
}

function page(input: {
  data: TLimitlessMarket[];
  invalidMarkets?: ActivePage["invalidMarkets"];
  totalMarketsCount: number;
  totalPages: number;
}): ActivePage {
  return {
    page: 1,
    data: input.data,
    invalidMarkets: input.invalidMarkets ?? [],
    totalMarketsCount: input.totalMarketsCount,
    totalPages: input.totalPages,
  };
}

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("fetchAllActive follows reported pages and deduplicates shifting rows", async () => {
  const pages = new Map<number, ActivePage>([
    [
      1,
      page({
        data: [market(1), market(2)],
        totalMarketsCount: 5,
        totalPages: 3,
      }),
    ],
    [
      2,
      page({
        data: [market(2), market(3)],
        totalMarketsCount: 5,
        totalPages: 3,
      }),
    ],
    [
      3,
      page({
        data: [market(4), market(5)],
        totalMarketsCount: 5,
        totalPages: 3,
      }),
    ],
  ]);
  const result = await fetchAllActive(40, 2, {
    fetchPage: async (pageNumber) =>
      pages.get(pageNumber) ??
      page({
        data: [],
        totalMarketsCount: 5,
        totalPages: 3,
      }),
    pageDelayMs: 0,
  });

  assert.deepEqual(
    result.markets.map((item) => item.id),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(result.coverage, {
    capReached: false,
    complete: true,
    duplicates: 1,
    failedPages: [],
    malformedMarkets: 0,
    pagesFetched: 3,
    reportedMarkets: 5,
    reportedPages: 3,
    uniqueMarkets: 5,
  });
});

await test("fetchAllActive reports incomplete coverage at the safety cap", async () => {
  const result = await fetchAllActive(2, 1, {
    fetchPage: async (pageNumber) =>
      page({ data: [market(pageNumber)], totalMarketsCount: 4, totalPages: 4 }),
    pageDelayMs: 0,
  });

  assert.equal(result.coverage.capReached, true);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.pagesFetched, 2);
});

await test("fetchAllActive marks malformed coverage incomplete", async () => {
  const result = await fetchAllActive(40, 2, {
    fetchPage: async () =>
      page({
        data: [market(1)],
        invalidMarkets: [{ index: 1, issues: [] }],
        totalMarketsCount: 2,
        totalPages: 1,
      }),
    pageDelayMs: 0,
  });

  assert.equal(result.coverage.malformedMarkets, 1);
  assert.equal(result.coverage.complete, false);
});

await test("fetchAllActive preserves partial coverage when a page fails", async () => {
  const result = await fetchAllActive(40, 2, {
    fetchPage: async (pageNumber) => {
      if (pageNumber === 2) throw new Error("temporary upstream failure");
      return page({
        data: [market(1), market(2)],
        totalMarketsCount: 6,
        totalPages: 3,
      });
    },
    pageDelayMs: 0,
  });

  assert.deepEqual(
    result.markets.map((item) => item.id),
    [1, 2],
  );
  assert.deepEqual(result.coverage.failedPages, [2]);
  assert.equal(result.coverage.pagesFetched, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.capReached, false);
});
