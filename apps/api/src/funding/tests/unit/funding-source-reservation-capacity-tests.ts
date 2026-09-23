#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { projectCashAvailability } from "../../../account-value/cash-availability-projector.js";
import type { ValuedAssetComponent } from "../../domain/types.js";
import {
  FundingPersistenceError,
  type FundingCommitReservation,
} from "../../persistence/funding-operation-repository.js";
import { assertSharedFundingSourceCapacity } from "../../planner/source-reservation-capacity.js";
import {
  SOLANA_NATIVE_ASSET,
  SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS,
} from "../../domain/network-fees.js";

for (const asset of [
  SOLANA_NATIVE_ASSET,
  {
    networkId: "solana:mainnet",
    assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  },
]) {
  const component: ValuedAssetComponent = {
    componentId: "component",
    location: {
      kind: "wallet",
      locationId: "location",
      accountId: "owner",
      asset,
      details: {},
    },
    amount: {
      asset,
      raw: (
        1782570n +
        (asset === SOLANA_NATIVE_ASSET
          ? SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          : 0n)
      ).toString(),
    },
    category: "cash",
    estimatedUsd: null,
    observedAt: new Date().toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    executionEligibility: "eligible",
    reasonCodes: [],
  };
  const reservation: FundingCommitReservation = {
    componentId: "component",
    locationId: "location",
    segmentOrdinal: 0,
    networkId: asset.networkId,
    assetId: asset.assetId,
    assetDecimals: asset.decimals,
    rawAmount: "384360",
    mode: "subtract_available",
    expiresAt: new Date().toISOString(),
  };
  const account = {
    projection: { components: [component] },
    cashAvailability: projectCashAvailability({
      components: [component],
      asOf: component.observedAt,
      adjustments: [
        {
          componentId: "component",
          venueId: null,
          venueBindingId: null,
          lockedRaw: "0",
          reservedRaw: "1398210",
          submittedDebitRaw: "0",
        },
      ],
    }),
  };
  const sources = [
    {
      reservation,
      heldRaw: "1398210",
      projectedHeldRaw: "1398210",
    },
  ];
  const available = account.cashAvailability.components[0];
  assert.ok(available);
  if (asset === SOLANA_NATIVE_ASSET) {
    const unpriced = {
      ...account,
      cashAvailability: {
        ...account.cashAvailability,
        components: [
          {
            ...available,
            availableRaw: "384360",
            freshness: "stale" as const,
            reasonCodes: ["trusted_price_unavailable" as const],
          },
        ],
      },
    };
    assert.doesNotThrow(() =>
      assertSharedFundingSourceCapacity(unpriced, "owner", sources, {
        directWithdrawal: true,
      }),
    );
    assert.throws(() =>
      assertSharedFundingSourceCapacity(unpriced, "owner", sources),
    );
    assert.throws(() =>
      assertSharedFundingSourceCapacity(
        unpriced,
        "owner",
        [
          {
            heldRaw: "1398210",
            projectedHeldRaw: "1398210",
            reservation: { ...reservation, rawAmount: "384361" },
          },
        ],
        { directWithdrawal: true },
      ),
    );
  }
  assert.doesNotThrow(() =>
    assertSharedFundingSourceCapacity(account, "owner", sources),
  );
  const rejected = (call: () => void) =>
    assert.throws(
      call,
      (error: unknown) =>
        error instanceof FundingPersistenceError &&
        error.code === "quote_invalidated",
    );
  rejected(() =>
    assertSharedFundingSourceCapacity(account, "other-owner", sources),
  );
  rejected(() =>
    assertSharedFundingSourceCapacity(account, "owner", [
      {
        heldRaw: "1398210",
        projectedHeldRaw: "1398210",
        reservation: { ...reservation, rawAmount: "384361" },
      },
    ]),
  );
  rejected(() =>
    assertSharedFundingSourceCapacity(account, "owner", [
      { reservation, heldRaw: "1398211", projectedHeldRaw: "1398210" },
    ]),
  );
  // Historical incident: a $2 receive-conversion hold and a $1.112645 trade
  // used distinct component IDs for one physical Solana USDC wallet.
  if (asset.networkId === "solana:mainnet" && asset.decimals === 6) {
    const aliasedAccount = {
      ...account,
      projection: {
        components: [{ ...component, amount: { asset, raw: "2000000" } }],
      },
      cashAvailability: {
        ...account.cashAvailability,
        components: [
          {
            ...available,
            amount: { asset, raw: "2000000" },
            availableRaw: "2000000",
            reservedRaw: "0",
          },
        ],
      },
    };
    rejected(() =>
      assertSharedFundingSourceCapacity(aliasedAccount, "owner", [
        {
          reservation: { ...reservation, rawAmount: "1112645" },
          heldRaw: "2000000",
          projectedHeldRaw: "0",
        },
      ]),
    );
    assert.doesNotThrow(() =>
      assertSharedFundingSourceCapacity(aliasedAccount, "owner", [
        {
          reservation: { ...reservation, rawAmount: "1000000" },
          heldRaw: "1000000",
          projectedHeldRaw: "0",
        },
      ]),
    );
    // Non-source reservations displayed on the selected component do not
    // overlap a subtract hold attached to another alias of the same wallet.
    const availabilityComponent = aliasedAccount.cashAvailability.components[0];
    assert.ok(availabilityComponent);
    const otherModeAccount = {
      ...aliasedAccount,
      cashAvailability: {
        ...aliasedAccount.cashAvailability,
        components: [
          {
            ...availabilityComponent,
            availableRaw: "1000000",
            reservedRaw: "1000000",
          },
        ],
      },
    };
    rejected(() =>
      assertSharedFundingSourceCapacity(otherModeAccount, "owner", [
        {
          reservation: { ...reservation, rawAmount: "1000000" },
          heldRaw: "1000000",
          projectedHeldRaw: "0",
        },
      ]),
    );
    rejected(() =>
      assertSharedFundingSourceCapacity(otherModeAccount, "owner", [
        {
          reservation: { ...reservation, rawAmount: "1000000" },
          heldRaw: "1000000",
          projectedHeldRaw: "1000001",
        },
      ]),
    );
  }
  for (const changes of [
    { freshness: "stale" as const },
    { availableRaw: "0" },
    { reasonCodes: ["cash_availability_unknown" as const] },
    { amount: { asset: { ...asset, decimals: 18 }, raw: "1782570" } },
  ]) {
    rejected(() =>
      assertSharedFundingSourceCapacity(
        {
          ...account,
          cashAvailability: {
            components: [{ ...available, ...changes }],
          },
        },
        "owner",
        sources,
      ),
    );
  }
  for (const changes of [
    { observationFreshness: "stale" as const },
    { category: "in_transit" as const },
    { location: { ...component.location, locationId: "another-location" } },
  ]) {
    rejected(() =>
      assertSharedFundingSourceCapacity(
        {
          ...account,
          projection: { components: [{ ...component, ...changes }] },
        },
        "owner",
        sources,
      ),
    );
  }
}
console.log(
  "[funding-source-reservation-capacity-tests] exact free remainder, ownership, freshness, and held-capacity checks pass for Solana and EVM",
);
