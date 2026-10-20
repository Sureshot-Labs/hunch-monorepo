// @requires-db
import assert from "node:assert/strict";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./services/hip4-account-projection.js";
import {
  claimHip4AccountRefresh,
  persistHip4AccountRefresh,
  readHip4AccountSnapshot,
  HIP4_ACCOUNT_REFRESH_LOCK_SQL,
} from "./services/hip4-account-repository.js";
import {
  planHip4FillRepair,
  advanceHip4FillRepair,
  planHip4LedgerRepair,
  advanceHip4LedgerRepair,
} from "./services/hip4-account-history.js";
import {
  HIP4_BASIS_FILLS_SQL,
  HIP4_BASIS_LEDGER_SQL,
  readHip4PositionAccounting,
} from "./services/hip4-accounting-repository.js";
import { HIP4_BASIS_CASH_RECEIPTS_SQL } from "./services/hip4-cash-ledger-evidence.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { verifyRelayHypercoreTransfer } from "./funding-providers/relay/hypercore-transfer-evidence.js";
import { projectHip4PortfolioPositions } from "./services/hip4-portfolio-positions.js";
import type { Hip4AccountObservation } from "./schemas/hip4-account.js";
import { proveHip4FillTailCoverage } from "./services/hip4-tail-history.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const address = "0x00000000000000000000000000000000000018a2";
const now = Date.now();
const at = new Date(now).toISOString();
const fill = {
  coin: "#87750",
  px: "0.4",
  sz: "10",
  side: "B",
  time: now - 3000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "999",
  hash: `0x${"a".repeat(64)}`,
  oid: 1,
  tid: 1,
  crossed: true,
  fee: "0.1",
  feeToken: "USDC",
};
const second = {
  ...fill,
  time: now - 2000,
  tid: 2,
  oid: 2,
  px: "0.6",
  startPosition: "10",
};
const sale = {
  ...fill,
  time: now - 1000,
  tid: 3,
  oid: 3,
  px: "0.8",
  startPosition: "20",
  dir: "Sell",
  side: "A",
  sz: "5",
  fee: "0.05",
};
const sources = [fill, second, sale];
const observation = projectHip4Account({
  environment: "testnet",
  observedAt: at,
  role: "user",
  mode: "disabled",
  quote: { index: 0, tokenId: "exact-quote", weiDecimals: 8 },
  state: {
    balances: [{ coin: "+87750", total: "15", hold: "0", entryNtl: "999" }],
  },
});
const history = {
  fillRepair: advanceHip4FillRepair(
    planHip4FillRepair(undefined, 60000, now, 32),
    sources,
    at,
    32,
  ),
  ledgerRepair: advanceHip4LedgerRepair(
    planHip4LedgerRepair(undefined, 60000, now, 32),
    [],
    at,
    32,
  ),
};
async function save(
  fills = sources,
  maxRows = 100,
  observed: Hip4AccountObservation | null = observation,
  savedHistory: Record<string, unknown> = history,
) {
  const lease = await claimHip4AccountRefresh(
    pool,
    "testnet",
    address,
    60000,
    new Date(),
  );
  assert.ok(lease);
  assert.equal(
    await persistHip4AccountRefresh(pool, {
      environment: "testnet",
      address,
      lease,
      observation: observed,
      executions: fills.map((row) =>
        projectHip4Execution("testnet", address, row),
      ),
      executionSources: fills,
      ledger: [],
      history: savedHistory,
      error: null,
      accountingMaxRows: maxRows,
    }),
    true,
  );
  const snapshot = await readHip4AccountSnapshot(pool, "testnet", address);
  assert.ok(snapshot);
  return snapshot;
}
try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  const first = await save();
  assert.equal(first.history.positionAccounting.positions[0].costBasis, "7.65");
  assert.equal(
    first.history.positionAccounting.positions[0].realizedSinceAnchor,
    "1.4",
  );
  const positions = projectHip4PortfolioPositions({
    userId: "synthetic",
    address,
    environment: "testnet",
    observation,
    accounting: first.history.positionAccounting,
    markets: new Map(),
    snapshotMaxAgeMs: 60000,
    now,
  });
  assert.equal(positions[0].costBasisRaw, "7.65");
  assert.equal(positions[0].averagePriceRaw, "0.51");
  assert.equal(positions[0].unrealizedPnl, null); // no market mark
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  const laggingHistory = {
    ...history,
    fillRepair: { ...history.fillRepair, coveredThrough: now - 1 },
  };
  const lagging = await save(sources, 100, observation, laggingHistory);
  assert.equal(
    lagging.history.positionAccounting.positions[0].reason,
    "history_incomplete",
  );
  const tailProof = proveHip4FillTailCoverage({
    environment: "testnet",
    address,
    request: { environment: "testnet", address, startedAt: now + 1 },
    snapshotTime: now,
    receivedAt: now + 2,
    lookbackMs: history.fillRepair.lookbackMs,
    previous: laggingHistory.fillRepair,
    page: sources,
  });
  assert.ok(tailProof);
  const bridged = await save([], 100, null, {
    ...laggingHistory,
    fillsTailCoverage: tailProof,
  });
  assert.equal(
    bridged.history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  assert.deepEqual(
    bridged.history.fillRepair,
    laggingHistory.fillRepair,
    "tail proof cannot mutate the pending historical source or coverage cursor",
  );
  assert.deepEqual(bridged.observation, observation);
  const ledgerLag = await save([], 100, null, {
    ...laggingHistory,
    fillsTailCoverage: tailProof,
    ledgerRepair: { ...history.ledgerRepair, coveredThrough: now - 1 },
  });
  assert.equal(
    ledgerLag.history.positionAccounting.positions[0].reason,
    "history_incomplete",
  );
  const preservedGap = await save([], 100, null, {
    ...laggingHistory,
    fillsTailCoverage: tailProof,
    fillRepair: {
      ...laggingHistory.fillRepair,
      gaps: [{ time: fill.time, reason: "timestamp_saturated" }],
      gapCount: 1,
    },
  });
  assert.equal(
    preservedGap.history.positionAccounting.positions[0].reason,
    "history_incomplete",
  );
  const laterSnapshot = await save(
    [],
    100,
    { ...observation, observedAt: new Date(now + 1).toISOString() },
    {
      ...laggingHistory,
      fillsTailCoverage: tailProof,
    },
  );
  assert.equal(
    laterSnapshot.history.positionAccounting.positions[0].reason,
    "history_incomplete",
    "a tail proof for the old exact snapshot cannot acquit a newer balance snapshot",
  );
  await save([], 100, observation, laggingHistory);
  const caughtUp = await save([], 100, null, history);
  assert.deepEqual(
    caughtUp.observation,
    observation,
    "history catch-up cannot renew cash, quantities, holds or observation time",
  );
  assert.equal(
    caughtUp.history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  assert.equal(
    caughtUp.history.positionAccounting.observedAt,
    observation.observedAt,
  );
  assert.equal(caughtUp.history.positionAccounting.allTimeComplete, false);
  const laterFailure = {
    ...history,
    fillRepair: {
      ...history.fillRepair,
      startTime: now,
      endTime: now + 1000,
      nextTime: now,
      lastError: "budget_exhausted",
    },
    ledgerRepair: {
      ...history.ledgerRepair,
      startTime: now,
      endTime: now + 1000,
      nextTime: now,
      lastError: "budget_exhausted",
    },
  };
  assert.equal(
    (await save([], 100, null, laterFailure)).history.positionAccounting
      .positions[0].costBasis,
    "7.65",
    "an unsuccessful later extension does not erase already covered evidence",
  );
  const advancedObservation = {
    ...observation,
    observedAt: new Date(now + 1).toISOString(),
  };
  const uncovered = await save([], 100, advancedObservation, laterFailure);
  assert.equal(
    uncovered.history.positionAccounting.positions[0].reason,
    "history_incomplete",
    "the old successful range cannot cover a newer balance observation",
  );
  await save();
  // Corrupt optional legacy evidence must not roll back new account facts.
  // This exercises a real SQL transaction/savepoint, not a mocked repository.
  await pool.query(
    `insert into hip4_account_ledger(environment,account_address,event_key,time_ms,ledger_entry)
     values('testnet',$1,'basis-test-malformed',$2,$3::jsonb)`,
    [address, now - 500, JSON.stringify({ time: now - 500, delta: null })],
  );
  const degraded = await save();
  assert.equal(degraded.observation.positions[0].quantity, "15");
  assert.equal(degraded.history.positionAccounting, null);
  assert.ok(degraded.attempt_error.includes("position_accounting_unavailable"));
  assert.equal(degraded.lease_until, null);
  await pool.query(
    `delete from hip4_account_ledger where environment='testnet'
     and account_address=$1 and event_key='basis-test-malformed'`,
    [address],
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  assert.equal(
    (await save(sources, 1)).history.positionAccounting.positions[0].reason,
    "history_incomplete",
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].costBasis,
    "7.65",
  );
  // Same normalized execution, but changed source startPosition: immutable
  // original is retained and current basis cannot pretend this is verified.
  const conflict = await save([{ ...fill, startPosition: "1" }, second, sale]);
  assert.ok(conflict.attempt_error.includes("execution_accounting_conflict"));
  assert.equal(
    conflict.history.positionAccounting.positions[0].reason,
    "execution_identity_conflict",
  );
  assert.equal(
    (await save()).history.positionAccounting.positions[0].reason,
    "execution_identity_conflict",
  );
  // A new zero anchor AFTER the conflicting record automatically recovers
  // current lot accounting; no reset/delete of old financial facts is required.
  const reset = { ...fill, time: now - 100, tid: 9, oid: 9, sz: "15" };
  const newLot = await save([reset]);
  // Previous position-chain mismatch is not proof of a sale: require a new
  // unambiguous zero anchor rather than pretending old lifetime PnL is known.
  assert.equal(newLot.observation.positions[0].quantity, "15");
  assert.equal(
    newLot.history.positionAccounting.positions[0].reason,
    "verified",
  );
  assert.equal(newLot.history.positionAccounting.positions[0].costBasis, "6.1");
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Production accounting SQL, real-shaped native credits, existing verified
    // receipt contract. All new receipt rows are pg_temp, never real funding.
    await client.query(`create temporary table funding_observations
      (like public.funding_observations including defaults including indexes) on commit drop`);
    await client.query(
      "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1)",
      [address],
    );
    for (const source of sources)
      await client.query(
        `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,
          canonical_market_id,execution,fingerprint,provider_fill)
         values('mainnet',$1,$2,$3,$4,$5,'hyperliquid:mainnet:outcome:43875','{}','basis-cash',$6::jsonb)`,
        [
          address,
          source.time,
          source.coin,
          source.tid,
          source.oid,
          JSON.stringify(source),
        ],
      );
    const sender = "0x00000000000000000000000000000000000018a4";
    const credits = ["0.205539", "0.389943"].map((amount, index) => ({
      time: now - 400 + index,
      hash: `0x${String(index + 4).repeat(64)}`,
      delta: {
        type: "send",
        user: sender,
        destination: address,
        nonce: now - 500 + index,
        token: "USDC",
        amount,
        usdcValue: amount,
        sourceDex: "",
        destinationDex: "spot",
        fee: "0.0",
        nativeTokenFee: "0.0",
        feeToken: "",
      },
    }));
    for (const entry of credits)
      await client.query(
        `insert into hip4_account_ledger(environment,account_address,event_key,time_ms,ledger_entry)
         values('mainnet',$1,$2,$3,$4::jsonb)`,
        [address, entry.hash, entry.time, JSON.stringify(entry)],
      );
    const nativeObservation = projectHip4Account({
      environment: "mainnet",
      observedAt: at,
      role: "user",
      mode: "disabled",
      quote: {
        index: 0,
        tokenId: HYPERCORE_MAINNET_USDC.assetId,
        weiDecimals: 8,
      },
      state: {
        balances: [{ coin: "+87750", total: "15", hold: "0", entryNtl: "999" }],
      },
    });
    const readNative = () =>
      readHip4PositionAccounting(client, {
        environment: "mainnet",
        address,
        observation: nativeObservation,
        history,
        maxRows: 100,
        conflicts: {},
      });
    assert.equal(
      (await readNative()).positions[0].reason,
      "unsupported_economic_event",
    );
    for (const [index, entry] of credits.entries()) {
      const rawAmount = index === 0 ? "20553900" : "38994300";
      const verified = verifyRelayHypercoreTransfer({
        expected: {
          asset: HYPERCORE_MAINNET_USDC,
          owner: address,
          dex: "spot",
          direction: "credit",
          transactionHash: entry.hash,
          actualRaw: rawAmount,
        },
        nativeTransaction: {
          txHash: entry.hash,
          chainId: 1337,
          status: "success",
          block: 123 + index,
          data: {
            hash: entry.hash,
            error: null,
            user: sender,
            action: {
              type: "sendAsset",
              hyperliquidChain: "Mainnet",
              destination: address,
              sourceDex: "",
              destinationDex: "spot",
              token: `USDC:${HYPERCORE_MAINNET_USDC.assetId}`,
              amount: entry.delta.amount,
              fromSubAccount: "",
              nonce: entry.delta.nonce,
            },
          },
        },
        ledger: [entry],
      });
      assert.equal(verified.kind, "verified");
      if (verified.kind !== "verified")
        throw new Error("fixture native credit proof missing");
      const evidence = verified.evidence;
      await client.query(
        `insert into funding_observations(operation_id,kind,network_id,asset_id,asset_decimals,
          tx_hash,event_index,from_address,to_address,raw_amount,observed_at,finality_status,canonical,metadata)
         values(gen_random_uuid(),'destination_credit',$1,$2,8,$3,'hypercore:send:destination_credit',
          $4,$5,$6,now(),'finalized',true,$7::jsonb)`,
        [
          HYPERCORE_MAINNET_USDC.networkId,
          HYPERCORE_MAINNET_USDC.assetId,
          entry.hash,
          sender,
          address,
          rawAmount,
          JSON.stringify({
            observerId: "relay_owned_destination_observation_v1",
            nativeEvidenceKind: "hypercore_send_ledger_v1",
            relayTransactionReferenceMatched: true,
            nativeNonce: evidence.nonce,
            nativeLedgerTime: evidence.ledgerTime,
            nativeProviderBlock: evidence.providerBlock,
            nativeSourceDex: evidence.sourceDex,
            nativeDestinationDex: evidence.destinationDex,
            nativeFeeObservation: evidence.feeObservation,
            nativeEvidenceFingerprint: evidence.evidenceFingerprint,
          }),
        ],
      );
    }
    const nativeBasis = await readNative();
    assert.equal(nativeBasis.positions[0].reason, "verified");
    assert.equal(nativeBasis.positions[0].costBasis, "7.65");
    assert.equal(nativeBasis.positions[0].realizedSinceAnchor, "1.4");
    assert.equal(nativeBasis.allTimeComplete, false);
    await client.query(
      "update funding_observations set canonical=false where tx_hash=$1",
      [credits[0].hash],
    );
    assert.equal(
      (await readNative()).positions[0].reason,
      "unsupported_economic_event",
      "revoking canonical receipt revokes this accounting-only proof on the next read",
    );
    await client.query(
      "update funding_observations set canonical=true where tx_hash=$1",
      [credits[0].hash],
    );
    assert.equal((await readNative()).positions[0].costBasis, "7.65");
    const changedLedger = {
      ...credits[0],
      delta: { ...credits[0].delta, token: "+87750" },
    };
    await client.query(
      `insert into hip4_account_ledger(environment,account_address,event_key,time_ms,ledger_entry)
       values('mainnet',$1,'basis-conflicting-ledger',$2,$3::jsonb)`,
      [address, changedLedger.time, JSON.stringify(changedLedger)],
    );
    assert.equal(
      (await readNative()).positions[0].reason,
      "unsupported_economic_event",
      "one proven hash cannot hide a conflicting full ledger delta",
    );
    // Representative physical-hash point lookup: no funding operation scan.
    await client.query(
      `insert into funding_observations(operation_id,kind,network_id,asset_id,asset_decimals,
      tx_hash,event_index,to_address,raw_amount,observed_at,finality_status,canonical)
      select gen_random_uuid(),'destination_credit','hyperliquid:mainnet',$1,8,
        '0x'||md5('basis-'||series_row.n)||md5('basis-tail-'||series_row.n),
        'hypercore:send:destination_credit',$2,'1',now(),'finalized',true
      from generate_series(1,100000) as series_row(n)`,
      [HYPERCORE_MAINNET_USDC.assetId, sender],
    );
    await client.query("analyze funding_observations");
    await client.query("set local plan_cache_mode=force_generic_plan");
    await client.query(
      `prepare hip_basis_cash_receipts(text[]) as ${HIP4_BASIS_CASH_RECEIPTS_SQL}`,
    );
    for (const [range, hashes, expectedRows] of [
      ["owned", credits.map((row) => row.hash), 2],
      ["empty", [`0x${"f".repeat(64)}`], 0],
    ] as const) {
      const plan = await client.query(
        `explain (analyze,buffers,format json) execute hip_basis_cash_receipts(ARRAY[${hashes.map((value) => `'${value}'`).join(",")}])`,
      );
      const result = plan.rows[0]["QUERY PLAN"][0];
      assert.equal(result.Plan["Actual Rows"], expectedRows);
      assert.ok(
        !JSON.stringify(result.Plan).includes('"Node Type":"Seq Scan"'),
      );
      // LIKE INCLUDING INDEXES gives the copied physical-hash index a new
      // pg_temp name. Check the actual indexed predicate, not that test name.
      assert.match(JSON.stringify(result.Plan), /"Index Cond":"[^"]*md5/u);
      console.log(
        JSON.stringify({
          basisQuery: "hip_basis_cash_receipts",
          range,
          ms: result["Execution Time"],
          buffers: result.Plan["Local Hit Blocks"],
          rows: expectedRows,
        }),
      );
    }
    const foreignAddress = "0x00000000000000000000000000000000000018a3";
    await client.query(
      `insert into hip4_account_snapshots(environment,account_address)
       values('testnet',$1)`,
      [foreignAddress],
    );
    // Rolled-back representative history: 10k owned + 30k foreign records.
    await client.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint,provider_fill)
       select 'testnet',case when series_row.n<=10000 then $1 else $2 end,
       $3::bigint-50000+series_row.n,'#87750',10000+series_row.n,10000+series_row.n,
       'hyperliquid:testnet:outcome:43875','{}'::jsonb,'test-basis-plan','{}'::jsonb
       from generate_series(1,40000) as series_row(n)`,
      [address, foreignAddress, now],
    );
    await client.query(
      `insert into hip4_account_ledger(environment,account_address,time_ms,event_key,ledger_entry)
       select 'testnet',case when series_row.n<=10000 then $1 else $2 end,
       $3::bigint-50000+series_row.n,'test-basis-plan-'||series_row.n,'{}'::jsonb
       from generate_series(1,40000) as series_row(n)`,
      [address, foreignAddress, now],
    );
    await client.query("analyze hip4_account_executions");
    await client.query("analyze hip4_account_ledger");
    await client.query(
      `insert into hip4_account_snapshots(environment,account_address)
       select 'testnet','0x'||lpad(to_hex(100000+series_row.n),40,'0')
       from generate_series(1,20000) as series_row(n)`,
    );
    const planLease = "00000000-0000-4000-8000-0000000018a2";
    await client.query(
      "update hip4_account_snapshots set lease_token=$2 where environment='testnet' and account_address=$1",
      [address, planLease],
    );
    await client.query("analyze hip4_account_snapshots");
    await client.query("set local plan_cache_mode=force_generic_plan");
    await client.query(
      `prepare hip_basis_snapshot(text,text,uuid) as ${HIP4_ACCOUNT_REFRESH_LOCK_SQL}`,
    );
    for (const selectedAddress of [address, `${address.slice(0, -1)}f`]) {
      const plan = await client.query(
        `explain (analyze,buffers,format json) execute hip_basis_snapshot('testnet','${selectedAddress}','${planLease}')`,
      );
      const result = plan.rows[0]["QUERY PLAN"][0];
      assert.ok(result.Plan["Actual Rows"] <= 1);
      assert.ok(
        !JSON.stringify(result.Plan).includes('"Node Type":"Seq Scan"'),
      );
      console.log(
        JSON.stringify({
          basisQuery: "hip_basis_snapshot",
          range: selectedAddress === address ? "owned" : "empty",
          ms: result["Execution Time"],
          buffers: result.Plan["Shared Hit Blocks"],
          rows: result.Plan["Actual Rows"],
        }),
      );
    }
    await client.query(
      `prepare hip_basis_fills(text,text,bigint,bigint,int) as ${HIP4_BASIS_FILLS_SQL}`,
    );
    await client.query(
      `prepare hip_basis_ledger(text,text,bigint,bigint,int) as ${HIP4_BASIS_LEDGER_SQL}`,
    );
    for (const name of ["hip_basis_fills", "hip_basis_ledger"]) {
      for (const [range, start, end, limit] of [
        ["sentinel", now - 60000, now, 101],
        ["covered", now - 60000, now, 20001],
        ["empty", now + 1, now + 1000, 101],
      ] as const) {
        const params = `'testnet','${address}',${start},${end},${limit}`;
        const plan = await client.query(
          `explain (analyze,buffers,format json) execute ${name}(${params})`,
        );
        const result = plan.rows[0]["QUERY PLAN"][0];
        assert.ok(result.Plan);
        assert.ok(result.Plan["Actual Rows"] <= limit);
        assert.ok(
          !JSON.stringify(result.Plan).includes('"Node Type":"Seq Scan"'),
        );
        console.log(
          JSON.stringify({
            basisQuery: name,
            range,
            ms: result["Execution Time"],
            buffers: result.Plan["Shared Hit Blocks"],
            rows: result.Plan["Actual Rows"],
          }),
        );
      }
    }
  } finally {
    await client.query("rollback");
    client.release();
  }
  console.log(
    "HIP basis PG16 atomic snapshot, replay, bounded reads, source conflict, common Portfolio and generic plans PASS",
  );
} finally {
  await pool.query(
    "delete from hip4_account_executions where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_positions where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_ledger where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.query(
    "delete from hip4_account_snapshots where environment='testnet' and account_address=$1",
    [address],
  );
  await pool.end();
}
