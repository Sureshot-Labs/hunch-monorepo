// @requires-db — disposable PG16, ephemeral OFFLINE signer, in-memory HTTP only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { HIP4_EXACT_REJECTION_PROOF_SQL } from "./funding/persistence/funding-trade-attempt-repository.js";
import {
  persistHip4OrderPreparationInTransaction as prepare,
  persistHip4CancelPreparationInTransaction as cancel,
} from "./repos/hip4-order-preparation.js";
import {
  admitHip4OrderActionInTransaction as productionAdmit,
  HIP4_OWNED_SUBMISSION_SQL,
  type Hip4AdmissionContext,
} from "./repos/hip4-order-admission.js";
import {
  HIP4_ORDER_HOLDS_SQL,
  HIP4_FUNDING_CASH_HOLDS_SQL,
  HIP4_ACTIVE_ORDER_EXPOSURE_SQL,
  readHip4OrderHoldRaw,
} from "./repos/hip4-order-holds.js";
import {
  recordHip4SubmissionReplyInTransaction as recordReply,
  submitHip4OrderAction,
} from "./services/hip4-order-submission.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { readHip4TradingPolicy } from "./repos/hip4-trading-policy.js";
import { HIP4_ORDER_RECOVERY_SQL } from "./repos/hip4-order-recovery.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { fetchUserFinancialLifecycleSummary } from "./services/user-financial-lifecycle.js";
import {
  FundingMergeConflictError,
  mergeUsers,
} from "./admin-merge-user-core.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
const wallet = Wallet.createRandom();
// Simulate future implementation support without changing production's shared
// HIP ceiling. Actual lifecycle modes still use the common capability matrix.
const testCapability: typeof venueHasLifecycleCapability = (
  policy,
  _venue,
  capability,
) =>
  venueHasLifecycleCapability(
    {
      ...policy,
      venues: { ...policy.venues, polymarket: policy.venues.hyperliquid },
    },
    "polymarket",
    capability,
  );
const admit = (
  db: Parameters<typeof productionAdmit>[0],
  input: Parameters<typeof productionAdmit>[1],
) => productionAdmit(db, input, testCapability);
let policyId: string | undefined;
const temporaryTradingPolicyIds: string[] = [];
let policyOrdinal = 0;
async function policy(lifecycle: "active" | "exit-only" | "unreleased") {
  const payload = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  payload.venues.hyperliquid = { lifecycle, indexerMode: "off" };
  return (
    await client.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',now()-interval '1 millisecond'+$2::int*interval '1 microsecond',$1::jsonb) returning id",
      [payload, ++policyOrdinal],
    )
  ).rows[0].id as string;
}
async function signed(action: Awaited<ReturnType<typeof prepare>>) {
  const { typedData } = prepareHip4TradeSigning(action.envelope);
  return wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  );
}
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await client.query("savepoint expected_failure");
  await assert.rejects(work, pattern);
  await client.query("rollback to savepoint expected_failure");
}
try {
  await client.query("begin");
  assert.match(
    (await client.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await policy("active");
  const fixture = await hip4OrderTestFixture(client, wallet.address);
  fixture.nonce -= 5000;
  const prepared = await prepare(client, fixture);
  const context: Hip4AdmissionContext = {
    profile: fixture.profile,
    feeCapRaw: fixture.feeCapRaw,
    capacity: {
      assetId: HYPERCORE_MAINNET_USDC.assetId,
      decimals: 8,
      availableRaw: "150000000",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  const input = {
    userId: fixture.userId,
    actionId: prepared.actionId,
    signature: await signed(prepared),
    actor: "web_app",
    context,
  };
  assert.ok(context.capacity);
  const capacity = context.capacity;
  await client.query("savepoint cancel_only_lifecycle");
  const lifecycleSummary = () =>
    fetchUserFinancialLifecycleSummary(client, [fixture.userId]);
  assert.equal((await lifecycleSummary()).activeMovement, false);
  const cancelOnly = await cancel(client, {
    userId: fixture.userId,
    requestKey: randomUUID(),
    orderId: prepared.orderId,
    profile: fixture.profile,
    nonce: fixture.nonce + 1,
    expiresAfter: fixture.expiresAfter,
  });
  const cancelOnlyInput = {
    ...input,
    actionId: cancelOnly.actionId,
    signature: await signed(cancelOnly),
  };
  await admit(client, cancelOnlyInput);
  assert.equal(
    (await lifecycleSummary()).activeMovement,
    false,
    "ambiguous cancellation of an unsigned order cannot create exposure",
  );
  assert.equal((await lifecycleSummary()).protectedEvidence, true);
  await recordReply(client, {
    ...cancelOnlyInput,
    body: {
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    },
  });
  assert.equal((await lifecycleSummary()).activeMovement, false);
  await admit(client, input);
  assert.ok(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
    "an old cancel ACK does not close a newly admitted initial order",
  );
  await recordReply(client, {
    ...input,
    body: {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order has insufficient spot balance to trade" }],
        },
      },
    },
  });
  assert.equal(
    (await lifecycleSummary()).activeMovement,
    false,
    "rejected initial order plus successful cancellation is not live exposure",
  );
  await client.query("rollback to savepoint cancel_only_lifecycle");
  await client.query("savepoint trading_policy_cases");
  const defaultTradingPolicy = await readHip4TradingPolicy(client);
  assert.equal(defaultTradingPolicy.minimumBuyNotionalUsd, "1.00");
  await client.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('hip4_trading',now()+interval '1 day',$1::jsonb)",
    [{ minimumBuyNotionalUsd: "1000" }],
  );
  assert.deepEqual(
    await readHip4TradingPolicy(client),
    defaultTradingPolicy,
    "future policy does not apply early",
  );
  const thresholdId = (
    await client.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('hip4_trading',now()-interval '1 millisecond',$1::jsonb) returning id",
      [{ minimumBuyNotionalUsd: "2" }],
    )
  ).rows[0].id;
  await rejects(() => admit(client, input), /current_amounts_invalid/u);
  assert.deepEqual(
    await prepare(client, { ...fixture, feeCapRaw: null }),
    prepared,
    "prepared replay survives raised policy and unavailable fees",
  );
  await rejects(
    () =>
      prepare(client, {
        ...fixture,
        nonce: fixture.nonce + 17,
        request: { ...fixture.request, requestKey: randomUUID() },
      }),
    /buy_below_minimum/u,
  );
  await client.query(
    "update runtime_policies set payload=$2::jsonb where id=$1",
    [thresholdId, { minimumBuyNotionalUsd: "0" }],
  );
  await rejects(() => admit(client, input), /trading_policy_invalid/u);
  assert.deepEqual(
    await prepare(client, fixture),
    prepared,
    "invalid new-order policy cannot hide an owned replay",
  );
  await client.query("rollback to savepoint trading_policy_cases");
  assert.deepEqual(
    await readHip4TradingPolicy(client),
    defaultTradingPolicy,
    "corrected policy recovers without cache reset",
  );
  await rejects(() => productionAdmit(client, input), /lifecycle_disabled/u);
  await rejects(
    () => admit(client, { ...input, actor: "telegram_bot" }),
    /client_submission_required/u,
  );
  await rejects(
    () => admit(client, { ...input, actor: "worker" }),
    /client_submission_required/u,
  );
  await rejects(
    () => admit(client, { ...input, signature: `0x${"00".repeat(65)}` }),
    /signature_invalid/u,
  );
  await rejects(
    () =>
      admit(client, {
        ...input,
        context: { ...context, feeCapRaw: "1000000000" },
      }),
    /current_amounts_invalid/u,
  );
  await rejects(
    () => admit(client, { ...input, context: { ...context, capacity: null } }),
    /capacity_unavailable/u,
  );
  await client.query("savepoint policy_change");
  await policy("exit-only");
  await rejects(() => admit(client, input), /lifecycle_disabled/u);
  await client.query("rollback to savepoint policy_change");
  await rejects(
    () =>
      client.query(
        `insert into hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,debit_asset_id)
    values($1,$2,'{}',$3,$4)`,
        [
          prepared.actionId,
          "a".repeat(64),
          wallet.address.toLowerCase(),
          HYPERCORE_MAINNET_USDC.assetId,
        ],
      ),
    /hip4_submission_complete_debit_check/u,
  );
  await client.query("savepoint funded_slice");
  const tokenId = (
    await client.query("select token_id from hip4_order_actions where id=$1", [
      prepared.actionId,
    ])
  ).rows[0].token_id;
  const funding = await hip4FundedOrderTestFixture(client, {
    userId: fixture.userId,
    profile: fixture.profile,
    marketId: fixture.request.marketId,
    tokenId,
  });
  await rejects(
    () =>
      admit(client, {
        ...input,
        context: { ...context, capacity: { ...capacity, availableRaw: "0" } },
        funding,
      }),
    /capacity_reserved/u,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as n from funding_trade_attempts where operation_id=$1",
        [funding.operationId],
      )
    ).rows[0].n,
    0,
    "failed admission rolls back funding claim and start",
  );
  // Same user, wrong physical destination wallet: failure must not steal its reservation.
  const otherWalletRef = randomUUID();
  await client.query(
    `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,wallet_source,is_internal_wallet,privy_profile_updated_at)
    values($1,$2,'0x2222222222222222222222222222222222222222','ethereum',true,'external',false,now())`,
    [otherWalletRef, fixture.userId],
  );
  const wrongWalletFunding = await hip4FundedOrderTestFixture(client, {
    userId: fixture.userId,
    profile: {
      ...fixture.profile,
      walletId: otherWalletRef,
      controllerWalletRef: otherWalletRef,
      address: "0x2222222222222222222222222222222222222222",
    },
    marketId: fixture.request.marketId,
    tokenId,
  });
  await rejects(
    () => admit(client, { ...input, funding: wrongWalletFunding }),
    /funding_destination_changed/u,
  );
  assert.equal((await admit(client, { ...input, funding })).admitted, true);
  const linked = (
    await client.query(
      "select funding_operation_id,funding_reservation_id,funding_trade_attempt_id from orders where id=$1",
      [prepared.orderId],
    )
  ).rows[0];
  assert.equal(linked.funding_operation_id, funding.operationId);
  assert.equal(linked.funding_reservation_id, funding.reservationId);
  assert.ok(linked.funding_trade_attempt_id);
  assert.equal(
    (
      await client.query(
        "select state,execution_path from funding_trade_attempts where id=$1",
        [linked.funding_trade_attempt_id],
      )
    ).rows[0].execution_path,
    "hyperliquid_outcome",
  );
  await recordReply(client, {
    ...input,
    body: {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order has insufficient spot balance to trade" }],
        },
      },
    },
  });
  assert.equal(
    (
      await client.query(
        "select state from funding_trade_attempts where id=$1",
        [linked.funding_trade_attempt_id],
      )
    ).rows[0].state,
    "definitive_failure",
  );
  assert.equal(
    (
      await client.query("select state from balance_reservations where id=$1", [
        funding.reservationId,
      ])
    ).rows[0].state,
    "released",
    "exact initial rejection returns funded cash through the common release path",
  );
  await client.query("rollback to savepoint funded_slice");
  const admitted = await admit(client, input);
  assert.equal(admitted.admitted, true);
  assert.equal(
    await readHip4OrderHoldRaw(
      client,
      fixture.userId,
      wallet.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    134332000n,
  );
  assert.ok(
    (
      await fetchUserFinancialLifecycleSummary(client, [fixture.userId])
    ).activeReasons.includes("active_hip4_submission"),
  );
  const replay = await admit(client, {
    ...input,
    context: { ...context, feeCapRaw: null, capacity: null },
  });
  assert.equal(
    replay.admitted,
    false,
    "committed replay is a read, not fresh admission",
  );
  const second = await prepare(client, {
    ...fixture,
    nonce: fixture.nonce + 1,
    request: { ...fixture.request, requestKey: randomUUID() },
  });
  const secondInput = {
    ...input,
    actionId: second.actionId,
    signature: await signed(second),
  };
  await rejects(() => admit(client, secondInput), /capacity_reserved/u);
  for (const terminal of [false, true]) {
    await client.query("savepoint terminal_buy_capacity");
    const buyBarrierAt = Date.now() - 2;
    await client.query(
      "update hip4_order_submissions set order_observation=$2::jsonb where action_id=$1",
      [
        prepared.actionId,
        {
          status: terminal ? "canceled" : "open",
          terminal,
          balanceBarrier: {
            state: terminal ? "terminal_observed" : "accepted_observed",
            responseAt: buyBarrierAt,
          },
        },
      ],
    );
    await rejects(
      () =>
        admit(client, {
          ...secondInput,
          context: {
            ...context,
            capacity: {
              ...capacity,
              observedAt: new Date(buyBarrierAt).toISOString(),
            },
          },
        }),
      /capacity_reserved/u,
    );
    if (!terminal) {
      await rejects(
        () =>
          admit(client, {
            ...secondInput,
            context: {
              ...context,
              capacity: {
                ...capacity,
                availableRaw: "134332000",
                observedAt: new Date(buyBarrierAt + 1).toISOString(),
              },
            },
          }),
        /capacity_reserved/u,
      );
    }
    assert.equal(
      (
        await admit(client, {
          ...secondInput,
          context: {
            ...context,
            capacity: {
              ...capacity,
              availableRaw: terminal ? "134332000" : "135332000",
              observedAt: new Date(buyBarrierAt + 1).toISOString(),
            },
          },
        })
      ).admitted,
      true,
      "new BUY uses subsequent capacity, retaining only the open order's fee cap",
    );
    assert.equal(
      await readHip4OrderHoldRaw(
        client,
        fixture.userId,
        wallet.address,
        HYPERCORE_MAINNET_USDC.assetId,
        new Date(buyBarrierAt + 1).toISOString(),
      ),
      134332000n + (terminal ? 0n : BigInt(fixture.feeCapRaw)),
      "the new submission is not credited against the earlier balance snapshot",
    );
    await client.query("rollback to savepoint terminal_buy_capacity");
  }
  await recordReply(client, {
    ...input,
    body: {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [
            {
              error:
                "Order could not immediately match against any resting orders.",
            },
          ],
        },
      },
    },
  });
  assert.equal(
    await readHip4OrderHoldRaw(
      client,
      fixture.userId,
      wallet.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    0n,
  );
  assert.equal(
    (await fetchUserFinancialLifecycleSummary(client, [fixture.userId]))
      .activeMovement,
    false,
  );
  assert.equal(
    (await admit(client, secondInput)).admitted,
    true,
    "exact rejection frees capacity for a NEW authorized action",
  );
  const unknown = await recordReply(client, {
    ...secondInput,
    body: { status: "err", response: "unknown nonce" },
  });
  assert.equal(unknown.state, "reconcile_required");
  assert.equal((await admit(client, secondInput)).admitted, false);
  await recordReply(client, {
    ...secondInput,
    body: {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order has insufficient spot balance to trade" }],
        },
      },
    },
  });
  assert.equal(
    await readHip4OrderHoldRaw(
      client,
      fixture.userId,
      wallet.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    134332000n,
    "a second, contradictory response cannot release an uncertain action",
  );
  await rejects(
    () =>
      client.query(
        "update hip4_order_submissions set debit_raw='1' where action_id=$1",
        [second.actionId],
      ),
    /immutable/u,
  );

  const selling = await prepare(client, {
    ...fixture,
    nonce: fixture.nonce + 2,
    request: {
      ...fixture.request,
      requestKey: randomUUID(),
      side: "SELL",
      quantity: "1",
      consentedDebitCapRaw: "100000",
    },
  });
  const sellToken = (
    await client.query("select token_id from hip4_order_actions where id=$1", [
      selling.actionId,
    ])
  ).rows[0].token_id;
  const sellContext = {
    ...context,
    capacity: {
      ...context.capacity,
      assetId: sellToken,
      decimals: 5,
      availableRaw: "100000",
    },
  };
  const sellInput = {
    ...input,
    actionId: selling.actionId,
    signature: await signed(selling),
    context: sellContext,
  };
  await policy("exit-only");
  const invalidBuyPolicyId = (
    await client.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('hip4_trading',now()-interval '1 millisecond',$1::jsonb) returning id",
      [{ minimumBuyNotionalUsd: "0" }],
    )
  ).rows[0].id;
  await rejects(
    () =>
      admit(client, {
        ...sellInput,
        context: { ...sellContext, feeCapRaw: "1000001" },
      }),
    /fee_consent_changed/u,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as count from hip4_order_submissions where action_id=$1",
        [selling.actionId],
      )
    ).rows[0].count,
    0,
    "increased SELL fee never admits or reserves shares",
  );
  assert.equal(
    (
      await admit(client, {
        ...sellInput,
        context: { ...sellContext, feeCapRaw: "999999" },
      })
    ).admitted,
    true,
    "lower fee recovers the same preparation; SELL remains possible in exit-only despite invalid BUY-only policy",
  );
  await client.query("delete from runtime_policies where id=$1", [
    invalidBuyPolicyId,
  ]);
  const secondSell = await prepare(client, {
    ...fixture,
    nonce: fixture.nonce + 3,
    request: {
      ...fixture.request,
      requestKey: randomUUID(),
      side: "SELL",
      quantity: "1",
      consentedDebitCapRaw: "100000",
    },
  });
  await rejects(
    async () =>
      admit(client, {
        ...sellInput,
        actionId: secondSell.actionId,
        signature: await signed(secondSell),
      }),
    /capacity_reserved/u,
  );
  for (const terminal of [false, true]) {
    await client.query("savepoint terminal_sell_capacity");
    const sellBarrierAt = Date.now() - 2;
    await client.query(
      "update hip4_order_submissions set order_observation=$2::jsonb where action_id=$1",
      [
        selling.actionId,
        {
          status: terminal ? "canceled" : "open",
          terminal,
          balanceBarrier: {
            state: terminal ? "terminal_observed" : "accepted_observed",
            responseAt: sellBarrierAt,
          },
        },
      ],
    );
    const nextSellInput = {
      ...sellInput,
      actionId: secondSell.actionId,
      signature: await signed(secondSell),
    };
    await rejects(
      () =>
        admit(client, {
          ...nextSellInput,
          context: {
            ...sellContext,
            capacity: {
              ...sellContext.capacity,
              observedAt: new Date(sellBarrierAt).toISOString(),
            },
          },
        }),
      /capacity_reserved/u,
    );
    assert.equal(
      (
        await admit(client, {
          ...nextSellInput,
          context: {
            ...sellContext,
            capacity: {
              ...sellContext.capacity,
              observedAt: new Date(sellBarrierAt + 1).toISOString(),
            },
          },
        })
      ).admitted,
      true,
      "SELL inclusion uses subsequent same-side owned shares, independent of BUY cash",
    );
    await client.query("rollback to savepoint terminal_sell_capacity");
  }
  await client.query("savepoint observed_fee_context");
  await policy("active");
  for (const side of ["BUY", "SELL"] as const) {
    const feeObservation = hip4FeeTestObservation({
      address: wallet.address.toLowerCase(),
      marketId: fixture.request.marketId,
      side,
      ...(side === "BUY" ? { closing: null } : {}),
    });
    const feePreparation = {
      ...fixture,
      feeCapRaw: null,
      feeObservation,
      nonce: fixture.nonce + (side === "BUY" ? 1000 : 1001),
      request: { ...fixture.request, side, requestKey: randomUUID() },
    };
    const quoted = await prepare(client, feePreparation);
    const snapshot = quoted.snapshot.amounts as Record<string, unknown>;
    assert.equal(snapshot.feeCapRaw, side === "BUY" ? "0" : null);
    if (side === "SELL") {
      assert.equal(snapshot.minimumNetProceedsRaw, null);
      assert.equal(typeof snapshot.estimatedNetProceedsAtLimitRaw, "string");
    }
    const feeInput: Parameters<typeof admit>[1] = {
      ...input,
      actionId: quoted.actionId,
      signature: await signed(quoted),
      context: {
        ...context,
        // Even an injected caller estimate cannot override server terms.
        feeCapRaw: "999999999999",
        feeObservation,
        capacity: {
          ...context.capacity,
          assetId: side === "BUY" ? HYPERCORE_MAINNET_USDC.assetId : sellToken,
          decimals: side === "BUY" ? 8 : 5,
          availableRaw: "10000000000",
        },
      },
    };
    await rejects(
      () =>
        admit(client, {
          ...feeInput,
          context: { ...feeInput.context, feeObservation: undefined },
        }),
      /fee_observation_unavailable/u,
    );
    const expired = {
      ...feeObservation,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    await rejects(
      () =>
        admit(client, {
          ...feeInput,
          context: { ...feeInput.context, feeObservation: expired },
        }),
      /fee_observation_unavailable/u,
    );
    if (side === "SELL") {
      const raised = structuredClone(feeObservation);
      assert.ok(raised.closing);
      raised.closing.userFees.userSpotCrossRate = "0.0009";
      await rejects(
        () =>
          admit(client, {
            ...feeInput,
            context: { ...feeInput.context, feeObservation: raised },
          }),
        /fee_consent_changed/u,
      );
    }
    const admitted = await admit(client, feeInput);
    assert.equal(admitted.admitted, true);
    assert.ok(
      (admitted.submission.admission_snapshot as Record<string, unknown>)
        .feeQuote,
    );
    assert.equal(
      (
        await admit(client, {
          ...feeInput,
          context: {
            ...feeInput.context,
            feeObservation: expired,
            capacity: null,
          },
        })
      ).admitted,
      false,
    );
    assert.equal(
      (await prepare(client, { ...feePreparation, feeObservation: expired }))
        .actionId,
      quoted.actionId,
    );
  }
  await client.query("rollback to savepoint observed_fee_context");
  await client.query("update unified_markets set status='CLOSED' where id=$1", [
    fixture.request.marketId,
  ]);
  const cancellation = await cancel(client, {
    userId: fixture.userId,
    requestKey: randomUUID(),
    orderId: second.orderId,
    profile: fixture.profile,
    nonce: fixture.nonce + 4,
    expiresAfter: fixture.expiresAfter,
  });
  const cancelInput = {
    ...input,
    actionId: cancellation.actionId,
    signature: await signed(cancellation),
    context: { ...context, capacity: null, feeCapRaw: null },
  };
  assert.equal(
    (await admit(client, cancelInput)).admitted,
    true,
    "cancel bypasses cash/minimum/closed-market gates",
  );
  await recordReply(client, {
    ...cancelInput,
    body: {
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    },
  });
  assert.equal(
    await readHip4OrderHoldRaw(
      client,
      fixture.userId,
      wallet.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    134332000n,
    "cancel ACK is not release authority",
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as n from executions where user_id=$1",
        [fixture.userId],
      )
    ).rows[0].n,
    0,
    "ACKs do not manufacture fills",
  );
  // Real parsing/execution of cash-hold queries with exact empty/sparse scope.
  assert.deepEqual(
    (
      await client.query(HIP4_FUNDING_CASH_HOLDS_SQL, [
        fixture.userId,
        "missing",
        HYPERCORE_MAINNET_USDC.assetId,
        null,
      ])
    ).rows,
    [],
  );

  // Representative 50k historical rejected submissions + one unresolved
  // account. Exercise the exact capacity SQL and generic hit/empty plans.
  await client.query(
    "create temp table orders(like public.orders including indexes including defaults) on commit drop",
  );
  await client.query(
    "create temp table hip4_order_actions(like public.hip4_order_actions including indexes including defaults) on commit drop",
  );
  await client.query(
    "create temp table hip4_order_submissions(like public.hip4_order_submissions including indexes including defaults) on commit drop",
  );
  await client.query(
    `insert into orders(id,user_id,venue,status) select md5('hold-order-'||entry)::uuid,$1,'hyperliquid','submitted' from generate_series(1,50000) entry`,
    [fixture.userId],
  );
  await client.query(
    `insert into hip4_order_actions select md5('hold-action-'||entry)::uuid,md5('hold-order-'||entry)::uuid,md5('hold-request-'||entry)::uuid,
    source_row.request_fingerprint,'order','mainnet',source_row.signer_address,source_row.canonical_market_id,source_row.token_id,
    '0x'||md5('hold-cloid-'||entry),entry,source_row.action_fingerprint,source_row.unsigned_envelope,source_row.preparation_snapshot,'prepared',now()
    from public.hip4_order_actions source_row cross join generate_series(1,50000) entry where source_row.id=$1`,
    [second.actionId],
  );
  await client.query(
    `insert into hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,debit_asset_id,debit_decimals,debit_raw,state)
    select id,action_fingerprint,'{}',signer_address,$1,8,'100',case when nonce=42 then 'reconcile_required' else 'rejected' end from hip4_order_actions`,
    [HYPERCORE_MAINNET_USDC.assetId],
  );
  await client.query(
    "analyze orders; analyze hip4_order_actions; analyze hip4_order_submissions; set local plan_cache_mode=force_generic_plan",
  );
  await client.query(
    `prepare hip4_hold_plan(uuid,text,text,numeric) as ${HIP4_ORDER_HOLDS_SQL}`,
  );
  for (const asset of [HYPERCORE_MAINNET_USDC.assetId, "missing"]) {
    const plan = (
      await client.query(
        `explain(analyze,buffers,format json) execute hip4_hold_plan('${fixture.userId}','${wallet.address.toLowerCase()}','${asset}',null)`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
    console.log(
      "[hip4-hold-plan]",
      JSON.stringify({
        rows: plan.Plan["Actual Rows"],
        ms: plan["Execution Time"],
        blocks: plan.Plan["Local Hit Blocks"],
      }),
    );
  }
  // Terminal histories remain auditable, not deleted/rejected for convenience.
  // Exercise the inclusion filter with 50k completed orders on this account,
  // not only unrelated/rejected rows that miss the partial index entirely.
  await client.query(`update hip4_order_submissions set state='reconcile_required',
    order_observation='{"terminal":true,"balanceBarrier":{"state":"terminal_observed","responseAt":100}}'::jsonb`);
  await client.query("analyze hip4_order_submissions");
  await client.query(
    `prepare hip4_active_exposure(uuid[]) as select exists(${HIP4_ACTIVE_ORDER_EXPOSURE_SQL}) as active`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const sparsePending of [false, true]) {
      await client.query(
        `update hip4_order_submissions set order_observation=case when $1 then null else
        '{"terminal":true,"balanceBarrier":{"state":"terminal_observed","responseAt":100}}'::jsonb end
        where action_id=md5('hold-action-42')::uuid`,
        [sparsePending],
      );
      const plan = (
        await client.query(`explain(analyze,buffers,format json) execute hip4_hold_plan(
        '${fixture.userId}','${wallet.address.toLowerCase()}','${HYPERCORE_MAINNET_USDC.assetId}',101)`)
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], sparsePending ? 1 : 0);
      const buffers =
        plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"];
      assert.ok(
        buffers < 128,
        "capacity must seek unaccounted orders rather than scan terminal history",
      );
      console.log("[hip4-terminal-hold-plan]", {
        mode,
        sparsePending,
        ms: plan["Execution Time"],
        buffers,
        readBuffers: plan.Plan["Local Read Blocks"],
      });
      if (process.env.HUNCH_TEST_SHOW_QUERY_PLAN === "1")
        console.log(JSON.stringify(plan));
      for (const owner of [fixture.userId, randomUUID()]) {
        const activeQuery = `execute hip4_active_exposure(ARRAY['${owner}']::uuid[])`;
        assert.equal(
          (await client.query(activeQuery)).rows[0].active,
          owner === fixture.userId && sparsePending,
        );
        const exposurePlan = (
          await client.query(
            `explain(analyze,buffers,format json) ${activeQuery}`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const exposureBuffers =
          exposurePlan.Plan["Local Hit Blocks"] +
          exposurePlan.Plan["Local Read Blocks"];
        if (process.env.HUNCH_TEST_SHOW_QUERY_PLAN === "1")
          console.log(JSON.stringify(exposurePlan));
        assert.ok(
          exposureBuffers < 500000,
          "terminal exposure query must not multiply histories",
        );
        if (owner !== fixture.userId)
          assert.ok(
            exposureBuffers < 50,
            "empty owner must not scan unrelated HIP order history under a generic plan",
          );
        console.log("[hip4-active-exposure-plan]", {
          mode,
          sparsePending,
          owned: owner === fixture.userId,
          ms: exposurePlan["Execution Time"],
          buffers: exposureBuffers,
        });
      }
    }
  }
  // One accepted open order among 50k retained terminal rows. Exercise the
  // changed fee-only projection under custom/generic plans, plus sparse/miss.
  await client.query(`update hip4_order_submissions set order_observation=
    '{"status":"open","terminal":false,"balanceBarrier":{"state":"accepted_observed","responseAt":100}}'::jsonb
    where action_id=md5('hold-action-42')::uuid`);
  await client.query(`update hip4_order_actions set preparation_snapshot=
    preparation_snapshot || jsonb_build_object('amounts',(preparation_snapshot->'amounts') ||
    '{"debitCapRaw":"100","feeCapRaw":"7"}'::jsonb) where id=md5('hold-action-42')::uuid`);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [owner, asset, expectedRows] of [
      [fixture.userId, HYPERCORE_MAINNET_USDC.assetId, 1],
      [fixture.userId, "missing", 0],
      [randomUUID(), HYPERCORE_MAINNET_USDC.assetId, 0],
    ] as const) {
      const statement = `execute hip4_hold_plan('${owner}','${wallet.address.toLowerCase()}','${asset}',101)`;
      const result = await client.query(statement);
      assert.equal(result.rows.length, expectedRows);
      if (expectedRows) assert.equal(result.rows[0].raw_amount, "7");
      const plan = (
        await client.query(`explain(analyze,buffers,format json) ${statement}`)
      ).rows[0]["QUERY PLAN"][0];
      const buffers =
        plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"];
      assert.ok(
        buffers < 128,
        "open inclusion must seek only unaccounted orders",
      );
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      console.log("[hip4-open-hold-plan]", {
        mode,
        rows: result.rows.length,
        ms: plan["Execution Time"],
        buffers,
      });
    }
  }
  await client.query("deallocate hip4_active_exposure");
  await client.query("deallocate hip4_hold_plan");
  await client.query(
    `prepare hip4_owned_submission_plan(uuid,uuid) as ${HIP4_OWNED_SUBMISSION_SQL}`,
  );
  const lookupAction = (
    await client.query("select md5('hold-action-42')::uuid as id")
  ).rows[0].id;
  for (const mode of ["force_generic_plan", "force_custom_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [actionId, userId, expectedRows] of [
      [lookupAction, fixture.userId, 1],
      [lookupAction, randomUUID(), 0],
      [randomUUID(), fixture.userId, 0],
    ] as const) {
      const plan = (
        await client.query(
          `explain(analyze,buffers,format json) execute hip4_owned_submission_plan('${actionId}','${userId}')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.equal(plan.Plan["Actual Rows"], expectedRows);
      console.log("[hip4-owned-submission-plan]", {
        mode,
        rows: expectedRows,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await client.query("deallocate hip4_owned_submission_plan");
  await client.query(
    `prepare hip4_recovery_scale(uuid,uuid) as ${HIP4_ORDER_RECOVERY_SQL}`,
  );
  for (const mode of ["force_generic_plan", "force_custom_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [actionId, userId, expectedRows] of [
      [lookupAction, fixture.userId, 1],
      [lookupAction, randomUUID(), 0],
      [randomUUID(), fixture.userId, 0],
    ] as const) {
      const plan = (
        await client.query(
          `explain(analyze,buffers,format json) execute hip4_recovery_scale('${actionId}','${userId}')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], expectedRows);
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      const buffers =
        (plan.Plan["Local Hit Blocks"] ?? 0) +
        (plan.Plan["Local Read Blocks"] ?? 0);
      assert.ok(
        buffers < 64,
        "recovery must use exact identity indexes, not scan order history",
      );
      console.log("[hip4-recovery-scale]", {
        mode,
        rows: expectedRows,
        ms: plan["Execution Time"],
        buffers,
      });
    }
  }
  await client.query("deallocate hip4_recovery_scale");
  const proofAction = (
    await client.query(
      "select id,order_id,cloid,action_fingerprint from hip4_order_actions where id=$1",
      [lookupAction],
    )
  ).rows[0];
  const proofAttempt = randomUUID(),
    proofLease = randomUUID();
  await client.query(
    "update orders set funding_trade_attempt_id=$2 where id=$1",
    [proofAction.order_id, proofAttempt],
  );
  await client.query(
    `update hip4_order_submissions set funding_trade_attempt_id=$2,reconcile_lease_token=$3,reconcile_lease_until=clock_timestamp()+interval '1 minute',
    order_observation='{"status":"minTradeNtlRejected","terminal":true,"balanceBarrier":{"state":"terminal_observed","responseAt":100}}'
    where action_id=$1`,
    [lookupAction, proofAttempt, proofLease],
  );
  await client.query(
    `prepare exact_rejection_proof(uuid,text,text,uuid,uuid,uuid,text) as ${HIP4_EXACT_REJECTION_PROOF_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [actionId, userId, rows] of [
      [lookupAction, fixture.userId, 1],
      [lookupAction, randomUUID(), 0],
      [randomUUID(), fixture.userId, 0],
    ] as const) {
      const plan = (
        await client.query(
          `explain(analyze,buffers,format json) execute exact_rejection_proof('${actionId}','${proofAction.cloid}','${proofAction.action_fingerprint}','${userId}','${proofAttempt}','${proofLease}','minTradeNtlRejected')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], rows);
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.ok(plan.Plan["Local Hit Blocks"] < 50);
      console.log("[hip4-rejection-proof-plan]", {
        mode,
        rows,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await client.query("deallocate exact_rejection_proof; rollback");

  // Actual two-request concurrency around COMMIT and mocked POST. Never use
  // any real exchange endpoint; the fetcher below does not access the network.
  await client.query("begin");
  policyId = await policy("active");
  const durable = await hip4OrderTestFixture(client, wallet.address);
  const action = await prepare(client, durable);
  const durableInput = {
    ...input,
    userId: durable.userId,
    actionId: action.actionId,
    signature: await signed(action),
    context: {
      ...context,
      profile: durable.profile,
      capacity: {
        ...context.capacity,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
  };
  const target = (
    await client.query("insert into users(is_active) values(true) returning *")
  ).rows[0];
  await client.query("commit");
  let postCount = 0;
  const transport = {
    timeoutMs: 1000,
    responseMaxBytes: 10000,
    fetcher: (async () => {
      postCount++;
      throw new Error("offline timeout");
    }) as typeof fetch,
  };
  const results = await Promise.all([
    submitHip4OrderAction(pool, durableInput, transport, testCapability),
    submitHip4OrderAction(pool, durableInput, transport, testCapability),
  ]);
  assert.equal(postCount, 1);
  assert.equal(results.filter((item) => item.replayed).length, 1);
  const source = (
    await client.query("select * from users where id=$1", [durable.userId])
  ).rows[0];
  await assert.rejects(
    () => mergeUsers(source, target, { dryRun: true, keepSource: false }, pool),
    (error) => {
      assert.ok(error instanceof FundingMergeConflictError);
      assert.equal(error.conflicts.activeHip4Submissions, 1);
      return true;
    },
  );
  const crashedAction = await (async () => {
    await client.query("begin");
    const next = await prepare(client, {
      ...durable,
      nonce: durable.nonce + 1,
      request: { ...durable.request, requestKey: randomUUID() },
    });
    const nextInput = {
      ...durableInput,
      actionId: next.actionId,
      signature: await signed(next),
      context: {
        ...durableInput.context,
        capacity: {
          ...durableInput.context.capacity,
          availableRaw: "1000000000",
        },
      },
    };
    await admit(client, nextInput);
    await client.query("commit");
    return nextInput;
  })();
  await submitHip4OrderAction(pool, crashedAction, transport, testCapability);
  assert.equal(
    postCount,
    1,
    "process loss after admission cannot authorize a resend",
  );
  await client.query("begin");
  const expiring = await prepare(client, {
    ...durable,
    nonce: Date.now() - 1,
    expiresAfter: Date.now() + 1000,
    request: { ...durable.request, requestKey: randomUUID() },
  });
  const expiringInput = {
    ...crashedAction,
    actionId: expiring.actionId,
    signature: await signed(expiring),
  };
  await client.query("commit");
  const waiter = await pool.connect();
  try {
    await client.query("begin");
    await waiter.query("begin");
    await client.query(
      "select id from unified_markets where id=$1 for update",
      [durable.request.marketId],
    );
    const lockerPid = (await client.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    const waiterPid = (await waiter.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    const pending = admit(waiter, expiringInput);
    void pending.catch(() => undefined);
    let blocked = false;
    const deadline = Date.now() + 500;
    while (!blocked && Date.now() < deadline) {
      blocked = (
        await pool.query(
          "select $1::int=any(pg_blocking_pids($2::int)) as blocked",
          [lockerPid, waiterPid],
        )
      ).rows[0].blocked;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      blocked,
      "admission reached the real market-row lock before expiry",
    );
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, (expiring.envelope.expiresAfter ?? 0) - Date.now() + 20),
      ),
    );
    await client.query("commit");
    await assert.rejects(pending, /preparation_expired/u);
    await waiter.query("rollback");
    assert.equal(
      (
        await client.query(
          "select count(*)::int as n from hip4_order_submissions where action_id=$1",
          [expiring.actionId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await client.query("rollback");
    await waiter.query("rollback");
    waiter.release();
  }
  await client.query("begin");
  const scheduledAction = await prepare(client, {
    ...durable,
    nonce: Date.now() - 1,
    expiresAfter: Date.now() + 60000,
    request: { ...durable.request, requestKey: randomUUID() },
  });
  const becomesEffective = new Date(Date.now() + 1000);
  const scheduledPolicyId = (
    await client.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('hip4_trading',$1,$2::jsonb) returning id",
      [becomesEffective, { minimumBuyNotionalUsd: "2" }],
    )
  ).rows[0].id;
  temporaryTradingPolicyIds.push(scheduledPolicyId);
  await client.query("commit");
  const policyWaiter = await pool.connect();
  const scheduledInput = {
    ...crashedAction,
    actionId: scheduledAction.actionId,
    signature: await signed(scheduledAction),
  };
  try {
    await client.query("begin");
    await client.query(
      "select id from unified_markets where id=$1 for update",
      [durable.request.marketId],
    );
    await policyWaiter.query("begin");
    const waiterPid = (
      await policyWaiter.query("select pg_backend_pid() as pid")
    ).rows[0].pid;
    const pending = admit(policyWaiter, scheduledInput);
    void pending.catch(() => undefined);
    let blocked = false;
    const deadline = becomesEffective.getTime() - 50;
    while (!blocked && Date.now() < deadline) {
      blocked = (
        await pool.query(
          "select cardinality(pg_blocking_pids($1))>0 as blocked",
          [waiterPid],
        )
      ).rows[0].blocked;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      blocked,
      "old policy was read before waiting on real market lock",
    );
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, becomesEffective.getTime() - Date.now() + 20),
      ),
    );
    await client.query("commit");
    await assert.rejects(pending, /current_amounts_invalid/u);
    await policyWaiter.query("rollback");
    assert.equal(
      (
        await client.query(
          "select count(*)::int as n from hip4_order_submissions where action_id=$1",
          [scheduledAction.actionId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await submitHip4OrderAction(
          pool,
          durableInput,
          transport,
          testCapability,
        )
      ).replayed,
      true,
      "already submitted result survives the new threshold without another POST",
    );
    await client.query("delete from runtime_policies where id=$1", [
      scheduledPolicyId,
    ]);
    await policyWaiter.query("begin");
    assert.equal(
      (await admit(policyWaiter, scheduledInput)).admitted,
      true,
      "valid policy repair retries the same unsigned preparation",
    );
    await policyWaiter.query("rollback");
  } finally {
    await client.query("rollback");
    await policyWaiter.query("rollback");
    policyWaiter.release();
  }
  for (const scenario of ["BUY", "SELL", "CANCEL", "FEE_EXPIRY"] as const) {
    const side = scenario === "FEE_EXPIRY" ? "BUY" : scenario;
    const effectiveAt = new Date(Date.now() + 1000);
    const feeObservation =
      scenario === "FEE_EXPIRY"
        ? hip4FeeTestObservation({
            address: wallet.address.toLowerCase(),
            marketId: durable.request.marketId,
            side: "BUY",
            closing: null,
            expiresAt: effectiveAt.toISOString(),
          })
        : undefined;
    await client.query("begin");
    const next =
      side === "CANCEL"
        ? await cancel(client, {
            userId: durable.userId,
            orderId: action.orderId,
            requestKey: randomUUID(),
            profile: durable.profile,
            nonce: Date.now() - 1,
            expiresAfter: Date.now() + 60000,
          })
        : await prepare(client, {
            ...durable,
            feeObservation,
            nonce: Date.now() - 1,
            expiresAfter: Date.now() + 60000,
            request: { ...durable.request, side, requestKey: randomUUID() },
          });
    const suspended = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
    suspended.venues.hyperliquid = {
      lifecycle: scenario === "FEE_EXPIRY" ? "active" : "unreleased",
      indexerMode: "off",
    };
    const scheduledLifecycleId = (
      await client.query(
        "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',$1,$2::jsonb) returning id",
        [effectiveAt, suspended],
      )
    ).rows[0].id;
    temporaryTradingPolicyIds.push(scheduledLifecycleId);
    await client.query("commit");
    const lifecycleWaiter = await pool.connect();
    const nextInput: Parameters<typeof admit>[1] = {
      ...crashedAction,
      actionId: next.actionId,
      signature: await signed(next),
      context: {
        ...crashedAction.context,
        feeObservation,
        capacity: {
          ...crashedAction.context.capacity,
          assetId:
            side === "SELL"
              ? `hyperliquid:mainnet:${Number(durable.request.marketId.split(":").at(-1)) * 10 + 1}`
              : HYPERCORE_MAINNET_USDC.assetId,
          decimals: side === "SELL" ? 5 : 8,
        },
      },
    };
    try {
      await client.query("begin");
      await client.query(
        "select id from hip4_order_actions where id=$1 for update",
        [next.actionId],
      );
      await lifecycleWaiter.query("begin");
      const waiterPid = (
        await lifecycleWaiter.query("select pg_backend_pid() as pid")
      ).rows[0].pid;
      const pending = admit(lifecycleWaiter, nextInput);
      void pending.catch(() => undefined);
      let blocked = false;
      while (!blocked && Date.now() < effectiveAt.getTime() - 50) {
        blocked = (
          await pool.query(
            "select cardinality(pg_blocking_pids($1))>0 as blocked",
            [waiterPid],
          )
        ).rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        blocked,
        `${scenario} reached row lock wait before the boundary`,
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, effectiveAt.getTime() - Date.now() + 20),
        ),
      );
      await client.query("commit");
      await assert.rejects(
        pending,
        scenario === "FEE_EXPIRY"
          ? /fee_observation_unavailable/u
          : /lifecycle_disabled/u,
      );
      await lifecycleWaiter.query("rollback");
      assert.equal(
        (
          await client.query(
            "select 1 from hip4_order_submissions where action_id=$1",
            [next.actionId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await submitHip4OrderAction(
            pool,
            durableInput,
            transport,
            testCapability,
          )
        ).replayed,
        true,
        "disabled venue still permits owned result replay, not another POST",
      );
      await client.query("delete from runtime_policies where id=$1", [
        scheduledLifecycleId,
      ]);
      if (feeObservation)
        nextInput.context.feeObservation = {
          ...feeObservation,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      await lifecycleWaiter.query("begin");
      assert.equal((await admit(lifecycleWaiter, nextInput)).admitted, true);
      await lifecycleWaiter.query("rollback");
    } finally {
      await client.query("rollback");
      await lifecycleWaiter.query("rollback");
      lifecycleWaiter.release();
    }
  }
  assert.equal(postCount, 1, "disabled-policy retries never submit again");
  console.log(
    "[hip4-order-submission] signature, lifecycle, BUY/SELL/cancel, rejection recovery, unknown replay, real concurrent one-POST, crash and merge guard passed",
  );
} finally {
  await client.query("rollback");
  // Only this test's committed override. Unsigned/signed synthetic records
  // remain in the disposable database; private keys were never persisted.
  if (policyId)
    await client.query("delete from runtime_policies where id=$1", [policyId]);
  for (const id of temporaryTradingPolicyIds)
    await client.query("delete from runtime_policies where id=$1", [id]);
  client.release();
  await pool.end();
}
