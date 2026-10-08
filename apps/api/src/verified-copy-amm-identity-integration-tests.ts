// @requires-db
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { normalizeLimitlessScopedTokenId } from "./lib/limitless-token.js";
import {
  getCopyAttributionStatus,
  recoverCopyPurchaseLinks,
  retainCopyBeforeSubmission,
} from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";
import { createIntegrationTestPool } from "./test-database-target.js";

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const walkPlan = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(walkPlan),
];
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const copier = randomUUID();
const otherCopier = randomUUID();
const note = randomUUID();
const position = `0x${"3".repeat(40)}`;
const unrelatedOrders = 200_000;
const calls: { text: string; values: unknown[] }[] = [];
let depth = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin")
      return client.query(`savepoint amm_identity_${++depth}`);
    if (text.toLowerCase() === "commit")
      return client.query(`release savepoint amm_identity_${depth--}`);
    if (text.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint amm_identity_${depth}`,
      );
      await client.query(`release savepoint amm_identity_${depth--}`);
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

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
    "This fixture targets PostgreSQL 16",
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as pending_rows from copy_attributions where copier_user_id is not null and state='pending' and order_id is null and execution_id is null",
        )
      ).rows[0].pending_rows,
    ),
    0,
    "Run with no other pending unlinked copy fixtures",
  );
  await client.query(
    "insert into users(id,display_name) values($1,'AMM copy fixture'),($2,'AMM copy decoy')",
    [copier, otherCopier],
  );
  await client.query(
    "insert into ai_notes(id,note_key,note_type,title,description,producer_type,producer_run_id) values($1::uuid,$1::text,'signal','AMM copy fixture','Fixture','holder_research','fixture')",
    [note],
  );
  // The same owner/venue has a large unrelated history: neither filter alone
  // makes a scan cheap. The exact persisted identity must use its existing index.
  await client.query(
    `insert into orders(user_id,venue,venue_order_id,status)
    select $1,'limitless',$2||sequence_row::text,'submitted'
    from generate_series(1,$3::int) sequence_row`,
    [copier, `unrelated:${randomUUID()}:`, unrelatedOrders],
  );
  const identityCases: {
    name: string;
    txHash: string;
    venueOrderId: string;
    matched: boolean;
  }[] = [];
  for (const [index, inputToken] of ["123", "limitless:124"].entries()) {
    const tokenId = normalizeLimitlessScopedTokenId(inputToken);
    assert.ok(tokenId);
    const rawToken = tokenId.slice("limitless:".length);
    const txHash = `0x${randomBytes(32).toString("hex")}`;
    const providerReference = `limitless:amm:8453:${txHash}:${rawToken}`;
    // These are the actual recordLimitlessAmmOrder persistence semantics for
    // both supported request aliases, not the pre-submit raw provider spelling.
    const venueOrderId = `amm:${txHash}:${tokenId}`;
    const instrument = {
      venue: "limitless" as const,
      marketId: `amm-identity:${note}`,
      tokenId,
      outcome: index === 0 ? ("YES" as const) : ("NO" as const),
      generation: `8453:${position}:${tokenId}`,
      expiry: null,
    };
    const copyId = randomUUID();
    const orderId = randomUUID();
    const oppositeToken = `limitless:${BigInt(rawToken) + 1n}`;
    await client.query(
      `insert into copy_attributions(id,copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference)
      values($1::uuid,$2,$3,'{}',$4::jsonb,$1::text,'fixture','fixture',$5)`,
      [copyId, copier, note, JSON.stringify(instrument), providerReference],
    );
    // Exact-looking wrong-user, opposite-token, other-transaction, other-venue,
    // raw-only, and suffix-only records must never acquire the local link.
    for (const [userId, venue, storedIdentity] of [
      [otherCopier, "limitless", venueOrderId],
      [copier, "limitless", `amm:${txHash}:${oppositeToken}`],
      [copier, "limitless", `amm:0x${"f".repeat(64)}:${tokenId}`],
      [copier, "polymarket", venueOrderId],
      [copier, "limitless", `amm:${txHash}:${rawToken}`],
      [copier, "limitless", `unrelated:${venueOrderId}`],
    ])
      await client.query(
        "insert into orders(user_id,venue,venue_order_id,token_id,side,status) values($1,$2,$3,$4,'BUY','filled')",
        [userId, venue, storedIdentity, tokenId],
      );
    assert.equal(await recoverCopyPurchaseLinks(db, 10), 0);
    assert.equal(
      (await getCopyAttributionStatus(db, copier, copyId))?.purchaseRef,
      null,
      `${inputToken}: decoys must not link`,
    );
    await client.query(
      `insert into orders(id,user_id,venue,venue_order_id,token_id,side,status,verified_buy_due_at)
      values($1,$2,'limitless',$3,$4,'BUY','submitted',now()+interval '1 year')`,
      [orderId, copier, venueOrderId, tokenId],
    );
    assert.equal(await recoverCopyPurchaseLinks(db, 10), 1);
    assert.deepEqual(
      (await getCopyAttributionStatus(db, copier, copyId))?.purchaseRef,
      { kind: "order", id: orderId },
      `${inputToken}: recover the actual scoped AMM writer identity`,
    );
    assert.deepEqual(
      (
        await client.query(
          "select provider_reference,instrument,state,canonical_purchase_key from copy_attributions where id=$1",
          [copyId],
        )
      ).rows[0],
      {
        provider_reference: providerReference,
        instrument,
        state: "pending",
        canonical_purchase_key: null,
      },
      "Identity linking must not change canonical identity, outcome, generation, or establish verification",
    );
    assert.equal(
      (
        await client.query(
          "select verified_buy_due_at=now() as due from orders where id=$1",
          [orderId],
        )
      ).rows[0].due,
      true,
    );
    const newKey = randomUUID();
    const prepared: PreparedTrade = {
      preparedId: txHash,
      venue: "limitless",
      quote: null,
      authorizationMode: "client_signed_order",
      authorizationRequests: [],
      reconcileKeys: {},
      expiresAt: null,
      venuePayload: {},
      intent: {
        actor: { kind: "web_app", userId: copier },
        venue: "limitless",
        sourceRef: { kind: "hunch", id: note },
        walletAddress: `0x${"1".repeat(40)}`,
        action: "BUY",
        outcome: instrument.outcome,
        amount: { type: "usd", value: "10" },
        idempotencyKey: newKey,
        target: {
          ...instrument,
          eventId: null,
          venueMarketId: null,
          title: null,
        },
      },
    };
    // Both writer input aliases and transaction-hash casing resolve to the
    // same prior local purchase; a new key cannot relabel it as a fresh Copy.
    for (const referenceHash of [txHash, txHash.toUpperCase()]) {
      await assert.rejects(
        () =>
          retainCopyBeforeSubmission(db, {
            prepared,
            providerReference: `limitless:amm:8453:${referenceHash}:${rawToken}`,
            preparedFingerprint: txHash,
            limitlessPositionContract: position,
          }),
        /copy_purchase_already_submitted/,
      );
      assert.equal(await getCopyAttributionStatus(db, copier, newKey), null);
    }
    identityCases.push({
      name: inputToken,
      txHash,
      venueOrderId,
      matched: true,
    });
  }
  await client.query("analyze orders");
  const lookup = calls.find((call) =>
    call.text.includes("and venue_order_id=$2 order by id limit 1"),
  );
  assert.ok(lookup, "Capture the real production AMM identity lookup");
  await client.query(`prepare amm_copy_identity(uuid,text) as ${lookup.text}`);
  identityCases.push({
    name: "empty",
    txHash: `0x${"0".repeat(64)}`,
    venueOrderId: `amm:0x${"0".repeat(64)}:limitless:999`,
    matched: false,
  });
  for (const identity of identityCases) {
    for (const generic of [false, true]) {
      await client.query(
        `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
      );
      // Both values are locally generated UUID/validated numeric-token fixture
      // identities; EXECUTE parameters cannot be passed through pg bind values.
      const explained = await client.query(
        `explain(analyze,buffers,format json) execute amm_copy_identity('${copier}','${identity.venueOrderId}')`,
      );
      const plan = explained.rows[0]["QUERY PLAN"][0];
      const nodes = walkPlan(plan.Plan);
      const scan = nodes.find(
        (node) => node["Index Name"] === "idx_orders_venue_order_id",
      );
      assert.ok(scan, "Use the existing exact venue/order identity index");
      assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
      assert.equal(plan.Plan["Actual Rows"], identity.matched ? 1 : 0);
      const scannedRows =
        Number(scan["Actual Rows"]) +
        Number(scan["Rows Removed by Filter"] ?? 0);
      const sharedHits = Number(plan.Plan["Shared Hit Blocks"] ?? 0);
      const sharedReads = Number(plan.Plan["Shared Read Blocks"] ?? 0);
      assert.ok(scannedRows <= 2);
      assert.ok(sharedHits + sharedReads < 50);
      console.log(
        JSON.stringify({
          scenario: identity.name,
          generic,
          unrelatedOrders,
          scannedRows,
          executionMs: plan["Execution Time"],
          sharedHits,
          sharedReads,
          index: scan["Index Name"],
        }),
      );
    }
  }
  console.log(
    "AMM Copy PG16: raw/scoped writer aliases recover exact local IDs; decoys excluded; prior purchases rejected without submission",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
