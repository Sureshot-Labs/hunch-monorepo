import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "@hunch/infra";

import type { UserWallet } from "../../../auth.js";
import type { ApiTradeMarket } from "../../../services/api-trading-market-repo.js";
import type { PreparationResult } from "../../domain/contracts.js";
import {
  type PreparedRuntimeDestination,
  type RuntimeVenueInspectionInput,
  WalletPreparationRuntimeService,
  type WalletPreparationRuntimeDriver,
  walletPreparationRuntimeTestHooks,
} from "../../preparation/runtime-service.js";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const SELECTED_WALLET_ID = "00000000-0000-4000-8000-000000000012";
const SELECTED_BINDING_ID = "binding_selected_12345678";

function wallet(index: number): UserWallet {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    userId: ACCOUNT_ID,
    walletAddress: `0x${index.toString(16).padStart(40, "0")}`,
    walletType: "ethereum",
    name: `Wallet ${index}`,
    isPrimary: index === 11,
    isVerified: true,
    privyWalletId: null,
    walletSource: "embedded",
    isInternalWallet: true,
    privyProfileUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const wallets = [wallet(11), wallet(12), wallet(13)] as const;

const market: ApiTradeMarket = {
  accepting_orders: true,
  best_ask: "0.52",
  best_bid: "0.50",
  clob_token_ids: null,
  close_time: new Date("2026-08-01T00:00:00.000Z"),
  condition_id: "condition-1",
  event_id: "polymarket:event-1",
  event_end_time: new Date("2026-08-01T00:00:00.000Z"),
  event_title: "Test event",
  expiration_time: new Date("2026-08-01T00:00:00.000Z"),
  id: "polymarket:market-1",
  is_initialized: true,
  last_price: "0.51",
  metadata: {},
  neg_risk: false,
  neg_risk_parent_condition_id: null,
  neg_risk_request_id: null,
  outcomes: '["YES","NO"]',
  question_id: "question-1",
  slug: "test-market",
  status: "active",
  title: "Test market",
  token_no: "token-no",
  token_yes: "token-yes",
  updated_at: NOW,
  venue: "polymarket",
  venue_market_id: "market-1",
};

function preparedDestination(
  input: RuntimeVenueInspectionInput,
): PreparedRuntimeDestination {
  const preparation = {
    status: "ready",
  } as unknown as PreparationResult;
  return {
    frozen: {
      bindingOption: {
        venueBindingOptionId:
          input.wallet.id === SELECTED_WALLET_ID
            ? SELECTED_BINDING_ID
            : `binding_${input.wallet.id}`,
      },
      preparation,
    } as unknown as PreparedRuntimeDestination["frozen"],
    preparation,
    wallet: input.wallet,
  } as unknown as PreparedRuntimeDestination;
}

function driver(
  inspected: RuntimeVenueInspectionInput[],
): WalletPreparationRuntimeDriver {
  return {
    venueId: "polymarket",
    supportedMarketClasses: ["standard", "neg_risk"],
    supportsWallet: () => true,
    inspect: async (input) => {
      inspected.push(input);
      return preparedDestination(input);
    },
    ownerCandidates: async ({ wallets: candidates }) => ({
      candidateWallets: candidates,
      ownershipHinted: candidates.length > 0,
    }),
    matchesAccountRef: () => false,
  };
}

function marketDb(queries: string[]): Pool {
  return {
    query: async (sql: string) => {
      queries.push(sql);
      assert.match(sql, /WHERE m\.id = \$1/i);
      return { rows: [market], rowCount: 1 };
    },
  } as unknown as Pool;
}

await test("explicit binding controller inspects exactly the selected wallet", async () => {
  const inspected: RuntimeVenueInspectionInput[] = [];
  const queries: string[] = [];
  const service = new WalletPreparationRuntimeService(
    marketDb(queries),
    () => NOW,
    [driver(inspected)],
    async () => wallets,
  );

  const preparation = await service.inspectBindingOption({
    accountId: ACCOUNT_ID,
    purpose: "buy",
    marketContextId: market.id,
    marketClass: null,
    positionActionRef: null,
    compatibleVenueBindingOptionIds: [SELECTED_BINDING_ID],
    controllerWalletRef: SELECTED_WALLET_ID,
    venueBindingOptionId: SELECTED_BINDING_ID,
  });

  assert.equal(preparation.status, "ready");
  assert.deepEqual(
    inspected.map((input) => input.wallet.id),
    [SELECTED_WALLET_ID],
  );
  assert.equal(queries.length, 1);
});

await test("one destination discovery resolves and shares one immutable market context", async () => {
  const inspected: RuntimeVenueInspectionInput[] = [];
  const queries: string[] = [];
  const service = new WalletPreparationRuntimeService(
    marketDb(queries),
    () => NOW,
    [driver(inspected)],
    async () => wallets,
  );

  const destinations = await service.frozenDestinations(
    {
      accountId: ACCOUNT_ID,
      purpose: "buy",
      marketContextId: market.id,
      marketClass: null,
      positionActionRef: null,
      compatibleVenueBindingOptionIds: null,
      controllerWalletRef: null,
    },
    market,
  );

  assert.equal(destinations.length, wallets.length);
  assert.equal(queries.length, 0);
  assert.equal(inspected.length, wallets.length);
  const contexts = inspected.map((input) => input.resolvedMarketContext);
  assert.ok(contexts.every(Boolean));
  assert.equal(new Set(contexts).size, 1);
  assert.equal(contexts[0]?.market, market);
});

await test("venue locks and internal reservations are both excluded from destination availability", () => {
  assert.equal(
    walletPreparationRuntimeTestHooks.availableRaw(
      "12500000",
      "5000000",
      "500000",
    ),
    "7000000",
  );
  assert.equal(
    walletPreparationRuntimeTestHooks.availableRaw(
      "1000000",
      "900000",
      "200000",
    ),
    "0",
  );
});
