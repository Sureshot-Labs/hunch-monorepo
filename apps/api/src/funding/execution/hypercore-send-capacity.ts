import { z } from "zod";
import type { Pool } from "@hunch/infra";
import {
  hypercoreSpotAccountLocation,
  hypercorePerpsRefundLocation,
} from "../../account-value/canonical.js";
import {
  loadFundingPhysicalNativeSnapshotDebits,
  FundingSnapshotDebitEvidenceError,
} from "../../account-value/funding-snapshot-debits.js";
import {
  readHip4FinancialObservation,
  readHip4PerpsFinancialObservation,
} from "../../services/hip4-financial-observation.js";
import {
  hypercoreLocationDex,
  isHypercoreMainnetUsdc,
} from "../domain/hypercore-identity.js";
import { assetLocationSchema } from "../domain/schemas.js";
import {
  FundingPersistenceError,
  lockFundingPhysicalSource,
} from "../persistence/funding-operation-repository.js";
import { fundingReservationHoldSql } from "../persistence/source-reservation-hold.js";
import type { NativeFundingCapacityCheck } from "./hypercore-auth-attempt.js";
import type { AssetLocation } from "../domain/types.js";
import {
  assertNativeTransferFeeObservation,
  type NativeTransferFeeObservation,
} from "../../services/hip4-transfer-fee-capability.js";
import { canonicalAssetId } from "../domain/asset-identity.js";
import {
  HIP4_FUNDING_CASH_HOLDS_SQL,
  readHip4OrderHoldRaw,
} from "../../repos/hip4-order-holds.js";

export type NativeSpotCapacity = {
  availableRaw: string;
  observedAt: string;
  expiresAt: string;
};

/** Fresh provider read only. Budget admissions use the pool (autocommit), not
 * the funding transaction: aborting admission must not refund consumed weight.
 * No cached balance, history refresh, signing or account-mode mutation. */
export async function readNativeSendCapacity(
  pool: Pick<Pool, "query">,
  address: string,
  fetcher?: typeof fetch,
  sourceDex: "spot" | "" = "spot",
): Promise<NativeSpotCapacity> {
  if (sourceDex === "")
    return readHip4PerpsFinancialObservation(pool, address, fetcher);
  const read = await readHip4FinancialObservation(pool, address, fetcher);
  return {
    availableRaw: read.cash.availableRaw,
    observedAt: read.observedAt,
    expiresAt: read.expiresAt,
  };
}

export const NATIVE_SEND_RESERVATIONS_SQL = `select id,operation_id,segment_id,component_id,location_id,network_id,asset_id,asset_decimals,raw_amount,
    operation_id=$5::uuid and segment_id=$6::uuid as own_reservation
  from balance_reservations
  where user_id=$1 and location_id=$2 and network_id=$3 and asset_id=$4
    and mode='subtract_available' and state='active'
    and ${fundingReservationHoldSql("balance_reservations")}
    and not exists(select 1 from funding_observations debit
      where debit.operation_id=balance_reservations.operation_id
        and debit.segment_id is not distinct from balance_reservations.segment_id
        and debit.kind='source_debit' and debit.canonical and debit.finality_status='finalized')
  order by id`;

/** Reuses the exact common physical-source lock and all common reservations.
 * Only the current operation's validated hold covers this send. Other holds
 * remain unavailable, including aliases with a different component ID.
 * Provider observation is obtained BEFORE the transaction; under the lock we
 * account for every subsequent Hunch debit/hold and reject an expired sample.
 * Never acquire another connection/perform provider IO while holding row locks. */
export function nativeSendCapacityCheck(
  read: (
    address: string,
    sourceDex: "spot" | "",
  ) => Promise<NativeSpotCapacity>,
  feeCapability: NativeTransferFeeObservation | undefined,
): NativeFundingCapacityCheck {
  return async (client, input) => {
    const source = z
      .object({
        kind: z.literal("owned_location"),
        location: assetLocationSchema,
      })
      .strict()
      .parse(input.sourceSnapshot);
    const location = source.location as AssetLocation;
    const binding = input.pair.validated.binding;
    assertNativeTransferFeeObservation(feeCapability, binding);
    const locationInput = {
      accountId: input.userId,
      address: binding.owner,
      controllerWalletId: input.profile.walletId,
    };
    const canonical =
      binding.sourceDex === "spot"
        ? hypercoreSpotAccountLocation(locationInput).location
        : hypercorePerpsRefundLocation(locationInput);
    if (
      hypercoreLocationDex(location) !== binding.sourceDex ||
      !isHypercoreMainnetUsdc(location.asset) ||
      location.accountId !== input.userId ||
      location.locationId !== canonical.locationId ||
      String(location.details.address).toLowerCase() !==
        binding.owner.toLowerCase() ||
      location.details.controllerWalletId !== input.profile.walletId
    )
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Native physical source binding changed",
      );
    await lockFundingPhysicalSource(client, input.userId, {
      locationId: location.locationId,
      networkId: location.asset.networkId,
      assetId: location.asset.assetId,
      assetDecimals: location.asset.decimals,
    });
    let capacity: NativeSpotCapacity;
    try {
      capacity = await read(binding.owner, binding.sourceDex);
    } catch {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native source capacity is unavailable; refresh and retry before sending",
      );
    }
    const snapshotAt = Date.parse(capacity.observedAt);
    const expiresAt = Date.parse(capacity.expiresAt);
    if (
      !/^(0|[1-9]\d*)$/.test(capacity.availableRaw) ||
      !Number.isFinite(snapshotAt) ||
      snapshotAt > Date.now() ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt <= snapshotAt
    )
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native capacity observation is not fresh",
      );
    const rows = await client.query<{
      id: string;
      component_id: string;
      raw_amount: string;
      asset_decimals: number;
      own_reservation: boolean;
    }>(NATIVE_SEND_RESERVATIONS_SQL, [
      input.userId,
      location.locationId,
      location.asset.networkId,
      canonicalAssetId(location.asset),
      input.operationId,
      input.pair.send.segment_id,
    ]);
    const own = rows.rows.filter((row) => row.own_reservation);
    if (
      own.length !== 1 ||
      own[0]?.raw_amount !== binding.sourceRaw ||
      rows.rows.some((row) => row.asset_decimals !== 8)
    )
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native source reservation changed",
      );
    const debits = await loadFundingPhysicalNativeSnapshotDebits(
      client,
      input.userId,
      location,
      capacity.observedAt,
    ).catch((error) => {
      if (error instanceof FundingSnapshotDebitEvidenceError)
        throw new FundingPersistenceError("quote_invalidated", error.message);
      throw error;
    });
    const otherCashHolds = await client.query<{
      raw_amount: string;
      asset_decimals: number;
    }>(HIP4_FUNDING_CASH_HOLDS_SQL, [
      input.userId,
      location.locationId,
      canonicalAssetId(location.asset),
      own[0].id,
    ]);
    if (otherCashHolds.rows.some((row) => row.asset_decimals !== 8))
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native reservation asset precision changed",
      );
    const tradeHolds =
      binding.sourceDex === "spot"
        ? await readHip4OrderHoldRaw(
            client,
            input.userId,
            binding.owner,
            canonicalAssetId(location.asset),
            capacity.observedAt,
          )
        : 0n;
    const needed =
      BigInt(own[0].raw_amount) +
      tradeHolds +
      otherCashHolds.rows.reduce(
        (sum, row) => sum + BigInt(row.raw_amount),
        0n,
      ) +
      debits.reduce((sum, row) => sum + BigInt(row.raw_amount), 0n);
    assertNativeTransferFeeObservation(feeCapability, binding);
    if (needed > BigInt(capacity.availableRaw) || expiresAt <= Date.now())
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native source balance no longer covers reserved funding",
      );
    return {
      expiresAt: new Date(
        Math.min(expiresAt, Date.parse(feeCapability.expiresAt)),
      ).toISOString(),
    };
  };
}
