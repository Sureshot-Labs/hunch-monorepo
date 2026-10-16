import { randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hip4Identity } from "@hunch/shared";
import type { WalletExecutionProfile } from "./funding/domain/types.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { mapHip4Market } from "./services/hip4-mapping.js";

/** Complete, independently fresh native contract; no book or flow is invented. */
export function hip4OrderTestMarket(
  identity: ReturnType<typeof hip4Identity>,
  now = Date.now(),
) {
  const { market } = mapHip4Market({
    environment: "mainnet",
    outcome: identity.outcome,
    fetchedAt: new Date(now).toISOString(),
    generation: "replaceable-order-test-read",
    metadata: {
      outcomes: [
        {
          outcome: identity.outcome,
          name: "Synthetic native contract",
          description: "Synthetic order-admission condition",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
          quoteToken: "USDC",
          deployerFeeScale: "1",
        },
      ],
      questions: [],
      feeScale: "1",
    },
    spotMetadata: {
      tokens: [
        {
          index: 0,
          name: "USDC",
          tokenId: HYPERCORE_MAINNET_USDC.assetId,
          szDecimals: 8,
          weiDecimals: 8,
        },
      ],
      universe: [],
    },
  });
  market.metadataValidUntil = new Date(now + 3600000).toISOString();
  return market;
}

/** Disposable PostgreSQL fixture, no keys or provider requests. */
export async function hip4OrderTestFixture(
  db: PoolClient,
  suppliedAddress?: string,
  existing?: { userId: string; profile: WalletExecutionProfile },
) {
  const userId = existing?.userId ?? randomUUID(),
    controllerWalletRef = existing?.profile.controllerWalletRef ?? randomUUID();
  const address =
    suppliedAddress?.toLowerCase() ??
    `0x${randomUUID().replaceAll("-", "")}12345678`;
  const identity = hip4Identity("mainnet", randomInt(10000000, 90000000));
  if (!existing) {
    await db.query("insert into users(id,is_active) values($1,true)", [userId]);
    await db.query(
      `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,
    wallet_source,is_internal_wallet,privy_profile_updated_at)
    values($1,$2,$3,'ethereum',true,'external',false,now())`,
      [controllerWalletRef, userId, address],
    );
  }
  await db.query(
    `insert into unified_events(id,venue,venue_event_id,title,status)
    values($1,'hyperliquid',$1,'Synthetic P4 preparation','ACTIVE')`,
    [identity.marketId],
  );
  await db.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,metadata)
    values($1,'hyperliquid',$1,$1,'Synthetic P4 preparation','ACTIVE','binary',$2::jsonb)`,
    [
      identity.marketId,
      JSON.stringify({ hip4: hip4OrderTestMarket(identity) }),
    ],
  );
  for (const token of identity.sides) {
    await db.query(
      "insert into unified_tokens(market_id,token_id,venue,side) values($1,$2,'hyperliquid',$3)",
      [identity.marketId, token.tokenId, token.sideIndex === 0 ? "YES" : "NO"],
    );
  }
  const profile: WalletExecutionProfile = existing?.profile ?? {
    walletId: controllerWalletRef,
    controllerWalletRef,
    networkId: "hyperliquid:mainnet",
    address,
    source: "external",
    signingModes: ["web_client"],
    serverWalletRef: null,
    sponsorshipPolicyIds: [],
  };
  return {
    userId,
    profile,
    request: {
      requestKey: randomUUID(),
      marketId: identity.marketId,
      outcomeSide: "NO" as const,
      side: "BUY" as const,
      timeInForce: "Ioc" as const,
      limitPrice: "0.333337",
      quantity: "4.8",
      consentedDebitCapRaw: "150000000",
      controllerWalletRef,
    },
    policy: { revision: "test-policy-1", minimumBuyNotionalUsd: "1.00" },
    feeCapRaw: "1000000",
    marketRevision: "market-1",
    accountRevision: "account-1",
    nonce: Date.now(),
    expiresAfter: Date.now() + 60000,
  };
}
