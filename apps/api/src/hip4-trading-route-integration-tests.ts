// @requires-db — real sessions/CSRF + native runtime in disposable PG16 only.
// Every provider call is mocked; ephemeral keys sign offline, never live orders.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import { Wallet } from "ethers";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, hip4Identity } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import {
  registerHip4TradingRoutes,
  hip4TradingRouteError,
} from "./routes/hip4-trading.js";
import { hip4TradingPreparationSchema } from "./schemas/hip4-trading.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
assert.match(
  (await pool.query("show server_version")).rows[0].server_version,
  /^16\./u,
);
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
process.env.JWT_SECRET = "hip4-disposable-trading-test-only";
process.env.PRIVY_APP_ID = "hip4-disposable-trading-test";
process.env.PRIVY_APP_SECRET = "hip4-disposable-trading-test";
const [
  { AuthService, createAuthMiddleware },
  { pool: authPool },
  { closeAcquiredRuntimeResources },
  { ordersRoutes },
] = await Promise.all([
  import("./auth.js"),
  import("./db.js"),
  import("./runtime-resource-cleanup.js"),
  import("./routes/orders.js"),
]);
assert.equal(
  (await authPool.query("select current_database() as name")).rows[0].name,
  process.env.HUNCH_TEST_EXPECT_DATABASE,
);
const app = Fastify(),
  closedApp = Fastify();
for (const server of [app, closedApp]) {
  server.setSerializerCompiler(serializerCompiler);
  server.setValidatorCompiler(validatorCompiler);
}
await app.register(swagger, {
  openapi: { info: { title: "HIP HTTP contract", version: "test" } },
  transform: jsonSchemaTransform,
});
const wallet = Wallet.createRandom();
const policyIds: string[] = [],
  sessionIds: string[] = [],
  actionIds: string[] = [];
let fixture: Awaited<ReturnType<typeof hip4OrderTestFixture>>;
let reads = 0,
  posts = 0,
  failReads = false;
let bookState: "fresh" | "stale" | "wrong_side" | "empty" = "fresh";
async function lifecycle(state: "active" | "exit-only" | "unreleased") {
  const value = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  value.venues.hyperliquid = { lifecycle: state, indexerMode: "off" };
  // PG has microseconds while the effective-policy reader takes JS milliseconds.
  // A test's immediately-following read must not see its own fixture as future.
  policyIds.push(
    (
      await pool.query(
        "insert into runtime_policies(policy_key,payload,effective_at) values('venue_lifecycle',$1,clock_timestamp()-interval '1 second') returning id",
        [value],
      )
    ).rows[0].id,
  );
}
let uninitializedAccount = false;
let fundedDefaultAccount = false;
let legacyDexAbstraction: unknown = null;
let omitDeployerFeeScale = false;
let omitGlobalFeeScale = false;
const fetcher: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (url === "https://api.hyperliquid.xyz/exchange") {
    posts++;
    return Response.json({
      status: "ok",
      response: {
        type: body.action.type === "order" ? "order" : "cancel",
        data: {
          statuses: [
            body.action.type === "order"
              ? { resting: { oid: 123456789 } }
              : "success",
          ],
        },
      },
    });
  }
  assert.equal(url, "https://api.hyperliquid.xyz/info");
  reads++;
  if (failReads)
    throw new Error("private-provider-url-and-secret-must-not-leak");
  if (body.user) assert.equal(body.user, wallet.address.toLowerCase());
  if (body.type === "orderStatus")
    return Response.json({ status: "unknownOid" });
  if (body.type === "userFillsByTime") return Response.json([]);
  const outcome = Number(fixture.request.marketId.split(":").at(-1));
  const identity = hip4Identity("mainnet", outcome);
  const responses: Record<string, unknown> = {
    l2Book: {
      coin: bookState === "wrong_side" ? identity.sides[0].coin : body.coin,
      time: Date.now() - (bookState === "stale" ? 3_600_001 : 0),
      levels:
        bookState === "empty"
          ? [[], []]
          : [[{ px: "0.49", sz: "4", n: 1 }], [{ px: "0.5", sz: "3", n: 1 }]],
    },
    userRole: { role: uninitializedAccount ? "missing" : "user" },
    userAbstraction:
      uninitializedAccount || fundedDefaultAccount ? "default" : "disabled",
    userDexAbstraction: legacyDexAbstraction,
    borrowLendUserState: {
      tokenToState: [],
      health: "healthy",
      healthFactor: null,
    },
    spotMeta: {
      tokens: [
        {
          index: 0,
          name: "USDC",
          tokenId: HYPERCORE_MAINNET_USDC.assetId,
          szDecimals: 8,
          weiDecimals: 8,
        },
      ],
    },
    spotClearinghouseState: {
      balances: uninitializedAccount
        ? []
        : [
            { coin: "USDC", token: 0, total: "1000", hold: "0", entryNtl: "0" },
            {
              coin: identity.sides[1].tokenName,
              token: outcome * 10 + 1,
              total: "1000",
              hold: "0",
              entryNtl: "0",
            },
          ],
    },
    outcomeMeta: {
      outcomes: [
        {
          outcome,
          name: "Synthetic",
          description: "",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
          quoteToken: "USDC",
          ...(omitDeployerFeeScale ? {} : { deployerFeeScale: "1" }),
        },
      ],
      ...(omitGlobalFeeScale ? {} : { feeScale: "1" }),
    },
    userFees: {
      userSpotCrossRate: "0.0007",
      userSpotAddRate: "0.0004",
      activeReferralDiscount: "0",
    },
  };
  assert.ok(body.type in responses);
  return Response.json(responses[body.type]);
};
const dependencies = {
  pool,
  authorize: createAuthMiddleware(),
  runtime: { fetcher },
};
registerHip4TradingRoutes(app, dependencies);
registerHip4TradingRoutes(closedApp, { ...dependencies, runtime: { fetcher } });
await app.register(ordersRoutes);
try {
  await pool.query(
    "create temp table hip4_request_budget(like public.hip4_request_budget including all)",
  );
  policyIds.push(
    (
      await pool.query(
        "insert into runtime_policies(policy_key,effective_at,payload) values('hip4_read',clock_timestamp()-interval '1 second',$1) returning id",
        [{ quotePreviewCacheEntries: 0 }],
      )
    ).rows[0].id,
  );
  await lifecycle("active");
  const setup = await pool.connect();
  try {
    await setup.query("begin");
    fixture = await hip4OrderTestFixture(setup, wallet.address);
    await setup.query("commit");
  } finally {
    await setup.query("rollback");
    setup.release();
  }
  const token = AuthService.generateToken(fixture.userId);
  const session = await AuthService.createSession(
    fixture.userId,
    wallet.address,
    token,
  );
  sessionIds.push(session.id);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-csrf-token": session.csrfToken,
    "x-hunch-wallet": wallet.address,
  };
  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, headers, payload });
  const resetBudget = () =>
    pool.query("update pg_temp.hip4_request_budget set admissions='[]'::jsonb");
  const request = fixture.request;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/prepare",
        payload: request,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/prepare",
        headers: { ...headers, "x-csrf-token": "wrong" },
        payload: request,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/prepare",
        headers: {
          ...headers,
          "x-hunch-wallet": Wallet.createRandom().address,
        },
        payload: request,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await post("/orders/prepare", { ...request, userId: fixture.userId }))
      .statusCode,
    400,
  );
  assert.equal(
    (await post("/orders/prepare", { ...request, capabilityCheck: true }))
      .statusCode,
    400,
  );
  assert.equal(reads, 0);
  assert.equal(posts, 0);
  for (const invalid of [
    { quantity: "abc" },
    { quantity: "0.1" },
    { limitPrice: "2" },
    { consentedDebitCapRaw: "NaN" },
  ]) {
    for (const path of ["/orders/quote", "/orders/prepare"])
      assert.equal(
        (await post(path, { ...request, ...invalid })).statusCode,
        400,
      );
  }
  assert.equal(reads, 0);
  await lifecycle("unreleased");
  assert.equal(
    (
      await closedApp.inject({
        method: "POST",
        url: "/orders/prepare",
        headers,
        payload: request,
      })
    ).statusCode,
    409,
    "ordinary unreleased lifecycle rejects before provider IO",
  );
  assert.equal(reads, 0);
  const marketRequest = {
    requestKey: randomUUID(),
    controllerWalletRef: request.controllerWalletRef,
    marketId: request.marketId,
    outcomeSide: request.outcomeSide,
    side: "BUY",
    consentedDebitCapRaw: "1000000000",
    slippageBps: 100,
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/market-quote",
        payload: marketRequest,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/market-quote",
        headers: { ...headers, "x-csrf-token": "wrong" },
        payload: marketRequest,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await closedApp.inject({
        method: "POST",
        url: "/orders/market-quote",
        headers,
        payload: marketRequest,
      })
    ).statusCode,
    409,
  );
  await lifecycle("active");
  assert.equal(
    (
      await post("/orders/market-quote", {
        ...marketRequest,
        slippageBps: -1,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post("/orders/market-quote", {
        ...marketRequest,
        controllerWalletRef: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    reads,
    0,
    "quote auth/lifecycle/ownership/shape precede public provider IO",
  );
  for (const state of ["stale", "wrong_side", "empty", "fresh"] as const) {
    await resetBudget();
    bookState = state;
    const marketQuote = await post("/orders/market-quote", marketRequest);
    assert.equal(
      marketQuote.statusCode,
      state === "fresh" ? 200 : state === "wrong_side" ? 503 : 409,
      marketQuote.body,
    );
    assert.equal(marketQuote.headers["cache-control"], "private, no-store");
    if (state === "fresh") {
      const data = marketQuote.json();
      assert.equal(data.amounts.quantity, "19");
      assert.equal(data.amounts.limitPrice, "0.505");
      assert.equal(data.amounts.debitCapRaw, "959500000");
      assert.equal(data.fees.buyFeeCapRaw, "0");
      assert.equal(data.providerCapacity.includesHunchHolds, false);
      assert.equal(data.executionEstimate.estimatedFillQuantity, "3");
      assert.equal(data.executionEstimate.estimatedUnfilledQuantity, "16");
      assert.equal(data.executionEstimate.partialFillPossible, true);
      await resetBudget();
      const native = await post("/orders/quote", data.preparationRequest);
      assert.equal(native.statusCode, 200, native.body);
      assert.deepEqual(
        native.json().amounts,
        data.amounts,
        "market quote feeds the existing exact preparation contract",
      );
    }
  }
  await resetBudget();
  const defaultSlippage = await post("/orders/market-quote", {
    ...marketRequest,
    slippageBps: undefined,
  });
  assert.equal(defaultSlippage.statusCode, 200, defaultSlippage.body);
  assert.equal(defaultSlippage.json().executionEstimate.slippageBps, 30);
  assert.equal(defaultSlippage.json().amounts.limitPrice, "0.5015");
  await resetBudget();
  const sellQuote = await post("/orders/market-quote", {
    ...marketRequest,
    side: "SELL",
    consentedDebitCapRaw: "200000",
  });
  assert.equal(sellQuote.statusCode, 200, sellQuote.body);
  assert.equal(sellQuote.json().amounts.quantity, "2");
  assert.equal(sellQuote.json().amounts.debitAsset, "outcome");
  assert.equal(sellQuote.json().fees.feeRoleAssumption, "taker");
  assert.notEqual(sellQuote.json().fees.estimatedFeeAtLimitRaw, "0");
  omitDeployerFeeScale = true;
  await resetBudget();
  const omittedShareQuote = await post("/orders/market-quote", {
    ...marketRequest,
    requestKey: randomUUID(),
    side: "SELL",
    consentedDebitCapRaw: "200000",
  });
  assert.equal(omittedShareQuote.statusCode, 200, omittedShareQuote.body);
  assert.equal(omittedShareQuote.json().fees.currentRateUpperBound, "0.0007");
  assert.notEqual(omittedShareQuote.json().fees.estimatedFeeAtLimitRaw, "0");
  omitGlobalFeeScale = true;
  await resetBudget();
  const missingGlobalQuote = await post("/orders/market-quote", {
    ...marketRequest,
    side: "SELL",
    consentedDebitCapRaw: "200000",
  });
  assert.equal(missingGlobalQuote.statusCode, 409, missingGlobalQuote.body);
  assert.equal(missingGlobalQuote.json().error, "hip4_fee_terms_unavailable");
  omitDeployerFeeScale = false;
  omitGlobalFeeScale = false;
  await resetBudget();
  assert.equal(
    (
      await post("/orders/market-quote", {
        ...marketRequest,
        consentedDebitCapRaw: "100000000",
      })
    ).statusCode,
    409,
    "cannot round a $1 budget up to $1.01 for two contracts",
  );
  assert.equal(posts, 0, "all market quotes are read-only");
  await resetBudget();
  uninitializedAccount = true;
  const firstBuyQuote = await post("/orders/market-quote", marketRequest);
  assert.equal(firstBuyQuote.statusCode, 200, firstBuyQuote.body);
  assert.equal(firstBuyQuote.json().providerCapacity.availableRaw, "0");
  const firstBuyRequest = firstBuyQuote.json().preparationRequest;
  const beforeFundingPrepare = await post("/orders/prepare", firstBuyRequest);
  assert.equal(beforeFundingPrepare.statusCode, 409, beforeFundingPrepare.body);
  assert.equal(
    posts,
    0,
    "uninitialized preview never submits or prepares an executable action",
  );
  uninitializedAccount = false;
  fundedDefaultAccount = true;
  await resetBudget();
  const quote = await post("/orders/quote", request);
  assert.equal(quote.statusCode, 200, quote.body);
  assert.equal(quote.json().amounts.quantity, "4");
  assert.equal(quote.json().providerCapacity.includesHunchHolds, false);
  assert.equal(quote.json().fees.fundingCostsIncluded, false);
  assert.equal(quote.json().fees.buyFeeCapRaw, "0");
  const quoteMetadata = (
    await pool.query("select metadata from unified_markets where id=$1", [
      request.marketId,
    ])
  ).rows[0].metadata;
  const expiringMetadata = structuredClone(quoteMetadata);
  const quoteMarketExpiry = new Date(Date.now() + 5000).toISOString();
  expiringMetadata.hip4.expiry = quoteMarketExpiry;
  await pool.query(
    "update unified_markets set metadata=$2::jsonb,expiration_time=$3 where id=$1",
    [request.marketId, JSON.stringify(expiringMetadata), quoteMarketExpiry],
  );
  for (const [path, body] of [
    ["/orders/quote", request],
    ["/orders/market-quote", marketRequest],
  ] as const) {
    await resetBudget();
    const cappedQuote = await post(path, body);
    assert.equal(cappedQuote.statusCode, 200, cappedQuote.body);
    assert.ok(
      Date.parse(cappedQuote.json().expiresAt) <= Date.parse(quoteMarketExpiry),
      "ordinary and IOC quote lifetimes cannot extend beyond a known native market expiry",
    );
  }
  await pool.query(
    "update unified_markets set metadata=$2::jsonb,expiration_time=null where id=$1",
    [request.marketId, JSON.stringify(quoteMetadata)],
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from orders where user_id=$1",
        [fixture.userId],
      )
    ).rows[0].n,
    0,
  );
  await resetBudget();
  const response = await post("/orders/prepare", request);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  const prepared = hip4TradingPreparationSchema.parse(response.json());
  actionIds.push(prepared.actionId);
  assert.equal(prepared.signerAddress, wallet.address.toLowerCase());
  assert.equal(prepared.amounts?.grossQuoteRaw, "133332000");
  assert.equal("profile" in response.json(), false);
  assert.equal("snapshot" in response.json(), false);
  const beforeReplay = reads;
  assert.deepEqual(
    (await post("/orders/prepare", request)).json(),
    response.json(),
  );
  assert.equal(reads, beforeReplay);
  assert.equal(
    (await post("/orders/prepare", { ...request, quantity: "5" })).statusCode,
    409,
  );
  const signature = await wallet.signTypedData(
    prepared.typedData.domain,
    prepared.typedData.types,
    prepared.typedData.message,
  );
  assert.equal(
    (
      await post("/orders/submit", {
        actionId: prepared.actionId,
        signature,
        capacity: "1000",
      })
    ).statusCode,
    400,
  );
  const stranger = Wallet.createRandom();
  const wrongSignature = await stranger.signTypedData(
    prepared.typedData.domain,
    prepared.typedData.types,
    prepared.typedData.message,
  );
  const rejectedSignature = await post("/orders/submit", {
    actionId: prepared.actionId,
    signature: wrongSignature,
  });
  assert.equal(rejectedSignature.statusCode, 400);
  assert.ok(!rejectedSignature.body.includes(wrongSignature));
  assert.equal(posts, 0);
  const strangerId = randomUUID();
  await pool.query("insert into users(id,is_active) values($1,true)", [
    strangerId,
  ]);
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [strangerId, stranger.address.toLowerCase()],
  );
  const strangerToken = AuthService.generateToken(strangerId);
  const strangerSession = await AuthService.createSession(
    strangerId,
    stranger.address,
    strangerToken,
  );
  sessionIds.push(strangerSession.id);
  const foreignRequest = await app.inject({
    method: "POST",
    url: "/orders/submit",
    payload: { actionId: prepared.actionId, signature },
    headers: {
      authorization: `Bearer ${strangerToken}`,
      "x-csrf-token": strangerSession.csrfToken,
      "x-hunch-wallet": stranger.address,
    },
  });
  assert.equal(
    foreignRequest.statusCode,
    404,
    "a valid signature does not transfer preparation ownership to a different session",
  );
  assert.equal(posts, 0);
  const recoveryUrl = `/orders/actions/${prepared.actionId}`;
  assert.equal((await app.inject(recoveryUrl)).statusCode, 401);
  const initialRecovery = await app.inject({ url: recoveryUrl, headers });
  assert.equal(initialRecovery.statusCode, 200, initialRecovery.body);
  assert.equal(initialRecovery.headers["cache-control"], "private, no-store");
  assert.equal(initialRecovery.json().submissionState, null);
  assert.equal(initialRecovery.json().requestKey, request.requestKey);
  for (const method of ["GET", "POST"] as const) {
    const foreignRecovery = await app.inject({
      method,
      url: method === "GET" ? recoveryUrl : "/orders/abandon",
      headers: {
        authorization: `Bearer ${strangerToken}`,
        "x-csrf-token": strangerSession.csrfToken,
        "x-hunch-wallet": stranger.address,
      },
      ...(method === "POST"
        ? { payload: { actionId: prepared.actionId } }
        : {}),
    });
    assert.equal(foreignRecovery.statusCode, 404);
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/orders/abandon",
        headers: { ...headers, "x-csrf-token": "wrong" },
        payload: { actionId: prepared.actionId },
      })
    ).statusCode,
    403,
  );
  await resetBudget();
  const discardRequest = { ...request, requestKey: randomUUID() };
  const discardResponse = await post("/orders/prepare", discardRequest);
  assert.equal(discardResponse.statusCode, 200, discardResponse.body);
  const discarded = hip4TradingPreparationSchema.parse(discardResponse.json());
  actionIds.push(discarded.actionId);
  const discardedSignature = await wallet.signTypedData(
    discarded.typedData.domain,
    discarded.typedData.types,
    discarded.typedData.message,
  );
  for (const change of ["stale", "generation", "expired"] as const) {
    const changedMetadata = structuredClone(quoteMetadata);
    if (change === "stale")
      changedMetadata.hip4.metadataValidUntil = "2000-01-01T00:00:00.000Z";
    if (change === "generation")
      changedMetadata.hip4.description += " changed after preparation";
    if (change === "expired")
      changedMetadata.hip4.expiry = "2000-01-01T00:00:00.000Z";
    await pool.query(
      "update unified_markets set metadata=$2::jsonb,expiration_time=$3 where id=$1",
      [
        request.marketId,
        JSON.stringify(changedMetadata),
        changedMetadata.hip4.expiry,
      ],
    );
    await resetBudget();
    const refused = await post("/orders/submit", {
      actionId: discarded.actionId,
      signature: discardedSignature,
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error, "hip4_market_unavailable");
    assert.equal(
      posts,
      0,
      "native contract refusal never reaches a provider POST",
    );
    const absent = await app.inject({
      url: `/orders/actions/${discarded.actionId}`,
      headers,
    });
    assert.equal(absent.statusCode, 200, absent.body);
    assert.equal(
      absent.json().submissionState,
      null,
      "owned Check exposes the rolled-back first admission for explicit discard/fresh Review",
    );
  }
  await pool.query(
    "update unified_markets set metadata=$2::jsonb,expiration_time=null where id=$1",
    [request.marketId, JSON.stringify(quoteMetadata)],
  );
  const beforeDiscardReads = reads;
  await lifecycle("unreleased");
  const discard = await post("/orders/abandon", {
    actionId: discarded.actionId,
  });
  assert.equal(discard.statusCode, 200, discard.body);
  assert.equal(discard.json().state, "abandoned");
  assert.equal(discard.json().submissionState, null);
  assert.deepEqual(
    (await post("/orders/abandon", { actionId: discarded.actionId })).json(),
    discard.json(),
  );
  assert.equal(
    (
      await post("/orders/submit", {
        actionId: discarded.actionId,
        signature: discardedSignature,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    reads,
    beforeDiscardReads,
    "read/discard/late submit need no provider IO",
  );
  assert.equal(posts, 0);
  await lifecycle("active");
  const fundingDb = await pool.connect();
  let funding: Awaited<ReturnType<typeof hip4FundedOrderTestFixture>>;
  try {
    await fundingDb.query("begin");
    funding = await hip4FundedOrderTestFixture(fundingDb, {
      userId: fixture.userId,
      profile: fixture.profile,
      marketId: request.marketId,
      tokenId: hip4Identity(
        "mainnet",
        Number(request.marketId.split(":").at(-1)),
      ).sides[1].tokenId,
    });
    await fundingDb.query("commit");
  } finally {
    await fundingDb.query("rollback");
    fundingDb.release();
  }
  const submission = {
    actionId: prepared.actionId,
    signature,
    funding: {
      operationId: funding.operationId,
      reservationId: funding.reservationId,
    },
  };
  legacyDexAbstraction = true;
  await resetBudget();
  const changedDefaultProof = await post("/orders/submit", submission);
  assert.equal(changedDefaultProof.statusCode, 503, changedDefaultProof.body);
  assert.equal(
    posts,
    0,
    "a prepared default order must obtain new ancillary proof before mock dispatch",
  );
  legacyDexAbstraction = null;
  await resetBudget();
  const submitted = await post("/orders/submit", submission);
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().reconciliationRequired, true);
  assert.equal(submitted.json().replayed, false);
  assert.equal(posts, 1);
  const beforeRecheck = reads;
  for (const failed of [
    await app.inject({
      method: "POST",
      url: "/orders/recheck",
      payload: { actionId: prepared.actionId },
    }),
    await app.inject({
      method: "POST",
      url: "/orders/recheck",
      headers: { ...headers, "x-csrf-token": "wrong" },
      payload: { actionId: prepared.actionId },
    }),
    await app.inject({
      method: "POST",
      url: "/orders/recheck",
      headers: {
        authorization: `Bearer ${strangerToken}`,
        "x-csrf-token": strangerSession.csrfToken,
        "x-hunch-wallet": stranger.address,
      },
      payload: { actionId: prepared.actionId },
    }),
  ].entries())
    assert.equal(failed[1].statusCode, [401, 403, 404][failed[0]]);
  assert.equal(
    reads,
    beforeRecheck,
    "unauthenticated/CSRF/foreign recheck never reaches a provider",
  );
  await resetBudget();
  await pool.query(
    "update hip4_order_submissions set reconcile_after='infinity' where action_id=$1",
    [prepared.actionId],
  );
  const rechecked = await post("/orders/recheck", {
    actionId: prepared.actionId,
  });
  assert.equal(rechecked.statusCode, 200, rechecked.body);
  assert.ok(
    reads > beforeRecheck,
    "explicit owned recheck bypasses housekeeping and performs actual read-only observation",
  );
  assert.equal(posts, 1, "Check cannot send a second exchange request");
  assert.equal(
    (
      await pool.query("select state from balance_reservations where id=$1", [
        funding.reservationId,
      ])
    ).rows[0].state,
    "active",
    "unknownOid is not release authority",
  );
  await pool.query(
    "update hip4_order_submissions set reconcile_lease_token=gen_random_uuid(),reconcile_lease_until=clock_timestamp()+interval '1 minute' where action_id=$1",
    [prepared.actionId],
  );
  const leaseReads = reads;
  assert.equal(
    (await post("/orders/recheck", { actionId: prepared.actionId })).statusCode,
    200,
  );
  assert.equal(
    reads,
    leaseReads,
    "concurrent explicit check does not bypass a live lease",
  );
  await pool.query(
    "update hip4_order_submissions set reconcile_lease_token=null,reconcile_lease_until=null where action_id=$1",
    [prepared.actionId],
  );
  const afterSubmit = reads;
  await lifecycle("unreleased");
  const submittedRecovery = await app.inject({ url: recoveryUrl, headers });
  assert.equal(submittedRecovery.statusCode, 200, submittedRecovery.body);
  assert.equal(submittedRecovery.json().submissionState, "reconcile_required");
  assert.deepEqual(
    (await post("/orders/abandon", { actionId: prepared.actionId })).json(),
    submittedRecovery.json(),
    "discard cannot cancel an already admitted order",
  );
  const replayed = await post("/orders/submit", submission);
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(replayed.json().replayed, true);
  assert.equal(reads, afterSubmit);
  assert.equal(posts, 1);
  assert.equal(
    (await post("/orders/submit", { actionId: prepared.actionId, signature }))
      .statusCode,
    409,
    "funding link cannot be removed on replay",
  );
  await lifecycle("exit-only");
  await pool.query("update unified_markets set status='CLOSED' where id=$1", [
    request.marketId,
  ]);
  const cancellation = await post("/orders/cancel/prepare", {
    orderId: prepared.orderId,
    requestKey: randomUUID(),
  });
  assert.equal(cancellation.statusCode, 200, cancellation.body);
  const cancel = hip4TradingPreparationSchema.parse(cancellation.json());
  actionIds.push(cancel.actionId);
  assert.equal(cancel.amounts, null);
  assert.equal(cancel.fees, null);
  assert.equal(cancel.orderId, prepared.orderId);
  assert.equal(reads, afterSubmit);
  const cancelSignature = await wallet.signTypedData(
    cancel.typedData.domain,
    cancel.typedData.types,
    cancel.typedData.message,
  );
  assert.equal(
    (
      await post("/orders/submit", {
        actionId: cancel.actionId,
        signature: cancelSignature,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post("/orders/cancel/submit", {
        actionId: prepared.actionId,
        orderId: prepared.orderId,
        signature,
      })
    ).statusCode,
    409,
    "funded BUY replay cannot shed its funding link through cancellation",
  );
  const canceled = await post("/orders/cancel/submit", {
    actionId: cancel.actionId,
    orderId: prepared.orderId,
    signature: cancelSignature,
  });
  assert.equal(canceled.statusCode, 200, canceled.body);
  assert.equal(canceled.json().reconciliationRequired, true);
  assert.equal(posts, 2);
  assert.equal(reads, afterSubmit);
  assert.equal(
    (
      await pool.query("select state from balance_reservations where id=$1", [
        funding.reservationId,
      ])
    ).rows[0].state,
    "active",
    "cancel ACK does not release funding",
  );
  const get = (url: string) => app.inject({ url, headers });
  assert.equal((await app.inject("/orders?venue=hyperliquid")).statusCode, 401);
  const opened = await get("/orders/open?venue=hyperliquid");
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(
    opened.json().orders.length,
    1,
    "cancel ACK cannot remove the native order",
  );
  assert.equal(opened.json().orders[0].id, prepared.orderId);
  assert.equal(opened.json().orders[0].nativeOrder.terminalConfirmed, false);
  // Exact observer facts are tested in the observer suite. Here exercise their
  // serialization through the ordinary authenticated routes and policy changes.
  await pool.query(
    "update orders set status='partially_filled',filled_size=1.25 where id=$1",
    [prepared.orderId],
  );
  await pool.query(
    "update hip4_order_submissions set order_observation=$2 where action_id=$1",
    [
      prepared.actionId,
      {
        status: "canceled",
        terminal: true,
        balanceBarrier: {
          state: "terminal_observed",
          responseAt: Date.now() - 1000,
        },
      },
    ],
  );
  await lifecycle("unreleased");
  const beforeHistoryReads = reads;
  const historyResponse = await get(
    "/orders?venue=hyperliquid&type=order&status=cancelled",
  );
  assert.equal(historyResponse.statusCode, 200, historyResponse.body);
  assert.equal(historyResponse.headers["cache-control"], "private, no-store");
  assert.equal(
    historyResponse.json().orders.length,
    1,
    "owned Hunch history remains available after venue disable",
  );
  const historyRow = historyResponse.json().orders[0];
  assert.equal(historyRow.status, "cancelled");
  assert.equal(historyRow.filledSize, 1.25);
  assert.equal(historyRow.nativeOrder.filledQuantity, "1.25");
  assert.equal(historyRow.nativeOrder.terminalConfirmed, true);
  assert.equal(historyRow.nativeOrder.fullQuantityObserved, false);
  assert.equal(
    (await get("/orders/open?venue=hyperliquid")).json().orders.length,
    0,
  );
  const detail = await get(`/orders/${prepared.orderId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().order, historyRow);
  const strangerRead = await app.inject({
    url: `/orders/${prepared.orderId}`,
    headers: {
      authorization: `Bearer ${strangerToken}`,
      "x-hunch-wallet": stranger.address,
    },
  });
  assert.equal(strangerRead.statusCode, 404);
  assert.equal(reads, beforeHistoryReads, "history has no provider IO");
  await lifecycle("active");
  // The cancellation/history scenario intentionally closed this instrument.
  // Restore its factual availability before isolating a provider-read error.
  await pool.query(
    "update unified_markets set status='ACTIVE',metadata=$2::jsonb,expiration_time=null where id=$1",
    [request.marketId, JSON.stringify(quoteMetadata)],
  );
  await resetBudget();
  failReads = true;
  const failedRead = await post("/orders/quote", {
    ...request,
    requestKey: randomUUID(),
  });
  assert.equal(failedRead.statusCode, 503);
  assert.doesNotMatch(failedRead.body, /secret|provider-url|signature/iu);
  assert.deepEqual(hip4TradingRouteError(new Error(signature)), {
    status: 503,
    error: "trade_temporarily_unavailable",
  });
  // Quote-only cases above still prove no order is created. Exercise unsigned
  // SELL preparation only after those zero-order assertions have completed.
  failReads = false;
  omitDeployerFeeScale = true;
  await resetBudget();
  const readySellQuote = await post("/orders/market-quote", {
    ...marketRequest,
    requestKey: randomUUID(),
    side: "SELL",
    consentedDebitCapRaw: "200000",
  });
  assert.equal(readySellQuote.statusCode, 200, readySellQuote.body);
  await resetBudget();
  const omittedSharePreparation = await post(
    "/orders/prepare",
    readySellQuote.json().preparationRequest,
  );
  assert.equal(
    omittedSharePreparation.statusCode,
    200,
    omittedSharePreparation.body,
  );
  actionIds.push(omittedSharePreparation.json().actionId);
  assert.equal(
    omittedSharePreparation.json().fees.currentRateUpperBound,
    "0.0007",
  );
  assert.equal(
    posts,
    2,
    "unsigned SELL preparation never sends an exchange request",
  );
  omitDeployerFeeScale = false;
  const spec = app.swagger();
  assert.ok(spec.paths?.["/orders/actions/{actionId}"]?.get);
  for (const route of [
    "/orders/market-quote",
    "/orders/abandon",
    "/orders/quote",
    "/orders/prepare",
    "/orders/submit",
    "/orders/cancel/prepare",
    "/orders/cancel/submit",
  ]) {
    const operation = spec.paths?.[route]?.post;
    assert.ok(
      operation && "requestBody" in operation && operation.requestBody,
      `documented ${route}`,
    );
  }
  console.log(
    "[hip4-trading-http] real auth/CSRF, DTO/OpenAPI, funding, sign-only prepare, one POST/replay, exit-only cancellation and redacted errors passed",
  );
} finally {
  for (const id of actionIds)
    await pool.query(
      "update hip4_order_submissions set reconcile_after='infinity' where action_id=$1",
      [id],
    );
  for (const id of sessionIds)
    await pool.query("delete from user_sessions where id=$1", [id]);
  for (const id of policyIds)
    await pool.query("delete from runtime_policies where id=$1", [id]);
  await app.close();
  await closedApp.close();
  await pool.end();
  await closeAcquiredRuntimeResources();
}
