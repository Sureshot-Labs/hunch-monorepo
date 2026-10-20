// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountExecutions,
  readHip4AccountSnapshot,
  failHip4AccountRefresh,
  HIP4_EXECUTION_PAGE_SQL,
  HIP4_EXECUTION_MARKET_PAGE_SQL,
} from "./services/hip4-account-repository.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./services/hip4-account-projection.js";
import {
  createHip4OwnedAccountService,
  refreshHip4OwnedAccount,
} from "./services/hip4-account-service.js";
import { hip4AccountProtectedRefsSql } from "./services/hip4-retention.js";
import { admitHip4Request } from "./services/hip4-repository.js";
import {
  advanceHip4FillRepair,
  planHip4FillRepair,
  advanceHip4LedgerRepair,
  planHip4LedgerRepair,
} from "./services/hip4-account-history.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const address = "0x0000000000000000000000000000000000000001";
const budgetAddress = "0x0000000000000000000000000000000000000002";
const longGapAddress = "0x0000000000000000000000000000000000000003";
const smallBudgetAddress = "0x0000000000000000000000000000000000000004";
const backgroundOwnerId = randomUUID();
const now = Date.now();
const quote = {
  tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
  index: 0,
  weiDecimals: 8,
};
const position = { coin: "+87750", total: "20", hold: "2", entryNtl: "10" };
const fill = {
  coin: "#87750",
  px: "0.5",
  sz: "2",
  side: "B",
  time: now - 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  crossed: true,
  fee: "0.01",
  tid: 1,
  feeToken: "USDC",
  builderFee: "0.01",
};
const observation = projectHip4Account({
  environment: "mainnet",
  observedAt: new Date(now).toISOString(),
  role: "user",
  mode: "disabled",
  quote,
  state: { balances: [position] },
});
const policyIds = [randomUUID(), randomUUID()];
const lifecycleFixture = await installHip4TestLifecycle(pool);
try {
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  assert.equal(
    (Number(
      (await pool.query("show server_version_num")).rows[0].server_version_num,
    ) /
      10000) |
      0,
    16,
  );
  const lease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(lease);
  assert.equal(
    await claimHip4AccountRefresh(
      pool,
      "mainnet",
      address,
      120000,
      new Date(now),
    ),
    null,
  );
  const entries = [
    fill,
    { ...fill, tid: 2 },
    { ...fill, coin: "#87751", tid: 3 },
  ].map((row) => projectHip4Execution("mainnet", address, row));
  const save = {
    environment: "mainnet" as const,
    address,
    lease,
    observation,
    executions: entries,
    ledger: [],
    history: {},
    error: null,
  };
  assert.equal(await persistHip4AccountRefresh(pool, save), true);
  assert.equal(await persistHip4AccountRefresh(pool, save), false);
  const retry = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(retry);
  await persistHip4AccountRefresh(pool, { ...save, lease: retry });
  const first = await readHip4AccountExecutions(pool, "mainnet", address, 1);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await readHip4AccountExecutions(
    pool,
    "mainnet",
    address,
    10,
    first.nextCursor,
  );
  assert.equal(second.items.length, 2);
  assert.ok(second.items.every((row) => row.id !== first.items[0].id));
  assert.equal(
    (await readHip4AccountExecutions(pool, "testnet", address, 10)).items
      .length,
    0,
  );
  const state = await readHip4AccountSnapshot(pool, "mainnet", address);
  assert.deepEqual(state?.observation, observation);
  const conflictLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(conflictLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: conflictLease,
    executions: [{ ...entries[0], fee: "0.02" }],
  });
  assert.ok(
    (
      await readHip4AccountSnapshot(pool, "mainnet", address)
    )?.attempt_error.includes("execution_identity_conflict"),
  );
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items.find(
      (row) => row.id === entries[0].id,
    )?.fee,
    "0.01",
  );
  const emptyLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(emptyLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: emptyLease,
    observation: null,
    executions: [],
    error: "timeout",
  });
  assert.equal(
    (await readHip4AccountSnapshot(pool, "mainnet", address))?.observation
      ?.positions.length,
    1,
  );
  const zeroLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(zeroLease);
  await persistHip4AccountRefresh(pool, {
    ...save,
    lease: zeroLease,
    observation: { ...observation, positions: [] },
    executions: [],
  });
  assert.equal(
    (await readHip4AccountSnapshot(pool, "mainnet", address))?.observation
      ?.positions.length,
    0,
  );
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items
      .length,
    3,
  );
  const expired = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(expired);
  await pool.query(
    "update hip4_account_snapshots set lease_until=now()-interval '1 second' where account_address=$1",
    [address],
  );
  const next = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    120000,
    new Date(now),
  );
  assert.ok(next);
  assert.equal(
    await persistHip4AccountRefresh(pool, { ...save, lease: expired }),
    false,
  );
  await failHip4AccountRefresh(
    pool,
    "mainnet",
    address,
    next,
    "synthetic_failure",
  );

  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...policyIds,
      JSON.stringify({ enabled: true, requestWeightPerMinute: 1000 }),
      JSON.stringify({ enabled: true }),
    ],
  );
  const provider = async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    const responses: Record<string, unknown> = {
      userRole: { role: "user" },
      userAbstraction: "disabled",
      spotMeta: { tokens: [{ name: "USDC", ...quote, szDecimals: 8 }] },
      spotClearinghouseState: { balances: [position] },
      userFills: [fill],
      userFillsByTime: [fill],
      userNonFundingLedgerUpdates: [],
      frontendOpenOrders: [],
    };
    return Response.json(responses[body.type]);
  };
  const service = createHip4OwnedAccountService(pool, provider);
  const policy = await service.policy();
  const loaded = await service.load(
    address,
    policy.readPolicy,
    policy.accountPolicy,
    policy.revision,
    true,
  );
  assert.equal(loaded.state, "fresh");
  assert.equal(loaded.observation?.positions.length, 1);
  assert.ok(loaded.history.executionsObservedAt);
  assert.equal(loaded.history.allTimeComplete, false);
  const evidence = await pool.query(
    "select provider_fill,provider_fingerprint from hip4_account_executions where environment='mainnet' and account_address=$1 and tid=1",
    [address],
  );
  assert.deepEqual(evidence.rows[0].provider_fill, fill);
  assert.match(evidence.rows[0].provider_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    "provider_fill" in
      (await readHip4AccountExecutions(pool, "mainnet", address, 10)).items[0],
    false,
  );
  const partialService = createHip4OwnedAccountService(
    pool,
    async (url, options) =>
      JSON.parse(String(options?.body)).type === "userFills"
        ? new Response("unavailable", { status: 500 })
        : provider(url, options),
  );
  const partial = await partialService.load(
    address,
    policy.readPolicy,
    policy.accountPolicy,
    policy.revision,
    true,
  );
  assert.equal(partial.state, "fresh");
  assert.equal(partial.observation?.positions.length, 1);
  assert.equal(
    partial.history.executionsObservedAt,
    loaded.history.executionsObservedAt,
  );
  assert.equal(partial.refreshState, "failed");

  // Saturated background work must not prevent a force-fresh Standard-account
  // cash observation. Optional history remains deferred, never fabricated.
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    { enabled: true, requestWeightPerMinute: 600 },
  ]);
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  assert.equal(
    await admitHip4Request(pool, "mainnet", 300, 600, {
      scope: "background_catalog",
      maximum: 300,
      backgroundMaximum: 300,
    }),
    true,
  );
  const budgetRequests: string[] = [];
  const repairRequests: { startTime: number; endTime: number }[] = [];
  let failingHistoryRequest: "userFills" | "userFillsByTime" | null = null;
  const budgetFetcher: typeof fetch = async (url, options) => {
    const request = JSON.parse(String(options?.body));
    budgetRequests.push(request.type);
    if (request.type === "userFillsByTime")
      repairRequests.push({
        startTime: request.startTime,
        endTime: request.endTime,
      });
    if (request.type === failingHistoryRequest)
      return new Response("unavailable", { status: 500 });
    if (request.type === "clearinghouseState")
      return Response.json({
        marginSummary: {
          accountValue: "10",
          totalRawUsd: "10",
          totalMarginUsed: "0",
          totalNtlPos: "0",
        },
        crossMarginSummary: {
          accountValue: "10",
          totalRawUsd: "10",
          totalMarginUsed: "0",
          totalNtlPos: "0",
        },
        crossMaintenanceMarginUsed: "0",
        withdrawable: "10",
        assetPositions: [],
        time: Date.now(),
      });
    if (request.type === "userFillsByTime") return Response.json([]);
    if (request.type === "spotClearinghouseState")
      return Response.json({
        balances: [{ ...position, total: "2", hold: "0" }],
      });
    return provider(url, options);
  };
  const budgetService = createHip4OwnedAccountService(pool, budgetFetcher);
  const budgetPolicy = await budgetService.policy();
  const refreshBudgetAccount = () =>
    budgetService.load(
      budgetAddress,
      budgetPolicy.readPolicy,
      budgetPolicy.accountPolicy,
      budgetPolicy.revision,
      true,
    );
  const usedBudgetWeight = async () => {
    const result = await pool.query<{ used_weight: number }>(
      `select coalesce(sum((admission_row->>'weight')::int),0)::int as used_weight
       from hip4_request_budget budget_row
       cross join lateral jsonb_array_elements(budget_row.admissions) admission_row
       where budget_row.scope='public-info'
         and (admission_row->>'at')::numeric > extract(epoch from statement_timestamp())-60`,
    );
    assert.ok(result.rows[0].used_weight <= 600);
    return result.rows[0].used_weight;
  };
  const refreshRequestedAt = Date.now();
  const deferredHistory = await refreshBudgetAccount();
  assert.equal(deferredHistory.state, "fresh");
  assert.ok(
    Date.parse(deferredHistory.observation?.observedAt ?? "") >=
      refreshRequestedAt,
  );
  assert.equal(deferredHistory.observation?.perpsCash?.state, "verified");
  assert.equal(deferredHistory.history.executionsObservedAt, null);
  assert.equal(deferredHistory.history.fillRepair?.lastSuccessAt, null);
  assert.equal(deferredHistory.history.fillRepair?.coveredThrough, null);
  assert.equal(
    deferredHistory.history.fillRepair?.lastError,
    "budget_exhausted",
  );
  assert.equal(deferredHistory.history.allTimeComplete, false);
  assert.deepEqual(budgetRequests, [
    "userRole",
    "userAbstraction",
    "spotMeta",
    "spotClearinghouseState",
    "clearinghouseState",
    "userAbstraction",
  ]);
  assert.equal(await usedBudgetWeight(), 424);

  const expireBudgetWindow = () =>
    pool.query(
      `update hip4_request_budget
       set admissions=jsonb_build_array(jsonb_build_object(
         'at',extract(epoch from statement_timestamp())-61,'weight',600))
       where scope='public-info'`,
    );
  await expireBudgetWindow();
  budgetRequests.length = 0;
  assert.equal(
    await admitHip4Request(pool, "mainnet", 20, 600, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  const repairProgress = await refreshBudgetAccount();
  assert.equal(repairProgress.state, "fresh");
  assert.equal(repairProgress.observation?.perpsCash?.state, "verified");
  assert.equal(
    budgetRequests.filter((type) => type === "userFillsByTime").length,
    1,
  );
  assert.equal(budgetRequests.includes("userFills"), true);
  assert.equal(
    repairProgress.history.executionsObservedAt != null,
    true,
    "a separately successful live tail publishes its own observation",
  );
  assert.deepEqual(repairRequests[0], {
    startTime: deferredHistory.history.fillRepair?.nextTime,
    endTime: deferredHistory.history.fillRepair?.endTime,
  });
  assert.ok(repairProgress.history.fillRepair?.lastSuccessAt);
  assert.equal(repairProgress.history.fillRepair?.pagesRead, 1);
  assert.equal(repairProgress.history.fillRepair?.nextTime, null);
  assert.equal(
    repairProgress.history.fillRepair?.coveredThrough,
    deferredHistory.history.fillRepair?.endTime,
    "repair exhausts only its original fixed provider-visible interval",
  );
  assert.equal(repairProgress.history.allTimeComplete, false);
  assert.equal(await usedBudgetWeight(), 250);
  assert.equal(
    repairProgress.history.positionAccounting?.positions[0].costBasis,
    null,
    "initial ledger catch-up exhausts its older fixed range, not the newer snapshot",
  );

  await expireBudgetWindow();
  budgetRequests.length = 0;
  assert.equal(
    await admitHip4Request(pool, "mainnet", 20, 600, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  const tailProgress = await refreshBudgetAccount();
  assert.ok(tailProgress.history.executionsObservedAt);
  assert.equal(budgetRequests.filter((type) => type === "userFills").length, 1);
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.ok(
    Date.parse(tailProgress.history.fillRepair?.lastSuccessAt ?? "") >=
      Date.parse(repairProgress.history.fillRepair?.lastSuccessAt ?? ""),
  );
  const tailCoveredThrough = tailProgress.history.fillRepair?.coveredThrough;
  const repairCoveredThrough =
    repairProgress.history.fillRepair?.coveredThrough;
  assert.ok(tailCoveredThrough != null && repairCoveredThrough != null);
  assert.ok(tailCoveredThrough >= repairCoveredThrough);
  assert.equal(await usedBudgetWeight(), 250);
  assert.equal(
    tailProgress.history.positionAccounting?.positions[0].costBasis,
    "1.01",
  );

  // An admitted failing repair retains its entire 120-weight reservation.
  // Rotation is scheduling state, not a successful-observation timestamp, so
  // that failure cannot deny a healthy live tail in every subsequent window.
  await expireBudgetWindow();
  budgetRequests.length = 0;
  failingHistoryRequest = "userFillsByTime";
  const failedRepair = await refreshBudgetAccount();
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(failedRepair.history.fillRepair?.lastError, "http_error");
  assert.equal(
    failedRepair.history.fillRepair?.lastSuccessAt,
    tailProgress.history.fillRepair?.lastSuccessAt,
  );
  assert.equal(
    failedRepair.history.fillRepair?.coveredThrough,
    tailProgress.history.fillRepair?.coveredThrough,
  );
  assert.equal(
    failedRepair.history.executionsObservedAt,
    tailProgress.history.executionsObservedAt,
  );
  const failedRepairRequest = repairRequests.at(-1);
  assert.equal(await usedBudgetWeight(), 309);

  await expireBudgetWindow();
  budgetRequests.length = 0;
  failingHistoryRequest = null;
  const tailAfterFailedRepair = await refreshBudgetAccount();
  assert.equal(budgetRequests.includes("userFills"), true);
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.ok(tailAfterFailedRepair.history.executionsObservedAt);
  assert.equal(
    tailAfterFailedRepair.history.fillRepair?.nextTime,
    null,
    "exact successful tail settlement leaves room for the bounded repair retry",
  );
  assert.deepEqual(repairRequests.at(-1), failedRepairRequest);
  assert.equal(await usedBudgetWeight(), 230);

  await expireBudgetWindow();
  budgetRequests.length = 0;
  const repairedAfterFailure = await refreshBudgetAccount();
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userFills"), true);
  assert.equal(repairedAfterFailure.history.fillRepair?.lastError, null);
  assert.equal(repairedAfterFailure.history.fillRepair?.nextTime, null);
  assert.equal(await usedBudgetWeight(), 230);

  // The reverse direction is equally important: admitted tail HTTP failures
  // cannot pin all following refreshes ahead of healthy bounded repair.
  await expireBudgetWindow();
  budgetRequests.length = 0;
  failingHistoryRequest = "userFills";
  const failedTail = await refreshBudgetAccount();
  assert.equal(budgetRequests.includes("userFills"), true);
  assert.equal(budgetRequests.includes("userFillsByTime"), false);
  assert.match(failedTail.error ?? "", /fills_http_error/u);
  assert.equal(
    failedTail.history.executionsObservedAt,
    repairedAfterFailure.history.executionsObservedAt,
  );
  assert.equal(await usedBudgetWeight(), 309);

  await expireBudgetWindow();
  budgetRequests.length = 0;
  failingHistoryRequest = null;
  const repairAfterFailedTail = await refreshBudgetAccount();
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userFills"), true);
  assert.equal(repairAfterFailedTail.history.fillRepair?.lastError, null);
  assert.equal(repairAfterFailedTail.history.fillRepair?.nextTime, null);
  assert.ok(repairAfterFailedTail.history.executionsObservedAt);
  assert.equal(repairAfterFailedTail.history.allTimeComplete, false);
  assert.equal(await usedBudgetWeight(), 230);

  for (let cycle = 0; cycle < 2; cycle++) {
    await expireBudgetWindow();
    assert.equal(
      await admitHip4Request(pool, "mainnet", 20, 600, {
        scope: "background_repair",
        maximum: 220,
        backgroundMaximum: 300,
      }),
      true,
    );
    const currentBasis = await refreshBudgetAccount();
    assert.equal(
      currentBasis.history.positionAccounting?.positions[0].costBasis,
      "1.01",
      "both consecutive normal core cycles retain exact verified basis alongside indexer work",
    );
    assert.equal(
      currentBasis.history.positionAccounting?.observedAt,
      currentBasis.observation?.observedAt,
    );
    assert.equal(await usedBudgetWeight(), 250);
  }

  // A worker must also make history progress while catalog capacity remains
  // reserved. Alternate real cash observations with independently bound
  // history-only work; never persist an old cash value as newly observed.
  await pool.query("insert into users(id,is_active) values($1,true)", [
    backgroundOwnerId,
  ]);
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [backgroundOwnerId, budgetAddress],
  );
  let backgroundMode = "disabled";
  let backgroundRole = "user";
  let backgroundLegacy: unknown = null;
  let changeLegacyDuringSpot = false;
  let cappedBackgroundFills = false;
  const backgroundFetcher: typeof fetch = async (url, options) => {
    const request = JSON.parse(String(options?.body));
    if (
      cappedBackgroundFills &&
      ["userFills", "userFillsByTime"].includes(request.type)
    ) {
      budgetRequests.push(request.type);
      const time =
        request.type === "userFillsByTime" ? request.startTime : fill.time;
      return Response.json(
        Array.from({ length: 2000 }, () => ({ ...fill, time })),
      );
    }
    if (request.type === "userRole") {
      budgetRequests.push(request.type);
      return Response.json(
        backgroundRole === "agent"
          ? { role: "agent", data: { user: address } }
          : { role: backgroundRole },
      );
    }
    if (request.type === "userAbstraction") {
      budgetRequests.push(request.type);
      return Response.json(backgroundMode);
    }
    if (request.type === "userDexAbstraction") {
      budgetRequests.push(request.type);
      return Response.json(backgroundLegacy);
    }
    if (request.type === "borrowLendUserState") {
      budgetRequests.push(request.type);
      return Response.json({
        tokenToState: [],
        health: "healthy",
        healthFactor: null,
      });
    }
    if (request.type === "spotClearinghouseState" && changeLegacyDuringSpot)
      backgroundLegacy = true;
    return budgetFetcher(url, options);
  };
  const runBackground = async (readPolicy = budgetPolicy.readPolicy) => {
    await expireBudgetWindow();
    budgetRequests.length = 0;
    const startedAt = new Date();
    const backgroundLease = await claimHip4AccountRefresh(
      pool,
      "mainnet",
      budgetAddress,
      budgetPolicy.accountPolicy.leaseMs,
      startedAt,
    );
    assert.ok(backgroundLease);
    const result = await refreshHip4OwnedAccount({
      pool,
      address: budgetAddress,
      lease: backgroundLease,
      policy: readPolicy,
      accountPolicy: budgetPolicy.accountPolicy,
      now: startedAt.getTime(),
      fetcher: backgroundFetcher,
      background: true,
      requireCurrentOwner: true,
    });
    assert.equal(result.saved, true);
    const snapshot = await readHip4AccountSnapshot(
      pool,
      "mainnet",
      budgetAddress,
    );
    assert.ok(snapshot);
    return { result, snapshot };
  };
  // Atomic background admission must preserve the existing explicit recovery
  // path. Standard mandatory cash costs124 and fits a160 global ceiling even
  // though an unknown-mode background reservation must conservatively need182.
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [backgroundOwnerId, smallBudgetAddress],
  );
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    { ...budgetPolicy.readPolicy, requestWeightPerMinute: 160 },
  ]);
  let smallBudgetMode = "disabled";
  const smallBudgetRequests: string[] = [];
  const smallBudgetFetcher: typeof fetch = async (url, options) => {
    const request = JSON.parse(String(options?.body));
    smallBudgetRequests.push(request.type);
    if (request.type === "userAbstraction")
      return Response.json(smallBudgetMode);
    if (request.type === "spotClearinghouseState")
      return Response.json({
        balances: [
          {
            coin: "USDC",
            token: 0,
            total: "3.25",
            hold: "0",
            entryNtl: "0",
          },
        ],
      });
    return backgroundFetcher(url, options);
  };
  const smallBudgetService = createHip4OwnedAccountService(
    pool,
    smallBudgetFetcher,
  );
  const smallPolicy = await smallBudgetService.policy();
  const explicitSmallRefresh = () =>
    smallBudgetService.load(
      smallBudgetAddress,
      smallPolicy.readPolicy,
      smallPolicy.accountPolicy,
      smallPolicy.revision,
      true,
    );
  await expireBudgetWindow();
  const smallStandard = await explicitSmallRefresh();
  assert.equal(smallStandard.state, "fresh");
  assert.equal(smallStandard.observation?.mode, "disabled");
  assert.equal(smallStandard.observation?.cash.ownedCash, "3.25");
  assert.equal(smallStandard.observation?.perpsCash?.state, "verified");
  assert.deepEqual(smallBudgetRequests, [
    "userRole",
    "userAbstraction",
    "spotMeta",
    "spotClearinghouseState",
    "clearinghouseState",
    "userAbstraction",
  ]);
  assert.equal(await usedBudgetWeight(), 124);
  assert.match(smallStandard.error ?? "", /budget_exhausted/u);
  const smallStored = await readHip4AccountSnapshot(
    pool,
    "mainnet",
    smallBudgetAddress,
  );
  assert.deepEqual(smallStored?.observation, smallStandard.observation);
  await expireBudgetWindow();
  smallBudgetRequests.length = 0;
  const smallStartedAt = new Date();
  const smallLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    smallBudgetAddress,
    smallPolicy.accountPolicy.leaseMs,
    smallStartedAt,
  );
  assert.ok(smallLease);
  const smallBackground = await refreshHip4OwnedAccount({
    pool,
    address: smallBudgetAddress,
    lease: smallLease,
    policy: smallPolicy.readPolicy,
    accountPolicy: smallPolicy.accountPolicy,
    now: smallStartedAt.getTime(),
    fetcher: smallBudgetFetcher,
    background: true,
    requireCurrentOwner: true,
  });
  assert.equal(smallBackground.saved, true);
  assert.ok(smallBackground.errors.includes("budget_exhausted"));
  assert.deepEqual(smallBudgetRequests, []);
  assert.equal(await usedBudgetWeight(), 0);

  // Default's actual182 requirement never fitted160. A failed explicit
  // attempt must retain the old verified Standard snapshot, not relabel it.
  await expireBudgetWindow();
  smallBudgetMode = "default";
  const smallDefault = await explicitSmallRefresh();
  assert.match(smallDefault.error ?? "", /budget_exhausted/u);
  assert.deepEqual(smallDefault.observation, smallStandard.observation);
  assert.deepEqual(smallBudgetRequests, [
    "userRole",
    "userAbstraction",
    "userDexAbstraction",
    "borrowLendUserState",
    "spotMeta",
    "spotClearinghouseState",
  ]);
  assert.equal(await usedBudgetWeight(), 142);

  // refresh=false on an authenticated account request means honor its TTL,
  // not background priority. Existing optional repair usage must not strand a
  // stale foreground account when the global interactive budget still fits.
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    {
      ...budgetPolicy.readPolicy,
      requestWeightPerMinute: 1200,
      interactiveRequestWeightReserveRatio: 0.75,
    },
  ]);
  const priorityPolicy = await smallBudgetService.policy();
  const staleDefault = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date(
      Date.now() - priorityPolicy.accountPolicy.snapshotMaxAgeMs - 1000,
    ).toISOString(),
    role: "user",
    mode: "default",
    quote,
    state: {
      balances: [
        { coin: "USDC", token: 0, total: "3.25", hold: "0", entryNtl: "0" },
      ],
    },
    defaultSpotCashEvidence: {
      legacyDexAbstraction: null,
      borrowLendState: {
        tokenToState: [],
        health: "healthy",
        healthFactor: null,
      },
    },
  });
  const staleLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    smallBudgetAddress,
    priorityPolicy.accountPolicy.leaseMs,
    new Date(),
  );
  assert.ok(staleLease);
  assert.equal(
    await persistHip4AccountRefresh(pool, {
      environment: "mainnet",
      address: smallBudgetAddress,
      lease: staleLease,
      observation: staleDefault,
      executions: [],
      ledger: [],
      history: { nextBackgroundRead: "cash" },
      error: null,
    }),
    true,
  );
  await expireBudgetWindow();
  assert.equal(
    await admitHip4Request(pool, "mainnet", 137, 1200, {
      scope: "background_repair",
      maximum: 220,
      backgroundMaximum: 300,
    }),
    true,
  );
  assert.equal(
    await admitHip4Request(pool, "mainnet", 80, 1200, {
      scope: "background_catalog",
      maximum: 300,
      backgroundMaximum: 300,
    }),
    true,
  );
  smallBudgetRequests.length = 0;
  const priorityBackgroundStartedAt = new Date();
  const priorityBackgroundLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    smallBudgetAddress,
    priorityPolicy.accountPolicy.leaseMs,
    priorityBackgroundStartedAt,
  );
  assert.ok(priorityBackgroundLease);
  const priorityBackground = await refreshHip4OwnedAccount({
    pool,
    address: smallBudgetAddress,
    lease: priorityBackgroundLease,
    policy: priorityPolicy.readPolicy,
    accountPolicy: priorityPolicy.accountPolicy,
    now: priorityBackgroundStartedAt.getTime(),
    fetcher: smallBudgetFetcher,
    background: true,
    requireCurrentOwner: true,
  });
  assert.ok(priorityBackground.errors.includes("budget_exhausted"));
  assert.deepEqual(smallBudgetRequests, []);
  assert.equal(await usedBudgetWeight(), 217);
  const foregroundStartedAt = Date.now();
  const ordinaryForeground = await smallBudgetService.load(
    smallBudgetAddress,
    priorityPolicy.readPolicy,
    priorityPolicy.accountPolicy,
    priorityPolicy.revision,
    false,
  );
  assert.equal(ordinaryForeground.state, "fresh");
  assert.equal(ordinaryForeground.observation?.mode, "default");
  assert.equal(ordinaryForeground.observation?.cash.ownedCash, "3.25");
  assert.deepEqual(ordinaryForeground.observation?.positions, []);
  assert.ok(
    Date.parse(ordinaryForeground.observation?.observedAt ?? "") >=
      foregroundStartedAt,
  );
  assert.deepEqual(smallBudgetRequests.slice(0, 8), [
    "userRole",
    "userAbstraction",
    "userDexAbstraction",
    "borrowLendUserState",
    "spotMeta",
    "spotClearinghouseState",
    "userAbstraction",
    "userDexAbstraction",
  ]);
  const priorityStored = await readHip4AccountSnapshot(
    pool,
    "mainnet",
    smallBudgetAddress,
  );
  assert.deepEqual(priorityStored?.observation, ordinaryForeground.observation);
  const foregroundCallCount = smallBudgetRequests.length;
  const stillFresh = await smallBudgetService.load(
    smallBudgetAddress,
    priorityPolicy.readPolicy,
    priorityPolicy.accountPolicy,
    priorityPolicy.revision,
    false,
  );
  assert.deepEqual(stillFresh.observation, ordinaryForeground.observation);
  assert.equal(smallBudgetRequests.length, foregroundCallCount);
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    budgetPolicy.readPolicy,
  ]);
  await expireBudgetWindow();

  const backgroundCash = await runBackground();
  assert.equal(backgroundCash.snapshot.history.nextBackgroundRead, "history");
  assert.equal(budgetRequests.includes("spotClearinghouseState"), true);
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), false);
  assert.ok(backgroundCash.snapshot.history.ledgerRepair?.lastSuccessAt);
  assert.equal(await usedBudgetWeight(), 189);
  const cashObservation = backgroundCash.snapshot.observation;
  await pool.query(
    "update hip4_account_snapshots set attempt_error='cash_read_failed' where environment='mainnet' and account_address=$1",
    [budgetAddress],
  );
  const backgroundHistory = await runBackground();
  assert.equal(backgroundHistory.snapshot.history.nextBackgroundRead, "cash");
  assert.deepEqual(
    backgroundHistory.snapshot.observation,
    cashObservation,
    "history-only work preserves the exact cash observation and its timestamp",
  );
  assert.equal(backgroundHistory.snapshot.attempt_error, "cash_read_failed");
  assert.equal(budgetRequests.includes("spotMeta"), false);
  assert.equal(budgetRequests.includes("spotClearinghouseState"), false);
  assert.equal(budgetRequests.includes("clearinghouseState"), false);
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userRole"), false);
  assert.equal(budgetRequests.includes("userAbstraction"), false);
  assert.equal(
    repairRequests.at(-1)?.endTime,
    Date.parse(cashObservation.observedAt),
    "historical reads stop at the exact retained snapshot, not the current clock",
  );
  assert.equal(await usedBudgetWeight(), 65);
  for (let pair = 0; pair < 2; pair++)
    assert.equal(
      await admitHip4Request(pool, "mainnet", 40, 600, {
        scope: "background_catalog",
        maximum: 300,
        backgroundMaximum: 300,
      }),
      true,
    );
  assert.equal(await usedBudgetWeight(), 145);
  const backgroundCashAgain = await runBackground();
  assert.equal(backgroundCashAgain.snapshot.attempt_error, null);
  assert.equal(
    backgroundCashAgain.snapshot.history.nextFillRead,
    backgroundHistory.snapshot.history.nextFillRead,
    "cash-only phases cannot consume the tail/repair rotation hint",
  );
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), false);
  const backgroundRepair = await runBackground();
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.ok(backgroundRepair.snapshot.history.fillRepair?.lastSuccessAt);
  assert.deepEqual(
    backgroundRepair.snapshot.observation,
    backgroundCashAgain.snapshot.observation,
  );
  assert.equal(await usedBudgetWeight(), 65);

  // A 300-weight repair quota fits the old 284 estimate, but not a Standard
  // cash144 + capped fills120 + conservative ledger45 = 309 bundle. A capped
  // page never gets a small-response settlement; splitting must still let the
  // independent ledger make progress without fabricating fill completeness.
  const middleBudgetPolicy = {
    ...budgetPolicy.readPolicy,
    requestWeightPerMinute: 800,
    backgroundRequestWeightPerMinute: 380,
  };
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    middleBudgetPolicy,
  ]);
  cappedBackgroundFills = true;
  const middleCash = await runBackground(middleBudgetPolicy);
  assert.equal(middleCash.snapshot.history.nextBackgroundRead, "history");
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), false);
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), true);
  assert.equal(await usedBudgetWeight(), 189);
  const middleHistory = await runBackground(middleBudgetPolicy);
  assert.equal(budgetRequests.includes("spotClearinghouseState"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), true);
  assert.equal(await usedBudgetWeight(), 165);
  assert.deepEqual(
    middleHistory.snapshot.observation,
    middleCash.snapshot.observation,
  );
  assert.equal(
    middleHistory.snapshot.history.fillRepair?.coveredThrough,
    middleCash.snapshot.history.fillRepair?.coveredThrough,
  );
  assert.equal(middleHistory.snapshot.history.fillRepair?.gapCount > 0, true);
  assert.equal(middleHistory.snapshot.history.ledgerRepair?.lastError, null);
  assert.ok(
    middleHistory.snapshot.history.ledgerRepair?.coveredThrough >=
      Date.parse(middleCash.snapshot.observation.observedAt),
  );
  backgroundMode = "default";
  const middleDefaultCash = await runBackground(middleBudgetPolicy);
  assert.equal(
    middleDefaultCash.snapshot.history.nextBackgroundRead,
    "history",
  );
  assert.equal(budgetRequests.includes("userFills"), false);
  assert.equal(budgetRequests.includes("userFillsByTime"), false);
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), true);
  assert.equal(await usedBudgetWeight(), 247);
  const middleDefaultHistory = await runBackground(middleBudgetPolicy);
  assert.deepEqual(
    middleDefaultHistory.snapshot.observation,
    middleDefaultCash.snapshot.observation,
  );
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), true);
  assert.equal(await usedBudgetWeight(), 165);
  cappedBackgroundFills = false;
  backgroundMode = "disabled";
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[0],
    budgetPolicy.readPolicy,
  ]);

  // A historical pass remains bound to its old observation even if the current
  // mode changed. It does not observe or authorize current cash in that mode.
  await runBackground(); // cash phase makes history the next phase
  backgroundMode = "unifiedAccount";
  const changedBinding = await runBackground();
  assert.deepEqual(budgetRequests, [
    "userFillsByTime",
    "userNonFundingLedgerUpdates",
  ]);
  assert.equal(changedBinding.result.errors.length, 0);
  assert.equal(changedBinding.snapshot.history.nextBackgroundRead, "cash");
  assert.equal(changedBinding.snapshot.observation?.mode, "disabled");
  backgroundMode = "disabled";
  await runBackground();
  backgroundMode = "default";
  await runBackground(); // historical disabled snapshot, next current cash phase
  const defaultCash = await runBackground();
  assert.equal(defaultCash.snapshot.observation?.mode, "default");
  assert.equal(defaultCash.snapshot.observation?.cash.ownedCash, "0");
  assert.equal(
    defaultCash.snapshot.observation?.perpsCash?.state,
    "unsupported",
  );
  assert.equal(
    budgetRequests.filter((type) => type === "userDexAbstraction").length,
    2,
  );
  assert.equal(budgetRequests.includes("borrowLendUserState"), true);
  assert.equal(budgetRequests.includes("clearinghouseState"), false);
  assert.equal(
    budgetRequests.includes("frontendOpenOrders"),
    true,
    "current open-order display stays in the current cash phase and background budget",
  );
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), false);
  assert.equal(await usedBudgetWeight(), 202);
  const defaultHistory = await runBackground();
  assert.equal(budgetRequests.includes("frontendOpenOrders"), false);
  assert.equal(budgetRequests.includes("borrowLendUserState"), false);
  assert.equal(
    budgetRequests.includes("userFills") ||
      budgetRequests.includes("userFillsByTime"),
    true,
  );
  assert.deepEqual(
    defaultHistory.snapshot.observation,
    defaultCash.snapshot.observation,
    "history-only work never renews qualified cash proof",
  );
  const retainedOpenOrders = defaultHistory.snapshot.history.openOrders;
  await pool.query(
    `update hip4_account_snapshots set history=jsonb_set(
       jsonb_set(jsonb_set(history,'{nextBackgroundRead}','"history"'::jsonb),
         '{nextFillRead}','"repair"'::jsonb),
       '{ledgerRepair,coveredThrough}',to_jsonb($2::bigint))
     where environment='mainnet' and account_address=$1`,
    [
      budgetAddress,
      Date.parse(defaultCash.snapshot.observation.observedAt) - 1,
    ],
  );
  const ledgerCatchUp = await runBackground();
  assert.equal(
    budgetRequests.includes("frontendOpenOrders"),
    false,
    "ledger coverage needed for the held balance snapshot precedes optional order history",
  );
  assert.equal(budgetRequests.includes("userFillsByTime"), true);
  assert.equal(budgetRequests.includes("userNonFundingLedgerUpdates"), true);
  assert.equal(await usedBudgetWeight(), 65);
  assert.ok(
    ledgerCatchUp.snapshot.history.ledgerRepair.coveredThrough >=
      Date.parse(defaultCash.snapshot.observation.observedAt),
  );
  assert.deepEqual(
    ledgerCatchUp.snapshot.history.openOrders,
    retainedOpenOrders,
    "deferral preserves the prior list rather than publishing empty orders or new holds",
  );
  assert.deepEqual(
    ledgerCatchUp.snapshot.observation,
    defaultCash.snapshot.observation,
  );
  const resumedCash = await runBackground(); // cash phase
  assert.equal(budgetRequests.includes("frontendOpenOrders"), true);
  await runBackground(); // historical phase keeps its own exact range
  assert.equal(budgetRequests.includes("frontendOpenOrders"), false);
  changeLegacyDuringSpot = true;
  const changedLegacy = await runBackground();
  assert.deepEqual(
    changedLegacy.snapshot.observation,
    resumedCash.snapshot.observation,
    "changed legacy selector cannot publish freshly qualified cash",
  );
  assert.equal(changedLegacy.result.errors.length > 0, true);
  changeLegacyDuringSpot = false;
  backgroundLegacy = null;
  await runBackground(); // history-only, preserving failed core-read status
  const recoveredDefault = await runBackground();
  assert.equal(
    recoveredDefault.snapshot.attempt_error,
    "ledger_budget_exhausted",
  );
  assert.equal(recoveredDefault.snapshot.observation?.cash.ownedCash, "0");
  backgroundMode = "disabled";
  await runBackground(); // historical default snapshot, no cash reuse
  await runBackground(); // fresh disabled cash
  await runBackground(); // historical disabled snapshot, no current role inference
  backgroundRole = "agent";
  const rejectedRole = await runBackground();
  assert.deepEqual(budgetRequests, ["userRole"]);
  assert.ok(rejectedRole.result.errors.includes("unsupported_account_role"));
  backgroundRole = "user";
  await runBackground();
  await pool.query("update users set is_active=false where id=$1", [
    backgroundOwnerId,
  ]);
  const rejectedOwner = await runBackground();
  assert.deepEqual(budgetRequests, [], "ownership loss makes zero HTTP calls");
  assert.ok(
    rejectedOwner.result.errors.some((error) =>
      error.includes("account_owner_unavailable"),
    ),
  );

  // A complete tail can bridge a long idle interval, but every intervening
  // economic fact must survive the moving lookback filter. A same-size exit
  // and re-entry before the new display window cannot retain the old basis.
  await pool.query("update users set is_active=true where id=$1", [
    backgroundOwnerId,
  ]);
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [backgroundOwnerId, longGapAddress],
  );
  const gapNow = Date.now();
  const oldEnd = gapNow - 90000;
  const gapBuy = { ...fill, time: gapNow - 120000, tid: 10001, oid: 10001 };
  const gapSell = {
    ...fill,
    time: gapNow - 80000,
    tid: 10002,
    oid: 10002,
    dir: "Sell",
    side: "A",
    startPosition: "2",
    px: "0.6",
  };
  const gapReentry = {
    ...fill,
    time: gapNow - 70000,
    tid: 10003,
    oid: 10003,
    px: "0.7",
    fee: "0.02",
  };
  const gapObservation = projectHip4Account({
    environment: "mainnet",
    observedAt: new Date(oldEnd).toISOString(),
    role: "user",
    mode: "disabled",
    quote,
    state: { balances: [{ ...position, total: "2", hold: "0" }] },
  });
  const gapLease = await claimHip4AccountRefresh(
    pool,
    "mainnet",
    longGapAddress,
    120000,
    new Date(),
  );
  assert.ok(gapLease);
  const gapHistory = {
    fillRepair: advanceHip4FillRepair(
      planHip4FillRepair(undefined, 60000, oldEnd, 32),
      [gapBuy],
      new Date(oldEnd).toISOString(),
      32,
    ),
    ledgerRepair: advanceHip4LedgerRepair(
      planHip4LedgerRepair(undefined, 60000, oldEnd, 32),
      [],
      new Date(oldEnd).toISOString(),
      32,
    ),
  };
  await persistHip4AccountRefresh(pool, {
    environment: "mainnet",
    address: longGapAddress,
    lease: gapLease,
    observation: gapObservation,
    executions: [projectHip4Execution("mainnet", longGapAddress, gapBuy)],
    executionSources: [gapBuy],
    ledger: [],
    history: gapHistory,
    error: null,
    accountingMaxRows: 100,
  });
  await expireBudgetWindow();
  const gapService = createHip4OwnedAccountService(
    pool,
    async (url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.user) assert.equal(request.user, longGapAddress);
      if (request.type === "userFills")
        return Response.json([gapBuy, gapSell, gapReentry]);
      return budgetFetcher(url, options);
    },
  );
  const gapResult = await gapService.load(
    longGapAddress,
    budgetPolicy.readPolicy,
    {
      ...budgetPolicy.accountPolicy,
      historyLookbackMs: 60000,
      historyRepairPagesPerRefresh: 0,
    },
    budgetPolicy.revision,
    true,
  );
  assert.equal(
    gapResult.history.positionAccounting?.positions[0].costBasis,
    "1.42",
  );
  assert.equal(
    gapResult.history.positionAccounting?.positions[0].anchorTime,
    gapReentry.time,
  );
  assert.deepEqual(
    gapResult.history.fillRepair,
    gapHistory.fillRepair,
    "tail coverage is not a rewritten ByTime cursor, even with range repair paused",
  );
  const preservedBridgeFacts = await pool.query(
    "select count(*)::int as count from hip4_account_executions where environment='mainnet' and account_address=$1 and time_ms>$2 and time_ms<$3",
    [longGapAddress, oldEnd, gapNow - 60000],
  );
  assert.equal(preservedBridgeFacts.rows[0].count, 2);

  // Exact private keyset scans, including sparse market filters and generic plans.
  await pool.query(
    `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
    select 'mainnet',$1,$2::bigint+fixture_row,'#87750',fixture_row+100,fixture_row+100,'hyperliquid:mainnet:outcome:8775',$3,'fixture'
    from generate_series(1,20000) fixture_row`,
    [address, now, JSON.stringify(entries[0])],
  );
  await pool.query("analyze hip4_account_executions");
  await pool.query("set plan_cache_mode=force_generic_plan");
  for (const [name, sql, parameters] of [
    [
      "account_page",
      HIP4_EXECUTION_PAGE_SQL,
      "text,text,bigint,text,bigint,bigint,int",
    ],
    [
      "account_market_page",
      HIP4_EXECUTION_MARKET_PAGE_SQL,
      "text,text,bigint,text,bigint,bigint,int,text",
    ],
  ]) {
    await pool.query(`prepare ${name}(${parameters}) as ${sql}`);
    for (const boundary of [Number.MAX_SAFE_INTEGER, now + 10000, 0]) {
      const plan = await pool.query(
        `explain (analyze,buffers,format json) execute ${name}('mainnet','${address}',${boundary},'~',9007199254740991,9007199254740991,31${name === "account_market_page" ? ",'hyperliquid:mainnet:outcome:8775'" : ""})`,
      );
      const result = plan.rows[0]["QUERY PLAN"][0];
      assert.ok(JSON.stringify(result.Plan).includes("Index"));
      assert.ok(result["Execution Time"] < 1000);
    }
  }
  await pool.query(
    "create temporary table p2_candidates(market_id text,venue text,event_id text)",
  );
  await pool.query(
    "insert into p2_candidates values('hyperliquid:mainnet:outcome:8775','hyperliquid','hip4-event')",
  );
  await pool.query(
    "create temporary table p2_tokens(market_id text,token_id text,venue text)",
  );
  const references = await pool.query(
    hip4AccountProtectedRefsSql("p2_candidates"),
  );
  assert.ok(
    references.rows.some((row) => row.reason === "hip4_account_executions"),
  );
  assert.ok(
    references.rows.some((row) => row.reason === "hip4_account_positions"),
  );
  console.log(
    "HIP4 owned account PG16: leases/replay/zero/failure/cursors/refresh/retention/generic plans PASS",
  );
} finally {
  await lifecycleFixture.close();
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    policyIds,
  ]);
  await pool.query(
    "delete from hip4_account_snapshots where account_address=any($1::text[])",
    [[address, budgetAddress, longGapAddress, smallBudgetAddress]],
  );
  await pool.query("delete from users where id=$1", [backgroundOwnerId]);
  await pool.end();
}
