// @api-integration
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Interface } from "ethers";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import "../../../integration-test-database-guard.js";
import { pool } from "../../../db.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { RELAY_DEPOSITORY_V2 } from "../../../funding-providers/relay/rehearsal.js";
import { createRelayReferenceCodec } from "../../../funding-providers/relay/reference-codec.js";
import { createFundingTransactionReferenceCodec } from "../../execution/transaction-reference-codec.js";
import { createRelayReceiveReceiptDispositionResolver } from "../../../funding-providers/relay/receive-operation.js";
import type { RelayQuoteRequest } from "../../../funding-providers/relay/client.js";
import { fundingPolicyRevision } from "../../policies/funding-policy.js";
import {
  createOrReuseFundingReceiveSession,
  insertFundingReceiveReceipt,
} from "../../persistence/funding-receive-session-repository.js";
import { buildFundingReceiveTargets } from "../../planner/receive-targets.js";
import { FundingReceiveReceiptRouter } from "../../receive/receive-receipt-router.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";

const source = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdc,
  decimals: 6,
};
const destination = { ...source, assetId: RELAY_PINNED_ASSETS.polygonPusd };
const policy = {
  version: 2,
  venues: ["polymarket"],
  receive: { assets: ["polygon:usdc"], privy: false },
  paused: false,
} as const;
const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const fixtureUsers: string[] = [];
const eventHashes: string[] = [];
const transactionErrors: string[] = [];
let policyId: string | undefined;

// Only the provider HTTP boundary is replaced. The production quote validator,
// authority check, operation commit, receipt claim/link and observer all run.
function solverQuote(request: RelayQuoteRequest, lossRaw: bigint) {
  const amount = BigInt(request.amount);
  const output = amount - lossRaw;
  const requestId = `router-lock-${randomUUID()}`;
  const token = (address: string, chainId: number) => ({
    address,
    chainId,
    decimals: 6,
  });
  const abi = new Interface([
    "function approve(address spender,uint256 amount)",
    "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
  ]);
  return {
    details: {
      operation: "swap",
      sender: request.user,
      recipient: request.recipient,
      currencyIn: {
        currency: token(request.originCurrency, request.originChainId),
        amount: amount.toString(),
        minimumAmount: amount.toString(),
      },
      currencyOut: {
        currency: token(
          request.destinationCurrency,
          request.destinationChainId,
        ),
        amount: output.toString(),
        minimumAmount: ((output * 99n) / 100n).toString(),
      },
    },
    fees: {
      relayer: {
        currency: token(request.originCurrency, request.originChainId),
        amount: lossRaw.toString(),
        minimumAmount: lossRaw.toString(),
        amountUsd: lossRaw === 55_000n ? "0.055" : "2",
      },
    },
    steps: [
      {
        id: "approve",
        to: request.originCurrency,
        data: abi.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, amount]),
      },
      {
        id: "deposit",
        to: RELAY_DEPOSITORY_V2,
        data: abi.encodeFunctionData("depositErc20", [
          request.user,
          request.originCurrency,
          amount,
          hex(32),
        ]),
      },
    ].map(({ id, to, data }) => ({
      id,
      kind: "transaction",
      requestId,
      items: [
        {
          status: "incomplete",
          data: {
            from: request.user,
            to,
            data,
            value: "0",
            chainId: request.originChainId,
            gas: "100000",
            maxFeePerGas: "50000000000",
            maxPriorityFeePerGas: "30000000000",
          },
          ...(id === "deposit"
            ? {
                check: {
                  method: "GET",
                  endpoint: `/intents/status/v3?requestId=${requestId}`,
                },
              }
            : {}),
        },
      ],
    })),
  };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`timeout: ${label}`)), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type QueryHook = (
  sql: string,
  values: readonly unknown[] | undefined,
  client: PoolClient,
  phase: "before" | "after",
) => Promise<void>;
function instrumentedPool(hook: QueryHook): Pool {
  const wrapped = Object.create(pool) as Pool;
  wrapped.query = pool.query.bind(pool);
  wrapped.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (
            sql: string | { text: string; values?: unknown[] },
            values?: unknown[],
          ) => {
            const text = typeof sql === "string" ? sql : sql.text;
            const params = typeof sql === "string" ? values : sql.values;
            await hook(text, params, target, "before");
            let result;
            try {
              result =
                typeof sql === "string"
                  ? await target.query(sql, values)
                  : await target.query(sql);
            } catch (error) {
              transactionErrors.push(
                String((error as { code?: string }).code ?? "unknown"),
              );
              throw error;
            }
            if (text.trim().toLowerCase() === "begin")
              await target.query("set local statement_timeout='10s'");
            await hook(text, params, target, "after");
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
  }) as Pool["connect"];
  return wrapped;
}

async function waitForBlock(waiter: number, blocker: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await pool.query<{ wait_event: string; blocked: boolean }>(
      `select wait_event, $2::int=any(pg_blocking_pids(pid)) as blocked from pg_stat_activity where pid=$1`,
      [waiter, blocker],
    );
    if (result.rows[0]?.blocked) return result.rows[0].wait_event;
    await delay(10);
  }
  assert.fail("expected real PostgreSQL lock wait");
}

async function fixture() {
  const now = new Date();
  const userId = randomUUID();
  fixtureUsers.push(userId);
  const address = hex(20);
  const walletRef = randomUUID();
  const privyWalletId = `fixture_${randomUUID()}`;
  await pool.query(
    "insert into users(id,email,is_active,is_verified) values($1,$2,true,true)",
    [userId, `${userId}@example.com`],
  );
  await pool.query(
    `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_primary,is_verified,privy_wallet_id,wallet_source,is_internal_wallet,privy_profile_updated_at)
    values($1,$2,$3,'ethereum',true,true,$4,'embedded',true,$5)`,
    [walletRef, userId, address, privyWalletId, now],
  );
  const variant = {
    variantId: `variant_${userId}`,
    networkId: source.networkId,
    asset: source,
    destinationAddress: address,
    destinationLocationId: `source_${userId}`,
    baselineRaw: "0",
    baselineRevision: `baseline_${userId}`,
    observation: {
      adapterId: "owned_wallet_liquid_balances_v1",
      payload: {
        eventCursorBlock: "99",
        eventConfirmations: 2,
        eventIdentity: "evm_erc20_transfer_v1",
        routeId: "polygon-usdc-to-polygon-pusd",
        balanceKey: `${source.networkId}:${source.assetId}:6`,
        sourceComponentId: `component_${userId}`,
        walletExecutionProfile: {
          walletId: stableWalletOpaqueId({
            walletType: "ethereum",
            networkId: source.networkId,
            address,
          }),
          controllerWalletRef: walletRef,
          networkId: source.networkId,
          address,
          source: "embedded",
          signingModes: ["web_client", "privy_authorization"],
          serverWalletRef: privyWalletId,
          sponsorshipPolicyIds: ["privy_user_authorized_evm_sponsorship_v1"],
          evmAtomicBatchMode: "privy_wallet_send_calls",
        },
      },
    },
    completion: { kind: "child_funding_operation" },
  };
  const receiveTargets = buildFundingReceiveTargets([variant]);
  const destinationOptionId = `destination_${userId}`;
  const venueBindingOptionId = `binding_${userId}`;
  const opened = await createOrReuseFundingReceiveSession(pool, {
    userId,
    venueId: "polymarket",
    ownerChannel: "web",
    destinationOptionId,
    venueBindingOptionId,
    destinationAsset: destination,
    destinationTargetSnapshot: {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        locationId: `destination_location_${userId}`,
        accountId: userId,
        asset: destination,
        details: { address, venueId: "polymarket" },
      },
    },
    venueBindingSnapshot: {
      venueBindingOptionId,
      safeLabel: "Polymarket",
      readinessClass: "internal_managed",
      preparationPurpose: "fund",
      marketClass: null,
      topology: "embedded",
      inspectionRevision: `inspection_${userId}`,
      selectable: true,
      reasonCodes: [],
    },
    methods: [
      {
        methodId: `method_${userId}`,
        kind: "manual",
        safeLabel: "Send crypto",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets,
          recommendedReceiveTargetId: receiveTargets[0].receiveTargetId,
          destinationOptionId,
          destinationAddress: address,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets,
    observationVariants: [variant],
    selectedReceiveTargetId: receiveTargets[0].receiveTargetId,
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "10",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 2,
    policyRevision: fundingPolicyRevision(policy),
    ownershipRevision: `ownership_${userId}`,
    expiresAt: new Date(now.getTime() + 86_400_000),
    observeUntil: new Date(now.getTime() + 8 * 86_400_000),
    now,
  });
  const sessionId = opened.snapshot.session.receiveSessionId;
  const oldHash = hex(32);
  const newHash = hex(32);
  eventHashes.push(oldHash, newHash);
  const old = await insertFundingReceiveReceipt(pool, {
    receiveSessionId: sessionId,
    userId,
    variantId: variant.variantId,
    asset: source,
    destinationAddress: address,
    rawAmount: "10000000",
    observationRevision: `old_${userId}`,
    canonicalEvent: {
      transactionHash: oldHash,
      eventIndex: "0",
      ledgerHeight: "100",
      blockHash: hex(32),
      sourceAddress: hex(20),
    },
    observedAt: now,
    handling: "automatic_conversion",
    status: "observed",
    evidence: { fixture: true },
    now,
  });
  let quoteCalls = 0;
  const resolveWithLoss = (lossRaw: bigint) =>
    createRelayReceiveReceiptDispositionResolver({
      client: {
        apiKey: "offline-router-fixture",
        fetchImpl: async (_url, init) => {
          quoteCalls++;
          const request = JSON.parse(String(init?.body)) as RelayQuoteRequest;
          assert.equal(request.forceSolverExecution, true);
          assert.equal(request.tradeType, "EXACT_INPUT");
          return new Response(JSON.stringify(solverQuote(request, lossRaw)), {
            headers: { "content-type": "application/json" },
          });
        },
      },
      referenceCodec: createRelayReferenceCodec({
        encryptionKey: Buffer.alloc(32, 7),
        lookupHmacKey: "fixture-lookup-key-not-a-secret-12345678",
        keyVersion: 1,
      }),
      subjectLookupHmacKey: "fixture-subject-key-not-a-secret-12345678",
      subjectLookupKeyVersion: 1,
    });
  const newBlockHash = hex(32),
    sender = hex(20);
  const observer = new FundingReceiveSessionObserver({
    transactionReferenceCodec: createFundingTransactionReferenceCodec({
      encryptionKey: Buffer.alloc(32, 7),
      lookupHmacKey: "fixture-lookup-key-not-a-secret-12345678",
      keyVersion: 1,
    }),
    relayReferenceCodec: createRelayReferenceCodec({
      encryptionKey: Buffer.alloc(32, 7),
      lookupHmacKey: "fixture-lookup-key-not-a-secret-12345678",
      keyVersion: 1,
    }),
    scanCanonicalEvents: async (variants) => ({
      events: variants
        .filter((v) => v.variantId === variant.variantId)
        .map((v) => ({
          variant: v,
          transactionHash: newHash,
          eventIndex: "0",
          blockNumber: "101",
          blockHash: newBlockHash,
          sourceAddress: sender,
          destinationAddress: address,
          rawAmount: "2000000",
          observedAt: new Date(now.getTime() + 100).toISOString(),
        })),
      variants,
      cursorAdvanced: false,
    }),
  });
  return {
    userId,
    sessionId,
    old,
    newHash,
    now,
    resolve: resolveWithLoss(55_000n),
    expensiveResolve: resolveWithLoss(2_000_000n),
    observer,
    quoteCalls: () => quoteCalls,
    scopeKey: `funding-receive-session:${userId}:${destinationOptionId}:${venueBindingOptionId}`,
  };
}

async function runRace(routerFirst: boolean) {
  const f = await fixture();
  const held = latch(),
    resume = latch(),
    waiting = latch();
  let holderPid = 0,
    waiterPid = 0,
    walletLocks = 0;
  const routerDb = instrumentedPool(async (sql, values, client, phase) => {
    if (
      phase === "before" &&
      sql.includes("pg_advisory_xact_lock") &&
      values?.[0] === f.scopeKey &&
      !routerFirst
    ) {
      waiterPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      waiting.release();
    }
    if (phase === "after" && sql.includes("for update of app_user, wallet")) {
      walletLocks++;
      if (routerFirst) {
        holderPid = (await client.query("select pg_backend_pid() as pid"))
          .rows[0].pid;
        held.release();
        await resume.promise;
      }
    }
  });
  const observerDb = instrumentedPool(async (sql, values, client, phase) => {
    if (!sql.includes("pg_advisory_xact_lock") || values?.[0] !== f.scopeKey)
      return;
    if (routerFirst && phase === "before") {
      waiterPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      waiting.release();
    } else if (!routerFirst && phase === "after" && !holderPid) {
      holderPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      held.release();
      await resume.promise;
    }
  });
  const router = new FundingReceiveReceiptRouter(
    routerDb,
    undefined,
    f.resolve,
  );
  const poll = () =>
    f.observer.pollBatch(observerDb, {
      limit: 100,
      minimumPollIntervalMs: 1000,
      classificationRetryDelayMs: 1000,
      now: new Date(f.now.getTime() + 1000),
    });
  let routerRun: ReturnType<typeof router.runBatch> | undefined;
  let observerRun: ReturnType<typeof poll> | undefined;
  try {
    if (routerFirst)
      routerRun = router.runBatch({
        limit: 100,
        now: new Date(f.now.getTime() + 1000),
      });
    else observerRun = poll();
    const holderRun = routerRun ?? observerRun;
    assert.ok(holderRun);
    await bounded(
      Promise.race([
        held.promise,
        holderRun.then(async (result) => {
          const diagnostic = await pool.query(
            "select status,routing_disposition,routing_last_error_code from funding_receive_receipts where user_id=$1",
            [f.userId],
          );
          assert.fail(
            `holder completed before lock: ${JSON.stringify({ result, receipts: diagnostic.rows })}`,
          );
        }),
      ]),
      "holder reaches real lock",
    );
    if (routerFirst) observerRun = poll();
    else
      routerRun = router.runBatch({
        limit: 100,
        now: new Date(f.now.getTime() + 1000),
      });
    await bounded(waiting.promise, "waiter reaches scope");
    assert.equal(
      await waitForBlock(waiterPid, holderPid),
      "advisory",
      "wait must be at receive scope, not a users FK or receipt lock",
    );
    if (!routerFirst) {
      assert.equal(walletLocks, 0, "router must wait before locking the owner");
      await tx(pool, async (db) => {
        const owner = await db.query(
          "select id from users where id=$1 for key share nowait",
          [f.userId],
        );
        assert.equal(owner.rowCount, 1);
      });
    }
  } finally {
    resume.release();
    await Promise.allSettled([routerRun, observerRun]);
  }
  assert.ok(routerRun && observerRun);
  assert.equal((await routerRun).operationsCreated, 1);
  assert.equal((await routerRun).retryableErrors, 0);
  assert.equal(walletLocks, 1);
  assert.equal(f.quoteCalls(), 1);
  assert.deepEqual(
    transactionErrors,
    [],
    "no SQL deadlocks, lock timeouts or statement errors",
  );
  // A stale snapshot may lose its CAS to the router. Existing bounded polls
  // must rebuild the real derived pages and publish once, with no manual repair.
  for (let tick = 3; tick < 23; tick++) {
    const recovered = await f.observer.pollBatch(pool, {
      limit: 100,
      minimumPollIntervalMs: 1000,
      classificationRetryDelayMs: 1000,
      now: new Date(f.now.getTime() + tick * 1000),
    });
    assert.equal(recovered.retryableErrors, 0);
    if (recovered.receiptsRecorded > 0) break;
    if (
      (
        await pool.query(
          "select count(*)::int as total from funding_receive_receipts where user_id=$1 and tx_hash=$2",
          [f.userId, f.newHash],
        )
      ).rows[0].total === 1
    )
      break;
  }
  const rows = await pool.query(
    `select id,status,tx_hash,child_funding_operation_id from funding_receive_receipts where user_id=$1 order by created_at`,
    [f.userId],
  );
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.filter((r) => r.tx_hash === f.newHash).length, 1);
  const linked = rows.rows.find((r) => r.id === f.old.receipt.receiptId);
  assert.equal(linked?.status, "routing");
  assert.ok(linked.child_funding_operation_id);
  const operations = await pool.query(
    "select id from funding_operations where user_id=$1",
    [f.userId],
  );
  assert.deepEqual(
    operations.rows.map((r) => r.id),
    [linked.child_funding_operation_id],
  );
  console.log(
    `PASS real receive router/observer ${routerFirst ? "router-first" : "observer-first"}: scope before owner, child linked once, new receipt recovered once`,
  );
  await cleanupFixtures();
}

async function runCompetingRouterRace(allowedFirst: boolean) {
  const f = await fixture();
  const held = latch(),
    resume = latch(),
    waiting = latch();
  let holderPid = 0,
    waiterPid = 0,
    walletLocks = 0;
  const allowedDb = instrumentedPool(async (sql, values, client, phase) => {
    if (
      !allowedFirst &&
      phase === "before" &&
      sql.includes("pg_advisory_xact_lock") &&
      values?.[0] === f.scopeKey
    ) {
      waiterPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      waiting.release();
    }
    if (phase === "after" && sql.includes("for update of app_user, wallet")) {
      walletLocks++;
      if (allowedFirst) {
        holderPid = (await client.query("select pg_backend_pid() as pid"))
          .rows[0].pid;
        held.release();
        await resume.promise;
      }
    }
  });
  const reviewDb = instrumentedPool(async (sql, values, client, phase) => {
    if (!sql.includes("pg_advisory_xact_lock") || values?.[0] !== f.scopeKey)
      return;
    if (allowedFirst && phase === "before") {
      waiterPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      waiting.release();
    } else if (!allowedFirst && phase === "after" && !holderPid) {
      holderPid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      held.release();
      await resume.promise;
    }
  });
  const allowed = new FundingReceiveReceiptRouter(
    allowedDb,
    undefined,
    f.resolve,
  );
  const expensive = new FundingReceiveReceiptRouter(
    reviewDb,
    undefined,
    f.expensiveResolve,
  );
  const options = { limit: 100, now: new Date(f.now.getTime() + 1000) };
  let allowedRun: ReturnType<typeof allowed.runBatch> | undefined;
  let reviewRun: ReturnType<typeof expensive.runBatch> | undefined;
  try {
    if (allowedFirst) allowedRun = allowed.runBatch(options);
    else reviewRun = expensive.runBatch(options);
    await bounded(held.promise, "first router reaches scope/wallet barrier");
    if (allowedFirst) reviewRun = expensive.runBatch(options);
    else allowedRun = allowed.runBatch(options);
    await bounded(waiting.promise, "competing router reaches scope");
    assert.equal(await waitForBlock(waiterPid, holderPid), "advisory");
    // In either order the waiting transaction has NOT already locked the same
    // receipt. Before the disposition fix, review held it while awaiting scope.
    await tx(pool, async (db) => {
      assert.equal(
        (
          await db.query(
            "select id from funding_receive_receipts where id=$1 for update nowait",
            [f.old.receipt.receiptId],
          )
        ).rowCount,
        1,
      );
    });
    if (!allowedFirst) assert.equal(walletLocks, 0);
  } finally {
    resume.release();
    await Promise.allSettled([allowedRun, reviewRun]);
  }
  assert.ok(allowedRun && reviewRun);
  const allowedResult = await allowedRun,
    reviewResult = await reviewRun;
  assert.equal(allowedResult.retryableErrors + reviewResult.retryableErrors, 0);
  assert.equal(allowedResult.operationsCreated, allowedFirst ? 1 : 0);
  assert.equal(reviewResult.reviewsRequired, allowedFirst ? 0 : 1);
  assert.equal(f.quoteCalls(), 2);
  assert.deepEqual(transactionErrors, []);
  const receipt = (
    await pool.query(
      "select status,child_funding_operation_id from funding_receive_receipts where id=$1",
      [f.old.receipt.receiptId],
    )
  ).rows[0];
  assert.equal(receipt.status, allowedFirst ? "routing" : "review_required");
  assert.equal(receipt.child_funding_operation_id !== null, allowedFirst);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from funding_operations where user_id=$1",
        [f.userId],
      )
    ).rows[0].count,
    allowedFirst ? 1 : 0,
  );
  console.log(
    `PASS two real routers, ${allowedFirst ? "accepted" : "review"} first: no scope/receipt inversion, losing stale decision cannot overwrite winner`,
  );
  await cleanupFixtures();
}

async function cleanupFixtures() {
  await tx(pool, async (db) => {
    // Exact, generated fixture owners only; never the application's cleanup path.
    await db.query("set local session_replication_role=replica");
    await db.query(
      `delete from funding_provider_requests where segment_id in(select id from funding_operation_segments where operation_id in(select id from funding_operations where user_id=any($1::uuid[])))`,
      [fixtureUsers],
    );
    for (const table of [
      "funding_operation_steps",
      "funding_operation_segments",
      "funding_reconciliation_jobs",
      "funding_observations",
      "balance_reservations",
      "funding_classification_revisions",
    ] as const) {
      await db.query(
        `delete from ${table} where operation_id in(select id from funding_operations where user_id=any($1::uuid[]))`,
        [fixtureUsers],
      );
    }
    await db.query(
      `delete from funding_receive_refund_candidates where event_id in(select event_id from funding_receive_refund_scans where user_id=any($1::uuid[]))`,
      [fixtureUsers],
    );
    for (const table of [
      "funding_receive_refund_scans",
      "funding_receive_open_idempotency",
      "funding_receive_receipts",
      "funding_receive_sessions",
      "funding_operations",
      "funding_quotes",
      "notifications",
      "user_wallets",
    ] as const) {
      await db.query(`delete from ${table} where user_id=any($1::uuid[])`, [
        fixtureUsers,
      ]);
    }
    await db.query(
      "delete from funding_receive_canonical_events where tx_hash=any($1::text[])",
      [eventHashes],
    );
    await db.query("delete from users where id=any($1::uuid[])", [
      fixtureUsers,
    ]);
  });
}

try {
  policyId = (
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload,created_by) values('funding_control_plane',clock_timestamp(),$1::jsonb,null) returning id",
      [JSON.stringify(policy)],
    )
  ).rows[0].id;
  await runRace(true);
  await runRace(false);
  await runCompetingRouterRace(true);
  await runCompetingRouterRace(false);
} finally {
  try {
    await cleanupFixtures();
    if (policyId)
      await pool.query("delete from runtime_policies where id=$1", [policyId]);
  } finally {
    await pool.end();
  }
}
