// @requires-db — disposable PG16 only, ephemeral offline signer, mocked provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { hip4Identity, DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import { testHip4CommonCancel } from "./hip4-cancel-runtime-pg.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  FUNDING_CONTROLLER_WALLET_SQL,
  assertFundingControllerWallet,
} from "./funding/execution/funding-controller-wallet-lock.js";
import {
  fetchFundingConsumerReservationForUser,
  consumeFundingReservationForLinkedConsumerInTransaction,
} from "./funding/persistence/funding-evidence-repository.js";
import {
  persistHip4OrderPreparationInTransaction as prepare,
  persistHip4CancelPreparationInTransaction as cancel,
} from "./repos/hip4-order-preparation.js";
import {
  submitHip4OrderWithCurrentContext as submit,
  prepareHip4OrderWithCurrentContext as runtimePrepare,
} from "./services/hip4-order-runtime.js";
import {
  HIP4_ORDER_CONTROLLER_SQL,
  readHip4OrderController,
} from "./repos/hip4-order-controller.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import type { TradeIntent } from "./services/trading-types.js";
import type { Hip4OrderSubmitReference } from "./repos/hip4-order-admission.js";
import {
  HIP4_OWNED_ACTION_SQL,
  readHip4OrderSubmissionAttempt,
} from "./repos/hip4-order-admission.js";

// max=1 proves budgeted provider reads do not borrow a transaction connection.
const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const wallet = Wallet.createRandom();
const policyIds: string[] = [];
async function policy(lifecycle: "active" | "unreleased") {
  const payload = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  payload.venues.hyperliquid = { lifecycle, indexerMode: "off" };
  const saved = await pool.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',clock_timestamp(),$1) returning id",
    [payload],
  );
  policyIds.push(saved.rows[0].id);
}
let fixture: Awaited<ReturnType<typeof hip4OrderTestFixture>>;
let nonce = Date.now() - 1000;
async function preparation(side: "BUY" | "SELL" = "BUY", legacy = false) {
  // Each independent synthetic scenario starts a fresh provider-budget window.
  // This is a connection-local table, never the shared runtime budget table.
  await pool.query(
    "update pg_temp.hip4_request_budget set admissions='[]'::jsonb",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const prepared = await prepare(client, {
      ...fixture,
      nonce: ++nonce,
      expiresAfter: Date.now() + 60000,
      request: {
        ...fixture.request,
        side,
        requestKey: randomUUID(),
        consentedDebitCapRaw: side === "SELL" ? "400000" : "150000000",
      },
      feeObservation: legacy
        ? undefined
        : hip4FeeTestObservation({
            address: wallet.address.toLowerCase(),
            marketId: fixture.request.marketId,
            side,
          }),
    });
    await client.query("commit");
    const typed = prepareHip4TradeSigning(prepared.envelope).typedData;
    const input: Hip4OrderSubmitReference = {
      userId: fixture.userId,
      actionId: prepared.actionId,
      actor: "web_app",
      signature: await wallet.signTypedData(
        typed.domain,
        typed.types,
        typed.message,
      ),
    };
    return { prepared, input };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
const calls: string[] = [];
let failReads = false;
let onRead: (() => Promise<void>) | null = null;
let postCount = 0;
const fetcher: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (url === "https://api.hyperliquid.xyz/exchange") {
    postCount++;
    calls.push("exchange");
    assert.ok(body.signature);
    // Durable state must already be visible outside the admission transaction.
    const durable = await pool.query(
      "select count(*)::int as n from hip4_order_submissions submission_row join hip4_order_actions action_row on action_row.id=submission_row.action_id join orders order_row on order_row.id=action_row.order_id where order_row.user_id=$1 and submission_row.state='submission_started'",
      [fixture.userId],
    );
    assert.ok(durable.rows[0].n > 0);
    return Response.json({
      status: "ok",
      response: {
        type: body.action.type === "order" ? "order" : "cancel",
        data: {
          statuses: [
            body.action.type === "order"
              ? { resting: { oid: 100000 + postCount } }
              : "success",
          ],
        },
      },
    });
  }
  assert.equal(url, "https://api.hyperliquid.xyz/info");
  calls.push(body.type);
  // A query during actual provider read must work with pool max=1, and budget
  // writes must be visible even if the subsequent admission is rejected.
  assert.ok(
    (
      await pool.query(
        "select jsonb_array_length(admissions) as n from hip4_request_budget where scope='public-info'",
      )
    ).rows[0].n > 0,
  );
  if (onRead) {
    const hook = onRead;
    onRead = null;
    await hook();
  }
  if (failReads) throw new Error("synthetic provider unavailable");
  if (body.user) assert.equal(body.user, wallet.address.toLowerCase());
  const outcome = Number(fixture.request.marketId.split(":").at(-1));
  const identity = hip4Identity("mainnet", outcome);
  const responses: Record<string, unknown> = {
    userRole: { role: "user" },
    userAbstraction: "disabled",
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
      balances: [
        { coin: "USDC", token: 0, total: "10000", hold: "0", entryNtl: "0" },
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
          deployerFeeScale: "1",
        },
      ],
      feeScale: "1",
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
const deps = { fetcher };

try {
  assert.match(
    (await pool.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await pool.query(
    "create temp table hip4_request_budget(like public.hip4_request_budget including defaults including indexes)",
  );
  await policy("active");
  const client = await pool.connect();
  try {
    await client.query("begin");
    fixture = await hip4OrderTestFixture(client, wallet.address);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  const first = await preparation();
  await policy("unreleased");
  await assert.rejects(
    submit(pool, first.input, { fetcher }),
    /lifecycle_disabled/u,
  );
  assert.equal(
    calls.length,
    0,
    "ordinary unreleased lifecycle rejects before provider IO",
  );
  await policy("active");
  await assert.rejects(
    submit(
      pool,
      { ...first.input, context: {} } as Hip4OrderSubmitReference,
      deps,
    ),
  );
  await assert.rejects(
    submit(pool, { ...first.input, userId: randomUUID() }, deps),
    /preparation_not_found/u,
  );
  await assert.rejects(
    submit(pool, { ...first.input, actor: "telegram_bot" }, deps),
  );
  await assert.rejects(
    submit(pool, { ...first.input, signature: `0x${"00".repeat(65)}` }, deps),
    /signature_invalid/u,
  );
  assert.equal(calls.length, 0);
  const firstResult = await submit(pool, first.input, deps);
  assert.equal(firstResult.replayed, false);
  assert.equal(firstResult.submission.state, "reconcile_required");
  assert.equal(postCount, 1);
  const beforeReplay = calls.length;
  await policy("unreleased");
  failReads = true;
  assert.equal((await submit(pool, first.input, deps)).replayed, true);
  assert.equal(
    calls.length,
    beforeReplay,
    "owned replay before policy, fee or balance requests",
  );
  await assert.rejects(
    submit(
      pool,
      {
        ...first.input,
        funding: { operationId: randomUUID(), reservationId: randomUUID() },
      },
      deps,
    ),
    /submission_conflict/u,
  );
  await policy("active");
  failReads = false;

  const legacy = await preparation("BUY", true);
  await assert.rejects(
    submit(pool, legacy.input, deps),
    /fee_preparation_required/u,
  );
  assert.equal(
    calls.length,
    beforeReplay,
    "legacy raw-cap cannot enter runtime",
  );
  const reparentedUser = randomUUID();
  await pool.query("insert into users(id,is_active) values($1,true)", [
    reparentedUser,
  ]);
  let changedOwner = false;
  try {
    const racedDb = {
      query: (async (sql: string, args: unknown[]) => {
        const result = await pool.query(sql, args);
        if (sql === HIP4_OWNED_ACTION_SQL) {
          await pool.query("update orders set user_id=$2 where id=$1", [
            first.prepared.orderId,
            reparentedUser,
          ]);
          changedOwner = true;
        }
        return result;
      }) as typeof pool.query,
    };
    assert.equal(
      (await readHip4OrderSubmissionAttempt(racedDb, first.input)).prior,
      undefined,
      "ownership change between action and submission reads cannot reveal new-owner submission",
    );
    assert.ok(changedOwner);
    await assert.rejects(
      submit(pool, first.input, deps),
      /preparation_not_found/u,
    );
    assert.equal(calls.length, beforeReplay);
  } finally {
    await pool.query("update orders set user_id=$2 where id=$1", [
      first.prepared.orderId,
      fixture.userId,
    ]);
  }
  const changed = await preparation();
  await pool.query("update user_wallets set is_verified=false where id=$1", [
    fixture.profile.controllerWalletRef,
  ]);
  await assert.rejects(
    submit(pool, changed.input, deps),
    /controller wallet changed/u,
  );
  assert.equal(
    calls.length,
    beforeReplay,
    "unverified owner cannot trigger private provider IO",
  );
  await pool.query("update user_wallets set is_verified=true where id=$1", [
    fixture.profile.controllerWalletRef,
  ]);
  onRead = async () => {
    await pool.query("update user_wallets set is_verified=false where id=$1", [
      fixture.profile.controllerWalletRef,
    ]);
  };
  await assert.rejects(
    submit(pool, changed.input, deps),
    /controller wallet changed/u,
  );
  assert.equal(
    postCount,
    1,
    "ownership change during IO is caught under admission lock",
  );
  await pool.query("update user_wallets set is_verified=true where id=$1", [
    fixture.profile.controllerWalletRef,
  ]);
  assert.equal(
    (await submit(pool, changed.input, deps)).replayed,
    false,
    "ordinary retry after ownership repair",
  );
  const sell = await preparation("SELL");
  assert.equal((await submit(pool, sell.input, deps)).replayed, false);
  assert.ok(calls.includes("userFees"));

  const funded = await preparation();
  const fundingClient = await pool.connect();
  let funding: Awaited<ReturnType<typeof hip4FundedOrderTestFixture>>;
  try {
    await fundingClient.query("begin");
    const tokenId = hip4Identity(
      "mainnet",
      Number(fixture.request.marketId.split(":").at(-1)),
    ).sides[1].tokenId;
    funding = await hip4FundedOrderTestFixture(fundingClient, {
      userId: fixture.userId,
      profile: fixture.profile,
      marketId: fixture.request.marketId,
      tokenId,
    });
    await fundingClient.query("commit");
  } catch (error) {
    await fundingClient.query("rollback");
    throw error;
  } finally {
    fundingClient.release();
  }
  const fundedInput = {
    ...funded.input,
    funding: {
      operationId: funding.operationId,
      reservationId: funding.reservationId,
    },
  };
  const fundedResult = await submit(pool, fundedInput, deps);
  assert.ok(fundedResult.submission.funding_trade_attempt_id);
  const acceptedClient = await pool.connect();
  try {
    await acceptedClient.query("begin");
    // Model a later independently reconciled consumer using the common writer.
    // The runtime under test must NOT do this merely on the ACK above.
    await consumeFundingReservationForLinkedConsumerInTransaction(
      acceptedClient,
      {
        userId: fixture.userId,
        reservationId: funding.reservationId,
        tradeAttemptId: fundedResult.submission.funding_trade_attempt_id,
        consumer: { kind: "web_order", orderId: funded.prepared.orderId },
        outcomeReason: "synthetic_reconciled_consumer",
      },
    );
    await acceptedClient.query("commit");
  } catch (error) {
    await acceptedClient.query("rollback");
    throw error;
  } finally {
    acceptedClient.release();
  }
  assert.equal(
    await fetchFundingConsumerReservationForUser(pool, {
      userId: fixture.userId,
      operationId: funding.operationId,
    }),
    null,
  );
  const beforeFundedReplay = calls.length;
  assert.equal(
    (await submit(pool, fundedInput, deps)).replayed,
    true,
    "consumed funding need not be ready again for replay",
  );
  assert.equal(calls.length, beforeFundedReplay);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from funding_trade_attempts where operation_id=$1",
        [funding.operationId],
      )
    ).rows[0].n,
    1,
  );

  const budgeted = await preparation();
  await pool.query(`insert into pg_temp.hip4_request_budget(scope,admissions)
    values('public-info',jsonb_build_array(jsonb_build_object('at',extract(epoch from clock_timestamp()),'weight',1200)))
    on conflict(scope) do update set admissions=excluded.admissions`);
  const beforeBudget = calls.length;
  await assert.rejects(submit(pool, budgeted.input, deps), /budget_exhausted/u);
  assert.equal(
    calls.length,
    beforeBudget,
    "budget denial precedes any provider request",
  );
  // Simulate passage of the provider's rolling window, not a production clear.
  await pool.query(`update pg_temp.hip4_request_budget set admissions=jsonb_build_array(
    jsonb_build_object('at',extract(epoch from clock_timestamp())-61,'weight',1200))`);
  assert.equal(
    (await submit(pool, budgeted.input, deps)).replayed,
    false,
    "same preparation recovers once the shared request budget becomes available",
  );

  const concurrent = await preparation();
  const beforeConcurrent = postCount;
  const results = await Promise.all([
    submit(pool, concurrent.input, deps),
    submit(pool, concurrent.input, deps),
  ]);
  assert.equal(results.filter((result) => result.replayed).length, 1);
  assert.equal(postCount, beforeConcurrent + 1);
  const raced = await preparation();
  onRead = async () => {
    await submit(pool, raced.input, deps);
    failReads = true;
  };
  assert.equal(
    (await submit(pool, raced.input, deps)).replayed,
    true,
    "bounded re-read recovers a concurrent commit during failed observation",
  );
  failReads = false;

  const cancelClient = await pool.connect();
  let cancelAction: Awaited<ReturnType<typeof cancel>>;
  try {
    await cancelClient.query("begin");
    cancelAction = await cancel(cancelClient, {
      userId: fixture.userId,
      orderId: first.prepared.orderId,
      requestKey: randomUUID(),
      profile: fixture.profile,
      nonce: ++nonce,
      expiresAfter: Date.now() + 60000,
    });
    await cancelClient.query("commit");
  } catch (error) {
    await cancelClient.query("rollback");
    throw error;
  } finally {
    cancelClient.release();
  }
  const cancelTyped = prepareHip4TradeSigning(cancelAction.envelope).typedData;
  const beforeCancel = calls.length;
  await submit(
    pool,
    {
      userId: fixture.userId,
      actionId: cancelAction.actionId,
      actor: "web_app",
      signature: await wallet.signTypedData(
        cancelTyped.domain,
        cancelTyped.types,
        cancelTyped.message,
      ),
    },
    deps,
  );
  assert.deepEqual(
    calls.slice(beforeCancel),
    ["exchange"],
    "cancel needs no balance or fee provider calls",
  );

  await pool.query(
    "update pg_temp.hip4_request_budget set admissions='[]'::jsonb",
  );
  const prepareInput = {
    userId: fixture.userId,
    actor: "web_app" as const,
    request: { ...fixture.request, requestKey: randomUUID() },
  };
  const currentProfile = await readHip4OrderController(pool, {
    userId: fixture.userId,
    controllerWalletRef: fixture.request.controllerWalletRef,
  });
  assert.equal(currentProfile.networkId, "hyperliquid:mainnet");
  assert.deepEqual(currentProfile.signingModes, ["web_client"]);
  const actualPrepared = await runtimePrepare(pool, prepareInput, deps);
  assert.deepEqual(actualPrepared.snapshot.profile, currentProfile);
  assert.equal(
    (actualPrepared.snapshot.amounts as { feeCapRaw: string }).feeCapRaw,
    "0",
  );
  assert.equal(actualPrepared.envelope.vaultAddress, null);
  const prepareCalls = calls.length;
  await policy("unreleased");
  failReads = true;
  await pool.query("update user_wallets set is_verified=false where id=$1", [
    fixture.profile.controllerWalletRef,
  ]);
  assert.deepEqual(
    await runtimePrepare(pool, prepareInput, deps),
    actualPrepared,
    "owned preparation replay does not refresh policies, ownership or provider data",
  );
  await assert.rejects(
    runtimePrepare(
      pool,
      { ...prepareInput, request: { ...prepareInput.request, quantity: "8" } },
      deps,
    ),
    /preparation_conflict/u,
  );
  assert.equal(calls.length, prepareCalls);
  await policy("active");
  await assert.rejects(
    runtimePrepare(
      pool,
      {
        ...prepareInput,
        request: { ...prepareInput.request, requestKey: randomUUID() },
      },
      deps,
    ),
    /controller_unavailable/u,
  );
  assert.equal(
    calls.length,
    prepareCalls,
    "new preparation checks current ownership before provider IO",
  );
  await pool.query("update user_wallets set is_verified=true where id=$1", [
    fixture.profile.controllerWalletRef,
  ]);
  failReads = false;
  for (const invalidAmount of [
    { quantity: "bad" },
    { quantity: "0" },
    { quantity: "0.9" },
    { limitPrice: "bad" },
    { limitPrice: "0" },
    { limitPrice: "1.01" },
    { consentedDebitCapRaw: "bad" },
    { consentedDebitCapRaw: "0" },
  ]) {
    await assert.rejects(
      runtimePrepare(
        pool,
        {
          ...prepareInput,
          request: {
            ...prepareInput.request,
            ...invalidAmount,
            requestKey: randomUUID(),
          },
        },
        deps,
      ),
      /hip4_preparation_/u,
    );
  }
  assert.equal(
    calls.length,
    prepareCalls,
    "invalid amounts do not spend provider budget",
  );

  // Capacity/signing lifetime can expire while fee evidence remains fresh.
  // Use actual PG locks (market and then shared nonce), never a mocked clock.
  const lockerPool = await createIntegrationTestPool({
    max: 1,
    options: "-c statement_timeout=15000",
  });
  try {
    for (const lockTarget of ["market", "nonce"] as const) {
      const locker = await lockerPool.connect();
      const waiting = await pool.connect();
      const request = { ...fixture.request, requestKey: randomUUID() };
      const frozenNonce = ++nonce;
      let pending: Promise<unknown> | undefined;
      try {
        await locker.query("begin");
        if (lockTarget === "market") {
          await locker.query(
            "select id from unified_markets where id=$1 for update",
            [request.marketId],
          );
        } else {
          // An uncommitted, rollback-only competitor holds the exact nonce
          // without holding the controller or market rows being tested.
          const competingActionId = randomUUID();
          await locker.query(
            `insert into hip4_order_actions
              (id,order_id,request_key,request_fingerprint,action_kind,environment,signer_address,
               canonical_market_id,token_id,cloid,nonce,action_fingerprint,unsigned_envelope,preparation_snapshot)
              select $1,order_id,$2,request_fingerprint,'cancelByCloid',environment,signer_address,
                canonical_market_id,token_id,cloid,$3,action_fingerprint,unsigned_envelope,preparation_snapshot
              from hip4_order_actions where id=$4`,
            [
              competingActionId,
              randomUUID(),
              frozenNonce,
              actualPrepared.actionId,
            ],
          );
          await locker.query(
            "insert into hyperliquid_nonce_claims(environment,signer_address,nonce,action_fingerprint,order_action_id) values('mainnet',$1,$2,$3,$4)",
            [
              wallet.address.toLowerCase(),
              frozenNonce,
              "a".repeat(64),
              competingActionId,
            ],
          );
        }
        await waiting.query("begin");
        const waiterPid = (
          await waiting.query("select pg_backend_pid() as pid")
        ).rows[0].pid;
        const expiresAfter = Date.now() + 1000;
        const input = {
          ...fixture,
          request,
          nonce: frozenNonce,
          expiresAfter,
          feeObservation: hip4FeeTestObservation({
            address: wallet.address.toLowerCase(),
            marketId: request.marketId,
            side: "BUY",
          }),
        };
        pending = assert.rejects(
          prepare(waiting, input),
          /hip4_preparation_expired/u,
        );
        let blocked = false;
        for (let poll = 0; poll < 100; poll++) {
          blocked = (
            await locker.query(
              "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
              [waiterPid],
            )
          ).rows[0].blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, `preparation must wait on the ${lockTarget} lock`);
        // Expiry is enforced by PG wall time, not the host/VM clock delta.
        await locker.query(
          "select pg_sleep(greatest(0,($1::numeric-extract(epoch from clock_timestamp())*1000)/1000))",
          [expiresAfter + 5],
        );
        // Rolled-back competing nonce does not conflict, but waiting used up TTL.
        await locker.query("rollback");
        await pending;
        await waiting.query("rollback");
        assert.equal(
          (
            await waiting.query(
              "select count(*)::int as n from hip4_order_actions where request_key=$1",
              [request.requestKey],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await waiting.query(
              "select count(*)::int as n from hyperliquid_nonce_claims where signer_address=$1 and nonce=$2",
              [wallet.address.toLowerCase(), frozenNonce],
            )
          ).rows[0].n,
          0,
        );
        await waiting.query("begin");
        const recovered = await prepare(waiting, {
          ...input,
          expiresAfter: Date.now() + 60000,
        });
        await waiting.query("commit");
        assert.equal(recovered.state, "prepared");
      } finally {
        await locker.query("rollback");
        if (pending) await pending.catch(() => {});
        await waiting.query("rollback");
        waiting.release();
        locker.release();
      }
    }
  } finally {
    await lockerPool.end();
  }
  const actualTyped = prepareHip4TradeSigning(
    actualPrepared.envelope,
  ).typedData;
  assert.equal(
    (
      await submit(
        pool,
        {
          ...first.input,
          actionId: actualPrepared.actionId,
          signature: await wallet.signTypedData(
            actualTyped.domain,
            actualTyped.types,
            actualTyped.message,
          ),
        },
        deps,
      )
    ).replayed,
    false,
  );
  await pool.query(
    "update pg_temp.hip4_request_budget set admissions='[]'::jsonb",
  );
  const prepRaceInput = {
    ...prepareInput,
    request: { ...prepareInput.request, requestKey: randomUUID() },
  };
  const preparedTwice = await Promise.all([
    runtimePrepare(pool, prepRaceInput, deps),
    runtimePrepare(pool, prepRaceInput, deps),
  ]);
  assert.deepEqual(preparedTwice[0], preparedTwice[1]);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from hip4_order_actions where request_key=$1",
        [prepRaceInput.request.requestKey],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    readHip4OrderController(pool, {
      userId: randomUUID(),
      controllerWalletRef: fixture.request.controllerWalletRef,
    }),
    /controller_unavailable/u,
  );
  await pool.query(
    "update user_wallets set wallet_source='embedded',is_internal_wallet=true,privy_wallet_id='synthetic-privy-controller' where id=$1",
    [fixture.profile.controllerWalletRef],
  );
  try {
    const embedded = await readHip4OrderController(pool, {
      userId: fixture.userId,
      controllerWalletRef: fixture.request.controllerWalletRef,
    });
    assert.equal(
      embedded.walletId,
      currentProfile.walletId,
      "same physical owner retains common wallet identity",
    );
    assert.equal(embedded.source, "embedded");
    assert.deepEqual(embedded.signingModes, [
      "web_client",
      "privy_authorization",
    ]);
    await pool.query(
      "update user_wallets set wallet_source='smart' where id=$1",
      [fixture.profile.controllerWalletRef],
    );
    await assert.rejects(
      readHip4OrderController(pool, {
        userId: fixture.userId,
        controllerWalletRef: fixture.request.controllerWalletRef,
      }),
      /controller_unavailable/u,
    );
  } finally {
    await pool.query(
      "update user_wallets set wallet_source='external',is_internal_wallet=false,privy_wallet_id=null where id=$1",
      [fixture.profile.controllerWalletRef],
    );
  }

  // The actual common registry must dispatch native durable ownership before
  // its generic funding wrapper, including replay after consumed funding.
  await pool.query(
    "update pg_temp.hip4_request_budget set admissions='[]'::jsonb",
  );
  const common = createApiTradingApplicationService(
    { pool },
    { hyperliquid: deps },
  );
  const identity = hip4Identity(
    "mainnet",
    Number(fixture.request.marketId.split(":").at(-1)),
  );
  const commonIntent: TradeIntent = {
    actor: { kind: "web_app", userId: fixture.userId },
    venue: "hyperliquid",
    walletAddress: wallet.address,
    walletChain: "ethereum",
    action: "BUY",
    orderType: "IOC",
    amount: { type: "shares", value: fixture.request.quantity },
    idempotencyKey: randomUUID(),
    target: {
      venue: "hyperliquid",
      marketId: fixture.request.marketId,
      venueMarketId: null,
      eventId: null,
      tokenId: identity.sides[1].tokenId,
      outcome: "NO",
      title: null,
    },
    nativeOrder: {
      kind: "hyperliquid_order",
      controllerWalletRef: fixture.request.controllerWalletRef,
      limitPrice: fixture.request.limitPrice,
      consentedDebitCapRaw: fixture.request.consentedDebitCapRaw,
    },
  };
  const ordersBefore = (
    await pool.query("select count(*)::int as n from orders where user_id=$1", [
      fixture.userId,
    ])
  ).rows[0].n;
  const commonQuote = await common.quote({ intent: commonIntent });
  assert.equal(
    commonQuote.price,
    null,
    "legacy floating price is not native authority",
  );
  assert.equal(
    (commonQuote.raw as { amounts: { limitPrice: string } }).amounts.limitPrice,
    "0.33333",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from orders where user_id=$1",
        [fixture.userId],
      )
    ).rows[0].n,
    ordersBefore,
    "quote creates no economic order",
  );
  const commonPrepared = await common.prepareTrade({
    intent: commonIntent,
    quote: commonQuote,
  });
  assert.equal(commonPrepared.authorizationMode, "client_signed_order");
  assert.equal(
    commonPrepared.quote,
    null,
    "caller quote is never persisted as preparation authority",
  );
  const commonRow = (
    await pool.query("select * from hip4_order_actions where id=$1", [
      commonPrepared.preparedId,
    ])
  ).rows[0];
  const commonTyped = prepareHip4TradeSigning(
    commonRow.unsigned_envelope,
  ).typedData;
  assert.deepEqual(commonPrepared.authorizationRequests[0].input, commonTyped);
  const commonSignature = await wallet.signTypedData(
    commonTyped.domain,
    commonTyped.types,
    commonTyped.message,
  );
  const commonFundingDb = await pool.connect();
  let commonFunding: Awaited<ReturnType<typeof hip4FundedOrderTestFixture>>;
  try {
    await commonFundingDb.query("begin");
    commonFunding = await hip4FundedOrderTestFixture(commonFundingDb, {
      userId: fixture.userId,
      profile: currentProfile,
      marketId: fixture.request.marketId,
      tokenId: identity.sides[1].tokenId,
    });
    await commonFundingDb.query("commit");
  } finally {
    await commonFundingDb.query("rollback");
    commonFundingDb.release();
  }
  commonPrepared.intent = {
    ...commonIntent,
    fundingReservation: {
      operationId: commonFunding.operationId,
      reservationId: commonFunding.reservationId,
    },
  };
  const commonSubmitInput = {
    prepared: commonPrepared,
    signatures: [{ id: commonPrepared.preparedId, signature: commonSignature }],
  };
  const beforeAppRequired = calls.length;
  await assert.rejects(
    common.executePreparedTrade({
      ...commonSubmitInput,
      prepared: {
        ...commonPrepared,
        intent: {
          ...commonPrepared.intent,
          actor: { ...commonIntent.actor, kind: "telegram_bot" },
        },
      },
    }),
    /Hunch app/u,
  );
  assert.equal(
    calls.length,
    beforeAppRequired,
    "native bot execution does not read/sign/submit",
  );
  await assert.rejects(
    common.executePreparedTrade({
      ...commonSubmitInput,
      onBeforeBroadcast: () => {
        throw new Error("must not execute a second funding owner");
      },
    }),
    /broadcast-management/u,
  );
  assert.equal(
    calls.length,
    beforeAppRequired,
    "unsupported financial callbacks cannot be silently skipped",
  );
  await pool.query(
    "update pg_temp.hip4_request_budget set admissions='[]'::jsonb",
  );
  const beforeCommonPost = postCount;
  const commonResults = await Promise.all([
    common.executePreparedTrade(commonSubmitInput),
    common.executePreparedTrade(commonSubmitInput),
  ]);
  assert.equal(postCount, beforeCommonPost + 1);
  for (const result of commonResults) {
    assert.equal(result.persisted?.orderId, commonRow.order_id);
    assert.equal(result.persisted?.executionId, null);
    assert.equal(result.effects, null);
    assert.equal(
      result.submitResult.status,
      "submitted",
      "resting ACK does not invent a confirmed execution",
    );
  }
  const commonAttempts = await pool.query(
    "select id from funding_trade_attempts where operation_id=$1",
    [commonFunding.operationId],
  );
  assert.equal(
    commonAttempts.rows.length,
    1,
    "one common attempt, not an adapter plus wrapper claim",
  );
  assert.ok(
    await fetchFundingConsumerReservationForUser(pool, {
      userId: fixture.userId,
      operationId: commonFunding.operationId,
    }),
    "ACK retains funded consumer reservation",
  );
  const completionDb = await pool.connect();
  try {
    await completionDb.query("begin");
    await consumeFundingReservationForLinkedConsumerInTransaction(
      completionDb,
      {
        userId: fixture.userId,
        reservationId: commonFunding.reservationId,
        tradeAttemptId: commonAttempts.rows[0].id,
        consumer: { kind: "web_order", orderId: commonRow.order_id },
        outcomeReason: "synthetic_later_common_reconciliation",
      },
    );
    await completionDb.query("commit");
  } finally {
    await completionDb.query("rollback");
    completionDb.release();
  }
  const beforeCommonReplay = calls.length;
  await policy("unreleased");
  failReads = true;
  assert.equal(
    (await common.submitPreparedTrade(commonSubmitInput)).status,
    "submitted",
  );
  assert.equal(
    (await common.executePreparedTrade(commonSubmitInput)).persisted?.orderId,
    commonRow.order_id,
  );
  assert.equal(
    calls.length,
    beforeCommonReplay,
    "common replay bypasses disabled lifecycle and consumed-funding readiness",
  );
  const callbackFailure = await common.executePreparedTrade({
    ...commonSubmitInput,
    onSubmitted: () => {
      throw new Error("synthetic follow-up failure");
    },
  });
  assert.equal(callbackFailure.persisted?.orderId, commonRow.order_id);
  assert.equal(
    callbackFailure.postSubmitError?.code,
    "post_submit_callback_failed",
  );
  assert.equal(
    calls.length,
    beforeCommonReplay,
    "follow-up callback failure never resends an existing action",
  );
  failReads = false;
  await policy("active");

  await testHip4CommonCancel({
    pool,
    common,
    wallet,
    userId: fixture.userId,
    controllerWalletRef: fixture.request.controllerWalletRef,
    orderId: commonRow.order_id,
    marketId: fixture.request.marketId,
    orderActionId: first.prepared.actionId,
    orderActionOrderId: first.prepared.orderId,
    orderSignature: first.input.signature,
    calls,
  });

  const plans = await pool.connect();
  try {
    await plans.query("begin");
    await plans.query(
      "create temp table user_wallets(like public.user_wallets including defaults including indexes) on commit drop",
    );
    await plans.query(
      "insert into user_wallets select * from public.user_wallets where id=$1",
      [fixture.profile.controllerWalletRef],
    );
    await plans.query(
      "insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,wallet_source,is_internal_wallet,privy_profile_updated_at) select gen_random_uuid(),$1,'0x'||lpad(to_hex(sample_row),40,'0'),'ethereum',true,'external',false,now() from generate_series(1,50000) as sample_row",
      [fixture.userId],
    );
    await plans.query("analyze user_wallets");
    const args = [
      fixture.userId,
      fixture.profile.controllerWalletRef,
      "ethereum",
      false,
      "external",
      null,
      "hyperliquid:mainnet",
      wallet.address.toLowerCase(),
    ];
    await plans.query(
      `prepare controller_lookup(uuid,uuid,text,boolean,text,text,text,text) as ${FUNDING_CONTROLLER_WALLET_SQL}`,
    );
    await plans.query(
      `prepare order_controller_lookup(uuid,uuid) as ${HIP4_ORDER_CONTROLLER_SQL}`,
    );
    for (const mode of ["force_generic_plan", "force_custom_plan"]) {
      await plans.query(`set local plan_cache_mode=${mode}`);
      await assertFundingControllerWallet(
        plans,
        fixture.userId,
        fixture.profile,
      );
      for (const reference of [
        fixture.profile.controllerWalletRef,
        randomUUID(),
      ]) {
        const literals = [args[0], reference, ...args.slice(2)]
          .map((value) =>
            value === null
              ? "null"
              : typeof value === "boolean"
                ? String(value)
                : `'${String(value).replaceAll("'", "''")}'`,
          )
          .join(",");
        const plan = (
          await plans.query(
            `explain(analyze,buffers,format json) execute controller_lookup(${literals})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.doesNotMatch(JSON.stringify(plan), /"Node Type":"Seq Scan"/u);
        console.log("[hip4-order-runtime-plan]", {
          mode,
          hit: reference === fixture.profile.controllerWalletRef,
          ms: plan["Execution Time"],
          buffers: plan.Plan["Local Hit Blocks"],
          rows: plan.Plan["Actual Rows"],
        });
        const profilePlan = (
          await plans.query(
            `explain(analyze,buffers,format json) execute order_controller_lookup('${reference}','${fixture.userId}')`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.doesNotMatch(JSON.stringify(profilePlan), /Seq Scan/u);
        assert.equal(
          profilePlan.Plan["Actual Rows"],
          reference === fixture.profile.controllerWalletRef ? 1 : 0,
        );
        console.log("[hip4-order-controller-plan]", {
          mode,
          ms: profilePlan["Execution Time"],
          buffers: profilePlan.Plan["Local Hit Blocks"],
          rows: profilePlan.Plan["Actual Rows"],
        });
      }
    }
    await plans.query("deallocate controller_lookup");
    await plans.query("deallocate order_controller_lookup");
    await plans.query("rollback");
  } finally {
    await plans.query("rollback");
    plans.release();
  }
  console.log(
    "[hip4-order-runtime] owned early replay, strict server context, max=1 IO, funding, concurrent one-POST, ownership recovery and cancel passed",
  );
} finally {
  for (const id of policyIds)
    await pool.query("delete from runtime_policies where id=$1", [id]);
  await pool.end();
}
