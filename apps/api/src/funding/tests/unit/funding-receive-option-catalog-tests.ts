#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";

import type {
  ExternalIngressInstruction,
  FundingDestinationOption,
  IntentLiquidityProjection,
  SourceOption,
} from "../../domain/types.js";
import {
  findFundingReceiveOption,
  listFundingReceiveOptions,
} from "../../receive/receive-option-catalog.js";
import { FundingReceiveSessionService } from "../../receive/receive-session-service.js";
import { FundingPlannerError } from "../../planner/money.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const RECEIVE_OPTION_TOKEN_KEY = "r".repeat(32);
const POLYGON_USDC = {
  networkId: "evm:137",
  assetId: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  decimals: 6,
};
const SOLANA_USDC = {
  networkId: "solana:mainnet",
  assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
};

function destination(
  suffix: string,
  venueId: "polymarket" | "limitless",
): FundingDestinationOption {
  return {
    destinationOptionId: `destination_${suffix}_12345678`,
    venueId,
    venueBindingId: `binding_${suffix}_12345678`,
    venueBindingOptionId: `binding_option_${suffix}_12345678`,
    controllerWalletId: `wallet_${suffix}_12345678`,
    safeLabel: venueId,
    requiredAsset: POLYGON_USDC,
    networkLabel: "Polygon",
    readinessClass: "internal_managed",
    preparationStatus: "ready",
    preparationPurpose: "fund",
    executionMode: "privy_authorization",
    marketClass: null,
    topology: "test",
    inspectionRevision: `inspection_${suffix}_12345678`,
    recommended: venueId === "polymarket",
    selectable: true,
    reasonCodes: [],
  };
}

function manualReceiveOption(input: {
  id: string;
  targetId: string;
  assets: readonly (typeof POLYGON_USDC | typeof SOLANA_USDC)[];
}): SourceOption {
  return {
    sourceOptionId: `source_${input.id}_12345678`,
    kind: "manual_receive",
    safeLabel: "Deposit crypto",
    source: {
      kind: "external_ingress",
      ingressKind: "manual",
      networkId: null,
      asset: null,
      controlledSender: false,
    },
    ingress: {
      ingressKind: "manual",
      sourceNetworkId: null,
      sourceAsset: null,
      receiveTargets: [
        {
          receiveTargetId: `target_${input.targetId}_12345678`,
          networkId: input.assets[0]?.networkId ?? "evm:137",
          destinationAddress: "0x0000000000000000000000000000000000000002",
          acceptedAssets: input.assets.map((asset) => ({
            asset,
            handling: "direct" as const,
            senderNativeFeeRequirement: null,
          })),
          safeInstructions: ["Send only the selected asset."],
        },
      ],
      recommendedReceiveTargetId: `target_${input.targetId}_12345678`,
      destinationOptionId: `destination_${input.id}_12345678`,
      destinationAddress: "0x0000000000000000000000000000000000000002",
      requestedAmount: null,
      amountSemantics: "minimum",
      expiresAt: null,
      safeInstructions: ["Send only the selected asset."],
    },
    amountMode: "variable_external",
    quotedSourceAmount: null,
    maximumSourceRaw: null,
    expectedDestination: null,
    minimumDestination: null,
    estimatedUsd: null,
    fees: [],
    eta: null,
    experienceMode: "inline_funding",
    requiredActions: [],
    expiresAt: "2026-08-21T00:00:00.000Z",
    recommended: true,
    selectable: true,
    reasonCodes: [],
  };
}

function privyFundingOption(asset: typeof POLYGON_USDC): SourceOption {
  const manual = manualReceiveOption({
    id: "privy",
    targetId: "privy",
    assets: [asset],
  });
  const ingress = manual.ingress as ExternalIngressInstruction;
  return {
    ...manual,
    sourceOptionId: "source_privy_funding_12345678",
    kind: "privy_funding_method",
    safeLabel: "Fund with Privy",
    source: {
      kind: "external_ingress",
      ingressKind: "privy",
      networkId: null,
      asset: null,
      controlledSender: false,
    },
    ingress: {
      ...ingress,
      ingressKind: "privy",
    },
  };
}

function liquidity(
  sourceOptions: readonly SourceOption[],
): IntentLiquidityProjection {
  return {
    liquidityProjectionId: "20000000-0000-4000-8000-000000000001",
    marketContextId: null,
    venueId: null,
    venueBindingOptionId: null,
    destinationOptionId: null,
    collateralAsset: POLYGON_USDC,
    requestedCollateralRaw: "1",
    availableNowRaw: "0",
    shortfallRaw: "1",
    convertibleRaw: "0",
    requestedUsd: "0",
    availableNowUsd: "0",
    shortfallUsd: "0",
    convertibleUsd: "0",
    mode: "prepare_first",
    eta: null,
    requiredActions: [],
    sourceOptions,
    asOf: "2026-08-21T00:00:00.000Z",
    expiresAt: "2026-08-21T00:01:00.000Z",
    policyVersion: 1,
    completeness: "complete",
    freshness: "fresh",
    errors: [],
    reasonCodes: [],
    destinationOptions: [],
  };
}

async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`[funding-receive-option-catalog-tests] ok ${name}`);
}

await test("collapses duplicate assets to the policy-preferred destination", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const limitless = destination("limitless", "limitless");
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket, limitless],
      policyDisabledOptions: [],
    }),
    liquidity: async (
      _userId: string,
      request: { destinationOptionId: string | null },
    ) =>
      liquidity(
        request.destinationOptionId === polymarket.destinationOptionId
          ? [
              manualReceiveOption({
                id: "polymarket",
                targetId: "polymarket",
                assets: [POLYGON_USDC, SOLANA_USDC],
              }),
            ]
          : [
              manualReceiveOption({
                id: "limitless",
                targetId: "limitless",
                assets: [POLYGON_USDC],
              }),
            ],
      ),
  };
  const catalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  const options = catalog.candidates;

  assert.equal(options.length, 2);
  assert.deepEqual(
    options.map((candidate) => [
      candidate.option.asset.networkId,
      candidate.option.asset.assetId,
      candidate.option.recommendedFor,
      candidate.destinationOptionId,
    ]),
    [
      [
        POLYGON_USDC.networkId,
        POLYGON_USDC.assetId,
        ["crypto"],
        polymarket.destinationOptionId,
      ],
      [
        SOLANA_USDC.networkId,
        SOLANA_USDC.assetId,
        [],
        polymarket.destinationOptionId,
      ],
    ],
  );
  assert.match(options[1]?.option.receiveOptionId ?? "", /^receive_option_/);
  assert.equal(options[1]?.option.network.name, "Solana");
});

await test("omits a destination whose discovery cannot establish a manual receive method", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket],
      policyDisabledOptions: [],
    }),
    liquidity: async () => liquidity([]),
  };
  const catalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
  });
  assert.deepEqual(catalog.candidates, []);
});

await test("advertises Card only for its exact supported asset variant", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket],
      policyDisabledOptions: [],
    }),
    liquidity: async () =>
      liquidity([
        manualReceiveOption({
          id: "polymarket",
          targetId: "polymarket",
          assets: [POLYGON_USDC, SOLANA_USDC],
        }),
        privyFundingOption(POLYGON_USDC),
      ]),
  };
  const catalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.deepEqual(
    catalog.candidates.map((candidate) => [
      candidate.option.asset.networkId,
      candidate.option.ingressMethods,
      candidate.option.recommendedFor,
    ]),
    [
      [
        "evm:137",
        ["connected_wallet", "manual_receive", "privy_card"],
        ["crypto", "card"],
      ],
      ["solana:mainnet", ["connected_wallet", "manual_receive"], []],
    ],
  );
});

await test("does not advertise Card when its receiver differs from the selected crypto target", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const card = privyFundingOption(POLYGON_USDC);
  const cardIngress = card.ingress as ExternalIngressInstruction;
  const target = cardIngress.receiveTargets?.[0];
  assert.ok(target);
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket],
      policyDisabledOptions: [],
    }),
    liquidity: async () =>
      liquidity([
        manualReceiveOption({
          id: "polymarket",
          targetId: "polymarket",
          assets: [POLYGON_USDC],
        }),
        {
          ...card,
          ingress: {
            ...cardIngress,
            destinationAddress: "0x0000000000000000000000000000000000000003",
            receiveTargets: [
              {
                ...target,
                destinationAddress:
                  "0x0000000000000000000000000000000000000003",
              },
            ],
          },
        },
      ]),
  };
  const catalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.deepEqual(catalog.candidates[0]?.option.ingressMethods, [
    "connected_wallet",
    "manual_receive",
  ]);
});

await test("resolves a still-live opaque choice across catalog refreshes", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket],
      policyDisabledOptions: [],
    }),
    liquidity: async () =>
      liquidity([
        manualReceiveOption({
          id: "polymarket",
          targetId: "polymarket",
          assets: [POLYGON_USDC],
        }),
      ]),
  };
  const issued = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  const receiveOptionId = issued.candidates[0]?.option.receiveOptionId;
  assert.ok(receiveOptionId);
  const refreshed = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:01:00.000Z"),
    expiresAt: new Date("2026-08-21T00:05:00.000Z"),
  });
  assert.ok(findFundingReceiveOption(refreshed, receiveOptionId));
  const forgedExpiry = receiveOptionId.replace(
    /_[0-9a-z]+$/u,
    `_${new Date("2027-08-21T00:00:00.000Z").getTime().toString(36)}`,
  );
  const forgedCatalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:01:00.000Z"),
    expiresAt: new Date("2027-08-21T00:00:00.000Z"),
  });
  assert.equal(
    findFundingReceiveOption(forgedCatalog, forgedExpiry),
    null,
    "expiry is part of the opaque option fingerprint and cannot be extended client-side",
  );
  const wrongKeyCatalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: "w".repeat(32),
    now: new Date("2026-08-21T00:01:00.000Z"),
    expiresAt: new Date("2026-08-21T00:05:00.000Z"),
  });
  assert.equal(
    findFundingReceiveOption(wrongKeyCatalog, receiveOptionId),
    null,
    "a token is valid only under the API-held signing key",
  );
});

await test("fails an expired opaque choice before opening a receive session", async () => {
  const polymarket = destination("polymarket", "polymarket");
  const runtime = {
    destinationAccess: async () => ({
      options: [polymarket],
      policyDisabledOptions: [],
    }),
    liquidity: async () =>
      liquidity([
        manualReceiveOption({
          id: "polymarket",
          targetId: "polymarket",
          assets: [POLYGON_USDC],
        }),
      ]),
  };
  const catalog = await listFundingReceiveOptions({
    runtime: runtime as never,
    userId: USER_ID,
    tokenKey: RECEIVE_OPTION_TOKEN_KEY,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  const receiveOptionId = catalog.candidates[0]?.option.receiveOptionId;
  assert.ok(receiveOptionId);
  const query = async () => ({ rows: [], rowCount: 0 });
  const service = new FundingReceiveSessionService(
    {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as Pool,
    { receiveOptionTokenKey: RECEIVE_OPTION_TOKEN_KEY },
  );
  Object.defineProperty(service, "runtime", { value: runtime });
  await assert.rejects(
    () =>
      service.open(
        USER_ID,
        {
          receiveOptionId,
          idempotencyKey: "receive-option-open-12345678",
        },
        new Date("2026-08-21T00:05:01.000Z"),
      ),
    (error: unknown) =>
      error instanceof FundingPlannerError &&
      error.code === "receive_option_expired",
  );
});
