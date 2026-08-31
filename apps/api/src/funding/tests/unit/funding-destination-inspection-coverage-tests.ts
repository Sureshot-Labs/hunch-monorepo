import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Pool } from "@hunch/infra";

import {
  collectDestinationInspectionCoverage,
  isDestinationDriverApplicable,
  supportsDestinationMarketClass,
} from "../../preparation/destination-inspection-coverage.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";
import { WalletPreparationRuntimeService } from "../../preparation/runtime-service.js";

const drivers = [
  {
    venueId: "polymarket",
    supportedMarketClasses: ["standard", "neg_risk"],
  },
  {
    venueId: "limitless",
    supportedMarketClasses: ["clob", "clob_neg_risk", "amm", "amm_neg_risk"],
  },
] as const;

function applicableVenueIds(input: {
  requestedMarketClass: string | null;
  targetVenueId: string | null;
}): string[] {
  return drivers
    .filter((driver) =>
      isDestinationDriverApplicable({
        driverVenueId: driver.venueId,
        supportedMarketClasses: driver.supportedMarketClasses,
        ...input,
      }),
    )
    .map((driver) => driver.venueId);
}

await test("market-scoped discovery inspects only the target venue driver", () => {
  assert.deepEqual(
    applicableVenueIds({
      requestedMarketClass: null,
      targetVenueId: "limitless",
    }),
    ["limitless"],
  );
  assert.deepEqual(
    applicableVenueIds({
      requestedMarketClass: null,
      targetVenueId: "polymarket",
    }),
    ["polymarket"],
  );
});

await test("an explicit market class also excludes incompatible venue drivers", () => {
  assert.deepEqual(
    applicableVenueIds({
      requestedMarketClass: "amm",
      targetVenueId: null,
    }),
    ["limitless"],
  );
  assert.deepEqual(
    applicableVenueIds({
      requestedMarketClass: "standard",
      targetVenueId: null,
    }),
    ["polymarket"],
  );
});

await test("funding discovery without a market class inspects every venue driver", () => {
  assert.deepEqual(
    applicableVenueIds({
      requestedMarketClass: null,
      targetVenueId: null,
    }),
    ["polymarket", "limitless"],
  );
  assert.equal(
    supportsDestinationMarketClass(["standard", "neg_risk"], null),
    true,
  );
  assert.equal(
    supportsDestinationMarketClass(
      ["clob", "clob_neg_risk", "amm", "amm_neg_risk"],
      null,
    ),
    true,
  );
});

await test("interactive destination inspection is bounded and reuses RPC evidence", () => {
  const source = readFileSync(
    new URL("../../preparation/runtime-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /DESTINATION_INSPECTION_TIMEOUT_MS = 20_000/);
  assert.match(source, /DESTINATION_INSPECTION_REUSE_MS = 30_000/);
  assert.match(source, /destinationInspectionInflight/);
  assert.match(source, /destinationInspectionCache/);
  assert.match(source, /withinDestinationInspectionDeadline/);
  assert.equal(
    (source.match(/bypassCodeCache: input\.forceFresh === true/g) ?? []).length,
    2,
  );
  assert.match(source, /refresh: input\.forceFresh === true/);
  assert.match(
    source,
    /if \(input\.forceFresh\) \{\s*throw new PreparationContractError\(\s*"preparation_unavailable"/,
  );
});

await test("Limitless preparation reads one exact onchain snapshot without the account route", () => {
  const source = readFileSync(
    new URL("../../preparation/runtime-service.ts", import.meta.url),
    "utf8",
  );
  const limitlessInspection = source.slice(
    source.indexOf("private async inspectLimitless"),
    source.indexOf("async frozenDestinations"),
  );
  assert.match(limitlessInspection, /fetchLimitlessOnchainSnapshot/);
  assert.match(
    limitlessInspection,
    /conditionalTokensAddress:\s*fundingSidecarRuntimeConfig\.limitlessConditionalTokensAddress/,
  );
  assert.doesNotMatch(limitlessInspection, /fetchLimitlessAccountRoute/);
  assert.equal(
    (limitlessInspection.match(/resolveLimitlessAuthContext/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    limitlessInspection,
    /AuthService\.getVenueCredentialsInfo/,
  );
  assert.match(limitlessInspection, /const authContextPromise/);
  assert.match(
    limitlessInspection,
    /Promise\.all\(\[\s*authContextPromise,\s*snapshotPromise/,
  );
});

await test("Polymarket preparation overlaps the account snapshot and CLOB inspection", () => {
  const source = readFileSync(
    new URL("../../preparation/runtime-service.ts", import.meta.url),
    "utf8",
  );
  const polymarketInspection = source.slice(
    source.indexOf("private async inspectPolymarket"),
    source.indexOf("private async inspectLimitless"),
  );
  assert.match(polymarketInspection, /const accountResultPromise/);
  assert.match(polymarketInspection, /const clobPromise/);
  assert.match(polymarketInspection, /const liveCollateralLocksPromise/);
  assert.match(
    polymarketInspection,
    /Promise\.all\(\[\s*marketContextPromise,\s*accountResultPromise,\s*clobPromise,\s*liveCollateralLocksPromise/,
  );
  assert.match(polymarketInspection, /credentialsInfo: credentials/);
  assert.match(polymarketInspection, /liveCollateralLocks/);
  assert.match(polymarketInspection, /onchainSnapshot/);
  assert.doesNotMatch(
    polymarketInspection,
    /AuthService\.getVenueCredentialsInfo/,
  );
  assert.doesNotMatch(
    polymarketInspection,
    /const clob = await inspectPolymarketClob/,
  );
});

await test("rejects a snapshot when every internal inspection for a venue failed", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "polymarket",
      internalWallet: true,
      outcome: { status: "fulfilled", value: "polymarket-option" },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "rejected", reason: new Error("temporary failure") },
    },
  ]);

  assert.deepEqual(coverage.values, ["polymarket-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, ["limitless"]);
});

await test("accepts a venue when one internal wallet inspection succeeds", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "rejected", reason: new Error("wallet unavailable") },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: { status: "fulfilled", value: "limitless-option" },
    },
  ]);

  assert.deepEqual(coverage.values, ["limitless-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, []);
});

await test("an external success cannot conceal a failed internal destination", () => {
  const coverage = collectDestinationInspectionCoverage([
    {
      venueId: "limitless",
      internalWallet: false,
      outcome: { status: "fulfilled", value: "external-option" },
    },
    {
      venueId: "limitless",
      internalWallet: true,
      outcome: {
        status: "rejected",
        reason: new Error("internal unavailable"),
      },
    },
  ]);

  assert.deepEqual(coverage.values, ["external-option"]);
  assert.deepEqual(coverage.incompleteVenueIds, ["limitless"]);
});

await test("destination listing keeps verified venues when another venue fails", async () => {
  const service = new WalletPreparationRuntimeService({} as Pool);
  Object.defineProperty(service, "loadWallets", {
    value: async () => [
      {
        id: "wallet_partial_coverage_12345678",
        isVerified: true,
        isInternalWallet: true,
      },
    ],
  });
  Object.defineProperty(service, "venueDrivers", {
    value: [
      {
        venueId: "polymarket",
        supportedMarketClasses: [],
        supportsWallet: () => true,
      },
      {
        venueId: "limitless",
        supportedMarketClasses: [],
        supportsWallet: () => true,
      },
    ],
  });
  Object.defineProperty(service, "inspectDestinationWithReuse", {
    value: async (input: { driver: { venueId: string } }) => {
      if (input.driver.venueId === "limitless") {
        throw new Error("Limitless temporarily unavailable");
      }
      return { venueId: input.driver.venueId };
    },
  });
  const preparedDestinations = Reflect.get(
    service,
    "preparedDestinations",
  ).bind(service) as (
    input: {
      accountId: string;
      compatibleVenueBindingOptionIds: null;
      controllerWalletRef: null;
      marketClass: null;
      marketContextId: null;
      positionActionRef: null;
      purpose: "fund";
    },
    resolvedMarket: null,
    allowPartialVenueCoverage: boolean,
  ) => Promise<readonly { venueId: string }[]>;
  const input = {
    accountId: "account_partial_coverage_12345678",
    compatibleVenueBindingOptionIds: null,
    controllerWalletRef: null,
    marketClass: null,
    marketContextId: null,
    positionActionRef: null,
    purpose: "fund" as const,
  };

  assert.deepEqual(await preparedDestinations(input, null, true), [
    { venueId: "polymarket" },
  ]);
  await assert.rejects(
    () => preparedDestinations(input, null, false),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      error.code === "preparation_unavailable",
  );
});
