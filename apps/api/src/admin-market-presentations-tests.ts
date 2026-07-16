#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminMarketPresentationBodySchema } from "./schemas/admin.js";
import {
  deleteAdminMarketPresentation,
  getAdminMarketPresentation,
  putAdminMarketPresentation,
  searchAdminMarketPresentations,
} from "./services/admin-market-presentations.js";

const REVIEWER_ID = "00000000-0000-4000-8000-000000000001";
const MARKET_ID = "polymarket:market-1";
type MarketPresentationDb = Parameters<
  typeof searchAdminMarketPresentations
>[0];

const draft = {
  version: 1 as const,
  subject: "World Championship Winner",
  predicate: "Bilibili Gaming",
  threshold: null,
  deadline: "2026-12-31",
  positions: {
    YES: {
      canonicalLabel: "Bilibili Gaming",
      shortLabel: "Bilibili Gaming",
      aliases: ["BGL", "BLG"],
    },
    NO: {
      canonicalLabel: "NO on Bilibili Gaming",
      shortLabel: "NO",
      aliases: [],
    },
  },
};

function createDb() {
  const row = {
    id: MARKET_ID,
    venue: "polymarket",
    title: "BGL",
    description: null,
    slug: "bgl",
    outcomes: JSON.stringify(["Yes", "No"]),
    close_time: "2026-12-31T00:00:00.000Z",
    expiration_time: "2026-12-31T00:00:00.000Z",
    metadata: {
      hunch: { retainedSetting: true },
      venueField: "preserved",
    } as Record<string, unknown>,
    event_id: "polymarket:event-1",
    event_title: "World Championship Winner",
    event_description: null,
  };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      if (sql.includes("jsonb_set(")) {
        const override = JSON.parse(String(params[1])) as Record<
          string,
          unknown
        >;
        const metadata = row.metadata as Record<string, unknown>;
        row.metadata = {
          ...metadata,
          hunch: {
            ...((metadata.hunch as Record<string, unknown>) ?? {}),
            telegramPresentationV1: override,
          },
        };
      } else if (sql.includes("#- '{hunch,telegramPresentationV1}'")) {
        const metadata = row.metadata as Record<string, unknown>;
        const hunch = {
          ...((metadata.hunch as Record<string, unknown>) ?? {}),
        };
        delete hunch.telegramPresentationV1;
        row.metadata = { ...metadata, hunch };
      }
      return { rows: [structuredClone(row) as unknown as T] };
    },
  } as unknown as MarketPresentationDb;
  return { calls, db, readMetadata: () => structuredClone(row.metadata) };
}

assert.equal(adminMarketPresentationBodySchema.safeParse(draft).success, true);
assert.equal(
  adminMarketPresentationBodySchema.safeParse({
    ...draft,
    reviewStatus: "approved",
  }).success,
  false,
  "clients must not provide server-controlled review provenance",
);

const fixture = createDb();
const search = await searchAdminMarketPresentations(fixture.db, "BGL");
assert.equal(search.length, 1);
assert.equal(fixture.calls[0]?.params[0], "BGL");

const original = await getAdminMarketPresentation(fixture.db, MARKET_ID);
assert.equal(original?.override, null);

const published = await putAdminMarketPresentation({
  db: fixture.db,
  marketId: MARKET_ID,
  override: draft,
  reviewedBy: REVIEWER_ID,
});
assert.equal(published?.override?.reviewStatus, "approved");
assert.equal(published?.override?.provenance.reviewedBy, REVIEWER_ID);
assert.equal(published?.override?.subject, draft.subject);

const reset = await deleteAdminMarketPresentation(fixture.db, MARKET_ID);
assert.equal(reset?.override, null);
assert.deepEqual(fixture.readMetadata(), {
  hunch: { retainedSetting: true },
  venueField: "preserved",
});
const afterReset = await getAdminMarketPresentation(fixture.db, MARKET_ID);
assert.equal(afterReset?.override, null);

const routesSource = readFileSync(
  new URL("./routes/admin.ts", import.meta.url),
  "utf8",
);
assert.match(
  routesSource,
  /z\.get\(\s*"\/admin\/intel\/market-presentations\/search"[\s\S]*?requiredAdminPermission: "intel:read"/,
);
assert.match(
  routesSource,
  /z\.put\(\s*"\/admin\/intel\/market-presentations\/:marketId"[\s\S]*?requiredAdminPermission: "intel:write"/,
);
assert.match(
  routesSource,
  /z\.delete\(\s*"\/admin\/intel\/market-presentations\/:marketId"[\s\S]*?requiredAdminPermission: "intel:write"/,
);

console.log("[admin-market-presentations-tests] passed 7/7");
