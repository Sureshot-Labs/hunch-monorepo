import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import { createHip4AccountClient } from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import {
  fundingRefundReceiptMatchesContract,
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
} from "../domain/refund-settlement.js";
import { compareFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import { EXACT_REFUND_OBSERVER_ID } from "./relay-exact-refund-receipts.js";
import {
  inspectEvmRefundCanonicality,
  inspectNativeRefundCanonicality,
  type RefundCanonicalProof,
  type RefundCanonicalTarget,
} from "./relay-refund-canonical-proof.js";

type Db = Pick<PoolClient, "query">;
export type RefundWatchRow = Readonly<{
  receipt_snapshot: string;
  user_id: string;
  refund_location_snapshot: unknown;
  provider_quote_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
}>;
export const REFUND_CANONICAL_PAGE_SQL = `with receipt_page as materialized (
  select * from funding_observations
  where operation_id=$1::uuid and kind='refund_credit'
    and id > $2::uuid
  order by id limit $3
)
select to_jsonb(receipt_page)::text as receipt_snapshot,
  operation_row.user_id, segment_row.refund_location_snapshot,
  segment_row.provider_quote_ref_lookup_hmac, segment_row.lookup_key_version
from receipt_page
join lateral (select user_id from funding_operations
  where id=receipt_page.operation_id offset 0) operation_row on true
left join lateral (select refund_location_snapshot, provider_quote_ref_lookup_hmac, lookup_key_version
  from funding_operation_segments where id=receipt_page.segment_id
    and operation_id=receipt_page.operation_id and provider_id='relay' offset 0) segment_row on true
order by receipt_page.id`;
export const REFUND_CANONICAL_LOCK_SQL = `select (asset_id=lower($4) and asset_decimals=$5 and raw_amount=$6::numeric
  and source_address=lower($7) and destination_address=lower($8)
  and ledger_height=$9::numeric and lower(block_hash)=lower($10)) as snapshot_matches
 from funding_receive_canonical_events
 where network_id=$1 and tx_hash=$2 and event_index=$3 for update`;
export const REFUND_RECEIVE_ANCHOR_UPDATE_SQL = `update funding_receive_canonical_events
  set ledger_height=$4::numeric, block_hash=$5
  where network_id=$1 and tx_hash=$2 and event_index=$3
    and allocation_status='recovery_required' and allocation_error_code in (
      'internal_exact_refund_suppressed','exact_refund_receipt_not_final',
      'exact_refund_receipt_conflict','internal_event_classification_conflict')
    and allocated_receipt_id is null and allocated_receive_session_id is null`;
const MIN_UUID = "00000000-0000-0000-0000-000000000000";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Unfinished pages and unresolved verification survive the ordinary terminal
 * watch window. This flag is diagnostic/work scheduling, never money evidence. */
export { exactRefundWatchPending } from "./relay-refund-watch-state.js";

function readTarget(row: RefundWatchRow): RefundCanonicalTarget | null {
  const receipt = JSON.parse(row.receipt_snapshot);
  if (
    !isRecord(receipt) ||
    !isRecord(receipt.metadata) ||
    receipt.metadata.observerId !== EXACT_REFUND_OBSERVER_ID
  )
    return null;
  const snapshot = row.refund_location_snapshot;
  const contract = readFundingRefundContract(snapshot, {
    requestFingerprint: row.provider_quote_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
  });
  const alternatives =
    isRecord(snapshot) && isRecord(snapshot.alternativeRefundLocations)
      ? snapshot.alternativeRefundLocations.locations
      : [];
  if (
    !isRecord(snapshot) ||
    snapshot.accountId !== row.user_id ||
    !Array.isArray(alternatives) ||
    alternatives.some(
      (location) => !isRecord(location) || location.accountId !== row.user_id,
    ) ||
    !contract?.supported ||
    typeof receipt.id !== "string" ||
    typeof receipt.network_id !== "string" ||
    typeof receipt.asset_id !== "string" ||
    typeof receipt.asset_decimals !== "number" ||
    typeof receipt.raw_amount !== "string" ||
    typeof receipt.tx_hash !== "string" ||
    typeof receipt.event_index !== "string" ||
    typeof receipt.to_address !== "string" ||
    typeof receipt.from_address !== "string"
  )
    return null;
  const target: RefundCanonicalTarget = {
    asset: {
      networkId: receipt.network_id,
      assetId: receipt.asset_id,
      decimals: receipt.asset_decimals,
    },
    txHash: receipt.tx_hash,
    eventIndex: receipt.event_index,
    rawAmount: receipt.raw_amount,
    fromAddress: receipt.from_address,
    toAddress: receipt.to_address,
    ledgerHeight:
      typeof receipt.ledger_height === "string" ? receipt.ledger_height : null,
    blockHash:
      typeof receipt.block_hash === "string" ? receipt.block_hash : null,
    nativeDex:
      receipt.metadata.nativeDestinationDex === "spot" ||
      receipt.metadata.nativeDestinationDex === ""
        ? receipt.metadata.nativeDestinationDex
        : null,
    nativeLedgerTime:
      typeof receipt.metadata.nativeLedgerTime === "number"
        ? receipt.metadata.nativeLedgerTime
        : null,
    nativeTransaction: receipt.metadata.relayRefundNativeTransaction,
  };
  return fundingRefundReceiptMatchesContract(contract, {
    observationId: receipt.id,
    money: { asset: target.asset, raw: target.rawAmount },
    destinationAddress: target.toAddress,
    nativeDestinationDex: target.nativeDex,
    identity: readFundingRefundReceiptIdentity(
      receipt.metadata.relayRefundReceipt,
    ),
    completionProofs: [],
  })
    ? target
    : null;
}

/** Physical locks -> operation -> CAS observation, just like allocation. Full
 * snapshot text avoids JS number/date precision loss. No transfer/amount/owner
 * is editable; re-mining changes only finality/anchor and appends provenance. */
export async function persistRefundCanonicalProofs(
  db: Db,
  input: {
    operationId: string;
    rows: readonly { row: RefundWatchRow; proof: RefundCanonicalProof }[];
    now: Date;
  },
): Promise<{ changed: number; stale: boolean }> {
  const targets = input.rows.flatMap(({ row, proof }) => {
    if (proof.kind === "pending") return [];
    const target = readTarget(row);
    return target &&
      target.asset.networkId.startsWith("evm:") &&
      target.ledgerHeight &&
      target.blockHash
      ? [
          {
            networkId: target.asset.networkId,
            asset: target.asset,
            destinationAddress: target.toAddress,
            sourceAddress: target.fromAddress,
            rawAmount: target.rawAmount,
            transactionHash: target.txHash,
            eventIndex: target.eventIndex,
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
            observedAt: input.now,
            now: input.now,
          },
        ]
      : [];
  });
  const stalePhysical = new Set<string>();
  const physicalKey = (network: string, hash: string, index: string) =>
    `${network}:${hash}:${index}`;
  // These are already-recorded receipts, so lock their existing physical keys
  // without inserting or asserting a now-stale block anchor. Another watcher
  // may have committed a remine while our RPC was in flight; retry that snapshot.
  for (const target of targets.sort(compareFundingReceiveCanonicalEvents)) {
    const locked = await db.query<{ snapshot_matches: boolean }>(
      REFUND_CANONICAL_LOCK_SQL,
      [
        target.networkId,
        target.transactionHash,
        target.eventIndex,
        target.asset.assetId,
        target.asset.decimals,
        target.rawAmount,
        target.sourceAddress,
        target.destinationAddress,
        target.ledgerHeight,
        target.blockHash,
      ],
    );
    if (locked.rows[0]?.snapshot_matches !== true)
      stalePhysical.add(
        physicalKey(
          target.networkId,
          target.transactionHash,
          target.eventIndex,
        ),
      );
  }
  await db.query(
    "select id from funding_operations where id=$1::uuid for update",
    [input.operationId],
  );
  let changed = 0;
  let stale = false;
  for (const { row, proof } of input.rows) {
    if (proof.kind === "pending") continue;
    const expected = JSON.parse(row.receipt_snapshot);
    if (
      stalePhysical.has(
        physicalKey(
          expected.network_id,
          expected.tx_hash,
          expected.event_index,
        ),
      )
    ) {
      stale = true;
      continue;
    }
    const current = await db.query<{ receipt_snapshot: string }>(
      `select to_jsonb(observation_row)::text as receipt_snapshot from funding_observations observation_row
       where id=$1::uuid and operation_id=$2::uuid and to_jsonb(observation_row)=$3::jsonb for update`,
      [expected.id, input.operationId, row.receipt_snapshot],
    );
    if (!current.rowCount) {
      stale = true;
      continue;
    }
    const target = readTarget(row);
    if (!target) {
      stale = true;
      continue;
    }
    // Current ownership/refund binding must still agree after network reads.
    const binding = await db.query<{
      user_id: string;
      refund_location_snapshot: unknown;
      provider_quote_ref_lookup_hmac: string | null;
      lookup_key_version: number | null;
    }>(
      `select operation_row.user_id, segment_row.refund_location_snapshot,
         segment_row.provider_quote_ref_lookup_hmac, segment_row.lookup_key_version
       from funding_operations operation_row join funding_operation_segments segment_row
         on segment_row.operation_id=operation_row.id and segment_row.id=$2::uuid and segment_row.provider_id='relay'
       where operation_row.id=$1::uuid`,
      [input.operationId, expected.segment_id],
    );
    if (!binding.rows[0] || !readTarget({ ...row, ...binding.rows[0] })) {
      stale = true;
      continue;
    }
    const sameAnchor =
      proof.kind === "canonical" &&
      proof.ledgerHeight === target.ledgerHeight &&
      proof.blockHash?.toLowerCase() === target.blockHash?.toLowerCase();
    if (
      expected.canonical === true &&
      expected.finality_status === "finalized" &&
      sameAnchor
    )
      continue;
    if (
      expected.canonical === true &&
      expected.finality_status === "finalized"
    ) {
      await db.query(
        `update funding_observations set canonical=false, finality_status='reorged', reorged_at=$2
        where id=$1::uuid`,
        [expected.id, input.now],
      );
      changed += 1;
    } else if (
      expected.canonical !== false ||
      expected.finality_status !== "reorged"
    ) {
      stale = true;
      continue;
    }
    if (proof.kind === "canonical") {
      if (target.asset.networkId.startsWith("evm:") && !sameAnchor) {
        const moved = await db.query(REFUND_RECEIVE_ANCHOR_UPDATE_SQL, [
          target.asset.networkId,
          target.txHash,
          target.eventIndex,
          proof.ledgerHeight,
          proof.blockHash,
        ]);
        if (moved.rowCount !== 1)
          throw new Error("refund canonical allocation changed before remine");
      }
      await db.query(
        `update funding_observations set canonical=true, finality_status='finalized',
        ledger_height=$2, block_hash=$3, finalized_at=$4, reorged_at=null,
        metadata=metadata || jsonb_build_object('exactRefundCanonicalityHistory',
          coalesce(metadata->'exactRefundCanonicalityHistory','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'previousBlock',ledger_height,'previousBlockHash',block_hash,'reorgedAt',reorged_at,'recanonicalizedAt',$4::timestamptz)))
        where id=$1::uuid and finality_status='reorged' and not canonical`,
        [expected.id, proof.ledgerHeight, proof.blockHash, input.now],
      );
      changed += 1;
    }
  }
  return { changed, stale };
}

export async function pollRelayRefundCanonicalWatch(
  pool: Pool,
  input: { operationId: string; now: Date; limit: number; deadlineMs?: number },
  inspect?: (
    target: RefundCanonicalTarget,
    now: Date,
  ) => Promise<RefundCanonicalProof>,
  clock: () => number = Date.now,
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 2147483647
  )
    throw new Error("Invalid refund watch page limit");
  const priorRow = await pool.query<{
    watch: unknown;
    has_exact_contract: boolean;
  }>(
    `select support_metadata->'exactRefundCanonicalWatch' as watch,
      exists(select 1 from funding_operation_segments segment_row where segment_row.operation_id=$1::uuid
        and segment_row.refund_location_snapshot ? 'refundEvidenceContract') as has_exact_contract
      from funding_operations where id=$1::uuid`,
    [input.operationId],
  );
  if (!priorRow.rows.length) return { checked: 0, changed: 0, pending: false };
  const prior = priorRow.rows[0].watch;
  if (!priorRow.rows[0].has_exact_contract && prior == null)
    return { checked: 0, changed: 0, pending: false };
  const state = isRecord(prior) && prior.version === 1 ? prior : {};
  const afterId =
    typeof state.afterId === "string" && uuid.test(state.afterId)
      ? state.afterId
      : null;
  const { rows } = await pool.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
    input.operationId,
    afterId ?? MIN_UUID,
    input.limit,
  ]);
  const deadline = input.deadlineMs ?? Number.POSITIVE_INFINITY;
  let nativePolicy:
    | Awaited<ReturnType<typeof readHip4Policy>>["policy"]
    | undefined;
  const readNative = async (
    owner: string,
    startTime: number,
    endTime: number,
  ) => {
    if (!nativePolicy) {
      const { policy: configured } = await readHip4Policy(pool, "accountRead");
      nativePolicy = { ...configured, environment: "mainnet" as const };
    }
    const policy = {
      ...nativePolicy,
      requestTimeoutMs: Math.max(
        1,
        Math.min(nativePolicy.requestTimeoutMs, Math.ceil(deadline - clock())),
      ),
    };
    const nativeRead = createHip4AccountClient(policy, (weight) =>
      admitHip4Request(pool, "mainnet", weight, policy.requestWeightPerMinute),
    );
    return nativeRead({
      type: "userNonFundingLedgerUpdates",
      user: owner,
      startTime,
      endTime,
    });
  };
  const results: { row: RefundWatchRow; proof: RefundCanonicalProof }[] = [];
  let visitedId: string | null = afterId;
  let interrupted = false;
  for (const row of rows) {
    if (clock() >= deadline) {
      interrupted = true;
      break;
    }
    const receipt = JSON.parse(row.receipt_snapshot);
    if (receipt.metadata?.observerId !== EXACT_REFUND_OBSERVER_ID) {
      visitedId = receipt.id;
      continue;
    }
    const target = readTarget(row);
    let proof: RefundCanonicalProof;
    try {
      proof = !target
        ? { kind: "pending", reason: "refund_watch_contract_invalid" }
        : inspect
          ? await inspect(target, input.now)
          : target.asset.networkId.startsWith("evm:")
            ? await inspectEvmRefundCanonicality(
                target,
                input.now,
                undefined,
                deadline,
              )
            : await inspectNativeRefundCanonicality(target, readNative);
    } catch {
      proof = { kind: "pending", reason: "refund_watch_transport_error" };
    }
    if (
      proof.kind === "pending" &&
      ["refund_watch_budget_exhausted", "refund_watch_deadline"].includes(
        proof.reason,
      )
    ) {
      interrupted = true;
      break;
    }
    results.push({ row, proof });
    visitedId = receipt.id;
  }
  return tx(pool, async (db) => {
    const persisted = await persistRefundCanonicalProofs(db, {
      ...input,
      rows: results,
    });
    const sweepPending =
      (afterId !== null && state.sweepPending === true) ||
      results.some((result) => result.proof.kind === "pending") ||
      persisted.stale;
    const nextId =
      interrupted || rows.length === input.limit ? visitedId : null;
    const pending = interrupted || sweepPending || nextId !== null;
    // Do not rewrite metadata for unrelated legacy operations.
    if (rows.length || afterId || prior !== null) {
      const updated = await db.query(
        `update funding_operations set version=version+1, support_metadata=jsonb_set(support_metadata,
        '{exactRefundCanonicalWatch}',$3::jsonb,true)
        where id=$1::uuid and coalesce(support_metadata->'exactRefundCanonicalWatch','null'::jsonb)=$2::jsonb`,
        [
          input.operationId,
          JSON.stringify(prior ?? null),
          {
            version: 1,
            afterId: nextId,
            pending,
            sweepPending,
            checkedAt: input.now.toISOString(),
            reason: interrupted
              ? "refund_watch_read_budget_pending"
              : persisted.stale
                ? "refund_watch_snapshot_changed"
                : results.find((result) => result.proof.kind === "pending")
                      ?.proof.kind === "pending"
                  ? "refund_watch_verification_pending"
                  : null,
          },
        ],
      );
      if (!updated.rowCount)
        throw new Error("refund watch cursor changed during observation");
    }
    return { checked: results.length, changed: persisted.changed, pending };
  });
}
