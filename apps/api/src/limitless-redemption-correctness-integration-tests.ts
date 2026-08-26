// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ethers } from "ethers";

import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  assertEmbeddedEvmSponsorshipAllowed,
  embeddedEvmSponsorshipTestHooks,
} from "./services/embedded-evm-sponsorship.js";
import {
  storeOrderInTransaction,
  updateOrderFromHistory,
} from "./repos/orders-repo.js";

const client = await pool.connect();

try {
  await client.query("begin");
  const suffix = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const eventId = `limitless:redemption-event:${suffix}`;
  const marketId = `limitless:redemption-market:${suffix}`;
  const adapterAddress = "0x6151EF8368b6316c1aa3C68453EF083ad31E712D";
  const otherAdapterAddress = "0x1111111111111111111111111111111111111111";
  const signer = "0x2222222222222222222222222222222222222222";
  const conditionId = `0x${"ab".repeat(32)}`;
  const otherConditionId = `0x${"cd".repeat(32)}`;

  await client.query(
    `insert into users (id, privy_user_id, is_active, is_verified)
     values ($1::uuid, $2::text, true, true)`,
    [userId, `did:privy:${suffix}`],
  );
  await client.query(
    `insert into unified_events (
       id, venue, venue_event_id, title, status, metadata
     ) values (
       $1::text, 'limitless', $2::text, 'Redemption adapter test',
       'SETTLED', jsonb_build_object('venueAdapter', $3::text)
     )`,
    [eventId, `event-${suffix}`, adapterAddress],
  );
  await client.query(
    `insert into unified_markets (
       id, venue, venue_market_id, event_id, title, status, market_type,
       condition_id, metadata
     ) values (
       $1::text, 'limitless', $2::text, $3::text,
       'Redemption adapter test', 'SETTLED', 'binary', $4::text, '{}'::jsonb
     )`,
    [marketId, `market-${suffix}`, eventId, conditionId],
  );

  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskAdapter(
      client,
      adapterAddress,
    ),
    true,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskAdapter(
      client,
      otherAdapterAddress,
    ),
    false,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
      client,
      adapterAddress,
      conditionId,
    ),
    true,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
      client,
      otherAdapterAddress,
      conditionId,
    ),
    false,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
      client,
      adapterAddress,
      otherConditionId,
    ),
    false,
  );

  const redemptionData = new ethers.Interface([
    "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
  ]).encodeFunctionData("redeemPositions", [conditionId, [6_305_257n, 0n]]);
  const operatorApprovalData = new ethers.Interface([
    "function setApprovalForAll(address operator,bool approved)",
  ]).encodeFunctionData("setApprovalForAll", [adapterAddress, true]);
  const sponsorshipDependencies = {
    isAuthorizedDestination: async () => false,
    isKnownLimitlessMarket: async () => false,
    isKnownLimitlessNegRiskAdapter: (adapter: string) =>
      embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskAdapter(
        client,
        adapter,
      ),
    isKnownLimitlessNegRiskRedemption: (adapter: string, condition: string) =>
      embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
        client,
        adapter,
        condition,
      ),
    isSupportedBridgeToken: async () => false,
    matchesBridgeOrder: async () => false,
    matchesFundingAction: async () => false,
    matchesPositionAction: async () => false,
  };
  await assert.doesNotReject(() =>
    assertEmbeddedEvmSponsorshipAllowed({
      chainId: 8453,
      dependencies: sponsorshipDependencies,
      signer,
      transactions: [
        {
          id: "limitless-redemption-approval",
          label: "Approve Limitless redemption",
          to: env.limitlessConditionalTokensAddress,
          data: operatorApprovalData,
        },
        {
          id: "limitless-redemption",
          label: "Limitless redemption",
          to: adapterAddress,
          data: redemptionData,
        },
      ],
      userId,
    }),
  );
  await assert.rejects(
    () =>
      assertEmbeddedEvmSponsorshipAllowed({
        chainId: 8453,
        dependencies: sponsorshipDependencies,
        signer,
        transactions: [
          {
            id: "unknown-limitless-redemption-approval",
            label: "Approve Limitless redemption",
            to: env.limitlessConditionalTokensAddress,
            data: new ethers.Interface([
              "function setApprovalForAll(address operator,bool approved)",
            ]).encodeFunctionData("setApprovalForAll", [
              otherAdapterAddress,
              true,
            ]),
          },
        ],
        userId,
      }),
    /not an allowed Hunch operation/,
  );

  const marketAdapterAddress = "0x3333333333333333333333333333333333333333";
  await client.query(
    `update unified_markets
     set metadata = jsonb_build_object('venueAdapter', $2::text)
     where id = $1::text`,
    [marketId, marketAdapterAddress],
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskAdapter(
      client,
      marketAdapterAddress,
    ),
    true,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskAdapter(
      client,
      adapterAddress,
    ),
    false,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
      client,
      marketAdapterAddress,
      conditionId,
    ),
    true,
  );
  assert.equal(
    await embeddedEvmSponsorshipTestHooks.isKnownLimitlessNegRiskRedemption(
      client,
      adapterAddress,
      conditionId,
    ),
    false,
  );

  const storedOrder = await storeOrderInTransaction(client, {
    errorMessage:
      "Order was not filled because no immediate match was available.",
    lastUpdate: new Date("2026-08-25T00:00:00.000Z"),
    orderType: "FOK",
    price: 0.5,
    rawError: null,
    side: "BUY",
    signerAddress: signer,
    size: 6.305257,
    status: "expired",
    tokenId: "limitless-redemption-token",
    userId,
    venue: "limitless",
    venueOrderId: `limitless-redemption-${suffix}`,
    walletAddress: signer,
  });
  await updateOrderFromHistory(client, {
    filledAt: new Date("2026-08-25T00:01:00.000Z"),
    id: storedOrder.order.id,
    lastUpdate: new Date("2026-08-25T00:01:00.000Z"),
    orderHash: `0x${"ef".repeat(32)}`,
    price: 0.5,
    size: 6.305257,
    status: "filled",
  });
  const reconciledOrder = await client.query<{
    error_message: string | null;
    status: string;
  }>(
    `select error_message, status
     from orders
     where id = $1::uuid`,
    [storedOrder.order.id],
  );
  assert.equal(reconciledOrder.rows[0]?.status, "filled");
  assert.equal(reconciledOrder.rows[0]?.error_message, null);

  console.log("[limitless-redemption-correctness-integration-tests] passed");
} finally {
  await client.query("rollback");
  client.release();
}
