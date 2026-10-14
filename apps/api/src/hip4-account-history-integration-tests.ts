// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { createHip4OwnedAccountService } from "./services/hip4-account-service.js";
import {
  readHip4AccountExecutions,
  readHip4AccountSnapshot,
} from "./services/hip4-account-repository.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=10000",
});
const address = "0x000000000000000000000000000000000000aaa2";
const lifecycle = await installHip4TestLifecycle(pool);
const policyIds = [randomUUID(), randomUUID()];
const now = Date.now();
const boundary = now - 600000;
const fill = (tid: number, time = boundary) => ({
  coin: "#87750",
  px: "0.5",
  sz: "2",
  side: "B",
  time,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: tid,
  crossed: true,
  fee: "0.01",
  tid,
  feeToken: "USDC",
});
const requests: { startTime: number; endTime: number }[] = [];
let pageResponse: unknown = [];
let pageBuilder: ((startTime: number) => unknown) | null = null;
let pageFails = false;
let nativeRole = "user";
let ledgerRows: unknown[] = [];
let ledgerFails = false;
const ledgerRequests: { startTime: number; endTime: number }[] = [];
let byTimeCalls = 0;
let captured = 0;
const provider = async (_url: unknown, options?: RequestInit) => {
  const request = JSON.parse(String(options?.body));
  assert.equal(request.user ?? address, address);
  if (request.type === "userNonFundingLedgerUpdates") {
    ledgerRequests.push(request);
    return ledgerFails
      ? new Response("unavailable", { status: 503 })
      : Response.json(ledgerRows);
  }
  if (request.type === "userFillsByTime") {
    byTimeCalls++;
    requests.push({ startTime: request.startTime, endTime: request.endTime });
    assert.equal(request.aggregateByTime, false);
    return pageFails
      ? new Response("failure", { status: 503 })
      : Response.json(
          pageBuilder ? pageBuilder(request.startTime) : pageResponse,
        );
  }
  const data: Record<string, unknown> = {
    userRole: { role: nativeRole },
    userAbstraction: "disabled",
    spotMeta: {
      tokens: [
        {
          name: "USDC",
          index: 0,
          weiDecimals: 8,
          szDecimals: 8,
          tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
        },
      ],
    },
    spotClearinghouseState: {
      balances: [{ coin: "+87750", total: "20", hold: "2", entryNtl: "10" }],
    },
    userFills: [fill(9000, now - 1)],
    userNonFundingLedgerUpdates: [],
    frontendOpenOrders: [],
  };
  assert.ok(request.type in data, request.type);
  return Response.json(data[request.type]);
};
const service = createHip4OwnedAccountService(pool, provider);
try {
  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [
      ...policyIds,
      JSON.stringify({ enabled: true, requestWeightPerMinute: 1200 }),
      JSON.stringify({ enabled: true }),
    ],
  );
  const configuration = await service.policy();
  const refresh = async (pages = 1) => {
    // Only this disposable DB; isolate test cases from the shared provider budget.
    await pool.query(
      "delete from hip4_request_budget where scope='public-info'",
    );
    return service.load(
      address,
      configuration.readPolicy,
      { ...configuration.accountPolicy, historyRepairPagesPerRefresh: pages },
      configuration.revision,
      true,
    );
  };

  // Non-HIP fills consume the same page cap. The two HIP fills at the tied
  // boundary must be replayed, and the third tied fill discovered next time.
  pageResponse = [
    ...Array.from({ length: 1998 }, (_, tid) => ({
      ...fill(tid, boundary - 1),
      coin: "@107",
    })),
    fill(1),
    fill(2),
  ];
  const first = await refresh();
  assert.equal(first.history.fillRepair?.nextTime, boundary);
  assert.equal(first.history.fillRepair?.pagesRead, 1);
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 100)).items
      .length,
    3,
  );
  assert.equal(first.observation?.positions[0].quantity, "20");

  pageFails = true;
  const failed = await refresh();
  assert.equal(failed.state, "fresh");
  assert.equal(failed.history.fillRepair?.nextTime, boundary);
  assert.equal(failed.history.fillRepair?.lastError, "http_error");
  assert.equal(
    failed.history.fillRepair?.lastSuccessAt,
    first.history.fillRepair?.lastSuccessAt,
  );
  assert.equal(failed.history.fillRepair?.pagesRead, 1);

  pageFails = false;
  pageResponse = [fill(1), fill(2), fill(3), fill(4, boundary + 1)];
  const recovered = await refresh();
  assert.equal(recovered.history.fillRepair?.nextTime, null);
  assert.equal(recovered.history.fillRepair?.pagesRead, 2);
  assert.equal(recovered.history.fillRepair?.lastError, null);
  assert.equal(recovered.history.allTimeComplete, false);
  assert.equal(requests[1].startTime, boundary);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(requests[0].endTime, requests[2].endTime);
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 100)).items
      .length,
    5,
  );

  captured = byTimeCalls;
  await refresh(0);
  assert.equal(byTimeCalls, captured);
  assert.deepEqual(
    (await readHip4AccountSnapshot(pool, "mainnet", address))?.history
      .fillRepair,
    recovered.history.fillRepair,
  );

  // A new scan overlaps the previous end. An invalid HIP fill cannot advance
  // its cursor or wipe the independently valid current balance.
  pageResponse = [{ ...fill(99, requests[0].endTime), px: "2" }];
  const malformed = await refresh();
  assert.equal(
    malformed.history.fillRepair?.nextTime,
    recovered.history.fillRepair?.endTime,
  );
  assert.equal(
    malformed.history.fillRepair?.lastError,
    "invalid_account_response",
  );
  assert.equal(malformed.observation?.positions[0].quantity, "20");
  assert.equal(
    (await readHip4AccountExecutions(pool, "mainnet", address, 100)).items
      .length,
    5,
  );

  // An unpageable millisecond is recorded without blocking later history.
  const stuck = malformed.history.fillRepair?.nextTime;
  assert.ok(stuck != null);
  pageResponse = Array.from({ length: 2000 }, (_, index) =>
    fill(10000 + index, stuck),
  );
  const saturated = await refresh();
  assert.equal(saturated.history.fillRepair?.gapCount, 1);
  assert.equal(saturated.history.fillRepair?.gaps[0].time, stuck);
  assert.equal(saturated.history.fillRepair?.nextTime, stuck + 1);

  await pool.query(
    "update runtime_policies set payload=jsonb_set(payload,'{requestWeightPerMinute}','262'::jsonb) where id=$1",
    [policyIds[0]],
  );
  captured = byTimeCalls;
  const deferred = await refresh();
  assert.equal(byTimeCalls, captured);
  assert.equal(deferred.history.fillRepair?.lastError, "budget_exhausted");
  assert.equal(
    deferred.history.fillRepair?.nextTime,
    saturated.history.fillRepair?.nextTime,
  );
  assert.equal(deferred.state, "fresh");
  await pool.query(
    "update runtime_policies set payload=jsonb_set(payload,'{requestWeightPerMinute}','1200'::jsonb) where id=$1",
    [policyIds[0]],
  );
  pageResponse = [];
  const budgetRecovered = await refresh();
  assert.equal(budgetRecovered.history.fillRepair?.lastError, null);
  assert.equal(budgetRecovered.history.fillRepair?.nextTime, null);

  // Test the policy page bound on a fresh range. Provider rows outside HIP
  // are still paginated, but never become phantom HIP executions/positions.
  await pool.query(
    "update hip4_account_snapshots set history=history-'fillRepair' where environment='mainnet' and account_address=$1",
    [address],
  );
  pageBuilder = (startTime) =>
    Array.from({ length: 2000 }, (_, tid) => ({
      time: startTime + 1,
      coin: "@107",
      tid,
    }));
  captured = byTimeCalls;
  const bounded = await refresh(2);
  assert.equal(byTimeCalls - captured, 2);
  assert.equal(bounded.history.fillRepair?.pagesRead, 2);
  assert.ok(bounded.history.fillRepair);
  assert.equal(
    bounded.history.fillRepair.nextTime,
    bounded.history.fillRepair.startTime + 2,
  );
  assert.equal(bounded.observation?.positions[0].quantity, "20");

  // Wrong native account role never refreshes historical facts from an alias.
  captured = byTimeCalls;
  nativeRole = "vault";
  const unsupported = await refresh();
  assert.equal(byTimeCalls, captured);
  assert.equal(unsupported.error, "unsupported_account_role");
  assert.deepEqual(unsupported.history.fillRepair, bounded.history.fillRepair);
  nativeRole = "user";
  pageBuilder = null;
  pageResponse = [];
  await pool.query(
    "update hip4_account_snapshots set history=history-'ledgerRepair' where environment='mainnet' and account_address=$1",
    [address],
  );
  ledgerRows = Array.from({ length: 500 }, (_, index) => ({
    time: boundary,
    hash: `0x${index.toString(16).padStart(64, "0")}`,
    delta: { type: "future_native_change", amount: String(index) },
  }));
  const ledgerFirst = await refresh(0);
  assert.equal(ledgerFirst.history.ledgerRepair?.nextTime, boundary);
  assert.equal(ledgerFirst.history.ledgerRepair?.pagesRead, 1);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from hip4_account_ledger where account_address=$1",
        [address],
      )
    ).rows[0].count,
    500,
  );
  ledgerFails = true;
  const ledgerFailed = await refresh(0);
  assert.equal(ledgerFailed.history.ledgerRepair?.lastError, "http_error");
  assert.equal(ledgerFailed.history.ledgerRepair?.nextTime, boundary);
  assert.equal(
    ledgerFailed.history.ledgerObservedAt,
    ledgerFirst.history.ledgerObservedAt,
  );
  ledgerFails = false;
  ledgerRows = ledgerRows.slice(-2);
  const ledgerRecovered = await refresh(0);
  assert.equal(ledgerRequests.at(-1)?.startTime, boundary);
  assert.equal(
    ledgerRequests.at(-1)?.endTime,
    ledgerFirst.history.ledgerRepair?.endTime,
  );
  assert.equal(ledgerRecovered.history.ledgerRepair?.nextTime, null);
  assert.equal(ledgerRecovered.history.ledgerRepair?.lastError, null);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as count from hip4_account_ledger where account_address=$1",
        [address],
      )
    ).rows[0].count,
    500,
    "overlapping ledger pages do not duplicate events",
  );
  console.log(
    "HIP4 PG16 history: inclusive boundary / replay / recovery / pause / invalid fill / saturation / budget / page bound / role PASS",
  );
} finally {
  await lifecycle.close();
  await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
    policyIds,
  ]);
  await pool.query(
    "delete from hip4_account_snapshots where account_address=$1",
    [address],
  );
  await pool.end();
}
