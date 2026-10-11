// @api-integration
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
  type PolymarketAssetContext,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction,
  TelegramAppHandoffV2DirectTradeError,
} from "./repos/telegram-app-handoff-v2-direct-trade-repository.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const client = await db.connect();
try {
  await client.query("begin");
  const userId = randomUUID();
  const telegramUserId = `ledger-${randomUUID()}`;
  const marketId = `polymarket:claim-${randomUUID()}`;
  const eventId = `polymarket:event-${randomUUID()}`;
  const signer = `0x${"11".repeat(20)}`;
  const base = (1n << 248n) | (0xabn << 120n);
  const assetId = base.toString();
  const conditionId = `0x${base.toString(16).padStart(64, "0")}`;
  const legacy = buildPolymarketAssetContext(
    marketId,
    resolvePolymarketMarketAssets({
      version: "v1",
      conditionId,
      clobTokenIds: [assetId, (base | 1n).toString()],
      outcomes: ["Yes", "No"],
      negRisk: false,
    }),
    assetId,
  );
  const next = buildPolymarketAssetContext(
    marketId,
    resolvePolymarketMarketAssets({
      version: "v2",
      conditionId,
      positionIds: [assetId, (base | 1n).toString()],
      outcomes: ["Yes", "No"],
      negRisk: false,
    }),
    assetId,
  );
  await client.query(
    "insert into users(id,is_active,is_verified) values($1,true,true)",
    [userId],
  );
  await client.query(
    "insert into user_telegram_accounts(user_id,privy_user_id,telegram_user_id) values($1,$2,$3)",
    [userId, `did:privy:${userId}`, telegramUserId],
  );
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'polymarket',$2,'Claim fixture','ACTIVE')",
    [eventId, eventId],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type) values($1,'polymarket',$2,$3,'Claim fixture','ACTIVE','binary')",
    [marketId, marketId, eventId],
  );

  const createHandoff = async (context?: PolymarketAssetContext) => {
    const intentId = randomUUID(),
      handoffId = randomUUID();
    const fingerprint = createHash("sha256").update(handoffId).digest("hex");
    const plan = {
      version: 2,
      executionContractVersion: 2,
      kind: "direct_trade",
      trade: {
        action: "sell",
        venue: "polymarket",
        side: "YES",
        marketId,
        eventId,
        outcomeTokenId: assetId,
        controllerWalletAddress: signer,
        sharesRaw: "10000000",
        minimumReceiveRaw: "1000000",
        ...(context ? { assetContext: context } : {}),
      },
    };
    await client.query(
      `insert into telegram_trade_intents(id,telegram_user_id,user_id,action,venue,market_id,event_id,side,shares_raw,status,result,expires_at,idempotency_key,delivery_mode)
      values($1,$2,$3,'sell','polymarket',$4,$5,'YES','10000000','external_handoff',$6::jsonb,now()+interval '1 hour',$7,'app_handoff')`,
      [
        intentId,
        telegramUserId,
        userId,
        marketId,
        eventId,
        JSON.stringify({
          appHandoffExecution: {
            version: 2,
            kind: "direct_trade",
            handoffId,
            committedAt: new Date().toISOString(),
          },
        }),
        `claim:${intentId}`,
      ],
    );
    await client.query(
      `insert into telegram_app_handoffs(id,trade_intent_id,user_id,telegram_user_id,token_hash,state,plan_fingerprint,policy_revision,authority_fingerprint,quote_snapshot,plan_snapshot,expires_at,claimed_at,claimed_by_user_id,committed_at)
      values($1,$2,$3,$4,$5,'committed',$5,'fixture-policy',$5,'{}'::jsonb,$6::jsonb,now()+interval '1 hour',now(),$3,now())`,
      [
        handoffId,
        intentId,
        userId,
        telegramUserId,
        fingerprint,
        JSON.stringify(plan),
      ],
    );
    return { intentId, binding: { handoffId, planFingerprint: fingerprint } };
  };
  const claim = async (
    handoff: Awaited<ReturnType<typeof createHandoff>>,
    context?: PolymarketAssetContext,
  ) => {
    const savepoint = `claim_fixture_${handoff.intentId.replaceAll("-", "")}`;
    await client.query(`savepoint ${savepoint}`);
    try {
      await claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(
        client,
        {
          userId,
          binding: handoff.binding,
          assertCurrentScope: async () => true,
          readSellPositionAvailableRaw: async () => "10000000",
          reconcileKeys: {
            tradeType: "clob",
            orderHash: `0x${handoff.binding.planFingerprint}`,
          },
          recoveryPayload: {},
          submission: {
            action: "sell",
            executionKind: "clob",
            marketId,
            outcomeTokenId: assetId,
            signer,
            spendRaw: "10000000",
            receiveRaw: "1000000",
            venue: "polymarket",
            ...(context ? { assetContext: context } : {}),
          },
        },
      );
      await client.query(`release savepoint ${savepoint}`);
    } catch (error) {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
      throw error;
    }
  };
  const ctf = await createHandoff(legacy);
  const pm = await createHandoff(next);
  await claim(ctf, legacy);
  await claim(pm, next); // Identical uint256/controller, independent ledger capacity.
  await claim(pm, next); // Exact retry is idempotent.
  const excessPm = await createHandoff(next);
  await assert.rejects(
    () => claim(excessPm, next),
    (e: unknown) =>
      e instanceof TelegramAppHandoffV2DirectTradeError &&
      e.code === "sell_position_unavailable",
  );
  const mismatch = await createHandoff(legacy);
  await assert.rejects(
    () => claim(mismatch, next),
    (e: unknown) =>
      e instanceof TelegramAppHandoffV2DirectTradeError &&
      e.code === "order_out_of_scope",
  );
  const old = await createHandoff();
  await assert.rejects(
    () => claim(old, next),
    (e: unknown) =>
      e instanceof TelegramAppHandoffV2DirectTradeError &&
      e.code === "order_out_of_scope",
    "old token-only consent cannot authorize V2",
  );
  await client.query(
    "update telegram_trade_intents set status='cancelled' where id=$1",
    [ctf.intentId],
  );
  await claim(old, legacy); // Old sealed scope is still valid for its original CTF.
  const rows = (
    await client.query(
      "select id,status from telegram_trade_intents where id=any($1::uuid[])",
      [
        [
          ctf.intentId,
          pm.intentId,
          excessPm.intentId,
          mismatch.intentId,
          old.intentId,
        ],
      ],
    )
  ).rows;
  assert.equal(rows.find((row) => row.id === pm.intentId)?.status, "executing");
  assert.equal(
    rows.find((row) => row.id === old.intentId)?.status,
    "executing",
  );
  assert.equal(
    rows.find((row) => row.id === excessPm.intentId)?.status,
    "external_handoff",
    "failed claims do not change state",
  );
  assert.equal(
    rows.find((row) => row.id === mismatch.intentId)?.status,
    "external_handoff",
  );
  console.log(
    "[telegram-polymarket-ledger-claim-integration-tests] PG16 ledger capacity, exact scope, retry and legacy compatibility passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await db.end();
}
