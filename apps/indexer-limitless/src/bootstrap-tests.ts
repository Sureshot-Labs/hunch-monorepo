#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  buildWsTargets,
  selectHotAmmQuoteCandidates,
  type HotLimitlessMarketRow,
  type WsMarketRefRow,
} from "./hot-targets.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function makeWsRow(
  index: number,
  overrides: Partial<WsMarketRefRow> = {},
): WsMarketRefRow {
  return {
    slug: `slug-${index}`,
    address: null,
    trade_type: "clob",
    ...overrides,
  };
}

function makeHotRow(
  index: number,
  overrides: Partial<HotLimitlessMarketRow> = {},
): HotLimitlessMarketRow {
  return {
    market_id: `market-${index}`,
    hot_rank: index,
    slug: `slug-${index}`,
    address: `0x${index.toString(16).padStart(4, "0")}`,
    trade_type: "amm",
    token_yes: `yes-${index}`,
    token_no: `no-${index}`,
    volume_total: 1000 - index,
    liquidity: 100 - index,
    ...overrides,
  };
}

test("buildWsTargets preserves input order within each subscription kind", () => {
  const targets = buildWsTargets(
    [
      makeWsRow(1, { trade_type: "amm", slug: null, address: "0xbbb" }),
      makeWsRow(2, { trade_type: "clob", slug: "slug-b" }),
      makeWsRow(3, { trade_type: "amm", slug: null, address: "0xaaa" }),
      makeWsRow(4, { trade_type: "clob", slug: "slug-a" }),
    ],
    10,
  );

  assert.deepEqual(targets.addresses, ["0xbbb", "0xaaa"]);
  assert.deepEqual(targets.slugs, ["slug-b", "slug-a"]);
});

test("buildWsTargets reserves room for AMM addresses instead of starving them", () => {
  const rows: WsMarketRefRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(makeWsRow(i));
  }
  rows.push(
    makeWsRow(100, { trade_type: "amm", slug: null, address: "0x101" }),
  );
  rows.push(
    makeWsRow(101, { trade_type: "amm", slug: null, address: "0x102" }),
  );
  rows.push(
    makeWsRow(102, { trade_type: "amm", slug: null, address: "0x103" }),
  );

  const targets = buildWsTargets(rows, 10);

  assert.equal(targets.addresses.length, 3);
  assert.equal(targets.slugs.length, 7);
});

test("buildWsTargets gives duration rows first claim when prepended", () => {
  const durationRows = [
    makeWsRow(1, { slug: "duration-a" }),
    makeWsRow(2, { slug: "duration-b" }),
  ];
  const hotRows = [
    makeWsRow(3, { slug: "duration-a" }),
    makeWsRow(4, { slug: "hot-a" }),
    makeWsRow(5, { slug: "top-a" }),
  ];

  const targets = buildWsTargets([...durationRows, ...hotRows], 3);

  assert.deepEqual(targets.slugs, ["duration-a", "duration-b", "hot-a"]);
});

test("selectHotAmmQuoteCandidates preserves hot order and max cap", () => {
  const candidates = selectHotAmmQuoteCandidates(
    [
      makeHotRow(1, { address: "0x111" }),
      makeHotRow(2, { trade_type: "clob" }),
      makeHotRow(3, { address: "0x333" }),
      makeHotRow(4, { address: "0x444" }),
    ],
    2,
  );

  assert.deepEqual(
    candidates.map((row) => row.address),
    ["0x111", "0x333"],
  );
});

test("selectHotAmmQuoteCandidates skips incomplete AMM rows", () => {
  const candidates = selectHotAmmQuoteCandidates(
    [
      makeHotRow(1, { address: null }),
      makeHotRow(2, { token_yes: null }),
      makeHotRow(3, { token_no: null }),
      makeHotRow(4, { address: "0x444" }),
    ],
    10,
  );

  assert.deepEqual(
    candidates.map((row) => row.address),
    ["0x444"],
  );
});
