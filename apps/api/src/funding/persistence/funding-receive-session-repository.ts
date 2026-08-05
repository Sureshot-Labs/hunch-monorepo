import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingReceiveReceipt,
  FundingReceiveAutomationPolicy,
  FundingReceiveSessionChannel,
  FundingReceiveMethod,
  FundingReceiveSession,
  FundingReceiveSessionStatus,
  JsonValue,
} from "../domain/types.js";
import { canonicalAccountAddress } from "../domain/asset-identity.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ReceiveTargets = NonNullable<ExternalIngressInstruction["receiveTargets"]>;
type ActiveReceiveSessionStatus =
  | "open"
  | "processing"
  | "review_required"
  | "recovery_required";

export class FundingReceiveSessionChannelConflictError extends Error {
  readonly code = "receive_channel_conflict";

  constructor() {
    super("an active receive session is owned by another channel");
    this.name = "FundingReceiveSessionChannelConflictError";
  }
}

type ReceiveSessionRow = Readonly<{
  id: string;
  user_id: string;
  status: FundingReceiveSessionStatus;
  owner_channel: FundingReceiveSessionChannel;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  destination_target_snapshot: JsonRecord;
  venue_binding_snapshot: JsonRecord;
  funding_methods: readonly FundingReceiveMethod[];
  receive_targets: ReceiveTargets;
  observation_variants: readonly JsonRecord[];
  observation_start_variants: readonly JsonRecord[];
  selected_receive_target_id: string | null;
  automation_policy: FundingReceiveAutomationPolicy;
  policy_version: string | number;
  policy_revision: string;
  ownership_revision: string;
  version: string | number;
  opened_at: Date;
  last_observed_at: Date | null;
  expires_at: Date;
  observe_until: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

type ReceiveReceiptRow = Readonly<{
  id: string;
  receive_session_id: string;
  user_id: string;
  variant_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  destination_address: string;
  raw_amount: string;
  observation_revision: string;
  tx_hash: string | null;
  event_index: string | null;
  ledger_height: string | null;
  block_hash: string | null;
  source_address: string | null;
  observed_at: Date;
  status: FundingReceiveReceipt["status"];
  handling: FundingReceiveReceipt["handling"];
  child_funding_operation_id: string | null;
  evidence: JsonRecord;
  created_at: Date;
  updated_at: Date;
}>;

const sessionColumns = `
  id,
  user_id,
  status,
  owner_channel,
  venue_id,
  destination_option_id,
  venue_binding_option_id,
  destination_asset,
  destination_target_snapshot,
  venue_binding_snapshot,
  funding_methods,
  receive_targets,
  observation_variants,
  observation_start_variants,
  selected_receive_target_id,
  automation_policy,
  policy_version,
  policy_revision,
  ownership_revision,
  version,
  opened_at,
  last_observed_at,
  expires_at,
  observe_until,
  closed_at,
  created_at,
  updated_at
`;

function publicSession(row: ReceiveSessionRow): FundingReceiveSession {
  return {
    receiveSessionId: row.id,
    status: row.status,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationAsset: row.destination_asset,
    methods: row.funding_methods,
    receiveTargets: row.receive_targets,
    selectedReceiveTargetId: row.selected_receive_target_id,
    automationPolicy: row.automation_policy,
    version: Number(row.version),
    openedAt: row.opened_at.toISOString(),
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    observeUntil: row.observe_until.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

function publicReceipt(row: ReceiveReceiptRow): FundingReceiveReceipt {
  return {
    receiptId: row.id,
    receiveSessionId: row.receive_session_id,
    variantId: row.variant_id,
    asset: {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    },
    destinationAddress: row.destination_address,
    rawAmount: row.raw_amount,
    observationRevision: row.observation_revision,
    observedAt: row.observed_at.toISOString(),
    status: row.status,
    handling: row.handling,
    childFundingOperationId: row.child_funding_operation_id,
  };
}

export function deriveActiveFundingReceiveSessionStatus(
  receiptStatuses: readonly FundingReceiveReceipt["status"][],
): ActiveReceiveSessionStatus {
  if (receiptStatuses.includes("recovery_required")) {
    return "recovery_required";
  }
  if (receiptStatuses.includes("review_required")) {
    return "review_required";
  }
  if (
    receiptStatuses.includes("observed") ||
    receiptStatuses.includes("routing")
  ) {
    return "processing";
  }
  return "open";
}

export async function derivePersistedFundingReceiveSessionStatus(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
  }>,
): Promise<ActiveReceiveSessionStatus> {
  const { rows } = await db.query<Pick<ReceiveReceiptRow, "status">>(
    `
      select status
      from funding_receive_receipts
      where receive_session_id = $1
        and user_id = $2
    `,
    [input.receiveSessionId, input.userId],
  );
  return deriveActiveFundingReceiveSessionStatus(rows.map((row) => row.status));
}

export type FundingReceiveSessionSnapshot = Readonly<{
  session: FundingReceiveSession;
  userId: string;
  ownerChannel: FundingReceiveSessionChannel;
  destinationTargetSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord;
  observationVariants: readonly JsonRecord[];
  policyVersion: number;
  policyRevision: string;
  ownershipRevision: string;
  observeUntil: Date;
}>;

export type FundingReceiveSessionPersistenceResult = Readonly<{
  snapshot: FundingReceiveSessionSnapshot;
  replayed: boolean;
}>;

function snapshot(row: ReceiveSessionRow): FundingReceiveSessionSnapshot {
  return {
    session: publicSession(row),
    userId: row.user_id,
    ownerChannel: row.owner_channel,
    destinationTargetSnapshot: row.destination_target_snapshot,
    venueBindingSnapshot: row.venue_binding_snapshot,
    observationVariants: row.observation_variants,
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    ownershipRevision: row.ownership_revision,
    observeUntil: row.observe_until,
  };
}

export async function createOrReuseFundingReceiveSession(
  db: Pool,
  input: Readonly<{
    userId: string;
    ownerChannel?: FundingReceiveSessionChannel;
    venueId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    destinationAsset: AssetRef;
    destinationTargetSnapshot: JsonRecord;
    venueBindingSnapshot: JsonRecord;
    methods: readonly FundingReceiveMethod[];
    receiveTargets: ReceiveTargets;
    observationVariants: readonly JsonRecord[];
    selectedReceiveTargetId: string | null;
    automationPolicy: FundingReceiveAutomationPolicy;
    policyVersion: number;
    policyRevision: string;
    ownershipRevision: string;
    expiresAt: Date;
    observeUntil: Date;
    now: Date;
  }>,
  finalize?: (
    client: PoolClient,
    result: FundingReceiveSessionPersistenceResult,
  ) => Promise<void>,
): Promise<FundingReceiveSessionPersistenceResult> {
  const ownerChannel = input.ownerChannel ?? "web";
  return tx(db, async (client) => {
    const finalized = async (
      result: FundingReceiveSessionPersistenceResult,
    ): Promise<FundingReceiveSessionPersistenceResult> => {
      await finalize?.(client, result);
      return result;
    };
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        [
          "funding-receive-session",
          input.userId,
          input.destinationOptionId,
          input.venueBindingOptionId,
        ].join(":"),
      ],
    );
    const existing = await client.query<ReceiveSessionRow>(
      `
        select ${sessionColumns}
        from funding_receive_sessions
        where user_id = $1
          and destination_option_id = $2
          and venue_binding_option_id = $3
          and status in ('open', 'processing', 'review_required')
        for update
      `,
      [input.userId, input.destinationOptionId, input.venueBindingOptionId],
    );
    const current = existing.rows[0];
    if (
      current &&
      current.owner_channel !== ownerChannel &&
      current.expires_at > input.now
    ) {
      throw new FundingReceiveSessionChannelConflictError();
    }
    if (
      current &&
      current.owner_channel === ownerChannel &&
      current.expires_at > input.now &&
      (current.status === "processing" ||
        current.status === "review_required" ||
        (current.policy_revision === input.policyRevision &&
          current.ownership_revision === input.ownershipRevision))
    ) {
      return finalized({ snapshot: snapshot(current), replayed: true });
    }
    if (current) {
      await client.query(
        `
          update funding_receive_sessions
          set status = 'expired',
              closed_at = $2,
              updated_at = $2,
              version = version + 1
          where id = $1
        `,
        [current.id, input.now],
      );
    }
    const inserted = await client.query<ReceiveSessionRow>(
      `
        insert into funding_receive_sessions (
          user_id,
          owner_channel,
          venue_id,
          destination_option_id,
          venue_binding_option_id,
          destination_asset,
          destination_target_snapshot,
          venue_binding_snapshot,
          funding_methods,
          receive_targets,
          observation_variants,
          observation_start_variants,
          selected_receive_target_id,
          automation_policy,
          policy_version,
          policy_revision,
          ownership_revision,
          opened_at,
          expires_at,
          observe_until
        )
        values (
          $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
          $9::jsonb, $10::jsonb, $11::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15,
          $16, $17, $18, $19
        )
        returning ${sessionColumns}
      `,
      [
        input.userId,
        ownerChannel,
        input.venueId,
        input.destinationOptionId,
        input.venueBindingOptionId,
        JSON.stringify(input.destinationAsset),
        JSON.stringify(input.destinationTargetSnapshot),
        JSON.stringify(input.venueBindingSnapshot),
        JSON.stringify(input.methods),
        JSON.stringify(input.receiveTargets),
        JSON.stringify(input.observationVariants),
        input.selectedReceiveTargetId,
        JSON.stringify(input.automationPolicy),
        input.policyVersion,
        input.policyRevision,
        input.ownershipRevision,
        input.now,
        input.expiresAt,
        input.observeUntil,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("funding receive session insert returned no row");
    return finalized({ snapshot: snapshot(row), replayed: false });
  });
}

export async function fetchFundingReceiveSessionForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; receiveSessionId: string }>,
): Promise<FundingReceiveSessionSnapshot | null> {
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      select ${sessionColumns}
      from funding_receive_sessions
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.receiveSessionId, input.userId],
  );
  return rows[0] ? snapshot(rows[0]) : null;
}

export async function expireFundingReceiveSessions(
  db: Pick<Pool, "query">,
  input: Readonly<{ now: Date }>,
): Promise<number> {
  const result = await db.query(
    `
      update funding_receive_sessions
      set status = 'expired',
          closed_at = $1,
          version = version + 1,
          updated_at = $1
      where status in ('open', 'processing', 'review_required')
        and expires_at <= $1
    `,
    [input.now],
  );
  return result.rowCount ?? 0;
}

export async function claimObservableFundingReceiveSessions(
  db: Pick<Pool, "query">,
  input: Readonly<{
    limit: number;
    minimumPollIntervalMs: number;
    inactivePollIntervalMs?: number;
    closedPollIntervalMs?: number;
    activeWindowMs?: number;
    now: Date;
  }>,
): Promise<readonly FundingReceiveSessionSnapshot[]> {
  const minimumPollIntervalMs = Math.max(
    1_000,
    Math.trunc(input.minimumPollIntervalMs),
  );
  const inactivePollIntervalMs = Math.max(
    minimumPollIntervalMs,
    Math.trunc(input.inactivePollIntervalMs ?? 60_000),
  );
  const closedPollIntervalMs = Math.max(
    inactivePollIntervalMs,
    Math.trunc(input.closedPollIntervalMs ?? 300_000),
  );
  const activeWindowMs = Math.max(
    minimumPollIntervalMs,
    Math.trunc(input.activeWindowMs ?? 15 * 60_000),
  );
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      with candidates as (
        select id
        from funding_receive_sessions
        where (
            (
              status in ('open', 'processing', 'review_required')
              and expires_at > $1
            )
            or (
              status in ('expired', 'cancelled')
              and observe_until > $1
            )
          )
          and coalesce(last_observed_at, opened_at)
            <= $1 - (
              case
                when status in ('expired', 'cancelled') then $5::bigint
                when opened_at <= $1 - ($6::bigint * interval '1 millisecond')
                  then $4::bigint
                else $3::bigint
              end * interval '1 millisecond'
            )
        order by coalesce(last_observed_at, opened_at) asc
        for update skip locked
        limit $2
      ),
      claimed as (
        update funding_receive_sessions session
        set last_observed_at = $1
        from candidates
        where session.id = candidates.id
        returning session.*
      )
      select ${sessionColumns}
      from claimed
      order by coalesce(last_observed_at, opened_at) asc
    `,
    [
      input.now,
      input.limit,
      minimumPollIntervalMs,
      inactivePollIntervalMs,
      closedPollIntervalMs,
      activeWindowMs,
    ],
  );
  return rows.map(snapshot);
}
export async function listFundingReceiveReceiptsForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; receiveSessionId: string }>,
): Promise<readonly FundingReceiveReceipt[]> {
  const { rows } = await db.query<ReceiveReceiptRow>(
    `
      select
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
      from funding_receive_receipts
      where receive_session_id = $1
        and user_id = $2
      order by created_at asc
    `,
    [input.receiveSessionId, input.userId],
  );
  return rows.map(publicReceipt);
}

export async function cancelFundingReceiveSessionForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    receiveSessionId: string;
    now: Date;
  }>,
): Promise<FundingReceiveSessionSnapshot | null> {
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      update funding_receive_sessions
      set status = 'cancelled',
          closed_at = $3,
          updated_at = $3,
          version = version + 1
      where id = $1
        and user_id = $2
        and owner_channel = $4
        and status = 'open'
        and not exists (
          select 1
          from funding_receive_receipts receipt
          where receipt.receive_session_id = funding_receive_sessions.id
        )
      returning ${sessionColumns}
    `,
    [input.receiveSessionId, input.userId, input.now, input.ownerChannel],
  );
  return rows[0] ? snapshot(rows[0]) : null;
}

type FundingReceiveCanonicalEventAllocationRow = Readonly<{
  id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  destination_address: string;
  source_address: string | null;
  raw_amount: string;
  tx_hash: string;
  event_index: string;
  ledger_height: string;
  block_hash: string;
  observed_at: Date;
  allocation_status: "pending" | "allocated" | "recovery_required";
  allocated_receive_session_id: string | null;
  allocated_receipt_id: string | null;
  allocation_error_code: string | null;
}>;

export type FundingReceiveCanonicalEventAllocation = Readonly<{
  eventId: string;
  status: "pending" | "allocated" | "recovery_required";
  targetReceiveSessionId: string | null;
  allocatedReceiptId: string | null;
  errorCode: string | null;
}>;

function sameCanonicalReceiveValue(
  networkId: string,
  left: string,
  right: string,
): boolean {
  return (
    canonicalAccountAddress(networkId, left) ===
    canonicalAccountAddress(networkId, right)
  );
}

function canonicalStartCursor(
  row: Readonly<{ observationStartVariants: readonly JsonRecord[] }>,
  input: Readonly<{
    networkId: string;
    assetId: string;
    destinationAddress: string;
  }>,
): bigint | null {
  const cursors = row.observationStartVariants.flatMap((raw) => {
    const asset =
      raw.asset && typeof raw.asset === "object" && !Array.isArray(raw.asset)
        ? (raw.asset as JsonRecord)
        : null;
    const observation =
      raw.observation &&
      typeof raw.observation === "object" &&
      !Array.isArray(raw.observation)
        ? (raw.observation as JsonRecord)
        : null;
    const payload =
      observation?.payload &&
      typeof observation.payload === "object" &&
      !Array.isArray(observation.payload)
        ? (observation.payload as JsonRecord)
        : null;
    if (
      raw.networkId !== input.networkId ||
      typeof asset?.assetId !== "string" ||
      typeof raw.destinationAddress !== "string" ||
      !sameCanonicalReceiveValue(
        input.networkId,
        asset.assetId,
        input.assetId,
      ) ||
      !sameCanonicalReceiveValue(
        input.networkId,
        raw.destinationAddress,
        input.destinationAddress,
      )
    ) {
      return [];
    }
    const cursor =
      payload?.eventCursorBlock ?? payload?.eventCursorSlot ?? null;
    return typeof cursor === "string" && /^[0-9]+$/u.test(cursor)
      ? [BigInt(cursor)]
      : [];
  });
  if (cursors.length === 0) return null;
  return cursors.reduce((highest, cursor) =>
    cursor > highest ? cursor : highest,
  );
}

export function selectFundingReceiveCanonicalEventTarget(
  input: Readonly<{
    networkId: string;
    assetId: string;
    destinationAddress: string;
    ledgerHeight: string;
    candidates: readonly Readonly<{
      receiveSessionId: string;
      userId: string;
      openedAt: Date;
      observationStartVariants: readonly JsonRecord[];
    }>[];
  }>,
):
  | Readonly<{ targetReceiveSessionId: string; errorCode: null }>
  | Readonly<{
      targetReceiveSessionId: null;
      errorCode:
        | "receive_session_allocation_unavailable"
        | "ambiguous_receive_session_owner";
    }> {
  const ledgerHeight = BigInt(input.ledgerHeight);
  const candidates = input.candidates.flatMap((candidate) => {
    const cursor = canonicalStartCursor(candidate, input);
    return cursor != null && cursor < ledgerHeight
      ? [{ candidate, cursor }]
      : [];
  });
  const owners = new Set(candidates.map(({ candidate }) => candidate.userId));
  if (candidates.length === 0) {
    return {
      targetReceiveSessionId: null,
      errorCode: "receive_session_allocation_unavailable",
    };
  }
  if (owners.size !== 1) {
    return {
      targetReceiveSessionId: null,
      errorCode: "ambiguous_receive_session_owner",
    };
  }
  candidates.sort((left, right) => {
    if (left.cursor > right.cursor) return -1;
    if (left.cursor < right.cursor) return 1;
    const opened =
      right.candidate.openedAt.getTime() - left.candidate.openedAt.getTime();
    if (opened !== 0) return opened;
    return left.candidate.receiveSessionId.localeCompare(
      right.candidate.receiveSessionId,
    );
  });
  const target = candidates[0];
  if (!target) {
    return {
      targetReceiveSessionId: null,
      errorCode: "receive_session_allocation_unavailable",
    };
  }
  return {
    targetReceiveSessionId: target.candidate.receiveSessionId,
    errorCode: null,
  };
}

function sameCanonicalEventIdentity(
  row: FundingReceiveCanonicalEventAllocationRow,
  input: Readonly<{
    networkId: string;
    asset: AssetRef;
    destinationAddress: string;
    sourceAddress: string | null;
    rawAmount: string;
    transactionHash: string;
    eventIndex: string;
    ledgerHeight: string;
    blockHash: string;
    observedAt: Date;
  }>,
): boolean {
  return (
    row.network_id === input.networkId &&
    sameCanonicalReceiveValue(
      input.networkId,
      row.asset_id,
      input.asset.assetId,
    ) &&
    row.asset_decimals === input.asset.decimals &&
    sameCanonicalReceiveValue(
      input.networkId,
      row.destination_address,
      input.destinationAddress,
    ) &&
    (row.source_address == null && input.sourceAddress == null
      ? true
      : row.source_address != null &&
        input.sourceAddress != null &&
        sameCanonicalReceiveValue(
          input.networkId,
          row.source_address,
          input.sourceAddress,
        )) &&
    row.raw_amount === input.rawAmount &&
    row.tx_hash === input.transactionHash &&
    row.event_index === input.eventIndex &&
    row.ledger_height === input.ledgerHeight &&
    row.block_hash === input.blockHash
  );
}

export async function claimFundingReceiveCanonicalEventAllocation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    networkId: string;
    asset: AssetRef;
    destinationAddress: string;
    sourceAddress: string | null;
    rawAmount: string;
    transactionHash: string;
    eventIndex: string;
    ledgerHeight: string;
    blockHash: string;
    observedAt: Date;
    now: Date;
  }>,
): Promise<FundingReceiveCanonicalEventAllocation> {
  const event = await client.query<FundingReceiveCanonicalEventAllocationRow>(
    `
      insert into funding_receive_canonical_events (
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        source_address,
        raw_amount,
        tx_hash,
        event_index,
        ledger_height,
        block_hash,
        observed_at,
        first_observed_at,
        last_observed_at
      )
      values (
        $1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::numeric, $10, $11,
        $12, $12
      )
      on conflict (network_id, tx_hash, event_index)
      do update set last_observed_at = greatest(
        funding_receive_canonical_events.last_observed_at,
        excluded.last_observed_at
      )
      returning
        id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        source_address,
        raw_amount::text,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        observed_at,
        allocation_status,
        allocated_receive_session_id,
        allocated_receipt_id,
        allocation_error_code
    `,
    [
      input.networkId,
      input.asset.assetId,
      input.asset.decimals,
      input.destinationAddress,
      input.sourceAddress,
      input.rawAmount,
      input.transactionHash,
      input.eventIndex,
      input.ledgerHeight,
      input.blockHash,
      input.observedAt,
      input.now,
    ],
  );
  const row = event.rows[0];
  if (!row || !sameCanonicalEventIdentity(row, input)) {
    throw new Error("canonical receive event identity collision");
  }
  if (row.allocation_status !== "pending") {
    return {
      eventId: row.id,
      status: row.allocation_status,
      targetReceiveSessionId: row.allocated_receive_session_id,
      allocatedReceiptId: row.allocated_receipt_id,
      errorCode: row.allocation_error_code,
    };
  }

  const sessions = await client.query<ReceiveSessionRow>(
    `
      select ${sessionColumns}
      from funding_receive_sessions
      where observe_until > $1
        and status in (
          'open',
          'processing',
          'review_required',
          'expired',
          'cancelled'
        )
        and exists (
          select 1
          from jsonb_array_elements(observation_start_variants) variant
          where variant->>'networkId' = $2
            and (
              case
                when $2 like 'evm:%'
                  and variant->'asset'->>'assetId'
                    ~ '^0x[0-9A-Fa-f]{40}$'
                  and $3 ~ '^0x[0-9A-Fa-f]{40}$'
                  then lower(variant->'asset'->>'assetId') = lower($3)
                else variant->'asset'->>'assetId' = $3
              end
            )
            and (
              case
                when $2 like 'evm:%'
                  and variant->>'destinationAddress'
                    ~ '^0x[0-9A-Fa-f]{40}$'
                  and $4 ~ '^0x[0-9A-Fa-f]{40}$'
                  then lower(variant->>'destinationAddress') = lower($4)
                else variant->>'destinationAddress' = $4
              end
            )
        )
      for update
    `,
    [input.now, input.networkId, input.asset.assetId, input.destinationAddress],
  );
  const selection = selectFundingReceiveCanonicalEventTarget({
    networkId: input.networkId,
    assetId: input.asset.assetId,
    destinationAddress: input.destinationAddress,
    ledgerHeight: input.ledgerHeight,
    candidates: sessions.rows.map((session) => ({
      receiveSessionId: session.id,
      userId: session.user_id,
      openedAt: session.opened_at,
      observationStartVariants: session.observation_start_variants,
    })),
  });
  if (selection.errorCode) {
    await client.query(
      `
        update funding_receive_canonical_events
        set allocation_status = 'recovery_required',
            allocation_error_code = $2,
            last_observed_at = $3
        where id = $1
          and allocation_status = 'pending'
      `,
      [row.id, selection.errorCode, input.now],
    );
    return {
      eventId: row.id,
      status: "recovery_required",
      targetReceiveSessionId: null,
      allocatedReceiptId: null,
      errorCode: selection.errorCode,
    };
  }
  return {
    eventId: row.id,
    status: "pending",
    targetReceiveSessionId: selection.targetReceiveSessionId,
    allocatedReceiptId: null,
    errorCode: null,
  };
}

export async function finalizeFundingReceiveCanonicalEventAllocation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    eventId: string;
    receiveSessionId: string;
    receiptId: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_canonical_events
      set allocation_status = 'allocated',
          allocated_receive_session_id = $2,
          allocated_receipt_id = $3,
          allocated_at = $4,
          last_observed_at = $4
      where id = $1
        and allocation_status = 'pending'
    `,
    [input.eventId, input.receiveSessionId, input.receiptId, input.now],
  );
  if (result.rowCount === 1) return true;
  const { rows } = await client.query<{
    allocated_receive_session_id: string | null;
    allocated_receipt_id: string | null;
  }>(
    `
      select allocated_receive_session_id, allocated_receipt_id
      from funding_receive_canonical_events
      where id = $1
        and allocation_status = 'allocated'
      limit 1
    `,
    [input.eventId],
  );
  return (
    rows[0]?.allocated_receive_session_id === input.receiveSessionId &&
    rows[0]?.allocated_receipt_id === input.receiptId
  );
}

export async function insertFundingReceiveReceipt(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
    variantId: string;
    asset: AssetRef;
    destinationAddress: string;
    rawAmount: string;
    observationRevision: string;
    canonicalEvent?: Readonly<{
      transactionHash: string;
      eventIndex: string;
      ledgerHeight: string;
      blockHash: string;
      sourceAddress: string | null;
    }> | null;
    observedAt: Date;
    handling: FundingReceiveReceipt["handling"];
    status: FundingReceiveReceipt["status"];
    evidence: JsonRecord;
    now: Date;
  }>,
): Promise<Readonly<{ receipt: FundingReceiveReceipt; replayed: boolean }>> {
  const { rows } = await client.query<ReceiveReceiptRow>(
    `
      insert into funding_receive_receipts (
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        evidence,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9,
        $10, $11, $12::numeric, $13, $14, $15, $16, $17,
        $18::jsonb, $19, $19
      )
      on conflict do nothing
      returning
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
    `,
    [
      input.receiveSessionId,
      input.userId,
      input.variantId,
      input.asset.networkId,
      input.asset.assetId,
      input.asset.decimals,
      input.destinationAddress,
      input.rawAmount,
      input.observationRevision,
      input.canonicalEvent?.transactionHash ?? null,
      input.canonicalEvent?.eventIndex ?? null,
      input.canonicalEvent?.ledgerHeight ?? null,
      input.canonicalEvent?.blockHash ?? null,
      input.canonicalEvent?.sourceAddress ?? null,
      input.observedAt,
      input.status,
      input.handling,
      JSON.stringify(input.evidence),
      input.now,
    ],
  );
  const inserted = rows[0];
  if (inserted) {
    return { receipt: publicReceipt(inserted), replayed: false };
  }
  const replay = await client.query<ReceiveReceiptRow>(
    `
      select
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
      from funding_receive_receipts
      where (
          receive_session_id = $1
          and variant_id = $2
          and observation_revision = $3
        )
        or (
          $4::text is not null
          and network_id = $5
          and tx_hash = $4
          and event_index = $6
        )
      order by created_at asc
      limit 1
    `,
    [
      input.receiveSessionId,
      input.variantId,
      input.observationRevision,
      input.canonicalEvent?.transactionHash ?? null,
      input.asset.networkId,
      input.canonicalEvent?.eventIndex ?? null,
    ],
  );
  const replayed = replay.rows[0];
  if (!replayed) {
    throw new Error("funding receive receipt conflict could not be resolved");
  }
  return { receipt: publicReceipt(replayed), replayed: true };
}

export async function updateFundingReceiveSessionObservation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    expectedVersion: number;
    observationVariants: readonly JsonRecord[];
    status: "open" | "processing" | "review_required" | "recovery_required";
    lastObservedAt: Date;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_sessions
      set observation_variants = $3::jsonb,
          status = $4,
          last_observed_at = $5,
          version = version + 1,
          updated_at = $6
      where id = $1
        and version = $2
        and status in ('open', 'processing', 'review_required')
    `,
    [
      input.receiveSessionId,
      input.expectedVersion,
      JSON.stringify(input.observationVariants),
      input.status,
      input.lastObservedAt,
      input.now,
    ],
  );
  return result.rowCount === 1;
}

export async function updateClosedFundingReceiveSessionObservation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    expectedVersion: number;
    observationVariants: readonly JsonRecord[];
    lastObservedAt: Date;
    recoveryRequired: boolean;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_sessions
      set observation_variants = $3::jsonb,
          status = case when $5 then 'recovery_required' else status end,
          closed_at = case when $5 then null else closed_at end,
          last_observed_at = $4,
          version = version + 1,
          updated_at = $6
      where id = $1
        and version = $2
        and status in ('expired', 'cancelled')
        and observe_until > $6
    `,
    [
      input.receiveSessionId,
      input.expectedVersion,
      JSON.stringify(input.observationVariants),
      input.lastObservedAt,
      input.recoveryRequired,
      input.now,
    ],
  );
  return result.rowCount === 1;
}

export type FundingReceiveReceiptRoutingTarget = Readonly<{
  receipt: FundingReceiveReceipt;
  receiptDestinationLocationId: string | null;
  userId: string;
  venueId: string;
  destinationOptionId: string;
  venueBindingOptionId: string;
  destinationAsset: AssetRef;
  automationPolicy: FundingReceiveAutomationPolicy;
  childOperationStatus: string | null;
  childBroadcastMayHaveOccurred: boolean;
  childHasUnfinishedAttempt: boolean;
  routingAttemptCount: number;
  routingDisposition:
    | "pending"
    | "retry_scheduled"
    | "operation_created"
    | "review_required"
    | "recovery_required"
    | "ready";
}>;

export type FundingReceiveReceiptReviewTarget =
  FundingReceiveReceiptRoutingTarget &
    Readonly<{
      reviewQuoteId: string | null;
    }>;

type ReceiveReceiptTargetRow = ReceiveReceiptRow & {
  receipt_destination_location_id: string | null;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  automation_policy: FundingReceiveAutomationPolicy;
  child_operation_status: string | null;
  child_broadcast_may_have_occurred: boolean;
  child_has_unfinished_attempt: boolean;
  routing_attempt_count: number;
  routing_disposition: FundingReceiveReceiptRoutingTarget["routingDisposition"];
};

function receiveReceiptRoutingTarget(
  row: ReceiveReceiptTargetRow,
): FundingReceiveReceiptRoutingTarget {
  return {
    receipt: publicReceipt(row),
    receiptDestinationLocationId: row.receipt_destination_location_id,
    userId: row.user_id,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationAsset: row.destination_asset,
    automationPolicy: row.automation_policy,
    childOperationStatus: row.child_operation_status,
    childBroadcastMayHaveOccurred: row.child_broadcast_may_have_occurred,
    childHasUnfinishedAttempt: row.child_has_unfinished_attempt,
    routingAttemptCount: row.routing_attempt_count,
    routingDisposition: row.routing_disposition,
  };
}

export async function listFundingReceiveReceiptsForRouting(
  db: Pick<Pool, "query">,
  input: Readonly<{ limit: number; now?: Date }>,
): Promise<readonly FundingReceiveReceiptRoutingTarget[]> {
  const { rows } = await db.query<ReceiveReceiptTargetRow>(
    `
      select
        receipt.id,
        receipt.receive_session_id,
        receipt.user_id,
        receipt.variant_id,
        receipt.network_id,
        receipt.asset_id,
        receipt.asset_decimals,
        receipt.destination_address,
        receipt.raw_amount::text,
        receipt.observation_revision,
        receipt.tx_hash,
        receipt.event_index,
        receipt.ledger_height::text,
        receipt.block_hash,
        receipt.source_address,
        receipt.observed_at,
        receipt.status,
        receipt.handling,
        receipt.child_funding_operation_id,
        receipt.routing_attempt_count,
        receipt.routing_disposition,
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        (
          select variant ->> 'destinationLocationId'
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_destination_location_id,
        session.venue_id,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.automation_policy,
        operation.status as child_operation_status,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.broadcast_may_have_occurred
        ) as child_broadcast_may_have_occurred,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.outcome = 'started'
        ) as child_has_unfinished_attempt
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join telegram_funding_sessions telegram_context
        on telegram_context.receive_session_id = session.id
       and telegram_context.user_id = session.user_id
      left join lateral (
        select consent.*
        from telegram_funding_consents consent
        where consent.telegram_funding_session_id = telegram_context.id
          and consent.consented_at <= receipt.observed_at
        order by consent.consented_at desc, consent.revision desc
        limit 1
      ) telegram_consent on true
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where (
          receipt.status = 'observed'
          and receipt.handling = 'automatic_conversion'
          and receipt.child_funding_operation_id is null
          and receipt.routing_next_attempt_at <= $2
          and (
            (
              session.owner_channel = 'web'
              and session.selected_receive_target_id is not null
            )
            or (
              session.owner_channel = 'telegram'
              and telegram_context.id is not null
              and receipt.observed_at <= telegram_context.expires_at
              and (
                telegram_context.cancelled_at is null
                or receipt.observed_at <= telegram_context.cancelled_at
              )
              and telegram_consent.automation_enabled
              and telegram_consent.max_auto_execute_source_raw is not null
              and receipt.raw_amount <= telegram_consent.max_auto_execute_source_raw
              and receipt.network_id = telegram_consent.selected_asset_network_id
              and receipt.asset_decimals = telegram_consent.selected_asset_decimals
              and (
                (
                  receipt.network_id like 'evm:%'
                  and lower(receipt.asset_id) = lower(telegram_consent.selected_asset_id)
                )
                or (
                  receipt.network_id not like 'evm:%'
                  and receipt.asset_id = telegram_consent.selected_asset_id
                )
              )
              and receipt.variant_id = any(telegram_consent.consented_variant_ids)
            )
          )
        )
        or (
          receipt.status = 'routing'
          and receipt.child_funding_operation_id is not null
        )
      order by receipt.created_at asc
      limit $1
    `,
    [input.limit, input.now ?? new Date()],
  );
  return rows.map(receiveReceiptRoutingTarget);
}

export async function recordFundingReceiveReceiptRoutingDisposition(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    disposition: "retry_scheduled" | "review_required" | "recovery_required";
    errorCode: string;
    retryAt?: Date | null;
    now: Date;
  }>,
): Promise<boolean> {
  return tx(db, async (client) => {
    const nextStatus =
      input.disposition === "review_required"
        ? "review_required"
        : input.disposition === "recovery_required"
          ? "recovery_required"
          : "observed";
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = $4,
            routing_disposition = $5,
            routing_attempt_count = routing_attempt_count + 1,
            routing_next_attempt_at = coalesce($6, routing_next_attempt_at),
            routing_last_attempt_at = $7,
            routing_last_error_code = $8,
            updated_at = $7
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and status = 'observed'
          and handling = 'automatic_conversion'
          and child_funding_operation_id is null
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        nextStatus,
        input.disposition,
        input.retryAt ?? null,
        input.now,
        input.errorCode,
      ],
    );
    if (receipt.rowCount !== 1) return false;
    if (nextStatus !== "observed") {
      const sessionStatus = await derivePersistedFundingReceiveSessionStatus(
        client,
        {
          receiveSessionId: input.receiveSessionId,
          userId: input.userId,
        },
      );
      await client.query(
        `
          update funding_receive_sessions
          set status = $3,
              version = version + 1,
              updated_at = $4
          where id = $1
            and user_id = $2
            and status in ('open', 'processing', 'review_required')
        `,
        [input.receiveSessionId, input.userId, sessionStatus, input.now],
      );
    }
    return true;
  });
}

export async function fetchFundingReceiveReceiptForReview(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    receiveSessionId: string;
    receiptId: string;
  }>,
): Promise<FundingReceiveReceiptReviewTarget | null> {
  const { rows } = await db.query<
    ReceiveReceiptTargetRow & { review_quote_id: string | null }
  >(
    `
      select
        receipt.id,
        receipt.receive_session_id,
        receipt.user_id,
        receipt.variant_id,
        receipt.network_id,
        receipt.asset_id,
        receipt.asset_decimals,
        receipt.destination_address,
        receipt.raw_amount::text,
        receipt.observation_revision,
        receipt.tx_hash,
        receipt.event_index,
        receipt.ledger_height::text,
        receipt.block_hash,
        receipt.source_address,
        receipt.observed_at,
        receipt.status,
        receipt.handling,
        receipt.child_funding_operation_id,
        receipt.review_quote_id,
        receipt.routing_attempt_count,
        receipt.routing_disposition,
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        (
          select variant ->> 'destinationLocationId'
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_destination_location_id,
        session.venue_id,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.automation_policy,
        operation.status as child_operation_status,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.broadcast_may_have_occurred
        ) as child_broadcast_may_have_occurred,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.outcome = 'started'
        ) as child_has_unfinished_attempt
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where receipt.id = $1
        and receipt.receive_session_id = $2
        and receipt.user_id = $3
        and receipt.handling in ('review_required', 'automatic_conversion')
        and receipt.status in ('review_required', 'routing')
      limit 1
    `,
    [input.receiptId, input.receiveSessionId, input.userId],
  );
  const row = rows[0];
  return row
    ? {
        ...receiveReceiptRoutingTarget(row),
        reviewQuoteId: row.review_quote_id,
      }
    : null;
}

export async function setFundingReceiveReceiptReviewQuote(
  db: Pick<Pool, "query">,
  input: Readonly<{
    receiptId: string;
    userId: string;
    quoteId: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `
      update funding_receive_receipts
      set review_quote_id = $3,
          updated_at = $4
      where id = $1
        and user_id = $2
        and status = 'review_required'
        and handling in ('review_required', 'automatic_conversion')
        and child_funding_operation_id is null
    `,
    [input.receiptId, input.userId, input.quoteId, input.now],
  );
  return result.rowCount === 1;
}

export async function linkFundingReceiveReceiptReviewOperation(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    quoteId: string;
    childFundingOperationId: string;
    now: Date;
  }>,
): Promise<boolean> {
  return tx(db, async (client) => {
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = 'routing',
            child_funding_operation_id = $5,
            routing_disposition = 'operation_created',
            routing_last_attempt_at = $6,
            routing_last_error_code = null,
            updated_at = $6
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and review_quote_id = $4
          and status = 'review_required'
          and handling in ('review_required', 'automatic_conversion')
          and child_funding_operation_id is null
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        input.quoteId,
        input.childFundingOperationId,
        input.now,
      ],
    );
    if (receipt.rowCount !== 1) return false;
    const sessionStatus = await derivePersistedFundingReceiveSessionStatus(
      client,
      {
        receiveSessionId: input.receiveSessionId,
        userId: input.userId,
      },
    );
    await client.query(
      `
        update funding_receive_sessions
        set status = $3,
            version = version + 1,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status in ('open', 'processing', 'review_required')
      `,
      [input.receiveSessionId, input.userId, sessionStatus, input.now],
    );
    return true;
  });
}

export async function linkFundingReceiveReceiptOperation(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    userId: string;
    childFundingOperationId: string;
    now: Date;
  }>,
): Promise<boolean> {
  return tx(db, async (client) => {
    const result = await client.query<{ receive_session_id: string }>(
      `
        update funding_receive_receipts
        set status = 'routing',
            child_funding_operation_id = $3,
            routing_disposition = 'operation_created',
            routing_last_attempt_at = $4,
            routing_last_error_code = null,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status = 'observed'
          and child_funding_operation_id is null
        returning receive_session_id
      `,
      [input.receiptId, input.userId, input.childFundingOperationId, input.now],
    );
    const receiveSessionId = result.rows[0]?.receive_session_id;
    if (!receiveSessionId) return false;
    const sessionStatus = await derivePersistedFundingReceiveSessionStatus(
      client,
      { receiveSessionId, userId: input.userId },
    );
    await client.query(
      `
        update funding_receive_sessions
        set status = $3,
            version = version + 1,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status in ('open', 'processing', 'review_required')
      `,
      [receiveSessionId, input.userId, sessionStatus, input.now],
    );
    return true;
  });
}

export async function settleFundingReceiveReceiptRouting(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    childOperationId?: string | null;
    childOperationStatus?: string | null;
    status: "ready" | "review_required" | "recovery_required";
    now: Date;
  }>,
): Promise<boolean> {
  if (
    input.status === "review_required" &&
    (!input.childOperationId || !input.childOperationStatus)
  ) {
    throw new Error(
      "retryable receive routing requires the exact failed child operation",
    );
  }
  return tx(db, async (client) => {
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = $4,
            routing_disposition = case
              when $4 = 'ready' then 'ready'
              when $4 = 'review_required' then 'review_required'
              else 'recovery_required'
            end,
            routing_last_error_code = case
              when $4 = 'ready' then null
              when $4 = 'review_required'
                then 'child_operation_failed_before_broadcast'
              else coalesce(routing_last_error_code, 'child_operation_failed')
            end,
            review_quote_id = case
              when $4 = 'review_required' then null
              else review_quote_id
            end,
            child_funding_operation_id = case
              when $4 = 'review_required' then null
              else child_funding_operation_id
            end,
            evidence = case
              when $4 = 'review_required' then jsonb_set(
                evidence,
                '{routingOperationHistory}',
                (
                  case
                    when jsonb_typeof(evidence -> 'routingOperationHistory') = 'array'
                      then evidence -> 'routingOperationHistory'
                    else '[]'::jsonb
                  end
                ) || jsonb_build_array(
                  jsonb_build_object(
                    'operationId', $6::text,
                    'outcome', $7::text,
                    'detachedAt', $5::timestamptz
                  )
                ),
                true
              )
              else evidence
            end,
            updated_at = $5::timestamptz
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and status = 'routing'
          and ($6::uuid is null or child_funding_operation_id = $6)
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        input.status,
        input.now,
        input.childOperationId ?? null,
        input.childOperationStatus ?? null,
      ],
    );
    if (receipt.rowCount !== 1) return false;
    const sessionStatus = await derivePersistedFundingReceiveSessionStatus(
      client,
      {
        receiveSessionId: input.receiveSessionId,
        userId: input.userId,
      },
    );
    await client.query(
      `
        update funding_receive_sessions
        set status = $3,
            version = version + 1,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status in ('open', 'processing', 'review_required')
      `,
      [input.receiveSessionId, input.userId, sessionStatus, input.now],
    );
    return true;
  });
}
