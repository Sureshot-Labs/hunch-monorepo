import { randomUUID } from "node:crypto";
import type { PoolClient } from "@hunch/infra";
import { hypercoreSpotAccountLocation } from "./account-value/canonical.js";
import { HYPERCORE_MAINNET_USDC as asset } from "./funding/domain/hypercore-identity.js";
import type { WalletExecutionProfile } from "./funding/domain/types.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  type FundingCommitPlan,
} from "./funding/persistence/funding-operation-repository.js";
import { ingestFundingObservationInTransaction } from "./funding/reconciliation/funding-observation-ingestion.js";
import { reduceFundingOperationInTransaction } from "./funding/reconciliation/funding-reducer.js";
import { buildFundingTradeConsumerIntent } from "./funding/persistence/funding-trade-consumer-intent.js";
import type { SocialSourceRef } from "./schemas/social-trade.js";
import { readHip4CopyAttribution } from "./services/hip4-copy-attribution.js";

/** Synthetic settlement via the real common commit/observation/reducer. Only
 * used in disposable tests, no manual ready flag and no external provider. */
export async function hip4FundedOrderTestFixture(
  db: PoolClient,
  input: {
    userId: string;
    profile: WalletExecutionProfile;
    marketId: string;
    tokenId: string;
    idempotencyKey?: string;
    sourceRef?: SocialSourceRef;
    copyIdempotencyKey?: string;
  },
) {
  const attribution = readHip4CopyAttribution(input);
  const cash = hypercoreSpotAccountLocation({
    accountId: input.userId,
    address: input.profile.address,
    controllerWalletId: input.profile.walletId,
  }).location;
  const money = (raw: string) => ({ asset, raw });
  const source = {
    componentId: randomUUID(),
    locationId: randomUUID(),
    networkId: asset.networkId,
    assetId: asset.assetId,
  };
  const destination = {
    componentId: randomUUID(),
    locationId: cash.locationId,
    networkId: asset.networkId,
    assetId: asset.assetId,
  };
  const raw = "150000000";
  const context = {
    ...(attribution ?? {}),
    venueId: "hyperliquid",
    marketId: input.marketId,
    marketContextId: input.tokenId.slice("hyperliquid:".length),
    side: "BUY",
    collateralAsset: asset,
    requestedCollateralRaw: raw,
  };
  const plan: FundingCommitPlan = {
    operation: {
      purpose: "trade_shortfall",
      initialState: { status: "in_progress", stage: "committed" },
      experienceMode: "instant",
      planKind: "wallet_route",
      sourceSnapshot: source,
      destinationTargetSnapshot: destination,
      externalRecipientId: null,
      venueId: "hyperliquid",
      marketId: input.marketId,
      marketContextSnapshot: context,
      venueBindingSnapshot: null,
      walletExecutionSnapshot: input.profile,
      placementSnapshot: {},
      requestedSourceAmount: money(raw),
      requestedDestinationAmount: money(raw),
      supportMetadata: { test: true },
    },
    segments: [
      {
        providerId: "synthetic",
        adapterId: "synthetic-read-only",
        adapterVersion: 1,
        segmentKind: "same_network_swap",
        status: "planned",
        sourceSnapshot: source,
        destinationTargetSnapshot: destination,
        quotedInput: money(raw),
        quotedExpectedOutput: money(raw),
        quotedMinOutput: money(raw),
        providerQuoteRefCiphertext: "synthetic",
        providerQuoteRefLookupHmac: "a".repeat(64),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: 1,
        refundLocationSnapshot: source,
        quoteExpiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ],
    steps: [],
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: source.componentId,
        locationId: source.locationId,
        networkId: asset.networkId,
        assetId: asset.assetId,
        assetDecimals: asset.decimals,
        rawAmount: raw,
        mode: "subtract_available",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ],
  };
  const consentToken = randomUUID();
  const quote = await createFundingQuoteInTransaction(db, {
    userId: input.userId,
    discoveryProjectionId: randomUUID(),
    selectedSourceOptionSnapshot: source,
    marketContextSnapshot: context,
    destinationOptionSnapshot: destination,
    venueBindingSnapshot: null,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "test-hip-funding",
    canonicalRequest: { test: true },
    consentToken,
    expiresAt: new Date(Date.now() + 60000),
  });
  const committed = await commitFundingOperationInTransaction(db, {
    userId: input.userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    plan,
    subjectLookupHmac: "b".repeat(64),
    subjectLookupKeyVersion: 1,
  });
  const operationId = committed.operation.id;
  const segmentId = (
    await db.query(
      "select id from funding_operation_segments where operation_id=$1",
      [operationId],
    )
  ).rows[0].id;
  await ingestFundingObservationInTransaction(db, {
    discoverySource: "venue_api",
    observation: {
      operationId,
      segmentId,
      kind: "destination_credit",
      networkId: asset.networkId,
      assetId: asset.assetId,
      assetDecimals: 8,
      txHash: `0x${randomUUID().replaceAll("-", "").repeat(2)}`,
      eventIndex: "0",
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: input.profile.address,
      rawAmount: raw,
      observedAt: new Date(),
      ledgerHeight: "1",
      blockHash: `0x${"ab".repeat(32)}`,
      finalityStatus: "finalized",
      finalizedAt: new Date(),
    },
  });
  await reduceFundingOperationInTransaction(db, { operationId });
  const reservationId = (
    await db.query(
      "select id from balance_reservations where operation_id=$1 and mode='settled_for_consumer'",
      [operationId],
    )
  ).rows[0]?.id;
  if (!reservationId)
    throw new Error(
      "synthetic funding did not create real consumer reservation",
    );
  return {
    operationId,
    reservationId,
    confirmedIntent: buildFundingTradeConsumerIntent({
      ...(attribution ?? {}),
      venueId: "hyperliquid",
      marketId: input.marketId,
      marketContextId: context.marketContextId,
      spend: money(raw),
    }),
  };
}
