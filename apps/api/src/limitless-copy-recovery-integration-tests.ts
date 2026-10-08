// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";
import { buildLimitlessClobSubmissionContext } from "./services/limitless-clob-evidence-identity.js";
import { retainLimitlessCopySubmission } from "./services/limitless-copy-submission.js";
import {
  getCopyAttributionStatus,
  markCopySubmissionStarted,
  retainClientCopyBeforeSubmission,
  retainCopyBeforeSubmission,
  type RetainedCopyAttempt,
} from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";
import type { VerifiedBuyObserverDependencies } from "./services/verified-buy-observer.js";
import { repairUnrecordedCopies } from "./services/verified-copy-repair.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const copier = randomUUID();
const eventId = `limitless:copy-recovery-event:${copier}`;
const owner = `0x${"1".repeat(40)}`;
const defaultExchange = `0x${"2".repeat(40)}`;
const alternateExchange = `0x${"3".repeat(40)}`;
const position = `0x${"4".repeat(40)}`;
const otherOwner = `0x${"5".repeat(40)}`;
const txHash = `0x${"a".repeat(64)}`;
const wrongHash = `0x${"b".repeat(64)}`;
const calls: { text: string; values: unknown[] }[] = [];
let depth = 0;
let fixtureIndex = 0;
let passed = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin")
      return client.query(`savepoint limitless_copy_${++depth}`);
    if (text.toLowerCase() === "commit")
      return client.query(`release savepoint limitless_copy_${depth--}`);
    if (text.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint limitless_copy_${depth}`,
      );
      await client.query(`release savepoint limitless_copy_${depth--}`);
      return result;
    }
    calls.push({ text, values });
    return client.query(text, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const policy = {
  batchSize: 1,
  concurrency: 1,
  leaseSeconds: 120,
  retrySeconds: 30,
  recheckSeconds: 3600,
};
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);

async function fixture(
  input: {
    path?: "embedded" | "client";
    exchange?: string;
    legacy?: boolean;
    metadata?: unknown;
  } = {},
) {
  const index = ++fixtureIndex;
  const key = randomUUID();
  const note = randomUUID();
  const marketId = `limitless:copy-recovery:${key}`;
  const tokenRaw = String(700_000 + index);
  const tokenId = `limitless:${tokenRaw}`;
  const clientOrderId = randomUUID();
  const providerOrderId = randomUUID();
  const exchange = input.exchange ?? alternateExchange;
  const order = {
    salt: String(index),
    maker: owner,
    signer: owner,
    taker: `0x${"0".repeat(40)}`,
    tokenId: tokenRaw,
    makerAmount: "10000000",
    takerAmount: "20000000",
    expiration: "0",
    nonce: "0",
    feeRateBps: "0",
    side: 0,
    signatureType: 0,
    signature: "0xfixture-signature-not-retained",
    clientOrderId,
    requestAuth: { secret: "fixture-auth-not-retained" },
  };
  const context = buildLimitlessClobSubmissionContext(exchange, order);
  const instrument = {
    venue: "limitless" as const,
    marketId,
    tokenId,
    outcome: "YES" as const,
    generation: `8453:${position}:${tokenId}`,
    expiry: null,
  };
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes,metadata)
    values($1,'limitless',$1,$3,'Limitless Copy recovery','ACTIVE','binary','["YES","NO"]',$2::jsonb)`,
    [
      marketId,
      JSON.stringify(input.metadata ?? { venueExchange: exchange }),
      eventId,
    ],
  );
  await client.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')",
    [tokenId, marketId],
  );
  await client.query(
    `insert into ai_notes(id,note_key,note_type,title,description,producer_type,producer_run_id,source_kind,source_id,metrics,lineage)
    values($1::uuid,$1::text,'signal','Limitless Copy recovery','Fixture','holder_research','fixture','market',$2,$3::jsonb,'{"side":"YES"}')`,
    [
      note,
      marketId,
      JSON.stringify({
        publicationDecisionV1: {
          status: "PUBLISH",
          authority: "holder_research_quality_gate",
        },
        socialInstrumentV1: instrument,
      }),
    ],
  );
  const prepared: PreparedTrade = {
    preparedId: key,
    venue: "limitless",
    quote: null,
    authorizationMode: "embedded_privy_evm",
    authorizationRequests: [],
    reconcileKeys: { clientOrderId },
    expiresAt: null,
    venuePayload: input.legacy
      ? {}
      : {
          orderPayload: order,
          submissionContext: context,
          requestAuth: { secret: "fixture-auth-not-retained" },
        },
    intent: {
      actor: { kind: "web_app", userId: copier },
      venue: "limitless",
      sourceRef: { kind: "hunch", id: note },
      walletAddress: owner,
      action: "BUY",
      outcome: "YES",
      amount: { type: "usd", value: "10" },
      idempotencyKey: key,
      orderType: "FOK",
      target: {
        ...instrument,
        eventId: null,
        venueMarketId: null,
        title: null,
      },
    },
  };
  let firstAttempt: RetainedCopyAttempt | null = null;
  async function retain() {
    if (input.path === "client") {
      await retainClientCopyBeforeSubmission(db, {
        sourceRef: { kind: "hunch", id: note },
        userId: copier,
        walletAddress: owner,
        venue: "limitless",
        marketId,
        tokenId,
        outcome: "YES",
        action: "BUY",
        amount: "10",
        idempotencyKey: key,
        providerReference: `limitless:clob:8453:${clientOrderId}`,
        preparedFingerprint: context.orderHash,
        orderType: "FOK",
        limitlessPositionContract: position,
        ...(!input.legacy
          ? {
              limitlessClobOrder: order,
              limitlessClobSubmissionContext: context,
            }
          : {}),
        onRetained: (attempt) => {
          firstAttempt ??= attempt;
        },
      });
    } else {
      const attempt = await retainCopyBeforeSubmission(db, {
        prepared,
        providerReference: `limitless:clob:8453:${clientOrderId}`,
        preparedFingerprint: context.orderHash,
        limitlessPositionContract: position,
      });
      firstAttempt ??= attempt;
      await markCopySubmissionStarted(db, copier, attempt);
    }
  }
  await retain();
  assert.ok(firstAttempt);
  const snapshot = (
    await client.query(
      "select source_snapshot,submission_started_at from copy_attributions where copier_user_id=$1 and idempotency_key=$2",
      [copier, key],
    )
  ).rows[0];
  assert.ok(
    snapshot.submission_started_at,
    "Broadcast uncertainty is retained before a provider request",
  );
  assert.deepEqual(
    snapshot.source_snapshot.submission.limitlessClob,
    input.legacy
      ? undefined
      : retainLimitlessCopySubmission({
          order,
          context,
          walletAddress: owner,
          tokenId,
        }),
  );
  assert.equal(
    JSON.stringify(snapshot.source_snapshot).includes("fixture-signature"),
    false,
  );
  assert.equal(
    JSON.stringify(snapshot.source_snapshot).includes("fixture-auth"),
    false,
  );
  // The external submission succeeded, but neither its HTTP response nor a
  // local order was persisted. Only read-only provider/chain evidence follows.
  await client.query("update ai_notes set status='retracted' where id=$1", [
    note,
  ]);
  let providerReads = 0;
  let receiptReads = 0;
  const evidence: {
    providerClientId: string;
    providerOrder: Record<string, unknown>;
    logExchange: string;
    logHash: string;
    logToken: string;
    logOwner: string;
  } = {
    providerClientId: clientOrderId,
    providerOrder: input.legacy ? order : {},
    logExchange: exchange,
    logHash: context.orderHash,
    logToken: tokenRaw,
    logOwner: owner,
  };
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: defaultExchange,
    solanaCollateralMint: "unused",
    readLimitlessOrder: async (identity) => {
      providerReads++;
      assert.deepEqual(identity, { providerOrderId: null, clientOrderId });
      return {
        status: "found",
        clientOrderId: evidence.providerClientId,
        orderId: providerOrderId,
        data: {
          order: {
            order: evidence.providerOrder,
            execution: { txHash, settlementStatus: "CONFIRMED" },
          },
        },
      };
    },
    readEvmReceipt: async (chainId, hash) => {
      receiptReads++;
      assert.equal(chainId, 8453);
      assert.equal(hash, txHash);
      return {
        timestamp: new Date().toISOString(),
        receipt: {
          hash,
          status: 1,
          logs: [
            {
              address: evidence.logExchange,
              index: 0,
              ...fill.encodeEventLog("OrderFilled", [
                evidence.logHash,
                evidence.logOwner,
                evidence.logExchange,
                0,
                evidence.logToken,
                10000000,
                20000000,
                100000,
              ]),
            },
            {
              address: position,
              index: 1,
              ...transfer.encodeEventLog("TransferSingle", [
                evidence.logExchange,
                evidence.logExchange,
                evidence.logOwner,
                evidence.logToken,
                19900000,
              ]),
            },
          ],
        },
      };
    },
    readPolymarketFills: async () => {
      throw new Error("Unexpected Polymarket read");
    },
    readDflowOrder: async () => {
      throw new Error("Unexpected DFlow read");
    },
    readFinalizedSolanaTransaction: async () => {
      throw new Error("Unexpected Solana read");
    },
  };
  async function repair(expected: "confirmed" | "pending") {
    await client.query(
      "update copy_attributions set repair_due_at=now() where copier_user_id=$1 and idempotency_key=$2",
      [copier, key],
    );
    const counts = await repairUnrecordedCopies(db, deps, policy);
    assert.equal(counts.checked, 1);
    assert.equal(counts[expected], 1);
    assert.equal(counts.leaseLost, 0);
    const saved = (
      await client.query(
        "select state,canonical_purchase_key,instrument,execution_facts,order_id,execution_id,source_snapshot from copy_attributions where copier_user_id=$1 and idempotency_key=$2",
        [copier, key],
      )
    ).rows[0];
    assert.equal(saved.state, expected);
    assert.equal(saved.order_id, null);
    assert.equal(saved.execution_id, null);
    assert.deepEqual(saved.instrument, instrument);
    if (expected === "confirmed") {
      assert.equal(
        saved.canonical_purchase_key,
        `limitless:clob:8453:${providerOrderId}`,
      );
      assert.deepEqual(saved.execution_facts.instrument, instrument);
      assert.equal(saved.execution_facts.netShares, "19.9");
      assert.equal(saved.execution_facts.grossNotionalUsd, "10");
    } else assert.equal(saved.canonical_purchase_key, null);
    assert.equal(
      (await getCopyAttributionStatus(db, copier, key))?.state,
      expected,
    );
    return saved;
  }
  return {
    key,
    note,
    marketId,
    tokenId,
    order,
    context,
    instrument,
    evidence,
    snapshot: snapshot.source_snapshot,
    retain,
    repair,
    reads: () => ({ providerReads, receiptReads }),
  };
}

async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`ok - ${name}`);
}

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await client.query("begin");
  await client.query("set local statement_timeout='30s'");
  await client.query("set local lock_timeout='5s'");
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as due_rows from copy_attributions where copier_user_id is not null and order_id is null and execution_id is null and repair_due_at<=now()",
        )
      ).rows[0].due_rows,
    ),
    0,
    "Run with no other due orphan Copy fixtures",
  );
  await client.query(
    "insert into users(id,display_name) values($1,'Limitless Copy recovery fixture')",
    [copier],
  );
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Limitless Copy recovery fixture','ACTIVE')",
    [eventId],
  );

  for (const path of ["embedded", "client"] as const)
    for (const exchange of [alternateExchange, defaultExchange])
      await test(`${path} retains exact ${exchange === alternateExchange ? "alternate" : "default"} exchange before lost-response recovery`, async () => {
        const current = await fixture({ path, exchange });
        // Frozen evidence is independent of current metadata and source visibility.
        await client.query(
          "update unified_markets set metadata=$2::jsonb where id=$1",
          [current.marketId, JSON.stringify({ venueExchange: "invalid" })],
        );
        const saved = await current.repair("confirmed");
        assert.deepEqual(saved.source_snapshot, current.snapshot);
        await current.retain();
        await current.repair("confirmed");
        assert.deepEqual(current.reads(), {
          providerReads: 2,
          receiptReads: 2,
        });
        assert.equal(
          Number(
            (
              await client.query(
                "select count(*) as attribution_count from copy_attributions where copier_user_id=$1 and idempotency_key=$2",
                [copier, current.key],
              )
            ).rows[0].attribution_count,
          ),
          1,
          "Exact retry cannot create another Copy attribution",
        );
      });

  for (const mismatch of [
    "client",
    "signed-fields",
    "exchange",
    "hash",
    "token",
    "owner",
  ] as const)
    await test(`${mismatch} mismatch stays pending; exact evidence recovers the same retained Copy`, async () => {
      const current = await fixture();
      const valid = { ...current.evidence };
      if (mismatch === "client")
        current.evidence.providerClientId = randomUUID();
      if (mismatch === "signed-fields")
        current.evidence.providerOrder = { ...current.order, salt: "999999" };
      if (mismatch === "exchange")
        current.evidence.logExchange = defaultExchange;
      if (mismatch === "hash") current.evidence.logHash = wrongHash;
      if (mismatch === "token") current.evidence.logToken = "999999";
      if (mismatch === "owner") current.evidence.logOwner = otherOwner;
      await current.repair("pending");
      if (mismatch === "client" || mismatch === "signed-fields")
        assert.equal(current.reads().receiptReads, 0);
      Object.assign(current.evidence, valid);
      await current.repair("confirmed");
    });

  await test("invalid retained context never downgrades to matching current market metadata", async () => {
    const current = await fixture();
    await client.query(
      "update copy_attributions set source_snapshot=jsonb_set(source_snapshot,'{submission,limitlessClob,context,chainId}','137') where copier_user_id=$1 and idempotency_key=$2",
      [copier, current.key],
    );
    await current.repair("pending");
    assert.deepEqual(current.reads(), { providerReads: 0, receiptReads: 0 });
    await client.query(
      "update copy_attributions set source_snapshot=$3::jsonb where copier_user_id=$1 and idempotency_key=$2",
      [copier, current.key, JSON.stringify(current.snapshot)],
    );
    await current.repair("confirmed");
  });

  for (const exchange of [alternateExchange, defaultExchange])
    await test(`legacy ${exchange === alternateExchange ? "exact market" : "absent exchange/default"} metadata recovers without source visibility`, async () => {
      const current = await fixture({
        legacy: true,
        exchange,
        metadata:
          exchange === defaultExchange
            ? {}
            : { market: { venue: { negRiskExchange: exchange } } },
      });
      await current.repair("confirmed");
      assert.deepEqual(current.reads(), { providerReads: 1, receiptReads: 1 });
    });

  await test("legacy wrong token/outcome mapping stays pending and repairs after exact mapping returns", async () => {
    const current = await fixture({ legacy: true });
    await client.query(
      "update unified_tokens set side='NO' where token_id=$1",
      [current.tokenId],
    );
    await current.repair("pending");
    assert.deepEqual(current.reads(), { providerReads: 0, receiptReads: 0 });
    await client.query(
      "update unified_tokens set side='YES' where token_id=$1",
      [current.tokenId],
    );
    await current.repair("confirmed");
  });

  await test("legacy current market expiry drift preserves the retained instrument expiry", async () => {
    const current = await fixture({ legacy: true });
    await client.query(
      "update unified_markets set expiration_time=now()+interval '7 days' where id=$1",
      [current.marketId],
    );
    const saved = await current.repair("confirmed");
    assert.equal(saved.instrument.expiry, null);
    assert.equal(saved.execution_facts.instrument.expiry, null);
    assert.deepEqual(current.reads(), { providerReads: 1, receiptReads: 1 });
  });

  await test("legacy provider domain extras cannot replace exact market exchange; metadata repair recovers", async () => {
    const current = await fixture({ legacy: true, metadata: {} });
    current.evidence.providerOrder = {
      ...current.order,
      exchangeAddress: alternateExchange,
      domain: { verifyingContract: alternateExchange },
      _hunchLimitlessClob: current.context,
    };
    await current.repair("pending");
    await client.query(
      "update unified_markets set metadata=$2::jsonb where id=$1",
      [current.marketId, JSON.stringify({ venueExchange: alternateExchange })],
    );
    await current.repair("confirmed");
  });

  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as order_count from orders where user_id=$1",
          [copier],
        )
      ).rows[0].order_count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as execution_count from executions where user_id=$1",
          [copier],
        )
      ).rows[0].execution_count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as attribution_count from copy_attributions where copier_user_id=$1",
          [copier],
        )
      ).rows[0].attribution_count,
    ),
    fixtureIndex,
  );
  const metadataLookup = calls.find((call) =>
    call.text.includes("select market_row.metadata"),
  );
  assert.ok(
    metadataLookup,
    "Exercise the actual exact legacy market/token metadata lookup",
  );
  const unrelatedMarkets = 20_000;
  const unrelatedPrefix = `limitless:copy-unrelated:${copier}:`;
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes)
    select $1||fixture_row.ordinality,'limitless',$1||fixture_row.ordinality,$3,'Unrelated Copy fixture','ACTIVE','binary','["YES","NO"]'
    from generate_series(1,$2::int) as fixture_row(ordinality)`,
    [unrelatedPrefix, unrelatedMarkets, eventId],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side)
    select $1||fixture_row.ordinality,'limitless',$1||fixture_row.ordinality,'YES'
    from generate_series(1,$2::int) as fixture_row(ordinality)`,
    [unrelatedPrefix, unrelatedMarkets],
  );
  await client.query("analyze unified_markets");
  await client.query("analyze unified_tokens");
  await client.query(
    `prepare limitless_copy_market(text,text,text) as ${metadataLookup.text}`,
  );
  type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
  const walkPlan = (node: PlanNode): PlanNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(walkPlan),
  ];
  for (const [scenario, values, expectedRows] of [
    ["hit", metadataLookup.values, 1],
    [
      "missing-market",
      [`missing:${copier}`, metadataLookup.values[1], "YES"],
      0,
    ],
    [
      "wrong-market",
      [`${unrelatedPrefix}1`, metadataLookup.values[1], "YES"],
      0,
    ],
    [
      "missing-token",
      [metadataLookup.values[0], `missing:${copier}`, "YES"],
      0,
    ],
    [
      "wrong-outcome",
      [metadataLookup.values[0], metadataLookup.values[1], "NO"],
      0,
    ],
  ] as const) {
    for (const generic of [false, true]) {
      await client.query(
        `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
      );
      const literals = (
        await client.query(
          "select quote_literal($1::text) as market_literal,quote_literal($2::text) as token_literal,quote_literal($3::text) as side_literal",
          [...values],
        )
      ).rows[0];
      const explained = await client.query(
        `explain(analyze,buffers,format json) execute limitless_copy_market(${literals.market_literal},${literals.token_literal},${literals.side_literal})`,
      );
      const plan = explained.rows[0]["QUERY PLAN"][0];
      const nodes = walkPlan(plan.Plan);
      assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
      assert.equal(plan.Plan["Actual Rows"], expectedRows);
      const scans = nodes.filter((node) => node["Index Name"]);
      assert.ok(
        scans.length >= 1,
        "Exact identity lookup uses existing indexes",
      );
      const visited = scans.reduce(
        (total, node) =>
          total +
          Number(node["Actual Rows"]) +
          Number(node["Rows Removed by Filter"] ?? 0),
        0,
      );
      assert.ok(
        visited <= 2,
        `${scenario}: at most one exact market and token row`,
      );
      const sharedHits = Number(plan.Plan["Shared Hit Blocks"] ?? 0);
      const sharedReads = Number(plan.Plan["Shared Read Blocks"] ?? 0);
      assert.ok(
        sharedHits + sharedReads < 50,
        `${scenario}: bounded index/heap work`,
      );
      console.log(
        JSON.stringify({
          scenario,
          generic,
          unrelatedMarkets,
          visited,
          executionMs: plan["Execution Time"],
          sharedHits,
          sharedReads,
          indexes: scans.map((node) => node["Index Name"]),
        }),
      );
    }
  }
  await client.query("deallocate limitless_copy_market");
  console.log(
    `Limitless Copy recovery PG16: ${passed} scenarios passed; ${fixtureIndex} retained identities, zero local buys/executions`,
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
