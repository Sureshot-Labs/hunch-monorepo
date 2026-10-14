import { z } from "zod";
import type { Pool } from "@hunch/infra";
import { hip4SpotMetadataSchema } from "@hunch/shared";
import { hypercoreSpotAccountLocation } from "../../account-value/canonical.js";
import { FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL } from "../../account-value/funding-movement-feed.js";
import {
  hip4AccountAbstractionSchema,
  hip4AccountRoleSchema,
} from "../../services/hip4-account-contract.js";
import { projectHip4Account } from "../../services/hip4-account-projection.js";
import {
  createHip4AccountClient,
  createHip4ReadClient,
} from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import { readHip4AccountPolicy } from "../../services/hip4-account-repository.js";
import { hypercoreSpotCashCapacity } from "../domain/hypercore-cash-capacity.js";
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
import { canonicalAssetId } from "../domain/asset-identity.js";

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
): Promise<NativeSpotCapacity> {
  const [read, account] = await Promise.all([
    readHip4Policy(pool, "accountRead"),
    readHip4AccountPolicy(pool),
  ]);
  if (
    !read.policy.enabled ||
    !account.policy.enabled ||
    read.policy.environment !== "mainnet"
  )
    throw new Error("native_account_read_unavailable");
  const admit = async (weight: number) =>
    admitHip4Request(
      pool,
      "mainnet",
      weight,
      read.policy.requestWeightPerMinute,
    );
  const accountRead = createHip4AccountClient(read.policy, admit, fetcher);
  const publicRead = createHip4ReadClient(read.policy, admit, fetcher);
  // Use the start, not end, of the provider observation interval.
  const observedAt = Date.now();
  const role = hip4AccountRoleSchema.parse(
    await accountRead({ type: "userRole", user: address }),
  );
  if (role.role !== "user") throw new Error("native_account_role_unsupported");
  const mode = hip4AccountAbstractionSchema.parse(
    await accountRead({ type: "userAbstraction", user: address }),
  );
  if (mode !== "disabled") throw new Error("native_cash_mode_unsupported");
  const metadata = hip4SpotMetadataSchema.parse(
    await publicRead({ type: "spotMeta" }),
  );
  const quote = metadata.tokens.find(
    (row) => row.index === 0 && row.name === "USDC",
  );
  if (
    !quote?.tokenId ||
    !isHypercoreMainnetUsdc({
      networkId: "hyperliquid:mainnet",
      assetId: quote.tokenId,
      decimals: quote.weiDecimals,
    })
  )
    throw new Error("native_cash_identity_mismatch");
  const state = await accountRead({
    type: "spotClearinghouseState",
    user: address,
  });
  if ((await accountRead({ type: "userAbstraction", user: address })) !== mode)
    throw new Error("native_cash_mode_changed");
  const observation = projectHip4Account({
    environment: "mainnet",
    role: "user",
    mode,
    state,
    observedAt: new Date(observedAt).toISOString(),
    quote: { tokenId: quote.tokenId, index: 0, weiDecimals: 8 },
  });
  const capacity = hypercoreSpotCashCapacity({
    observation,
    environment: "mainnet",
    snapshotMaxAgeMs: account.policy.snapshotMaxAgeMs,
    now: Date.now(),
  });
  if (!capacity.known) throw new Error(`native_cash_${capacity.reason}`);
  return {
    availableRaw: capacity.availableRaw,
    observedAt: observation.observedAt,
    expiresAt: new Date(
      observedAt + account.policy.snapshotMaxAgeMs,
    ).toISOString(),
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
  read: (address: string) => Promise<NativeSpotCapacity>,
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
    const canonical = hypercoreSpotAccountLocation({
      accountId: input.userId,
      address: binding.owner,
      controllerWalletId: input.profile.walletId,
    }).location;
    if (
      binding.sourceDex !== "spot" ||
      hypercoreLocationDex(location) !== "spot" ||
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
      capacity = await read(binding.owner);
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
    const debits = await client.query<{ raw_amount: string }>(
      FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL,
      [
        input.userId,
        JSON.stringify([
          {
            component_id: null,
            location_id: location.locationId,
            address: binding.owner.toLowerCase(),
            asset_decimals: 8,
            snapshot_at: capacity.observedAt,
          },
        ]),
      ],
    );
    const needed =
      rows.rows.reduce((sum, row) => sum + BigInt(row.raw_amount), 0n) +
      debits.rows.reduce((sum, row) => sum + BigInt(row.raw_amount), 0n);
    if (needed > BigInt(capacity.availableRaw) || expiresAt <= Date.now())
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native source balance no longer covers reserved funding",
      );
    return { expiresAt: capacity.expiresAt };
  };
}
