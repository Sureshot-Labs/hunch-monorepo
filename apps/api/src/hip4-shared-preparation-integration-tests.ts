// @requires-db — disposable PG16, rollback fixtures; no provider or signer IO.
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  DEFAULT_HIP4_READ_POLICY,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  hip4Identity,
} from "@hunch/shared";
import type { UserWallet } from "./auth.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { readHip4TradeLifecycle } from "./repos/hip4-order-admission.js";
import { DEFAULT_HIP4_ACCOUNT_POLICY } from "./services/hip4-account-policy.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { hip4AccountReadResponse } from "./services/hip4-account-service.js";
import { hip4PortfolioPositionId } from "./services/hip4-portfolio-positions.js";
import {
  findTradeMarketById,
  loadMarket,
  resolveTradeMarketOutcomeIdentity,
} from "./services/api-trading-market-repo.js";
import { WalletPreparationRuntimeService } from "./funding/preparation/runtime-service.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const db = await pool.connect();
try {
  await db.query("begin");
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  const fixture = await hip4OrderTestFixture(db);
  const now = new Date();
  const identity = hip4Identity(
    "mainnet",
    Number(fixture.request.marketId.split(":").at(-1)),
  );
  for (const side of identity.sides)
    await db.query(
      "insert into unified_market_tokens(market_id,token_id,venue,outcome_side) values($1,$2,'hyperliquid',$3)",
      [identity.marketId, side.tokenId, side.sideIndex === 0 ? "YES" : "NO"],
    );
  const market = await findTradeMarketById(db, identity.marketId);
  assert.equal(market?.venue, "hyperliquid");
  assert.equal(market?.token_yes, identity.sides[0].tokenId);
  await assert.rejects(
    loadMarket(db, identity.marketId),
    /not supported for Telegram/u,
  );
  assert.equal(
    (
      await resolveTradeMarketOutcomeIdentity(db, {
        marketId: identity.marketId,
        venue: "hyperliquid",
        marketContextId: identity.sides[1].tokenId.slice("hyperliquid:".length),
      })
    )?.side,
    "NO",
  );
  await db.query(
    "create temporary table runtime_policies (like public.runtime_policies including all) on commit drop",
  );
  const policy = {
    ...DEFAULT_VENUE_LIFECYCLE_POLICY,
    venues: {
      ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
      hyperliquid: { lifecycle: "active", indexerMode: "full" },
    },
  };
  await db.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',now(),$1::jsonb)",
    [JSON.stringify(policy)],
  );
  assert.ok(fixture.profile.controllerWalletRef);
  const wallet: UserWallet = {
    id: fixture.profile.controllerWalletRef,
    userId: fixture.userId,
    walletAddress: fixture.profile.address,
    walletType: "ethereum",
    name: null,
    isVerified: true,
    isPrimary: true,
    isInternalWallet: false,
    walletSource: "external",
    privyWalletId: null,
    privyProfileUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const readPolicy = { ...DEFAULT_HIP4_READ_POLICY, enabled: true };
  const accountPolicy = { ...DEFAULT_HIP4_ACCOUNT_POLICY, enabled: true };
  const observation = projectHip4Account({
    environment: "mainnet",
    observedAt: now.toISOString(),
    role: "user",
    mode: "disabled",
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [
        {
          coin: "USDC",
          token: 0,
          total: "3.00000001",
          hold: "1",
          entryNtl: "0",
        },
        {
          coin: identity.sides[1].tokenName,
          token: identity.outcome * 10 + 1,
          total: "5.00001",
          hold: "1",
          entryNtl: "0",
        },
      ],
    },
  });
  let reads = 0;
  const service = new WalletPreparationRuntimeService(
    db as unknown as Pool,
    () => now,
    undefined,
    async () => [wallet],
    undefined,
    {
      policy: async () => ({
        readPolicy,
        accountPolicy,
        revision: "synthetic-account-v1",
      }),
      load: async (address, policy, account, revision) => {
        reads++;
        return hip4AccountReadResponse({
          address,
          policy,
          accountPolicy: account,
          revision,
          now: now.getTime(),
          row: {
            observation,
            observed_at: now,
            attempt_at: now,
            attempt_error: null,
            lease_until: null,
            history: {},
          },
        });
      },
    },
    async () => {
      throw new Error("Trading preparation must not read funding policy");
    },
    async (purpose) => {
      try {
        const lifecycle = await readHip4TradeLifecycle(
          db,
          purpose === "buy" ? "BUY" : "SELL",
        );
        return JSON.stringify(lifecycle.policy);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "hip4_lifecycle_disabled"
        )
          return null;
        throw error;
      }
    },
  );
  const request = {
    accountId: fixture.userId,
    purpose: "buy" as const,
    marketClass: null,
    marketContextId: identity.marketId,
    compatibleVenueBindingOptionIds: null,
    controllerWalletRef: wallet.id,
  };
  const [buy] = await service.frozenDestinations(request);
  assert.equal(buy.preparation.status, "ready");
  assert.equal(buy.spendability.availableAmount.raw, "200000001");
  assert.deepEqual(
    buy.spendability.availableAmount.asset,
    HYPERCORE_MAINNET_USDC,
  );
  assert.equal(buy.preparation.evidence.facts.marketId, identity.marketId);
  const [sell] = await service.frozenDestinations({
    ...request,
    purpose: "sell",
    positionActionRef: hip4PortfolioPositionId(
      "mainnet",
      wallet.walletAddress,
      identity.sides[1].tokenId,
    ),
  });
  assert.equal(sell.preparation.status, "ready");
  assert.equal(
    sell.preparation.evidence.facts.positionTokenId,
    identity.sides[1].tokenId,
  );
  await db.query(
    "update runtime_policies set payload=jsonb_set(payload,'{venues,hyperliquid,lifecycle}','\"exit-only\"'::jsonb) where policy_key='venue_lifecycle'",
  );
  assert.deepEqual(await service.frozenDestinations(request), []);
  assert.equal(reads, 2, "disabled purpose must not read the account again");
  assert.equal(
    (
      await service.frozenDestinations({
        ...request,
        purpose: "sell",
        positionActionRef: hip4PortfolioPositionId(
          "mainnet",
          wallet.walletAddress,
          identity.sides[1].tokenId,
        ),
      })
    )[0].preparation.status,
    "ready",
  );
  await db.query("update unified_markets set status='CLOSED' where id=$1", [
    identity.marketId,
  ]);
  assert.deepEqual(
    await service.listDestinationOptions({
      ...request,
      purpose: "sell",
      positionActionRef: hip4PortfolioPositionId(
        "mainnet",
        wallet.walletAddress,
        identity.sides[1].tokenId,
      ),
    }),
    [],
  );
  console.log(
    "[hip4-shared-preparation] real unified identity, local outcome, native holds, lifecycle, sell owner and terminal recovery passed",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
