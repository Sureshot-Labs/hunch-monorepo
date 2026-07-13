// @requires-db

import assert from "node:assert/strict";

import { pool, type DbQuery } from "./db.js";
import {
  clearVenueLifecyclePolicyCache,
  resolveVenueLifecyclePolicy,
} from "./services/runtime-policies.js";
import {
  filterVenuesForLifecycleCapability,
  lifecycleCapabilityForTradingAction,
  resolveCollateralPairTradingAction,
  venueLifecycleAllows,
  venueLifecycleAllowsTradingAction,
} from "./services/venue-lifecycle.js";

const client = await pool.connect();

try {
  await client.query("begin");
  const db: DbQuery = {
    query: client.query.bind(client) as DbQuery["query"],
  };

  await client.query(
    `insert into runtime_policies (
       policy_key,
       effective_at,
       payload,
       created_by
     )
     values ('venue_lifecycle', clock_timestamp() - interval '2 milliseconds', $1::jsonb, null)`,
    [
      JSON.stringify({
        version: 1,
        venues: {
          polymarket: { lifecycle: "active", indexerMode: "full" },
          limitless: { lifecycle: "exit-only", indexerMode: "maintenance" },
          kalshi: { lifecycle: "active", indexerMode: "full" },
          hyperliquid: { lifecycle: "unreleased", indexerMode: "off" },
        },
      }),
    ],
  );

  clearVenueLifecyclePolicyCache(db);
  const resolved = await resolveVenueLifecyclePolicy(db);
  assert.equal(resolved.source, "db");
  assert.equal(resolved.invalidOverride, false);
  assert.match(resolved.revision, /^db-/);
  assert.equal(
    await venueLifecycleAllows(db, "kalshi", "increaseExposure"),
    true,
  );
  assert.equal(
    await venueLifecycleAllows(db, "limitless", "increaseExposure"),
    false,
  );
  assert.equal(
    await venueLifecycleAllows(db, "limitless", "reduceExposure"),
    true,
  );
  assert.equal(await venueLifecycleAllows(db, "unknown", "accountRead"), false);
  assert.equal(lifecycleCapabilityForTradingAction("BUY"), "increaseExposure");
  assert.equal(lifecycleCapabilityForTradingAction("SELL"), "reduceExposure");
  assert.equal(
    resolveCollateralPairTradingAction({
      collateralAsset: "USDC",
      inputAsset: "USDC",
      outputAsset: "YES",
    }),
    "BUY",
  );
  assert.equal(
    resolveCollateralPairTradingAction({
      collateralAsset: "USDC",
      inputAsset: "NO",
      outputAsset: "USDC",
    }),
    "SELL",
  );
  assert.equal(
    resolveCollateralPairTradingAction({
      collateralAsset: "USDC",
      inputAsset: "YES",
      outputAsset: "NO",
    }),
    null,
  );
  assert.equal(
    await venueLifecycleAllowsTradingAction(db, "limitless", "SELL"),
    true,
  );
  assert.equal(
    await venueLifecycleAllowsTradingAction(db, "limitless", "SELL", {
      automation: true,
    }),
    false,
  );

  const filtered = await filterVenuesForLifecycleCapability(
    db,
    ["limitless", "kalshi", "dflow", "unknown"],
    "discovery",
  );
  assert.deepEqual(filtered.venues, ["kalshi"]);
  assert.equal(filtered.revision, resolved.revision);

  await client.query(
    `insert into runtime_policies (
       policy_key,
       effective_at,
       payload,
       created_by
     )
     values ('venue_lifecycle', clock_timestamp() - interval '1 millisecond', $1::jsonb, null)`,
    [
      JSON.stringify({
        version: 1,
        venues: {
          polymarket: { lifecycle: "active", indexerMode: "full" },
        },
      }),
    ],
  );
  const cachedBeforeInvalidation = await resolveVenueLifecyclePolicy(db);
  assert.equal(cachedBeforeInvalidation.source, "db");
  assert.equal(
    cachedBeforeInvalidation.effective.venues.limitless.lifecycle,
    "exit-only",
  );
  clearVenueLifecyclePolicyCache(db);
  const invalid = await resolveVenueLifecyclePolicy(db);
  assert.equal(invalid.source, "default");
  assert.equal(invalid.invalidOverride, true);
  assert.equal(invalid.revision, "defaults-v1");
  assert.equal(invalid.effective.venues.kalshi.lifecycle, "exit-only");
  assert.equal(invalid.effective.venues.kalshi.indexerMode, "maintenance");

  console.log("[venue-lifecycle-integration-tests] passed 21/21");
} finally {
  clearVenueLifecyclePolicyCache();
  await client.query("rollback");
  client.release();
}
