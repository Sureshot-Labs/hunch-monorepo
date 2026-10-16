import { tx, type Pool } from "@hunch/infra";
import { parsePolymarketAssetContext } from "@hunch/shared";
import { isRecord } from "../lib/type-guards.js";
import type {
  ClaimedPurchase,
  PurchaseObservation,
  VerifiedPurchaseEvidence,
  NativePurchaseEvidenceGuard,
  NativePurchaseEvidenceFinalizer,
} from "./verified-buy.js";
import { EvidenceBudgetExhausted, factsFromEvidence } from "./verified-buy.js";
import {
  combinePurchaseEvidence,
  parseEvmClobBuyEvidence,
  parseEvmAmmBuyEvidence,
} from "./verified-buy-evidence.js";
import {
  verifiedBuyFactsSchema,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import {
  parseLimitlessOrderResult,
  isLimitlessTerminalRejectedStatus,
} from "./limitless-order-result.js";
import { resolveLimitlessClobEvidenceIdentity } from "./limitless-clob-evidence-identity.js";
import { buildHip4SocialInstrument } from "./hip4-social-instrument.js";
import {
  interpretHip4SocialPurchase,
  isHip4OriginalBuyFill,
} from "./hip4-social-evidence.js";
import { prepareHip4TradeSigning } from "./hip4-trade-signing.js";
import { interpretHip4ExactOrderStatus } from "./hip4-order-evidence.js";
import { projectHip4Execution } from "./hip4-account-projection.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import { Hip4ReadError } from "./hip4-client.js";
import {
  hip4LegacyExecutionConflictTime,
  readHip4ProviderEvidenceStatus,
} from "./hip4-account-repository.js";
type Db = Pick<Pool, "query">;
export type VerifiedBuyObserverDependencies = {
  maxEvidenceItems: number;
  assertEvidenceBudget?: (minimumReads: number) => void;
  limitlessPositionContract: string;
  limitlessExchangeAddress: string;
  solanaCollateralMint: string;
  readEvmReceipt: (
    chainId: number,
    hash: string,
  ) => Promise<{ receipt: unknown; timestamp: string } | null>;
  readFinalizedSolanaTransaction: (signature: string) => Promise<unknown>;
  readLimitlessOrder: (input: {
    providerOrderId: string | null;
    clientOrderId: string | null;
  }) => Promise<unknown>;
  readDflowOrder: (signature: string) => Promise<unknown>;
  readHip4OrderStatus?: (input: {
    environment: "mainnet";
    accountAddress: string;
    cloid: string;
  }) => Promise<unknown>;
  recheckHip4OrderFills?: (input: {
    environment: "mainnet";
    accountAddress: string;
    coin: string;
    orderId: string;
    timeMs: number;
  }) => Promise<void>;
  readPolymarketFills: (input: {
    userId: string;
    owner: string;
    signer: string;
    orderHash: string;
    tokenId: string;
  }) => Promise<
    Array<{ provider_tx_hash: string | null; provider_status: string | null }>
  >;
};

const pending = (reason: string): PurchaseObservation => ({
  state: "pending",
  reason,
});
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function root(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function failedReceipt(receipt: unknown, txHash: string): boolean {
  const record = root(receipt);
  return (
    String(record.hash ?? record.transactionHash).toLowerCase() ===
      txHash.toLowerCase() &&
    (record.status === 0 || record.status === "0x0")
  );
}
export function terminalZeroFill(input: {
  status: string | null;
  filledQuantity: string | null;
  evidenceCount: number;
}): boolean {
  return (
    ["CANCELLED", "CANCELED", "EXPIRED", "UNMATCHED", "NO_FILL"].includes(
      input.status?.toUpperCase() ?? "",
    ) &&
    /^0+(?:\.0+)?$/.test(input.filledQuantity ?? "") &&
    input.evidenceCount === 0
  );
}

export type VerifiedBuySourceRow = {
  id: string;
  user_id: string;
  venue: string;
  wallet_address: string | null;
  order_hash: string | null;
  venue_order_id: string | null;
  token_id: string | null;
  side: string | null;
  order_payload: unknown;
  client_order_id: string | null;
  tx_signature: string | null;
  market_id: string | null;
  outcome: string | null;
  expiration_time: Date | null;
  market_metadata: unknown;
  input_mint: string | null;
  output_mint: string | null;
  signer_address?: string | null;
};

/** Exact admitted original action, never a recorder's opaque order_payload.
 * The original-action partial unique index makes this an at-most-one-row read.
 * Ownership is joined afresh so a merged/deleted account cannot reuse a stale
 * worker's financial identity. Prepared-only and legacy orders have no proof. */
export const HIP4_VERIFIED_BUY_SOURCE_SQL = `select
  action_row.environment,action_row.signer_address,action_row.canonical_market_id,
  action_row.token_id,action_row.cloid,action_row.action_fingerprint,
  action_row.unsigned_envelope,action_row.preparation_snapshot,
  submission_row.signer_address as submission_signer_address,
  snapshot_row.history as account_history
  from orders purchase_row
  join hip4_order_actions action_row on action_row.order_id=purchase_row.id and action_row.action_kind='order'
  join hip4_order_submissions submission_row on submission_row.action_id=action_row.id
  left join hip4_account_snapshots snapshot_row on snapshot_row.environment=action_row.environment
    and snapshot_row.account_address=action_row.signer_address
  where purchase_row.id=$1 and purchase_row.user_id=$2 and purchase_row.venue='hyperliquid'`;

/** The existing exact-order index bounds work before the row limit. No wallet
 * history scan, transaction-hash proximity, or inferred dual-order alias. */
export const HIP4_VERIFIED_BUY_FILLS_SQL = `select execution,provider_fill,
  time_ms::text as time_ms,tid::text as tid,provider_evidence_status
  from hip4_account_executions where environment=$1 and account_address=$2
    and coin=$3 and oid=$4::bigint
  order by hip4_account_executions.time_ms,hip4_account_executions.tid limit $5`;

type Hip4EvidenceRow = {
  execution: unknown;
  provider_fill: unknown;
  time_ms: string;
  tid: string;
  provider_evidence_status: unknown;
};

function hip4EvidenceRowsGuard(entries: Hip4EvidenceRow[]) {
  const rows: NativePurchaseEvidenceGuard["rows"] = [];
  for (const entry of entries) {
    const status = readHip4ProviderEvidenceStatus(
      entry.provider_evidence_status,
    );
    if (
      status === undefined ||
      !/^(0|[1-9]\d*)$/u.test(entry.time_ms) ||
      !/^(0|[1-9]\d*)$/u.test(entry.tid)
    )
      return null;
    rows.push({
      timeMs: entry.time_ms,
      tradeId: entry.tid,
      revision: status?.revision ?? null,
    });
  }
  return rows;
}

/** No provider IO under these locks. P2 serializes all exact execution writes
 * on this account row FOR UPDATE. The separate post-wait statement is vital:
 * a SELECT begun before a waiting lock could otherwise retain an old snapshot.
 * Comparing the full bounded OID set also rejects newly inserted phantom fills. */
export function createHip4NativeEvidenceFinalizer(
  pool: Pool,
): NativePurchaseEvidenceFinalizer {
  return async (guard, store) =>
    tx(pool, async (db) => {
      await db.query("set transaction isolation level read committed");
      const locked = await db.query(
        `select account_address from hip4_account_snapshots
      where environment=$1 and account_address=$2 for share`,
        [guard.environment, guard.accountAddress],
      );
      if (locked.rows.length !== 1) return { stored: false as const };
      const history = await db.query(
        `select history from hip4_account_snapshots
        where environment=$1 and account_address=$2`,
        [guard.environment, guard.accountAddress],
      );
      if (
        hip4LegacyExecutionConflictTime(
          history.rows[0]?.history,
          guard.coin,
        ) !== guard.legacyConflictTime
      )
        return { stored: false as const };
      const current = await db.query<Hip4EvidenceRow>(
        HIP4_VERIFIED_BUY_FILLS_SQL,
        [
          guard.environment,
          guard.accountAddress,
          guard.coin,
          guard.orderId,
          guard.rows.length + 1,
        ],
      );
      const rows = hip4EvidenceRowsGuard(current.rows);
      if (!rows || canonicalJsonHash(rows) !== canonicalJsonHash(guard.rows))
        return { stored: false as const };
      return { stored: true as const, result: await store(db) };
    });
}

type Hip4VerifiedBuySource = {
  environment: string;
  signer_address: string;
  canonical_market_id: string;
  token_id: string;
  cloid: string;
  action_fingerprint: string;
  unsigned_envelope: unknown;
  preparation_snapshot: unknown;
  submission_signer_address: string;
  account_history: unknown;
};

const nativeUnavailable = (reason: string): PurchaseObservation =>
  pending(`observation_unavailable:hip4_${reason.replace(/^hip4_/u, "")}`);

type Hip4NativeEvidenceRead =
  | {
      kind: "evidence";
      entries: Hip4EvidenceRow[];
      guard: NativePurchaseEvidenceGuard;
    }
  | { kind: "observation"; observation: PurchaseObservation };

async function readHip4NativeSocialEvidence(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
  scope: {
    accountAddress: string;
    coin: string;
    orderId: string;
    legacyConflictTime: number | null;
    cloid: string;
  },
): Promise<Hip4NativeEvidenceRead> {
  const load = async () =>
    (
      await db.query<Hip4EvidenceRow>(HIP4_VERIFIED_BUY_FILLS_SQL, [
        "mainnet",
        scope.accountAddress,
        scope.coin,
        scope.orderId,
        deps.maxEvidenceItems + 1,
      ])
    ).rows;
  let entries = await load();
  const checkBudget = () => {
    if (entries.length > deps.maxEvidenceItems)
      throw new EvidenceBudgetExhausted(entries.length, deps.maxEvidenceItems);
  };
  checkBudget();
  const guard = (): NativePurchaseEvidenceGuard | null => {
    const rows = hip4EvidenceRowsGuard(entries);
    return rows
      ? {
          kind: "hip4",
          environment: "mainnet",
          accountAddress: scope.accountAddress,
          coin: scope.coin,
          orderId: scope.orderId,
          legacyConflictTime: scope.legacyConflictTime,
          rows,
        }
      : null;
  };
  const originalEntries = () =>
    entries.filter((entry) =>
      isHip4OriginalBuyFill(entry.provider_fill, scope),
    );
  const provenanceProblem = (entry: Hip4EvidenceRow): string | null => {
    try {
      const projected = projectHip4Execution(
        "mainnet",
        scope.accountAddress,
        entry.provider_fill,
      );
      const retainedStatus = readHip4ProviderEvidenceStatus(
        entry.provider_evidence_status,
      );
      return canonicalJsonHash(entry.execution) !==
        canonicalJsonHash(projected) ||
        projected.coin !== scope.coin ||
        projected.orderId !== scope.orderId ||
        String(projected.time) !== entry.time_ms ||
        projected.tradeId !== entry.tid ||
        (retainedStatus != null &&
          retainedStatus.retainedFingerprint !==
            canonicalJsonHash(entry.execution))
        ? "execution_provenance_conflict"
        : null;
    } catch {
      return "execution_provenance_unavailable";
    }
  };
  const preciseConflict = (): Hip4NativeEvidenceRead | null => {
    const nativeEvidenceGuard = guard();
    return nativeEvidenceGuard &&
      originalEntries().some(
        (entry) =>
          readHip4ProviderEvidenceStatus(entry.provider_evidence_status)
            ?.state === "conflicted" && provenanceProblem(entry) === null,
      )
      ? {
          kind: "observation",
          observation: {
            state: "revoked",
            reason: "hip4_execution_evidence_conflict",
            nativeEvidenceGuard,
          },
        }
      : null;
  };
  const knownConflict = preciseConflict();
  if (knownConflict) return knownConflict;
  const ambiguous = () =>
    originalEntries().filter(
      (entry) =>
        readHip4ProviderEvidenceStatus(entry.provider_evidence_status) ===
          null &&
        scope.legacyConflictTime !== null &&
        Number(entry.time_ms) <= scope.legacyConflictTime,
    );
  const quarantine = (): Hip4NativeEvidenceRead => {
    const nativeEvidenceGuard = guard();
    return {
      kind: "observation",
      observation: nativeEvidenceGuard
        ? {
            state: "pending",
            reason: "hip4_legacy_execution_conflict_unscoped",
            nativeEvidenceGuard,
          }
        : nativeUnavailable("execution_evidence_status_unavailable"),
    };
  };
  const legacy = ambiguous();
  if (legacy.length) {
    if (deps.recheckHip4OrderFills) {
      deps.assertEvidenceBudget?.(1);
      try {
        await deps.recheckHip4OrderFills({
          environment: "mainnet",
          accountAddress: scope.accountAddress,
          coin: scope.coin,
          orderId: scope.orderId,
          timeMs: Number(legacy[0].time_ms),
        });
      } catch (error) {
        if (error instanceof EvidenceBudgetExhausted) throw error;
        if (
          error instanceof Hip4ReadError &&
          error.reason === "budget_exhausted"
        )
          throw new EvidenceBudgetExhausted(1, 0);
        return quarantine();
      }
      entries = await load();
      checkBudget();
      const refreshedConflict = preciseConflict();
      if (refreshedConflict) return refreshedConflict;
    }
    if (ambiguous().length) return quarantine();
  }
  const nativeGuard = guard();
  for (const entry of originalEntries()) {
    const problem = provenanceProblem(entry);
    if (problem)
      return { kind: "observation", observation: nativeUnavailable(problem) };
  }
  return nativeGuard
    ? { kind: "evidence", entries, guard: nativeGuard }
    : {
        kind: "observation",
        observation: nativeUnavailable("execution_evidence_status_unavailable"),
      };
}

async function observeHip4VerifiedBuy(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
  row: VerifiedBuySourceRow,
): Promise<PurchaseObservation> {
  const saved = (
    await db.query<Hip4VerifiedBuySource>(HIP4_VERIFIED_BUY_SOURCE_SQL, [
      row.id,
      row.user_id,
    ])
  ).rows[0];
  if (!saved) return nativeUnavailable("admitted_original_order_missing");
  const account = hip4AccountAddressSchema.safeParse(row.wallet_address);
  if (
    !account.success ||
    saved.environment !== "mainnet" ||
    saved.signer_address !== account.data ||
    saved.submission_signer_address !== account.data ||
    saved.token_id !== row.token_id
  )
    return nativeUnavailable("original_owner_binding_unavailable");
  const snapshot = root(saved.preparation_snapshot);
  const frozenInstrument = verifiedBuyFactsSchema.shape.instrument.safeParse(
    snapshot.socialInstrument,
  );
  if (
    !frozenInstrument.success ||
    frozenInstrument.data.venue !== "hyperliquid"
  )
    return nativeUnavailable("frozen_instrument_missing");
  const instrument = buildHip4SocialInstrument({
    marketId: saved.canonical_market_id,
    tokenId: saved.token_id,
    outcome: frozenInstrument.data.outcome,
    expiry: frozenInstrument.data.expiry,
    snapshot: snapshot.socialInstrumentSnapshot,
  });
  if (
    !instrument ||
    canonicalJsonHash(instrument) !== canonicalJsonHash(frozenInstrument.data)
  )
    return nativeUnavailable("frozen_instrument_provenance_unavailable");
  let prepared: ReturnType<typeof prepareHip4TradeSigning>;
  try {
    prepared = prepareHip4TradeSigning(
      saved.unsigned_envelope as Parameters<typeof prepareHip4TradeSigning>[0],
    );
  } catch {
    return nativeUnavailable("original_action_invalid");
  }
  const envelope = {
    environment: prepared.environment,
    action: prepared.action,
    nonce: prepared.nonce,
    expiresAfter: prepared.expiresAfter,
    vaultAddress: prepared.vaultAddress,
  };
  if (
    prepared.environment !== "mainnet" ||
    prepared.vaultAddress !== null ||
    prepared.action.type !== "order" ||
    prepared.action.orders.length !== 1 ||
    !prepared.action.orders[0].b ||
    prepared.action.orders[0].c !== saved.cloid ||
    canonicalJsonHash(envelope) !== saved.action_fingerprint
  )
    return nativeUnavailable("original_action_provenance_unavailable");
  const frozenCoin = `#${prepared.action.orders[0].a - 100_000_000}`;
  const legacyConflictTime = hip4LegacyExecutionConflictTime(
    saved.account_history,
    frozenCoin,
  );
  let nativeEvidence: Extract<
    Hip4NativeEvidenceRead,
    { kind: "evidence" }
  > | null = null;
  // Known original evidence/contradictions take precedence over status absence.
  // Reuse this bounded read; never source-recheck twice.
  if (row.venue_order_id && /^(0|[1-9]\d*)$/u.test(row.venue_order_id)) {
    const read = await readHip4NativeSocialEvidence(db, deps, {
      accountAddress: account.data,
      coin: frozenCoin,
      orderId: row.venue_order_id,
      legacyConflictTime,
      cloid: saved.cloid,
    });
    if (read.kind === "observation") return read.observation;
    nativeEvidence = read;
  }
  if (!deps.readHip4OrderStatus)
    return nativeUnavailable("status_reader_unavailable");
  deps.assertEvidenceBudget?.(1);
  let body: unknown;
  try {
    body = await deps.readHip4OrderStatus({
      environment: "mainnet",
      accountAddress: account.data,
      cloid: saved.cloid,
    });
  } catch (error) {
    if (error instanceof EvidenceBudgetExhausted) throw error;
    if (error instanceof Hip4ReadError && error.reason === "budget_exhausted")
      throw new EvidenceBudgetExhausted(1, 0);
    return nativeUnavailable("status_read_unavailable");
  }
  const observedAt = Date.now();
  const scope = {
    accountAddress: account.data,
    envelope,
    knownPrimaryOrderId: row.venue_order_id,
    orderStatus: body,
    instrument: instrument as typeof frozenInstrument.data & {
      venue: "hyperliquid";
    },
    quoteAsset: HYPERCORE_MAINNET_USDC,
    observedAt,
    maxEvidenceItems: deps.maxEvidenceItems,
  };
  const status = interpretHip4ExactOrderStatus({
    envelope,
    body,
    knownOrderId: row.venue_order_id,
  });
  let statusContradiction: string | null = null;
  if (status.kind === "pending") {
    const result = interpretHip4SocialPurchase({ ...scope, fills: [] });
    if (result.kind !== "invalid")
      return nativeUnavailable(
        result.kind === "pending" ? result.reason : "status_unavailable",
      );
    if (!row.venue_order_id || !/^(0|[1-9]\d*)$/u.test(row.venue_order_id))
      return nativeUnavailable("contradiction_scope_unavailable");
    statusContradiction = result.reason;
  }
  const coin = status.kind === "pending" ? frozenCoin : status.coin;
  const orderId =
    status.kind === "pending" ? row.venue_order_id : status.orderId;
  if (orderId === null)
    return nativeUnavailable("contradiction_scope_unavailable");
  if (
    !nativeEvidence ||
    nativeEvidence.guard.coin !== coin ||
    nativeEvidence.guard.orderId !== orderId
  ) {
    const read = await readHip4NativeSocialEvidence(db, deps, {
      accountAddress: account.data,
      coin,
      orderId,
      legacyConflictTime,
      cloid: saved.cloid,
    });
    if (read.kind === "observation") return read.observation;
    nativeEvidence = read;
  }
  const { entries, guard: nativeEvidenceGuard } = nativeEvidence;
  if (statusContradiction)
    return {
      state: "revoked",
      reason: statusContradiction,
      nativeEvidenceGuard,
    };
  const result = interpretHip4SocialPurchase({
    ...scope,
    fills: entries.map((entry) => entry.provider_fill),
  });
  if (result.kind === "invalid")
    return { state: "revoked", reason: result.reason, nativeEvidenceGuard };
  if (result.kind !== "observed") return nativeUnavailable(result.reason);
  return {
    state: "verified",
    facts: factsFromEvidence(result.evidence),
    nativeEvidenceGuard,
  };
}

/** Only read paths are injected. This module has no API env/auth/executor imports. */
export function createVerifiedBuyObserver(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
) {
  return async (claim: ClaimedPurchase): Promise<PurchaseObservation> => {
    const source =
      claim.purchaseRef.kind === "order"
        ? await db.query<VerifiedBuySourceRow>(
            `select purchase_row.id, purchase_row.user_id, purchase_row.venue,
          purchase_row.wallet_address, purchase_row.signer_address,purchase_row.order_hash, purchase_row.venue_order_id,
          purchase_row.token_id, purchase_row.side, purchase_row.order_payload,
          coalesce(purchase_row.order_payload->>'clientOrderId',purchase_row.order_payload->'submitted'->>'clientOrderId',
            purchase_row.order_payload->'_hunchSubmitted'->>'clientOrderId') as client_order_id,
          null::text as tx_signature, token_row.market_id, token_row.side as outcome,
          market_row.expiration_time, market_row.metadata as market_metadata,
          null::text as input_mint, null::text as output_mint
        from orders purchase_row left join unified_tokens token_row on token_row.token_id = purchase_row.token_id
        left join unified_markets market_row on market_row.id = token_row.market_id
        where purchase_row.id = $1 and purchase_row.user_id = $2`,
            [claim.purchaseRef.id, claim.userId],
          )
        : await db.query<VerifiedBuySourceRow>(
            `select purchase_row.id, purchase_row.user_id, purchase_row.venue,
          purchase_row.wallet_address, null::text as order_hash, purchase_row.venue_order_id,
          token_row.token_id, purchase_row.side, null::jsonb as order_payload, null::text as client_order_id,
          purchase_row.tx_signature, purchase_row.unified_market_id as market_id, token_row.side as outcome,
          market_row.expiration_time, market_row.metadata as market_metadata,
          purchase_row.input_mint, purchase_row.output_mint
        from executions purchase_row
        left join unified_tokens token_row on token_row.token_id = 'sol:' || purchase_row.output_mint
          and token_row.market_id = purchase_row.unified_market_id
        left join unified_markets market_row on market_row.id = purchase_row.unified_market_id
        where purchase_row.id = $1 and purchase_row.user_id = $2`,
            [claim.purchaseRef.id, claim.userId],
          );
    return observeVerifiedBuySource(db, deps, source.rows[0]);
  };
}

export async function observeVerifiedBuySource(
  db: Db,
  deps: VerifiedBuyObserverDependencies,
  row: VerifiedBuySourceRow | undefined,
): Promise<PurchaseObservation> {
  if (!row || row.side?.toUpperCase() !== "BUY" || !row.wallet_address)
    return pending("purchase_identity_missing");
  if (row.venue === "hyperliquid") return observeHip4VerifiedBuy(db, deps, row);
  const payload = root(row.order_payload);
  let context = parsePolymarketAssetContext(payload.assetContext);
  if (!context && row.venue === "polymarket" && row.token_id) {
    // Append-only historical binding, not today's replaceable token mapping.
    // Ambiguous ledger identities remain pending rather than guessing a generation.
    const bindings = await db.query<{ context: unknown }>(
      `select jsonb_build_object(
        'contextVersion',1,'chainId',chain_id,'positionContract',position_contract,'assetId',asset_id,'marketId',market_id,
        'protocolVersion',protocol_version,'assetKind',asset_kind,'conditionId',condition_id,
        'outcomeIndex',outcome_index,'negRisk',neg_risk,'exchangeAddress',exchange_address,
        'orderDomainVersion',order_domain_version,'conditionalAssetType',conditional_asset_type) as context
        from polymarket_asset_bindings where asset_id=$1 order by chain_id,position_contract limit 2`,
      [row.token_id],
    );
    if (bindings.rows.length === 1)
      context = parsePolymarketAssetContext(bindings.rows[0]?.context);
  }
  const marketId = context?.marketId ?? row.market_id;
  const tokenId = context?.assetId ?? row.token_id;
  const outcome = context
    ? context.outcomeIndex === 0
      ? "YES"
      : "NO"
    : row.outcome;
  if (
    !marketId ||
    !tokenId ||
    (outcome !== "YES" && outcome !== "NO") ||
    !["polymarket", "limitless", "kalshi"].includes(row.venue)
  )
    return pending("instrument_binding_missing");
  const instrument: VerifiedBuyFacts["instrument"] = {
    venue: row.venue as VerifiedBuyFacts["instrument"]["venue"],
    marketId,
    tokenId,
    outcome,
    generation: context
      ? `${context.chainId}:${context.positionContract.toLowerCase()}:${context.protocolVersion}`
      : row.venue === "kalshi"
        ? `solana:mainnet:${tokenId}`
        : `8453:${deps.limitlessPositionContract.toLowerCase()}:${tokenId}`,
    expiry: row.expiration_time?.toISOString() ?? null,
  };
  if (row.venue === "polymarket") {
    if (!context || !row.order_hash)
      return pending("frozen_order_binding_missing");
    const fills = await db.query<{
      provider_tx_hash: string | null;
      provider_status: string | null;
    }>(
      `
        select distinct provider_tx_hash, provider_status from order_fills where order_id = $1
        order by provider_tx_hash limit $2`,
      [row.id, deps.maxEvidenceItems + 1],
    );
    if (
      !fills.rows.length ||
      fills.rows.some(
        (fill) =>
          !fill.provider_tx_hash ||
          fill.provider_status?.toUpperCase() !== "CONFIRMED",
      )
    ) {
      fills.rows = await deps.readPolymarketFills({
        userId: row.user_id,
        owner: row.wallet_address,
        signer: row.signer_address ?? row.wallet_address,
        orderHash: row.order_hash,
        tokenId,
      });
    }
    if (fills.rows.length > deps.maxEvidenceItems)
      throw new EvidenceBudgetExhausted(
        fills.rows.length,
        deps.maxEvidenceItems,
      );
    if (fills.rows.length === 1 && fills.rows[0]?.provider_status === "NO_FILL")
      return { state: "revoked", reason: "provider_terminal_zero_fill" };
    // A failed settlement attempt is not evidence against another actual fill
    // of the same order. Only surviving candidates contribute purchase proof.
    const candidates = fills.rows.filter(
      (fill) => fill.provider_status?.toUpperCase() !== "FAILED",
    );
    if (fills.rows.length && !candidates.length)
      return { state: "revoked", reason: "provider_fill_failed" };
    if (!candidates.length || candidates.some((fill) => !fill.provider_tx_hash))
      return pending("fill_transaction_identity_missing");
    if (
      candidates.some(
        (fill) => fill.provider_status?.toUpperCase() !== "CONFIRMED",
      )
    )
      return pending("provider_settlement_pending");
    const parts: VerifiedPurchaseEvidence[] = [];
    const hashes = new Set(
      candidates.flatMap((fill) =>
        fill.provider_tx_hash ? [fill.provider_tx_hash] : [],
      ),
    );
    deps.assertEvidenceBudget?.(hashes.size * 3);
    for (const hash of hashes) {
      const observed = await deps.readEvmReceipt(context.chainId, hash);
      if (!observed) return pending("receipt_pending");
      if (failedReceipt(observed.receipt, hash)) continue;
      const evidence = parseEvmClobBuyEvidence({
        receipt: observed.receipt,
        txHash: hash,
        owner: row.wallet_address,
        orderHash: row.order_hash,
        exchangeAddress: context.exchangeAddress,
        positionContract: context.positionContract,
        tokenId,
        chainId: context.chainId,
        instrument,
        purchasedAt: observed.timestamp,
      });
      if (!evidence) return pending("receipt_exact_fill_unavailable");
      parts.push(evidence);
    }
    if (!parts.length)
      return { state: "revoked", reason: "finalized_receipt_failed" };
    const facts = combinePurchaseEvidence(parts);
    return facts
      ? { state: "verified", facts }
      : pending("evidence_identity_conflict");
  }
  if (row.venue === "limitless") {
    const ammMatch = row.venue_order_id?.match(/^amm:(0x[0-9a-f]{64}):/i);
    if (ammMatch?.[1]) {
      const marketAddress =
        text(root(row.market_metadata).marketAddress) ??
        text(payload.marketAddress);
      if (!marketAddress) return pending("amm_contract_missing");
      const observed = await deps.readEvmReceipt(8453, ammMatch[1]);
      if (!observed) return pending("receipt_pending");
      if (failedReceipt(observed.receipt, ammMatch[1]))
        return { state: "revoked", reason: "finalized_receipt_failed" };
      const evidence = parseEvmAmmBuyEvidence({
        receipt: observed.receipt,
        txHash: ammMatch[1],
        owner: row.wallet_address,
        marketAddress,
        positionContract: deps.limitlessPositionContract,
        tokenId: tokenId.replace(/^limitless:/, ""),
        outcomeIndex: outcome === "YES" ? 0 : 1,
        chainId: 8453,
        instrument,
        purchasedAt: observed.timestamp,
      });
      const facts = evidence && combinePurchaseEvidence([evidence]);
      return facts
        ? { state: "verified", facts }
        : pending("amm_exact_fill_unavailable");
    }
    const status = root(
      await deps.readLimitlessOrder({
        providerOrderId: row.venue_order_id,
        clientOrderId: row.client_order_id,
      }),
    );
    if (
      status.status !== "found" ||
      (row.client_order_id && status.clientOrderId !== row.client_order_id)
    )
      return pending("provider_order_pending");
    const providerOrderId = text(status.orderId);
    if (
      !providerOrderId ||
      (row.venue_order_id &&
        !row.venue_order_id.startsWith("client:") &&
        providerOrderId !== row.venue_order_id)
    )
      return pending("provider_order_identity_conflict");
    const data = root(status.data),
      wrapper = root(data.order),
      order = root(wrapper.order ?? data.order);
    const execution = root(wrapper.execution ?? data.execution);
    const parsedOrder = parseLimitlessOrderResult(status);
    const totals = root(execution.totalsRaw);
    const matches =
      wrapper.makerMatches ?? data.makerMatches ?? order.makerMatches;
    if (
      parsedOrder.explicitNoFill ||
      (isLimitlessTerminalRejectedStatus(parsedOrder.status) &&
        parsedOrder.matched === false &&
        terminalZeroFill({
          status: parsedOrder.status,
          filledQuantity: text(totals.contractsGross),
          evidenceCount: Array.isArray(matches) ? matches.length : -1,
        }) &&
        /^0+$/.test(text(totals.usdGross) ?? "") &&
        !text(execution.txHash))
    )
      return { state: "revoked", reason: "provider_terminal_zero_fill" };
    if (
      ["FAILED", "REVERTED"].includes(
        String(execution.settlementStatus).toUpperCase(),
      )
    )
      return { state: "revoked", reason: "provider_settlement_failed" };
    const hash = text(execution.txHash);
    const identity = resolveLimitlessClobEvidenceIdentity({
      orderPayload: payload,
      marketMetadata: row.market_metadata,
      legacyExchangeAddress: deps.limitlessExchangeAddress,
      providerOrder: order,
    });
    if (!identity) return pending("signed_order_identity_missing");
    if (
      !hash ||
      !["MINED", "CONFIRMED"].includes(
        String(execution.settlementStatus).toUpperCase(),
      )
    )
      return pending("provider_settlement_pending");
    const observed = await deps.readEvmReceipt(8453, hash);
    if (!observed) return pending("receipt_pending");
    if (failedReceipt(observed.receipt, hash))
      return { state: "revoked", reason: "finalized_receipt_failed" };
    const evidence = parseEvmClobBuyEvidence({
      receipt: observed.receipt,
      txHash: hash,
      owner: row.wallet_address,
      orderHash: identity.orderHash,
      providerOrderId,
      exchangeAddress: identity.exchangeAddress,
      positionContract: deps.limitlessPositionContract,
      tokenId: tokenId.replace(/^limitless:/, ""),
      chainId: 8453,
      instrument,
      purchasedAt: observed.timestamp,
    });
    const facts = evidence && combinePurchaseEvidence([evidence]);
    return facts
      ? { state: "verified", facts }
      : pending("receipt_exact_fill_unavailable");
  }
  // Deprecated venue: no speculative provider field names become verified money.
  return pending("dflow_evidence_unsupported");
}
