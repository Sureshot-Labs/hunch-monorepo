import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "@hunch/infra";

import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import {
  limitlessClobQuoteQuerySchema,
  limitlessEmbeddedSignOrderPrepareBodySchema,
} from "./schemas/limitless-private.js";
import {
  computeLimitlessCollateralBuyCheck,
  enforceLimitlessCollateralBuyCheck,
  inspectLimitlessCollateralBuy,
  limitlessEmbeddedFokBuyPrincipal,
  limitlessUsdToRaw,
} from "./services/limitless-collateral-buy.js";

const wallet = "0x0000000000000000000000000000000000000001";
const exchange = "0x0000000000000000000000000000000000000002";
const feeModule = "0x0000000000000000000000000000000000000003";
const marketSlug = "test-collateral-market";
const market = {
  slug: marketSlug,
  venue: { exchange, feeModule, feeModuleType: "COLLATERAL" },
  metadata: { fee: true },
};
const input = {
  db: {
    query: () => {
      throw new Error("Unmocked DB read");
    },
  } as unknown as Pick<Pool, "query">,
  userId: "test-user",
  marketSlug,
  signer: wallet,
  principal: 2_000_000n,
};

test("the observed wallet covers the principal but not the venue's standard reserve", () => {
  const check = computeLimitlessCollateralBuyCheck({
    principal: 2_000_000n,
    balance: 2_019_319n,
    locked: 0n,
    feeEnabled: true,
  });
  assert.deepEqual(check, {
    status: "standard_reserve_shortfall",
    principalRaw: "2000000",
    balanceRaw: "2019319",
    availableRaw: "2019319",
    standardFeeReserveRaw: "100000",
    standardRequiredRaw: "2100000",
    standardShortfallRaw: "80681",
    standardMaxBuyRaw: "1923160",
  });
  assert.equal(enforceLimitlessCollateralBuyCheck(check, false), null);
  assert.equal(
    enforceLimitlessCollateralBuyCheck(check, true)?.payload.code,
    "limitless_collateral_standard_reserve_shortfall",
  );
  assert.equal(
    enforceLimitlessCollateralBuyCheck(check, true)?.statusCode,
    409,
  );
});

test("fee-disabled markets use principal only; missing facts never mean zero or approval", () => {
  const base = { principal: 2_000_000n, balance: 2_000_000n, locked: 0n };
  const feeFree = computeLimitlessCollateralBuyCheck({
    ...base,
    feeEnabled: false,
  });
  assert.equal(feeFree.status, "ready");
  assert.equal(feeFree.standardRequiredRaw, "2000000");
  const unavailable = computeLimitlessCollateralBuyCheck({
    ...base,
    feeEnabled: null,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.standardRequiredRaw, null);
  assert.equal(enforceLimitlessCollateralBuyCheck(unavailable, false), null);
  assert.equal(
    enforceLimitlessCollateralBuyCheck(unavailable, true)?.statusCode,
    503,
  );
  const exactShortfall = computeLimitlessCollateralBuyCheck({
    ...base,
    balance: 1_999_999n,
    locked: null,
    feeEnabled: null,
  });
  assert.equal(
    enforceLimitlessCollateralBuyCheck(exactShortfall, false)?.payload.code,
    "limitless_collateral_balance_insufficient",
  );
  assert.equal(
    computeLimitlessCollateralBuyCheck({
      ...base,
      balance: 2_100_000n,
      feeEnabled: true,
    }).status,
    "ready",
  );
  const roundedUp = computeLimitlessCollateralBuyCheck({
    ...base,
    principal: 21n,
    feeEnabled: true,
  });
  assert.equal(roundedUp.standardFeeReserveRaw, "2");
});

test("read-only check scopes the wallet, reuses verified market, and subtracts known local BUY locks", async () => {
  const inspected = await inspectLimitlessCollateralBuy(
    { ...input, marketPayload: market },
    {
      fetchMarket: async () => {
        throw new Error("Already loaded market must not be fetched again");
      },
      readBalance: async (request) => {
        assert.equal(request.owner, wallet);
        assert.equal(
          request.tokenAddress.toLowerCase(),
          fundingSidecarRuntimeConfig.limitlessUsdcAddress.toLowerCase(),
        );
        assert.ok(request.timeoutMs <= 3000);
        return 2_160_000n;
      },
      readLocks: async (db, request) => {
        assert.equal(db, input.db);
        assert.deepEqual(request, {
          userId: "test-user",
          polymarketWallets: [],
          limitlessWallets: [wallet],
        });
        return {
          polymarket: new Map(),
          limitless: new Map([[wallet, 65_000n]]),
        };
      },
    },
  );
  assert.equal(inspected?.availableRaw, "2095000");
  assert.equal(inspected?.standardShortfallRaw, "5000");
  assert.equal(inspected?.status, "standard_reserve_shortfall");
});

test("legacy and mismatched market facts never trigger an on-chain preflight", async () => {
  let reads = 0;
  const deps = {
    readBalance: async () => {
      reads++;
      return 0n;
    },
    readLocks: async () => {
      reads++;
      return { polymarket: new Map(), limitless: new Map() };
    },
  };
  assert.equal(
    await inspectLimitlessCollateralBuy(
      {
        ...input,
        marketPayload: { slug: marketSlug, venue: { exchange } },
      },
      deps,
    ),
    null,
  );
  assert.equal(
    (
      await inspectLimitlessCollateralBuy(
        {
          ...input,
          marketPayload: { ...market, slug: "different" },
        },
        deps,
      )
    )?.status,
    "unavailable",
  );
  assert.equal(reads, 0);
  const failed = await inspectLimitlessCollateralBuy(
    { ...input, marketPayload: market },
    {
      readBalance: async () => {
        throw new Error("Fixture timeout");
      },
      readLocks: deps.readLocks,
    },
  );
  assert.equal(failed?.status, "unavailable");
  assert.equal(failed?.balanceRaw, null);
});

test("only fixed-principal FOK BUY signatures and exact USDC amounts enter the new lane", () => {
  const fok = { side: 0, makerAmount: "2000000", takerAmount: 1 };
  assert.equal(limitlessEmbeddedFokBuyPrincipal(fok), 2_000_000n);
  assert.equal(
    limitlessEmbeddedFokBuyPrincipal({ ...fok, takerAmount: "0x1" }),
    2_000_000n,
  );
  assert.equal(limitlessEmbeddedFokBuyPrincipal({ ...fok, side: 1 }), null);
  assert.equal(
    limitlessEmbeddedFokBuyPrincipal({ ...fok, takerAmount: 1000 }),
    null,
  );
  assert.equal(
    limitlessEmbeddedFokBuyPrincipal({
      ...fok,
      makerAmount: Number.MAX_SAFE_INTEGER + 1,
    }),
    null,
  );
  assert.equal(limitlessUsdToRaw(0.019319), 19_319n);
  assert.equal(limitlessUsdToRaw(0.0000001), null);
  assert.equal(
    limitlessClobQuoteQuerySchema.parse({
      slug: marketSlug,
      tokenId: "123",
      side: "BUY",
      amountUsd: "2",
      checkCollateral: "true",
    }).checkCollateral,
    true,
  );
  const prepared = limitlessEmbeddedSignOrderPrepareBodySchema.parse({
    marketSlug,
    requireStandardFeeReserve: true,
    order: {
      ...fok,
      maker: wallet,
      signer: wallet,
      tokenId: "123",
      salt: "1234",
      expiration: "0",
      nonce: 0,
      signatureType: 0,
    },
  });
  assert.equal(prepared.requireStandardFeeReserve, true);
});
