// @requires-db — explicit disposable PG16, ephemeral offline key, mocked IO only.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, hip4Identity } from "@hunch/shared";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { FUNDING_POLICY_KEY } from "./funding/policies/funding-policy.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  persistHip4OrderPreparationInTransaction,
  persistHip4CancelPreparationInTransaction,
} from "./repos/hip4-order-preparation.js";
import { readHip4OrderHoldRaw } from "./repos/hip4-order-holds.js";
import {
  HIP4_NATIVE_ORDER_READ_FACTS,
  HIP4_NATIVE_ORDER_READ_JOINS,
} from "./repos/hip4-native-order-read.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { submitHip4OrderWithCurrentContext } from "./services/hip4-order-runtime.js";
import { recheckHip4OwnedOrder } from "./services/hip4-owned-order-recheck.js";

// One isolated owned schema lets a second session contend on actual owner rows.
// Only the named copied fixture relations are used; no public fixture writes.
const schemaName = `hip4_fast_${randomUUID().replaceAll("-", "")}`;
assert.match(schemaName, /^hip4_fast_[a-f0-9]{32}$/u);
const pool = await createIntegrationTestPool({
  max: 1,
  options: `-c search_path=${schemaName},public -c statement_timeout=15000 -c lock_timeout=2000`,
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("external IO forbidden in fast-confirmation test");
};
const fixtureTables = [
  "runtime_policies",
  "users",
  "user_wallets",
  "unified_events",
  "unified_markets",
  "unified_tokens",
  "orders",
  "hip4_order_actions",
  "hip4_order_submissions",
  "hyperliquid_nonce_claims",
  "hip4_account_snapshots",
  "hip4_account_positions",
  "hip4_account_executions",
  "hip4_account_ledger",
  "hip4_request_budget",
  "funding_quotes",
  "funding_operations",
  "funding_operation_segments",
  "funding_operation_steps",
  "funding_operation_step_attempts",
  "funding_provider_requests",
  "funding_observations",
  "funding_step_receipt_observations",
  "funding_reconciliation_jobs",
  "funding_trade_attempts",
  "funding_receive_sessions",
  "funding_receive_receipts",
  "balance_reservations",
  "telegram_trade_intents",
  "telegram_funding_authorization_reservations",
] as const;
type Mode =
  | "filled"
  | "failed_status"
  | "slow_status"
  | "slow_fill"
  | "budget_denied"
  | "unknown_oid"
  | "missing_fills"
  | "full_page"
  | "rejected";

async function scenario(initialMode: Mode) {
  // Each synthetic purchase owns an isolated user/account and budget window.
  await pool.query("update hip4_request_budget set admissions='[]'::jsonb");
  const wallet = Wallet.createRandom();
  const setup = await tx(pool, async (db) => {
    const fixture = await hip4OrderTestFixture(db, wallet.address);
    fixture.nonce = Date.now() - 5000;
    fixture.request.limitPrice = "0.3";
    fixture.request.quantity = "4";
    const prepared = await persistHip4OrderPreparationInTransaction(db, {
      ...fixture,
      feeObservation: hip4FeeTestObservation({
        address: fixture.profile.address,
        marketId: fixture.request.marketId,
        side: "BUY",
      }),
    });
    const identity = hip4Identity(
      "mainnet",
      Number(fixture.request.marketId.split(":").at(-1)),
    );
    const funding = await hip4FundedOrderTestFixture(db, {
      userId: fixture.userId,
      profile: fixture.profile,
      marketId: fixture.request.marketId,
      tokenId: identity.sides[1].tokenId,
    });
    return { fixture, prepared, funding, identity };
  });
  const { fixture, prepared, funding, identity } = setup;
  const signing = prepareHip4TradeSigning(prepared.envelope);
  assert.equal(signing.action.type, "order");
  if (signing.action.type !== "order") throw new Error("fixture action");
  const wire = signing.action.orders[0];
  assert.equal(wire.s, "4", "synthetic exact fill must match prepared size");
  const typed = signing.typedData;
  const input = {
    userId: fixture.userId,
    actionId: prepared.actionId,
    actor: "web_app" as const,
    signature: await wallet.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    ),
    funding: {
      operationId: funding.operationId,
      reservationId: funding.reservationId,
    },
  };
  let mode = initialMode;
  let exchangeCalls = 0;
  let exchangeAt = 0;
  let abortedAt = 0;
  let beforeStatus: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const oid = randomInt(1_000_000_000, 10_000_000_000);
  const fill = (tid: number, fee: string) => ({
    coin: identity.sides[1].coin,
    px: wire.p,
    sz: "2",
    side: "B",
    time: fixture.nonce + 100 + tid,
    startPosition: "0",
    dir: "Buy",
    closedPnl: "0",
    hash: `0x${"23".repeat(32)}`,
    oid,
    crossed: true,
    fee,
    tid,
    cloid: wire.c,
    feeToken: "USDC",
    twapId: null,
  });
  const waitForAbort = async (signal: AbortSignal | null | undefined) => {
    assert.ok(signal, "fast observer transport must be abortable");
    await new Promise<never>((_resolve, reject) => {
      const rejectAborted = () => {
        abortedAt = Date.now();
        reject(signal.reason);
      };
      if (signal.aborted) rejectAborted();
      else signal.addEventListener("abort", rejectAborted, { once: true });
    });
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    const request = JSON.parse(String(init?.body));
    if (url === "https://api.hyperliquid.xyz/exchange") {
      exchangeCalls++;
      requests.push("exchange");
      exchangeAt = Date.now();
      assert.ok(request.signature);
      const durable = (
        await pool.query(
          `select submission_row.state from hip4_order_submissions submission_row
           join hip4_order_actions action_row on action_row.id=submission_row.action_id
           where action_row.order_id=$1 and action_row.action_kind=$2`,
          [prepared.orderId, request.action.type],
        )
      ).rows[0];
      assert.equal(durable.state, "submission_started");
      if (mode === "budget_denied")
        await pool.query(`insert into hip4_request_budget(scope,admissions)
          values('public-info',jsonb_build_array(jsonb_build_object('at',extract(epoch from clock_timestamp()),'weight',1200)))
          on conflict(scope) do update set admissions=excluded.admissions`);
      return Response.json({
        status: "ok",
        response: {
          type: request.action.type === "order" ? "order" : "cancel",
          data: {
            statuses: [
              request.action.type !== "order"
                ? "success"
                : mode === "rejected"
                  ? {
                      error:
                        "Order could not immediately match against any resting orders.",
                    }
                  : {
                      filled: {
                        oid,
                        totalSz: wire.s,
                        avgPx: wire.p,
                        cloid: wire.c,
                      },
                    },
            ],
          },
        },
      });
    }
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    requests.push(request.type);
    if (request.user) assert.equal(request.user, fixture.profile.address);
    // A provider read must not retain the only pooled DB connection.
    assert.ok((await pool.query("select 1 as available")).rows[0].available);
    if (request.type === "orderStatus") {
      await beforeStatus?.();
      assert.equal(request.oid, prepared.cloid);
      if (mode === "failed_status") throw new Error("synthetic status failure");
      if (mode === "slow_status") await waitForAbort(init?.signal);
      if (mode === "slow_fill")
        await new Promise((resolve) => setTimeout(resolve, 1800));
      if (mode === "unknown_oid")
        return Response.json({ status: "unknownOid" });
      return Response.json({
        status: "order",
        order: {
          status: "filled",
          statusTimestamp: fixture.nonce + 300,
          order: {
            coin: identity.sides[1].coin,
            oid,
            cloid: wire.c,
            side: "B",
            limitPx: wire.p,
            sz: "0",
            origSz: wire.s,
            timestamp: fixture.nonce + 100,
            orderType: "Limit",
            reduceOnly: false,
            tif: "Ioc",
          },
        },
      });
    }
    if (request.type === "userFillsByTime") {
      assert.equal(request.startTime, fixture.nonce);
      assert.equal(request.aggregateByTime, false);
      if (mode === "slow_fill") await waitForAbort(init?.signal);
      if (mode === "missing_fills") return Response.json([]);
      if (mode === "full_page")
        return Response.json(
          Array.from({ length: 2000 }, (_, index) => ({
            ...fill(index + 1, "0"),
            coin: "#1",
            time: fixture.nonce + 200,
          })),
        );
      return Response.json([fill(1, "0.00000001"), fill(2, "-0.00000002")]);
    }
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
          { coin: "USDC", token: 0, total: "100", hold: "0", entryNtl: "0" },
        ],
      },
      outcomeMeta: {
        outcomes: [
          {
            outcome: identity.outcome,
            name: "Synthetic fast confirmation",
            description: "Synthetic fast confirmation",
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
    assert.ok(
      Object.hasOwn(responses, request.type),
      `unexpected info type ${request.type}`,
    );
    return Response.json(responses[request.type]);
  };
  const read = async () =>
    (
      await pool.query(
        `select o.status,o.filled_size::text,${HIP4_NATIVE_ORDER_READ_FACTS} as native_order
       from orders o ${HIP4_NATIVE_ORDER_READ_JOINS} where o.id=$1 and o.user_id=$2`,
        [prepared.orderId, fixture.userId],
      )
    ).rows[0];
  const submission = async () =>
    (
      await pool.query(
        `select submission_row.state,submission_row.reconcile_error,
        submission_row.reconcile_lease_token,submission_row.reconcile_lease_until,attempt_row.state as attempt_state,
        reservation_row.state as reservation_state
       from hip4_order_submissions submission_row
       join funding_trade_attempts attempt_row on attempt_row.id=submission_row.funding_trade_attempt_id
       join balance_reservations reservation_row on reservation_row.id=attempt_row.reservation_id
       where submission_row.action_id=$1`,
        [prepared.actionId],
      )
    ).rows[0];
  const nativeHold = () =>
    readHip4OrderHoldRaw(
      pool,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
    );
  const assertExact = async () => {
    const row = await read();
    const saved = await submission();
    assert.equal(
      row.status,
      "filled",
      JSON.stringify({ row, saved, requests }),
    );
    assert.equal(Number(row.filled_size), 4);
    assert.equal(row.native_order.terminalConfirmed, true);
    assert.equal(row.native_order.fullQuantityObserved, true);
    assert.deepEqual(row.native_order.executionSummary, {
      version: 1,
      source: "hyperliquid_user_fills",
      quantity: "4",
      grossNotional: "1.2",
      fee: "-0.00000001",
      feeToken: "USDC",
      netQuoteCash: "-1.19999999",
      executionCount: 2,
      fullQuantityObserved: true,
    });
    assert.equal(saved.reconcile_error, null);
    assert.equal(saved.reconcile_lease_token, null);
    assert.equal(saved.attempt_state, "accepted");
    assert.equal(saved.reservation_state, "consumed");
    assert.equal(
      Number(
        (
          await pool.query(
            "select count(*) as execution_count from hip4_account_executions where account_address=$1",
            [fixture.profile.address],
          )
        ).rows[0].execution_count,
      ),
      2,
    );
  };
  const assertPending = async (consumerPending: boolean) => {
    const row = await read();
    assert.notEqual(
      row.status,
      "filled",
      "summary ACK cannot create executions",
    );
    assert.equal(row.native_order.executionSummary, null);
    assert.equal(row.native_order.fullQuantityObserved, false);
    const saved = await submission();
    assert.equal(saved.state, "reconcile_required");
    if (saved.reconcile_lease_token !== null)
      assert.ok(
        Date.parse(saved.reconcile_lease_until) <= Date.now(),
        "optional lease cannot outlive the response deadline",
      );
    if (consumerPending) {
      assert.equal(saved.attempt_state, "ambiguous");
      assert.equal(saved.reservation_state, "active");
    }
    assert.ok(
      (await nativeHold()) > 0n,
      "missing observations cannot drop the native debit hold",
    );
  };
  return {
    ...setup,
    wallet,
    input,
    requests,
    fetcher,
    read,
    submission,
    nativeHold,
    assertExact,
    assertPending,
    setMode: (next: Mode) => {
      mode = next;
    },
    exchangeCalls: () => exchangeCalls,
    exchangeAt: () => exchangeAt,
    abortedAt: () => abortedAt,
    onStatus: (hook: () => Promise<void>) => {
      beforeStatus = hook;
    },
    submit: (runtimePool: Pool = pool) =>
      submitHip4OrderWithCurrentContext(runtimePool, input, { fetcher }),
    recover: () => recheckHip4OwnedOrder(pool, input, fetcher),
  };
}

try {
  assert.match(
    (await pool.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  // Fixed allowlist and read-only existence preflight before fixture DDL.
  const present = await pool.query(
    "select fixture_name,to_regclass('public.'||fixture_name) is not null as present from unnest($1::text[]) fixture_scope(fixture_name)",
    [fixtureTables],
  );
  assert.equal(present.rows.length, fixtureTables.length);
  assert.ok(
    present.rows.every((row) => row.present),
    "fixture schema must be migrated first",
  );
  assert.equal(
    (
      await pool.query("select to_regnamespace($1) as existing_schema", [
        schemaName,
      ])
    ).rows[0].existing_schema,
    null,
  );
  await pool.query(`create schema ${schemaName}`);
  for (const table of fixtureTables)
    await pool.query(
      `create table ${schemaName}.${table}(like public.${table} including all)`,
    );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "off" };
  for (const [key, payload] of [
    ["venue_lifecycle", lifecycle],
    ["hip4_read", {}],
    // A larger normal repair quota proves submit's independent one-page cap.
    ["hip4_account", { historyRepairPagesPerRefresh: 4 }],
    ["hip4_trading", {}],
  ] as const)
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values($1,clock_timestamp()-interval '1 second',$2)",
      [key, payload],
    );

  const fast = await scenario("filled");
  const result = await fast.submit();
  assert.equal(result.replayed, false);
  assert.equal(result.submission.state, "reconcile_required");
  assert.equal(fast.exchangeCalls(), 1);
  assert.equal(
    fast.requests.filter((type) => type === "orderStatus").length,
    1,
  );
  assert.equal(
    fast.requests.filter((type) => type === "userFillsByTime").length,
    1,
  );
  await fast.assertExact();
  // No worker is imported, ticked, waited for or used to complete these facts.
  const beforeReplay = [...fast.requests];
  assert.equal((await fast.submit()).replayed, true);
  assert.deepEqual(
    fast.requests,
    beforeReplay,
    "owned replay has no provider IO",
  );
  assert.equal(fast.exchangeCalls(), 1);
  await fast.assertExact();

  for (const mode of [
    "failed_status",
    "slow_status",
    "slow_fill",
    "budget_denied",
  ] as const) {
    const current = await scenario(mode);
    const ack = await current.submit();
    assert.equal(ack.replayed, false, `${mode}: ACK remains successful`);
    assert.equal(ack.submission.state, "reconcile_required");
    assert.equal(current.exchangeCalls(), 1);
    await current.assertPending(mode !== "slow_fill");
    if (mode === "slow_status" || mode === "slow_fill") {
      assert.ok(
        current.abortedAt() > 0,
        `${mode}: transport reached the abort deadline`,
      );
      assert.ok(current.abortedAt() - current.exchangeAt() >= 2500);
      assert.ok(
        current.abortedAt() - current.exchangeAt() < 5000,
        `${mode}: status and fills share one 3-second budget, not one each`,
      );
    }
    if (mode === "budget_denied")
      assert.equal(
        current.requests.includes("orderStatus"),
        false,
        "budget rejects before provider IO",
      );
    const pendingRequests = [...current.requests];
    assert.equal((await current.submit()).replayed, true);
    assert.deepEqual(
      current.requests,
      pendingRequests,
      "failed observation never replays IO",
    );
    current.setMode("filled");
    await pool.query("update hip4_request_budget set admissions='[]'::jsonb");
    // Explicit repair bypasses the future housekeeping schedule, not the lease.
    await current.recover();
    await current.assertExact();
    assert.equal(
      current.exchangeCalls(),
      1,
      "recovery cannot post another purchase",
    );
  }

  for (const mode of ["unknown_oid", "missing_fills", "full_page"] as const) {
    const current = await scenario(mode);
    await current.submit();
    await current.assertPending(mode === "unknown_oid");
    assert.equal(current.exchangeCalls(), 1);
    assert.ok(
      current.requests.filter((type) => type === "userFillsByTime").length <= 1,
      "even a saturated page cannot grow the fast lane beyond one fill page",
    );
    if (mode !== "full_page") {
      current.setMode("filled");
      await current.recover();
      await current.assertExact();
    }
    assert.equal(current.exchangeCalls(), 1);
  }

  const rejected = await scenario("rejected");
  assert.equal((await rejected.submit()).submission.state, "rejected");
  assert.equal(rejected.requests.includes("orderStatus"), false);
  assert.equal(rejected.requests.includes("userFillsByTime"), false);
  assert.equal(await rejected.nativeHold(), 0n);

  for (const contention of [
    "funding_policy",
    "owner",
    "pool",
    "persist_policy",
    "persist_owner",
  ] as const) {
    const current = await scenario("filled");
    const holders = await createIntegrationTestPool({
      max: 1,
      options: `-c search_path=${schemaName},public -c statement_timeout=10000`,
    });
    let holder: PoolClient | undefined;
    let pooledHolder: Promise<PoolClient> | undefined;
    let armed = false;
    let blocked = false;
    const lockHolder = async () => {
      holder = await holders.connect();
      await holder.query("begin");
      if (contention === "funding_policy" || contention === "persist_policy")
        await holder.query("select pg_advisory_xact_lock(hashtext($1))", [
          FUNDING_POLICY_KEY,
        ]);
      else
        await holder.query("select id from users where id=$1 for update", [
          current.fixture.userId,
        ]);
    };
    if (contention.startsWith("persist_"))
      current.onStatus(async () => {
        blocked = true;
        await lockHolder();
      });
    const runtimePool = new Proxy(pool, {
      get(target, property) {
        if (property === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === "query")
                  return async (text: string, values?: unknown[]) => {
                    const result = await connection.query(text, values);
                    if (
                      /^commit$/iu.test(text) &&
                      current.exchangeCalls() === 1 &&
                      !blocked &&
                      !contention.startsWith("persist_")
                    ) {
                      blocked = true;
                      if (contention === "pool") armed = true;
                      else {
                        await lockHolder();
                      }
                    }
                    return result;
                  };
                if (key === "release")
                  return (discard?: boolean) => {
                    connection.release(discard);
                    if (armed) {
                      armed = false;
                      pooledHolder = target.connect();
                    }
                  };
                const value = Reflect.get(connection, key);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const ack = await current.submit(runtimePool);
      const elapsed = Date.now() - current.exchangeAt();
      assert.equal(ack.submission.state, "reconcile_required");
      assert.ok(blocked, "contention begins only after durable ACK commit");
      assert.ok(
        elapsed < 3500,
        `${contention}: optional confirmation exceeded its absolute deadline (${elapsed}ms)`,
      );
      assert.equal(current.exchangeCalls(), 1);
      assert.deepEqual(
        current.requests.slice(current.requests.indexOf("exchange")),
        contention.startsWith("persist_")
          ? ["exchange", "orderStatus"]
          : ["exchange"],
        "blocked fast work cannot reach provider IO",
      );
      if (holder) {
        await holder.query("rollback");
        holder.release();
        holder = undefined;
      }
      if (pooledHolder) {
        (await pooledHolder).release();
        pooledHolder = undefined;
      }
      // Queue behind any late acquisition: it must release without claiming/IO.
      await pool.query("select 1");
      await current.assertPending(true);
      current.onStatus(async () => {});
      await current.recover();
      await current.assertExact();
      assert.equal(current.exchangeCalls(), 1);
      const settings = (
        await pool.query(
          "select current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout",
        )
      ).rows[0];
      assert.deepEqual(
        settings,
        { statement_timeout: "15s", lock_timeout: "2s" },
        "fast SET LOCAL deadlines cannot leak into ordinary repair",
      );
      console.log(
        JSON.stringify({
          fastContention: contention,
          elapsedMs: elapsed,
          exchangeCalls: 1,
          ordinaryRecovery: "exact",
        }),
      );
    } finally {
      if (holder) {
        await holder.query("rollback");
        holder.release();
      }
      if (pooledHolder) (await pooledHolder).release();
      await holders.end();
    }
  }

  // A normal cancellation still uses the ordinary one-shot exchange path;
  // this new post-submit observation must not run for cancel acknowledgments.
  const cancellation = await tx(pool, (db) =>
    persistHip4CancelPreparationInTransaction(db, {
      userId: fast.fixture.userId,
      requestKey: randomUUID(),
      orderId: fast.prepared.orderId,
      profile: fast.fixture.profile,
      nonce: Date.now(),
      expiresAfter: Date.now() + 60000,
    }),
  );
  const cancelTyped = prepareHip4TradeSigning(cancellation.envelope).typedData;
  const beforeCancelStatus = fast.requests.filter(
    (type) => type === "orderStatus",
  ).length;
  const cancelResult = await submitHip4OrderWithCurrentContext(
    pool,
    {
      userId: fast.fixture.userId,
      actionId: cancellation.actionId,
      actor: "web_app",
      signature: await fast.wallet.signTypedData(
        cancelTyped.domain,
        cancelTyped.types,
        cancelTyped.message,
      ),
    },
    { fetcher: fast.fetcher },
  );
  assert.equal(cancelResult.replayed, false);
  assert.equal(
    cancelResult.submission.reply_summary?.kind,
    "cancel_acknowledged",
  );
  assert.equal(
    fast.exchangeCalls(),
    2,
    "one original mocked order and one explicit mocked cancellation",
  );
  assert.equal(
    fast.requests.filter((type) => type === "orderStatus").length,
    beforeCancelStatus,
  );
  console.log(
    "[hip4-fast-confirmation] exact pre-return fees/fills, one POST, no-IO replay, shared deadline, budget/error recovery, one-page cap, unknown evidence and cancel/rejection exclusions passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  const owned = (
    await pool.query(
      "select tablename from pg_tables where schemaname=$1 order by tablename",
      [schemaName],
    )
  ).rows.map((row) => row.tablename);
  if (owned.length) {
    assert.deepEqual(
      owned,
      [...fixtureTables].sort(),
      "cleanup may drop only this run's exact fixture table allowlist",
    );
    await pool.query(`drop schema ${schemaName} cascade`);
  }
  await pool.end();
}
