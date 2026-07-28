import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingReceiveReceipt,
  FundingReceiveAutomationPolicy,
  FundingReceiveMethod,
  FundingReceiveSession,
  FundingReceiveSessionStatus,
  JsonValue,
} from "../domain/types.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ReceiveTargets = NonNullable<ExternalIngressInstruction["receiveTargets"]>;
type ActiveReceiveSessionStatus =
  | "open"
  | "processing"
  | "review_required"
  | "recovery_required";

type ReceiveSessionRow = Readonly<{
  id: string;
  user_id: string;
  status: FundingReceiveSessionStatus;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  destination_target_snapshot: JsonRecord;
  venue_binding_snapshot: JsonRecord;
  funding_methods: readonly FundingReceiveMethod[];
  receive_targets: ReceiveTargets;
  observation_variants: readonly JsonRecord[];
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
  venue_id,
  destination_option_id,
  venue_binding_option_id,
  destination_asset,
  destination_target_snapshot,
  venue_binding_snapshot,
  funding_methods,
  receive_targets,
  observation_variants,
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
  destinationTargetSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord;
  observationVariants: readonly JsonRecord[];
  policyVersion: number;
  policyRevision: string;
  ownershipRevision: string;
  observeUntil: Date;
}>;

function snapshot(row: ReceiveSessionRow): FundingReceiveSessionSnapshot {
  return {
    session: publicSession(row),
    userId: row.user_id,
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
): Promise<
  Readonly<{ snapshot: FundingReceiveSessionSnapshot; replayed: boolean }>
> {
  return tx(db, async (client) => {
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
      current.expires_at > input.now &&
      (current.status === "processing" ||
        current.status === "review_required" ||
        (current.policy_revision === input.policyRevision &&
          current.ownership_revision === input.ownershipRevision))
    ) {
      return { snapshot: snapshot(current), replayed: true };
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
          venue_id,
          destination_option_id,
          venue_binding_option_id,
          destination_asset,
          destination_target_snapshot,
          venue_binding_snapshot,
          funding_methods,
          receive_targets,
          observation_variants,
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
          $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
          $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17,
          $18
        )
        returning ${sessionColumns}
      `,
      [
        input.userId,
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
    return { snapshot: snapshot(row), replayed: false };
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

export async function listObservableFundingReceiveSessions(
  db: Pick<Pool, "query">,
  input: Readonly<{ limit: number; now: Date }>,
): Promise<readonly FundingReceiveSessionSnapshot[]> {
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      select ${sessionColumns}
      from funding_receive_sessions
      where (
          status in ('open', 'processing', 'review_required')
          and expires_at > $1
        )
        or (
          status in ('expired', 'cancelled')
          and observe_until > $1
        )
      order by coalesce(last_observed_at, opened_at) asc
      limit $2
    `,
    [input.now, input.limit],
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
        and status = 'open'
        and not exists (
          select 1
          from funding_receive_receipts receipt
          where receipt.receive_session_id = funding_receive_sessions.id
        )
      returning ${sessionColumns}
    `,
    [input.receiveSessionId, input.userId, input.now],
  );
  return rows[0] ? snapshot(rows[0]) : null;
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
  userId: string;
  venueId: string;
  destinationOptionId: string;
  venueBindingOptionId: string;
  destinationAsset: AssetRef;
  automationPolicy: FundingReceiveAutomationPolicy;
  childOperationStatus: string | null;
}>;

export type FundingReceiveReceiptReviewTarget =
  FundingReceiveReceiptRoutingTarget &
    Readonly<{
      reviewQuoteId: string | null;
    }>;

type ReceiveReceiptTargetRow = ReceiveReceiptRow & {
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  automation_policy: FundingReceiveAutomationPolicy;
  child_operation_status: string | null;
};

function receiveReceiptRoutingTarget(
  row: ReceiveReceiptTargetRow,
): FundingReceiveReceiptRoutingTarget {
  return {
    receipt: publicReceipt(row),
    userId: row.user_id,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationAsset: row.destination_asset,
    automationPolicy: row.automation_policy,
    childOperationStatus: row.child_operation_status,
  };
}

export async function listFundingReceiveReceiptsForRouting(
  db: Pick<Pool, "query">,
  input: Readonly<{ limit: number }>,
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
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        session.venue_id,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.automation_policy,
        operation.status as child_operation_status
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where receipt.status in ('observed', 'routing')
        and receipt.handling = 'automatic_conversion'
      order by receipt.created_at asc
      limit $1
    `,
    [input.limit],
  );
  return rows.map(receiveReceiptRoutingTarget);
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
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        session.venue_id,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.automation_policy,
        operation.status as child_operation_status
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where receipt.id = $1
        and receipt.receive_session_id = $2
        and receipt.user_id = $3
        and receipt.handling = 'review_required'
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
        and handling = 'review_required'
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
            updated_at = $6
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and review_quote_id = $4
          and status = 'review_required'
          and handling = 'review_required'
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
  db: Pick<Pool, "query">,
  input: Readonly<{
    receiptId: string;
    userId: string;
    childFundingOperationId: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `
      update funding_receive_receipts
      set status = 'routing',
          child_funding_operation_id = $3,
          updated_at = $4
      where id = $1
        and user_id = $2
        and status = 'observed'
        and child_funding_operation_id is null
    `,
    [input.receiptId, input.userId, input.childFundingOperationId, input.now],
  );
  return result.rowCount === 1;
}

export async function settleFundingReceiveReceiptRouting(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    status: "ready" | "recovery_required";
    now: Date;
  }>,
): Promise<boolean> {
  return tx(db, async (client) => {
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = $4,
            updated_at = $5
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and status = 'routing'
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        input.status,
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
