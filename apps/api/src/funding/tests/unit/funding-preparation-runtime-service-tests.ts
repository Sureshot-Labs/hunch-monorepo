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

function venueDriver(input: {
  inspected: RuntimeVenueInspectionInput[];
  venueId: "polymarket" | "limitless";
  inspect: (
    inspection: RuntimeVenueInspectionInput,
  ) => Promise<PreparedRuntimeDestination>;
}): WalletPreparationRuntimeDriver {
  return {
    venueId: input.venueId,
    supportedMarketClasses: ["standard", "neg_risk"],
    supportsWallet: () => true,
    inspect: async (inspection) => {
      input.inspected.push(inspection);
      return input.inspect(inspection);
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

await test("owner-bound redemption inspects the canonical historical owner", async () => {
  const inspected: RuntimeVenueInspectionInput[] = [];
  const exactOwner = wallets[0].walletAddress;
  const service = new WalletPreparationRuntimeService(
    {} as Pool,
    () => NOW,
    [
      {
        venueId: "polymarket",
        supportedMarketClasses: ["standard", "neg_risk"],
        supportsWallet: () => true,
        ownerCandidates: async () => ({
          candidateWallets: [wallets[0]],
          ownershipHinted: true,
        }),
        matchesAccountRef: (accountRef, ownerAddress) =>
          accountRef.toLowerCase() === ownerAddress.toLowerCase(),
        inspect: async (input) => {
          inspected.push(input);
          const binding = {
            bindingId: "binding_historical_owner_12345678",
            accountRef: exactOwner,
          };
          return {
            frozen: {
              preparation: { binding },
            },
            wallet: input.wallet,
          } as unknown as PreparedRuntimeDestination;
        },
      },
    ],
    async () => wallets,
  );

  const resolved = await service.resolveOwnerPreparation({
    accountId: ACCOUNT_ID,
    venueId: "polymarket",
    ownerAddress: exactOwner,
    marketContextId: market.id,
    marketClass: "standard",
  });

  assert.equal(inspected.length, 1);
  assert.equal(inspected[0]?.requiredOwnerAccountRef, exactOwner);
  assert.equal(resolved.frozen.preparation.binding.accountRef, exactOwner);
});

await test("Polymarket inspection preserves an exact signer-held position owner", () => {
  const signer = wallets[0].walletAddress;
  const deposit = wallets[1].walletAddress;
  assert.equal(
    walletPreparationRuntimeTestHooks.polymarketInspectionAccountRef({
      walletAddress: signer,
      storedFunderAddress: null,
      derivedDepositAddress: deposit,
      requiredOwnerAccountRef: signer,
    }),
    signer,
  );
  assert.throws(() =>
    walletPreparationRuntimeTestHooks.polymarketInspectionAccountRef({
      walletAddress: signer,
      storedFunderAddress: null,
      derivedDepositAddress: deposit,
      requiredOwnerAccountRef: wallets[2].walletAddress,
    }),
  );
});

await test("only the canonical derived Deposit Wallet is owner verified", () => {
  const signer = wallets[0].walletAddress;
  const canonicalDeposit = wallets[1].walletAddress;
  const arbitraryStoredFunder = wallets[2].walletAddress;
  const signatureTypeThreeCandidate = {
    funder: arbitraryStoredFunder,
    signatureType: 3 as const,
    source: "stored" as const,
    expectedContract: true,
    deployed: false,
    contractKind: "NOT_DEPLOYED" as const,
  };

  assert.deepEqual(
    walletPreparationRuntimeTestHooks.polymarketTopology({
      signer,
      funder: canonicalDeposit,
      candidate: null,
      deposit: {
        address: canonicalDeposit,
        deployed: false,
        generation: "beacon",
        factory: wallets[0].walletAddress,
        implementation: wallets[1].walletAddress,
        beacon: wallets[2].walletAddress,
      },
    }),
    {
      topology: "deposit_wallet",
      deployed: false,
      ownerVerified: true,
      executionMode: "venue_relayer",
    },
  );
  assert.deepEqual(
    walletPreparationRuntimeTestHooks.polymarketTopology({
      signer,
      funder: arbitraryStoredFunder,
      candidate: signatureTypeThreeCandidate,
      deposit: {
        address: canonicalDeposit,
        deployed: false,
        generation: "beacon",
        factory: wallets[0].walletAddress,
        implementation: wallets[1].walletAddress,
        beacon: wallets[2].walletAddress,
      },
    }),
    {
      topology: "unknown_contract",
      deployed: false,
      ownerVerified: false,
      executionMode: "web_client",
    },
  );
});

await test("external wallets verify a distinct stored Deposit Wallet canonically", () => {
  const signer = wallets[0].walletAddress;
  const storedFunder = wallets[1].walletAddress;

  assert.equal(
    walletPreparationRuntimeTestHooks.shouldInspectPolymarketDepositWallet({
      internalWallet: false,
      requiredOwnerAccountRef: null,
      storedFunderAddress: storedFunder,
      walletAddress: signer,
    }),
    true,
  );
  assert.equal(
    walletPreparationRuntimeTestHooks.shouldInspectPolymarketDepositWallet({
      internalWallet: false,
      requiredOwnerAccountRef: null,
      storedFunderAddress: signer,
      walletAddress: signer,
    }),
    false,
  );
  assert.deepEqual(
    walletPreparationRuntimeTestHooks.polymarketTopology({
      signer,
      funder: storedFunder,
      candidate: {
        funder: storedFunder,
        signatureType: 3,
        source: "stored",
        expectedContract: true,
        deployed: true,
        contractKind: "CONTRACT",
      },
      deposit: {
        address: storedFunder,
        deployed: true,
        generation: "beacon",
        factory: wallets[0].walletAddress,
        implementation: wallets[1].walletAddress,
        beacon: wallets[2].walletAddress,
      },
    }),
    {
      topology: "deposit_wallet",
      deployed: true,
      ownerVerified: true,
      executionMode: "venue_relayer",
    },
  );
});

await test("an exact successful binding is not blocked by an unrelated venue inspection failure", async () => {
  const inspected: RuntimeVenueInspectionInput[] = [];
  const service = new WalletPreparationRuntimeService(
    {} as Pool,
    () => NOW,
    [
      venueDriver({
        inspected,
        venueId: "polymarket",
        inspect: async (input) => preparedDestination(input),
      }),
      venueDriver({
        inspected,
        venueId: "limitless",
        inspect: async () => {
          throw new Error("unrelated venue unavailable");
        },
      }),
    ],
    async () => wallets,
  );

  const destinations = await service.frozenDestinations({
    accountId: ACCOUNT_ID,
    purpose: "fund",
    marketContextId: null,
    marketClass: null,
    positionActionRef: null,
    compatibleVenueBindingOptionIds: [SELECTED_BINDING_ID],
    controllerWalletRef: SELECTED_WALLET_ID,
  });

  assert.deepEqual(
    destinations.map(
      (destination) => destination.bindingOption.venueBindingOptionId,
    ),
    [SELECTED_BINDING_ID],
  );
  assert.equal(inspected.length, 2);
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
