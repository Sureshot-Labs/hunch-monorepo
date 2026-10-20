import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction as prepare } from "./repos/hip4-order-preparation.js";
import { admitHip4OrderActionInTransaction as admit } from "./repos/hip4-order-admission.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { runHip4FinancialReadPass } from "./hip4-account-worker-entry.js";

export async function testHip4ObserverSharedBudget() {
  const pool = await createIntegrationTestPool({
    max: 1,
    options: "-c statement_timeout=15000",
  });
  const wallet = Wallet.createRandom();
  const policyIds: string[] = [];
  const orders: { id: string; body: unknown }[] = [];
  const byCloid = new Map<string, unknown>();
  try {
    const db = await pool.connect();
    try {
      await db.query("begin");
      let original:
        | Awaited<ReturnType<typeof hip4OrderTestFixture>>
        | undefined;
      for (let index = 0; index < 2; index++) {
        const fixture = await hip4OrderTestFixture(
          db,
          wallet.address,
          original && { userId: original.userId, profile: original.profile },
        );
        original ??= fixture;
        fixture.nonce = Date.now() - 10000 + index;
        const prepared = await prepare(db, fixture);
        const signable = prepareHip4TradeSigning(prepared.envelope);
        await admit(
          db,
          {
            userId: fixture.userId,
            actionId: prepared.actionId,
            actor: "web_app",
            signature: await wallet.signTypedData(
              signable.typedData.domain,
              signable.typedData.types,
              signable.typedData.message,
            ),
            context: {
              profile: fixture.profile,
              feeCapRaw: fixture.feeCapRaw,
              capacity: {
                assetId: HYPERCORE_MAINNET_USDC.assetId,
                decimals: 8,
                availableRaw: "15000000000",
                observedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            },
          },
          () => true,
        );
        if (signable.action.type !== "order") throw new Error("fixture");
        const native = signable.action.orders[0];
        const body = {
          status: "order",
          order: {
            status: "open",
            statusTimestamp: fixture.nonce + 100,
            order: {
              coin: `#${native.a - 100000000}`,
              oid: 22345 + index,
              cloid: native.c,
              side: "B",
              limitPx: native.p,
              origSz: native.s,
              sz: native.s,
              timestamp: fixture.nonce + 100,
              reduceOnly: false,
              tif: "Ioc",
              orderType: "Limit",
            },
          },
        };
        orders.push({ id: prepared.actionId, body });
        byCloid.set(native.c, body);
      }
      const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
      lifecycle.venues.hyperliquid = {
        lifecycle: "active",
        indexerMode: "off",
      };
      for (const [key, payload] of [
        [
          "hip4_read",
          {
            environment: "mainnet",
            requestWeightPerMinute: 600,
            // Exercise combined-refresh contention at the SAME global ceiling.
            // Default background reserves correctly split cash/history now,
            // so relying on those defaults no longer reaches this scenario.
            backgroundRequestWeightPerMinute: 600,
            interactiveRequestWeightReserveRatio: 0,
          },
        ],
        [
          "hip4_account",
          {
            workerBatchSize: 2,
            workerIntervalMs: 60000,
            historyRepairPagesPerRefresh: 1,
            ledgerRepairPagesPerRefresh: 1,
          },
        ],
        ["venue_lifecycle", lifecycle],
      ] as const) {
        policyIds.push(
          (
            await db.query(
              "insert into runtime_policies(policy_key,payload,effective_at) values($1,$2,clock_timestamp()) returning id",
              [key, payload],
            )
          ).rows[0].id,
        );
      }
      // Same production SQL, isolated scheduling/budget rows for these fixtures.
      await db.query(
        "create temp table hip4_request_budget(like public.hip4_request_budget including all)",
      );
      await db.query(
        "create temp table hip4_order_submissions(like public.hip4_order_submissions including all)",
      );
      await db.query(
        "insert into hip4_order_submissions select * from public.hip4_order_submissions where action_id=any($1::uuid[])",
        [orders.map((order) => order.id)],
      );
      await db.query(
        "create temp table hip4_account_snapshots(like public.hip4_account_snapshots including all)",
      );
      await db.query(
        "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1)",
        [wallet.address.toLowerCase()],
      );
      await db.query("commit");
    } finally {
      await db.query("rollback");
      db.release();
    }
    const transport: typeof fetch = async (url, options) => {
      assert.equal(url, "https://api.hyperliquid.xyz/info");
      const request = JSON.parse(String(options?.body));
      if (request.user)
        assert.equal(request.user, wallet.address.toLowerCase());
      if (request.type === "orderStatus") {
        assert.ok(byCloid.has(request.oid));
        return Response.json(byCloid.get(request.oid));
      }
      const data: Record<string, unknown> = {
        userRole: { role: "user" },
        userAbstraction: "disabled",
        spotMeta: {
          tokens: [
            {
              name: "USDC",
              tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
              index: 0,
              weiDecimals: 8,
              szDecimals: 8,
            },
          ],
        },
        spotClearinghouseState: {
          balances: [
            {
              coin: "USDC",
              token: 0,
              total: "12.34",
              hold: "0",
              entryNtl: "0",
            },
          ],
        },
        frontendOpenOrders: [],
        userFills: [],
        userNonFundingLedgerUpdates: [],
        userFillsByTime: [],
      };
      assert.ok(request.type in data, request.type);
      return Response.json(data[request.type]);
    };
    const first = await runHip4FinancialReadPass(pool, transport, false);
    assert.equal(first.orderObservation.saved, 2);
    assert.equal(
      first.budgetExhausted,
      0,
      "small successful fill pages settle to20 and no longer exhaust the600 ceiling",
    );
    const firstHistory = (
      await pool.query(
        "select history from hip4_account_snapshots where account_address=$1",
        [wallet.address.toLowerCase()],
      )
    ).rows[0].history;
    assert.equal(firstHistory.fillRepair.lastError, null);
    assert.ok(firstHistory.fillRepair.lastSuccessAt);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from hip4_order_submissions where fills_observation->'repair'->>'lastSuccessAt' is not null",
        )
      ).rows[0].n,
      2,
    );
    // Advance only this session's clock fixtures, rather than sleeping a minute.
    assert.equal(
      (await pool.query("select count(*)::int as n from hip4_request_budget"))
        .rows[0].n,
      1,
    );
    await pool.query(
      "update hip4_request_budget set admissions='[]' where scope='public-info'",
    );
    await pool.query(
      "update hip4_account_snapshots set attempt_at=statement_timestamp()-interval '1 day' where account_address=$1",
      [wallet.address.toLowerCase()],
    );
    await pool.query(
      `update hip4_order_submissions set reconcile_after='-infinity',
        fills_observation=jsonb_set(fills_observation,'{repair,lastAttemptAt}',to_jsonb($2::text))
        where action_id=any($1::uuid[])`,
      [
        orders.map((order) => order.id),
        new Date(Date.now() - 60000).toISOString(),
      ],
    );
    const second = await runHip4FinancialReadPass(pool, transport, true);
    assert.equal(second.updated, 1);
    const secondHistory = (
      await pool.query(
        "select history from hip4_account_snapshots where account_address=$1",
        [wallet.address.toLowerCase()],
      )
    ).rows[0].history;
    assert.ok(secondHistory.fillRepair.lastSuccessAt);
    assert.equal(secondHistory.fillRepair.lastError, null);
    assert.equal(second.orderObservation.budgetExhausted, 0);
    const weight = (
      await pool.query(
        "select sum((entry->>'weight')::int)::int as weight from hip4_request_budget cross join lateral jsonb_array_elements(admissions) entry",
      )
    ).rows[0].weight;
    assert.ok(weight <= 600);
    console.log(
      "[hip4-observer-budget] settled small fill pages advance both histories at600/min without changing provider budget",
    );
  } finally {
    if (policyIds.length)
      await pool.query(
        "delete from runtime_policies where id=any($1::uuid[])",
        [policyIds],
      );
    if (orders.length)
      await pool.query(
        "update public.hip4_order_submissions set reconcile_after='infinity' where action_id=any($1::uuid[])",
        [orders.map((order) => order.id)],
      );
    await pool.end();
  }
}
