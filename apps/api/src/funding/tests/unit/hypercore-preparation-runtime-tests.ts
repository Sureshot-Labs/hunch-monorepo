import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_HIP4_READ_POLICY, hip4Identity } from "@hunch/shared";
import type { UserWallet } from "../../../auth.js";
import { DEFAULT_HIP4_ACCOUNT_POLICY } from "../../../services/hip4-account-policy.js";
import { projectHip4Account } from "../../../services/hip4-account-projection.js";
import { hip4AccountReadResponse } from "../../../services/hip4-account-service.js";
import {
  hypercoreSpotAccountLocation,
  stableWalletOpaqueId,
} from "../../../account-value/canonical.js";
import { HYPERCORE_PREPARATION_AVAILABILITY_SQL } from "../../preparation/hypercore-availability.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import { resolveFundingPolicy } from "../../policies/funding-policy-service.js";
import { WalletPreparationRuntimeService } from "../../preparation/runtime-service.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";
import { hypercoreFundingBalance } from "../../preparation/hypercore-adapter.js";
import { hip4PortfolioPositionId } from "../../../services/hip4-portfolio-positions.js";
import type { ApiTradeMarket } from "../../../services/api-trading-market-repo.js";
import {
  fundingDestinationsQuerySchema,
  fundingPreparationInspectRequestSchema,
  fundingPreparationPrepareRequestSchema,
} from "../../../schemas/funding.js";

const isPreparationUnavailable = (error: unknown): boolean =>
  error instanceof PreparationContractError &&
  error.code === "preparation_unavailable";

async function fixture(outcome = 1473) {
  let now = new Date("2026-10-14T16:00:00Z");
  const wallet: UserWallet = {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    walletAddress: `0x${"a".repeat(40)}`,
    walletType: "ethereum",
    name: null,
    isPrimary: true,
    isVerified: true,
    privyWalletId: null,
    walletSource: "external",
    isInternalWallet: false,
    privyProfileUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const baseFunding = await resolveFundingPolicy({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool);
  const state = {
    fundingEnabled: true,
    fundingRevision: "fund-1",
    buyEnabled: true,
    sellEnabled: true,
    tradeRevision: "trade-1",
    tradeError: false,
    readRevision: "read-1",
    accountRevision: "account-1",
    readEnabled: true,
    environment: "mainnet" as "mainnet" | "testnet",
    maxAgeMs: 60000,
    error: null as string | null,
    refreshing: false,
    role: "user" as "user" | "missing",
    mode: "disabled" as "disabled" | "default" | "unifiedAccount",
    qualifiedDefault: false,
    total: "0",
    held: "0",
    observedAt: now.toISOString(),
    empty: false,
    positionQuantity: "0",
    positionHeld: "0",
    positionSide: 0 as 0 | 1,
    wrongOwner: false,
    reservedRaw: "0",
    debitRaw: "0",
    afterLoad: null as (() => void) | null,
  };
  const loads: boolean[] = [];
  const loadedAddresses: string[] = [];
  const wallets = [wallet];
  const identity = hip4Identity("mainnet", outcome);
  const market: ApiTradeMarket = {
    id: identity.marketId,
    venue: "hyperliquid",
    venue_market_id: identity.marketId,
    event_id: "hyperliquid:mainnet:question:198",
    event_title: "Synthetic native preparation",
    title: "Synthetic native outcome",
    event_end_time: null,
    status: "ACTIVE",
    slug: null,
    token_yes: identity.sides[0].tokenId,
    token_no: identity.sides[1].tokenId,
    accepting_orders: false,
    close_time: null,
    expiration_time: null,
    metadata: { acceptingOrders: false },
    outcomes: '["Yes","No"]',
    best_ask: null,
    best_bid: null,
    last_price: null,
    clob_token_ids: null,
    is_initialized: null,
    updated_at: now,
  };
  let policyReads = 0;
  const snapshot = () =>
    projectHip4Account({
      environment: state.environment,
      role: state.role,
      mode: state.mode,
      defaultSpotCashEvidence: state.qualifiedDefault
        ? {
            legacyDexAbstraction: null,
            borrowLendState: {
              tokenToState: [],
              health: "healthy",
              healthFactor: null,
            },
          }
        : undefined,
      observedAt: state.observedAt,
      quote: {
        tokenId: HYPERCORE_MAINNET_USDC.assetId,
        index: 0,
        weiDecimals: 8,
      },
      state: {
        balances: state.empty
          ? []
          : [
              {
                coin: "USDC",
                token: 0,
                total: state.total,
                hold: state.held,
                entryNtl: "0",
              },
              ...(state.positionQuantity !== "0"
                ? [
                    {
                      coin: identity.sides[state.positionSide].tokenName,
                      token: outcome * 10 + state.positionSide,
                      total: state.positionQuantity,
                      hold: state.positionHeld,
                      entryNtl: "0",
                    },
                  ]
                : []),
            ],
      },
    });
  const readPolicy = () => ({
    ...DEFAULT_HIP4_READ_POLICY,
    enabled: state.readEnabled,
    environment: state.environment,
  });
  const accountPolicy = () => ({
    ...DEFAULT_HIP4_ACCOUNT_POLICY,
    enabled: true,
    snapshotMaxAgeMs: state.maxAgeMs,
  });
  const nativeService = {
    policy: async () => {
      policyReads++;
      return {
        readPolicy: readPolicy(),
        accountPolicy: accountPolicy(),
        revision: `${state.readRevision}:${state.accountRevision}`,
      };
    },
    load: async (
      address: string,
      policy: ReturnType<typeof readPolicy>,
      account: ReturnType<typeof accountPolicy>,
      revision: string,
      refresh: boolean,
    ) => {
      loads.push(refresh);
      loadedAddresses.push(address);
      const value = hip4AccountReadResponse({
        row: {
          observation: snapshot(),
          observed_at: new Date(state.observedAt),
          attempt_at: now,
          attempt_error: state.error,
          lease_until: state.refreshing ? new Date(now.getTime() + 1000) : null,
          history: {},
        },
        policy,
        accountPolicy: account,
        revision,
        address: state.wrongOwner ? `0x${"b".repeat(40)}` : address,
        now: now.getTime(),
      });
      state.afterLoad?.();
      return value;
    },
  };
  const funding = async () => ({
    ...baseFunding,
    revision: state.fundingRevision,
    runtime: {
      ...baseFunding.runtime,
      creationMode: "on" as const,
      gates: {
        ...baseFunding.runtime.gates,
        quoteCreation: true,
        commit: true,
        startUnsubmittedAction: true,
        emergencyBroadcastPause: false,
      },
      // Offline activation envelope only; the production validator stays closed.
      venues: [
        ...baseFunding.runtime.venues.filter(
          (venue) => venue.venueId !== "hyperliquid",
        ),
        {
          ...baseFunding.runtime.venues[0],
          venueId: "hyperliquid",
          lifecycleEnabled: state.fundingEnabled,
          destinationReadinessEnabled: state.fundingEnabled,
          fundingEnabled: state.fundingEnabled,
        },
      ],
    },
  });
  const db = {
    query: async (sql: string, values: unknown[]) => {
      if (
        sql.includes("FROM unified_markets m") &&
        sql.includes("WHERE m.id = $1")
      ) {
        assert.equal(values[0], market.id);
        return { rows: [structuredClone(market)] };
      }
      if (sql === HYPERCORE_PREPARATION_AVAILABILITY_SQL) {
        const [source] = JSON.parse(String(values[1]));
        assert.equal(source.address, wallet.walletAddress);
        assert.equal(source.asset_decimals, 8);
        assert.equal(source.snapshot_at, state.observedAt);
        assert.equal(source.component_id, null);
        return {
          rows: [
            {
              reserved_raw: state.reservedRaw,
              submitted_debit_raw: state.debitRaw,
              debit_alias_candidates: [],
            },
          ],
        };
      }
      throw new Error("Unexpected preparation query");
    },
  } as unknown as Pool;
  const service = new WalletPreparationRuntimeService(
    db,
    () => now,
    undefined,
    async () => wallets,
    undefined,
    nativeService,
    funding,
    async (purpose) => {
      if (state.tradeError) throw new Error("Synthetic lifecycle unavailable");
      return (purpose === "buy" ? state.buyEnabled : state.sellEnabled)
        ? state.tradeRevision
        : null;
    },
  );
  const input = {
    accountId: wallet.userId,
    purpose: "fund" as const,
    marketContextId: null,
    marketClass: "hip4",
    compatibleVenueBindingOptionIds: null,
  };
  return {
    state,
    wallet,
    wallets,
    service,
    input,
    loads,
    loadedAddresses,
    snapshot,
    market,
    identity,
    reads: () => policyReads,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test("native fund uses canonical identity, real observation time, holds and common post-snapshot debits", async () => {
  const f = await fixture();
  Object.assign(f.state, {
    total: "100",
    held: "5",
    reservedRaw: "300000000",
    debitRaw: "200000000",
    error: "fills_timeout",
  });
  const [candidate] = await f.service.resolvedCandidates(f.input);
  assert.ok(candidate?.option.selectable);
  const identity = hypercoreSpotAccountLocation({
    accountId: f.wallet.userId,
    address: f.wallet.walletAddress,
    controllerWalletId: stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: HYPERCORE_MAINNET_USDC.networkId,
      address: f.wallet.walletAddress,
    }),
  });
  assert.deepEqual(candidate.target, {
    kind: "owned_location",
    location: identity.location,
  });
  assert.equal(candidate.availableNow.raw, "9000000000");
  assert.deepEqual(candidate.option.spendability, {
    availableAmount: candidate.availableNow,
    revision: candidate.spendability.revision,
    asOf: candidate.spendability.asOf,
    expiresAt: candidate.spendability.expiresAt,
  });
  assert.equal(candidate.spendability.submittedDebitRaw, "200000000");
  assert.equal(candidate.spendability.asOf, f.state.observedAt);
  assert.deepEqual(candidate.preparationActions, []);
});

test("zero Standard and clean missing/default accounts are fund-only ready without mode coercion", async () => {
  for (const empty of [false, true]) {
    const f = await fixture();
    if (empty)
      Object.assign(f.state, { empty: true, role: "missing", mode: "default" });
    const [frozen] = await f.service.frozenDestinations(f.input);
    assert.equal(frozen.preparation.status, "ready");
    assert.equal(frozen.spendability.availableAmount.raw, "0");
    assert.equal(
      frozen.preparation.evidence.facts.accountMode,
      empty ? "default" : "disabled",
    );
    assert.equal(
      frozen.preparation.topology,
      empty ? "native_uninitialized_recipient" : "native_standard_spot",
    );
    assert.deepEqual(frozen.preparation.requiredActions, []);
  }
});

test("funding-disabled HIP never reads native accounts or poisons generic venue discovery", async () => {
  const f = await fixture();
  f.state.fundingEnabled = false;
  for (const [method, venueId] of [
    ["inspectPolymarket", "polymarket"],
    ["inspectLimitless", "limitless"],
  ]) {
    Object.defineProperty(f.service, method, {
      value: async () => ({
        frozen: {
          venueId,
          preparation: {
            status: "ready",
            expiresAt: new Date(f.now().getTime() + 45000).toISOString(),
          },
        },
      }),
    });
  }
  const results = await f.service.frozenDestinations({
    ...f.input,
    marketClass: null,
  });
  assert.deepEqual(
    results.map((row) => row.venueId),
    ["polymarket", "limitless"],
  );
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.loads, []);
});

test("native policy scope invalidates cached readiness, never masks disabled or testnet reads", async () => {
  const f = await fixture();
  assert.equal((await f.service.listDestinationOptions(f.input)).length, 1);
  await f.service.listDestinationOptions(f.input);
  assert.equal(f.loads.length, 1);
  f.state.readEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.readEnabled = true;
  f.state.environment = "testnet";
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.environment = "mainnet";
  f.state.accountRevision = "account-2";
  f.state.maxAgeMs = 1000;
  f.advance(2000);
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.observedAt = f.now().toISOString();
  assert.equal((await f.service.listDestinationOptions(f.input)).length, 1);
  assert.equal(f.loads.length, 3);
});

test("native observation expiry is not extended by preparation cache", async () => {
  const f = await fixture();
  f.state.observedAt = new Date(f.now().getTime() - 59000).toISOString();
  const [frozen] = await f.service.frozenDestinations(f.input);
  assert.equal(
    frozen.preparation.expiresAt,
    new Date(f.now().getTime() + 1000).toISOString(),
  );
  assert.equal(frozen.preparation.inspectedAt, f.state.observedAt);
  f.advance(1001);
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.observedAt = f.now().toISOString();
  assert.equal((await f.service.listDestinationOptions(f.input)).length, 1);
});

test("policy change during native load rejects the result and ordinary retry recovers", async () => {
  const f = await fixture();
  f.state.afterLoad = () => {
    f.state.fundingEnabled = false;
  };
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.afterLoad = null;
  f.state.fundingEnabled = true;
  f.state.fundingRevision = "fund-2";
  assert.equal((await f.service.listDestinationOptions(f.input)).length, 1);
});

test("explicit native refresh bypasses cached readiness and a failed refresh cannot resurrect it", async () => {
  const f = await fixture();
  const [initial] = await f.service.frozenDestinations(f.input);
  const request = {
    ...f.input,
    venueBindingOptionId: initial.bindingOption.venueBindingOptionId,
  };
  await Promise.all(
    Array.from({ length: 6 }, () => f.service.inspectBindingOption(request)),
  );
  assert.deepEqual(f.loads, [false]);
  f.state.total = "8";
  const refreshed = await f.service.inspectBindingOption(request, {
    forceFresh: true,
  });
  assert.equal(refreshed.evidence.facts.cashRaw, "800000000");
  assert.deepEqual(f.loads, [false, true]);
  const prepared = await f.service.prepareBindingOption({
    ...request,
    operationId: "00000000-0000-4000-8000-000000000003",
    expectedInspectionRevision: refreshed.inspectionRevision,
  });
  assert.deepEqual(prepared, { actions: [], controllerWalletRef: f.wallet.id });
  f.state.mode = "unifiedAccount";
  await assert.rejects(
    f.service.inspectBindingOption(request, { forceFresh: true }),
    PreparationContractError,
  );
  assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  f.state.mode = "disabled";
  assert.equal((await f.service.listDestinationOptions(f.input)).length, 1);
});

test("forced native inspection requires new core evidence after failed IO or a contended lease and retries immediately", async () => {
  for (const purpose of ["fund", "buy", "sell"] as const) {
    const f = await fixture();
    f.state.positionQuantity = "3";
    const input = {
      ...f.input,
      purpose,
      marketContextId: purpose === "fund" ? null : f.market.id,
      positionActionRef:
        purpose === "sell"
          ? hip4PortfolioPositionId(
              "mainnet",
              f.wallet.walletAddress,
              f.identity.sides[0].tokenId,
            )
          : null,
    };
    const [initial] = await f.service.frozenDestinations(input);
    const request = {
      ...input,
      venueBindingOptionId: initial.bindingOption.venueBindingOptionId,
    };
    f.advance(1000);
    // Still within TTL, but no new observation after a failed core refresh.
    f.state.error = "account_timeout";
    await assert.rejects(
      f.service.inspectBindingOption(request, { forceFresh: true }),
      PreparationContractError,
    );
    f.state.error = null;
    f.state.refreshing = true;
    await assert.rejects(
      f.service.inspectBindingOption(request, { forceFresh: true }),
      PreparationContractError,
    );
    // Core data recovered; an unrelated history failure is not a cash failure.
    f.state.refreshing = false;
    f.state.error = "fills_timeout";
    f.state.observedAt = f.now().toISOString();
    const recovered = await f.service.inspectBindingOption(request, {
      forceFresh: true,
    });
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.inspectedAt, f.state.observedAt);
    assert.notEqual(recovered.inspectedAt, initial.preparation.inspectedAt);
    assert.deepEqual(f.loads, [false, true, true, true]);
  }
});

test("unsupported purposes do not inspect or confer native redeem/withdraw readiness", async () => {
  const f = await fixture();
  for (const purpose of ["redeem", "withdraw"] as const) {
    assert.deepEqual(
      await f.service.listDestinationOptions({ ...f.input, purpose }),
      [],
    );
  }
  await assert.rejects(
    f.service.resolveOwnerPreparation({
      accountId: f.wallet.userId,
      venueId: "hyperliquid",
      marketClass: "hip4",
      marketContextId: "hyperliquid:mainnet:outcome:1",
      ownerAddress: f.wallet.walletAddress,
    }),
    PreparationContractError,
  );
  assert.deepEqual(f.loads, []);
  assert.equal(f.reads(), 0);
});

test("native BUY uses shared preparation and exact 8-decimal availability without requiring funding enabled", async () => {
  const f = await fixture();
  Object.assign(f.state, {
    fundingEnabled: false,
    total: "2.00000001",
    reservedRaw: "50000000",
    debitRaw: "1",
  });
  const [candidate] = await f.service.resolvedCandidates({
    ...f.input,
    purpose: "buy",
    marketContextId: f.market.id,
  });
  assert.equal(candidate.option.selectable, true);
  assert.equal(candidate.availableNow.raw, "150000000");
  assert.deepEqual(candidate.availableNow.asset, HYPERCORE_MAINNET_USDC);
  assert.deepEqual(candidate.preparationActions, []);
  const [frozen] = await f.service.frozenDestinations({
    ...f.input,
    purpose: "buy",
    marketContextId: f.market.id,
  });
  assert.equal(frozen.preparation.evidence.facts.marketId, f.market.id);
  assert.equal(
    frozen.preparation.evidence.facts.capacityAuthority,
    "fresh_quote_and_submission",
  );
  assert.equal(frozen.preparation.purpose, "buy");
  assert.deepEqual(f.loads, [false]);
});

test("native BUY shortfall accepts clean empty recipients without asserting Standard authority", async () => {
  const f = await fixture();
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  assert.equal(
    (await f.service.frozenDestinations(request))[0].spendability
      .availableAmount.raw,
    "0",
  );
  Object.assign(f.state, {
    mode: "default",
    empty: true,
    role: "missing",
    accountRevision: "first-buy",
  });
  const firstBuy = (await f.service.frozenDestinations(request))[0];
  assert.equal(firstBuy.spendability.availableAmount.raw, "0");
  assert.equal(firstBuy.preparation.topology, "native_uninitialized_recipient");
  assert.equal(firstBuy.preparation.status, "ready");
  assert.equal(
    JSON.stringify(firstBuy.preparation).includes("native_standard_account"),
    false,
  );
  assert.equal(
    JSON.stringify(firstBuy.preparation).includes("native_recipient_observed"),
    true,
  );
  for (const mode of ["unifiedAccount"] as const) {
    Object.assign(f.state, {
      mode,
      empty: true,
      role: "missing",
      accountRevision: mode,
    });
    await assert.rejects(
      f.service.listDestinationOptions(request),
      isPreparationUnavailable,
    );
  }
  Object.assign(f.state, {
    mode: "disabled",
    empty: false,
    role: "user",
    accountRevision: "recovered",
  });
  assert.equal((await f.service.listDestinationOptions(request)).length, 1);
});

test("destination refresh bypasses cached pre-funding cash and cannot restore it after failed IO", async () => {
  const f = await fixture();
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  const initial = (await f.service.listDestinationOptions(request))[0];
  assert.equal(initial.spendability?.availableAmount.raw, "0");
  f.advance(1000);
  f.state.error = "account_timeout";
  await assert.rejects(
    f.service.listDestinationOptions(request, { forceFresh: true }),
    isPreparationUnavailable,
  );
  f.state.error = null;
  f.state.total = "10";
  f.state.observedAt = f.now().toISOString();
  const refreshed = (
    await f.service.listDestinationOptions(request, { forceFresh: true })
  )[0];
  assert.equal(refreshed.spendability?.availableAmount.raw, "1000000000");
  assert.equal(refreshed.spendability?.asOf, f.state.observedAt);
  assert.deepEqual(f.loads, [false, true, true]);
});
test("qualified funded default destinations support explicit BUY shortfall and SELL preparation without mode coercion", async () => {
  const f = await fixture();
  Object.assign(f.state, {
    mode: "default",
    total: "7.12345678",
    held: "0.12345678",
    qualifiedDefault: true,
    positionQuantity: "2.00001",
  });
  const buy = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  const [funded] = await f.service.frozenDestinations(buy);
  assert.equal(funded.preparation.status, "ready");
  assert.equal(funded.preparation.topology, "native_qualified_default_spot");
  assert.equal(funded.preparation.evidence.facts.accountMode, "default");
  assert.equal(funded.spendability.availableAmount.raw, "700000000");
  assert.deepEqual(
    funded.preparation.requiredActions,
    [],
    "inspection never changes mode or submits a BUY",
  );
  const [sell] = await f.service.frozenDestinations({
    ...buy,
    purpose: "sell",
    positionActionRef: hip4PortfolioPositionId(
      "mainnet",
      f.wallet.walletAddress,
      f.identity.sides[0].tokenId,
    ),
  });
  assert.equal(sell.preparation.status, "ready");
  assert.equal(
    sell.preparation.evidence.checks.some(
      (row) => row.checkId === "native_spot_account",
    ),
    true,
  );
  f.state.qualifiedDefault = false;
  f.state.accountRevision = "proof-unavailable";
  await assert.rejects(
    f.service.frozenDestinations(buy),
    isPreparationUnavailable,
  );
});

test("market-scoped discovery keeps policy-disabled and unsupported wallets as legitimate empty results", async () => {
  const f = await fixture();
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  f.state.buyEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  f.state.buyEnabled = true;
  f.wallet.isVerified = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  f.wallet.isVerified = true;
  f.wallet.walletSource = "unknown";
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  assert.deepEqual(f.loads, []);
});

test("market-scoped native refresh budget denial reports unavailability and ordinary snapshot retry recovers", async () => {
  const f = await fixture();
  Object.assign(f.state, { empty: true, role: "missing", mode: "default" });
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  const [initial] = await f.service.listDestinationOptions(request);
  assert.equal(initial.preparationStatus, "ready");
  assert.equal(initial.spendability?.availableAmount.raw, "0");
  f.advance(1000);
  f.state.error = "budget_exhausted";
  await assert.rejects(
    f.service.listDestinationOptions(request, { forceFresh: true }),
    (error: unknown) => {
      assert.ok(error instanceof PreparationContractError);
      assert.equal(error.code, "preparation_unavailable");
      assert.equal(
        error.message,
        "The requested Trading Wallet could not be verified. Try again.",
      );
      assert.doesNotMatch(error.message, /budget_exhausted/);
      return true;
    },
  );
  // Failure to obtain newer core evidence does not invalidate the still-fresh
  // stored zero snapshot or impose a cooldown on an ordinary inspection.
  const [recovered] = await f.service.listDestinationOptions(request);
  assert.equal(recovered.preparationStatus, "ready");
  assert.equal(recovered.topology, "native_uninitialized_recipient");
  assert.equal(recovered.spendability?.availableAmount.raw, "0");
  assert.equal(recovered.spendability?.asOf, f.state.observedAt);
  assert.deepEqual(f.loads, [false, true, false]);
});

test("two native NO contracts pass the public preparation schemas and exact owned runtime without extra setup", async () => {
  const f = await fixture(11797);
  Object.assign(f.state, { positionQuantity: "2", positionSide: 1 });
  const positionActionRef = hip4PortfolioPositionId(
    "mainnet",
    f.wallet.walletAddress,
    f.identity.sides[1].tokenId,
  );
  const query = fundingDestinationsQuerySchema.parse({
    purpose: "sell",
    marketContextId: f.market.id,
    positionActionRef,
    controllerWalletRef: f.wallet.id,
  });
  const request = {
    ...query,
    accountId: f.wallet.userId,
    marketContextId: query.marketContextId ?? null,
    marketClass: query.marketClass ?? null,
    compatibleVenueBindingOptionIds: null,
  };
  const [option] = await f.service.listDestinationOptions(request);
  assert.equal(option.preparationStatus, "ready");
  const inspectionRequest = fundingPreparationInspectRequestSchema.parse({
    ...query,
    marketClass: null,
    venueBindingOptionId: option.venueBindingOptionId,
  });
  const inspection = await f.service.inspectBindingOption({
    ...request,
    ...inspectionRequest,
  });
  assert.equal(inspection.status, "ready");
  assert.equal(
    inspection.evidence.facts.positionTokenId,
    f.identity.sides[1].tokenId,
  );
  const preparedRequest = fundingPreparationPrepareRequestSchema.parse({
    ...inspectionRequest,
    expectedInspectionRevision: inspection.inspectionRevision,
  });
  const prepared = await f.service.prepareBindingOption({
    ...request,
    ...preparedRequest,
    operationId: "synthetic_sell_preparation_11797",
  });
  assert.deepEqual(prepared.actions, []);
  assert.equal(prepared.controllerWalletRef, f.wallet.id);
  // Syntactically valid foreign references still reach the existing exact
  // address/token/environment ownership check; accepting a ref is not authority.
  const foreignQuery = fundingDestinationsQuerySchema.parse({
    ...query,
    positionActionRef: hip4PortfolioPositionId(
      "mainnet",
      `0x${"b".repeat(40)}`,
      f.identity.sides[1].tokenId,
    ),
  });
  await assert.rejects(
    f.service.listDestinationOptions({ ...request, ...foreignQuery }),
    isPreparationUnavailable,
  );
});

test("native SELL scopes discovery and explicit refresh to the selected owned wallet before account IO", async () => {
  const f = await fixture(11797);
  Object.assign(f.state, { positionQuantity: "2", positionSide: 1 });
  f.wallets.unshift({
    ...f.wallet,
    id: "00000000-0000-4000-8000-000000000003",
    walletAddress: `0x${"b".repeat(40)}`,
    isPrimary: false,
  });
  const request = {
    ...f.input,
    purpose: "sell" as const,
    marketContextId: f.market.id,
    positionActionRef: hip4PortfolioPositionId(
      "mainnet",
      f.wallet.walletAddress,
      f.identity.sides[1].tokenId,
    ),
  };
  const [option] = await f.service.listDestinationOptions(request);
  assert.equal(option.preparationStatus, "ready");
  assert.deepEqual(f.loadedAddresses, [f.wallet.walletAddress]);
  const inspection = await f.service.inspectBindingOption(
    { ...request, venueBindingOptionId: option.venueBindingOptionId },
    { forceFresh: true },
  );
  assert.equal(inspection.status, "ready");
  assert.deepEqual(f.loadedAddresses, [
    f.wallet.walletAddress,
    f.wallet.walletAddress,
  ]);
  assert.deepEqual(f.loads, [false, true]);
  // Deterministic selection is not holding evidence: a fresh missing holding
  // still fails, rather than reusing another wallet or an old inspection.
  f.state.positionQuantity = "0";
  await assert.rejects(
    f.service.inspectBindingOption(
      { ...request, venueBindingOptionId: option.venueBindingOptionId },
      { forceFresh: true },
    ),
    isPreparationUnavailable,
  );
});

test("foreign native SELL references reject before account IO and disabled SELL stays empty", async () => {
  const f = await fixture(11797);
  const request = {
    ...f.input,
    purpose: "sell" as const,
    marketContextId: f.market.id,
    positionActionRef: hip4PortfolioPositionId(
      "mainnet",
      `0x${"c".repeat(40)}`,
      f.identity.sides[1].tokenId,
    ),
  };
  await assert.rejects(
    f.service.listDestinationOptions(request),
    isPreparationUnavailable,
  );
  assert.deepEqual(f.loads, []);
  f.state.sellEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  assert.deepEqual(f.loads, []);
});

test("native SELL binds the exact portfolio position and remains independent of BUY/funding switches", async () => {
  const f = await fixture();
  Object.assign(f.state, {
    buyEnabled: false,
    fundingEnabled: false,
    positionQuantity: "2.00001",
  });
  const positionActionRef = hip4PortfolioPositionId(
    "mainnet",
    f.wallet.walletAddress,
    f.identity.sides[0].tokenId,
  );
  const request = {
    ...f.input,
    purpose: "sell" as const,
    marketContextId: f.market.id,
    positionActionRef,
  };
  const [frozen] = await f.service.frozenDestinations(request);
  assert.equal(frozen.preparation.status, "ready");
  assert.equal(
    frozen.preparation.evidence.facts.positionTokenId,
    f.identity.sides[0].tokenId,
  );
  assert.deepEqual(frozen.preparation.requiredActions, []);
  for (const ref of [
    null,
    hip4PortfolioPositionId(
      "mainnet",
      `0x${"b".repeat(40)}`,
      f.identity.sides[0].tokenId,
    ),
    hip4PortfolioPositionId(
      "testnet",
      f.wallet.walletAddress,
      f.identity.sides[0].tokenId,
    ),
    hip4PortfolioPositionId(
      "mainnet",
      f.wallet.walletAddress,
      f.identity.sides[1].tokenId,
    ),
  ]) {
    await assert.rejects(
      f.service.listDestinationOptions({
        ...request,
        positionActionRef: ref,
      }),
      isPreparationUnavailable,
    );
  }
  assert.deepEqual(
    await f.service.listDestinationOptions({ ...request, purpose: "buy" }),
    [],
  );
  f.state.sellEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
});

test("native lifecycle revision is checked before cache and again after account IO", async () => {
  const f = await fixture();
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  f.state.buyEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  assert.deepEqual(f.loads, []);
  f.state.buyEnabled = true;
  f.state.afterLoad = () => {
    f.state.tradeRevision = "changed-during-read";
  };
  await assert.rejects(
    f.service.listDestinationOptions(request),
    isPreparationUnavailable,
  );
  f.state.afterLoad = null;
  assert.equal((await f.service.listDestinationOptions(request)).length, 1);
  f.state.buyEnabled = false;
  assert.deepEqual(await f.service.listDestinationOptions(request), []);
  f.state.buyEnabled = true;
  f.state.tradeError = true;
  await assert.rejects(
    f.service.frozenDestinations(request),
    PreparationContractError,
  );
  f.state.tradeError = false;
  assert.equal((await f.service.listDestinationOptions(request)).length, 1);
});

test("native trading requires canonical active identity and expires with the instrument, not generic account TTL", async () => {
  const f = await fixture();
  const request = {
    ...f.input,
    purpose: "buy" as const,
    marketContextId: f.market.id,
  };
  assert.deepEqual(
    await f.service.listDestinationOptions({
      ...request,
      marketContextId: null,
    }),
    [],
  );
  assert.deepEqual(f.loads, []);
  f.market.expiration_time = new Date(f.now().getTime() + 500);
  const [frozen] = await f.service.frozenDestinations(request);
  assert.equal(
    frozen.preparation.expiresAt,
    f.market.expiration_time.toISOString(),
  );
  f.advance(501);
  await assert.rejects(
    f.service.listDestinationOptions(request),
    isPreparationUnavailable,
  );
  f.market.expiration_time = null;
  assert.equal((await f.service.listDestinationOptions(request)).length, 1);
  f.market.status = "CLOSED";
  await assert.rejects(
    f.service.listDestinationOptions(request),
    isPreparationUnavailable,
  );
  f.market.status = "ACTIVE";
  f.market.token_no = f.market.token_yes;
  await assert.rejects(
    f.service.listDestinationOptions(request),
    isPreparationUnavailable,
  );
  f.market.token_no = f.identity.sides[1].tokenId;
  assert.equal((await f.service.listDestinationOptions(request)).length, 1);
});

test("unverified identity, unsupported mode and unknown/stale facts cannot manufacture zero readiness", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.wrongOwner = true;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.mode = "unifiedAccount";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.observedAt = new Date(f.now().getTime() + 1000).toISOString();
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.wallet.userId = "foreign-account";
    },
  ]) {
    const f = await fixture();
    mutate(f);
    assert.deepEqual(await f.service.listDestinationOptions(f.input), []);
  }
  const f = await fixture();
  Object.assign(f.state, { empty: true, role: "missing", mode: "default" });
  const observation = f.snapshot();
  for (const cash of [
    { ...observation.cash, total: "1" },
    { ...observation.cash, borrowed: "1" },
    { ...observation.cash, decimals: 6 },
  ])
    assert.throws(
      () =>
        hypercoreFundingBalance({
          observation: { ...observation, cash },
          environment: "mainnet",
          snapshotMaxAgeMs: 60000,
          now: f.now().getTime(),
        }),
      PreparationContractError,
    );
});
