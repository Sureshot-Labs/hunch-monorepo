import type { PoolClient } from "@hunch/infra";
import { Interface } from "ethers";
import { z } from "zod";
import { isRecord } from "../../lib/type-guards.js";
import {
  RELAY_DEPOSITORY_V2,
  validateRelayDepositoryV2Action,
} from "../../funding-providers/relay/rehearsal.js";
import { RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS } from "../../funding-providers/relay/mappings.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import {
  assetLocationSchema,
  moneySchema,
  normalizedActionSchema,
} from "../domain/schemas.js";
import { readFundingRefundContract } from "../domain/refund-settlement.js";
import {
  readCommittedFundingIdentity,
  refundSnapshotAccountIds,
} from "../domain/committed-economic-identity.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { parseEmbeddedFundingSubmission } from "../execution/embedded-funding-submission-contract.js";
import type { RefundSourceCandidateRow } from "./relay-refund-source-candidates.js";
import { fundingSyntheticUnissuedAttemptSql } from "../persistence/funding-unissued-attempt-sql.js";
import { fundingActionPageCtes } from "../persistence/funding-action-page-sql.js";

export type RefundSourceActionRow = Readonly<{
  operation_id: string;
  segment_id: string;
  step_id: string | null;
  step_ordinal: number;
  step_kind: string | null;
  executor_id: string | null;
  action_fingerprint: string | null;
  normalized_action: unknown;
  action_validation_result: unknown;
  attempt_id: string | null;
  attempt_number: number;
  attempt_fingerprint: string | null;
  attempt_executor_id: string | null;
  attempt_outcome: string | null;
  broadcast_may_have_occurred: boolean | null;
  synthetic_cancellation: boolean;
  unreferenced_attempt: boolean;
  attempt_costs: unknown;
  receipt_status: string | null;
  receipt_canonical: boolean | null;
  receipt_action_match: boolean | null;
  receipt_evidence: unknown;
  receipt_network_id: string | null;
  receipt_ledger_height: string | null;
  receipt_block_hash: string | null;
  source_debit: unknown;
}>;

/** Read ONLY an enumerated envelope candidate. No terminal/status/expiry filter
 * can discard a current attempt or reorg. All attempts, not just latest, count.
 * This one statement gives action+receipt facts one PostgreSQL snapshot. It is
 * not a snapshot of the separate ownership/source/settlement facts. A resumed
 * page uses the shared single-row indexed traversal: even dense steps with
 * dense attempt history consume at most one work item per hop. Other route
 * legs consume cursor work before being filtered by the reader; filtering them
 * before paging would scan an unbounded sparse prefix without a leg index.
 * Receipt hydration only
 * sees the bounded fact_page. Origin provenance uses a scalar PK subquery:
 * older PG16 builds can Memoize a joined UUID expression over JSONB. Keeping
 * that expression out of a cached join also bounds each provenance probe to
 * one row without changing financial checks or global planner settings. */
export const REFUND_SOURCE_ACTION_FACTS_SQL = `
${fundingActionPageCtes("refund_segment")}
select action_row.operation_id,action_row.segment_id,
  action_row.id as step_id,action_row.step_kind,action_row.executor_id,
  action_row.ordinal as step_ordinal,
  action_row.action_fingerprint,action_row.normalized_action,action_row.action_validation_result,
  fact_page.attempt_id,coalesce(fact_page.attempt_number,0) as attempt_number,
  attempt_row.canonical_action_fingerprint as attempt_fingerprint,
  attempt_row.executor_id as attempt_executor_id,attempt_row.outcome as attempt_outcome,
  attempt_row.broadcast_may_have_occurred,
  coalesce(${fundingSyntheticUnissuedAttemptSql("attempt_row")},false) as synthetic_cancellation,
  attempt_row.actual_costs as attempt_costs,
  (attempt_row.id is not null and attempt_row.reference_kind is null
    and attempt_row.receipt_ref_ciphertext is null and attempt_row.receipt_ref_lookup_hmac is null
    and attempt_row.lookup_key_version is null) as unreferenced_attempt,
  receipt_row.status as receipt_status,receipt_row.canonical as receipt_canonical,
  receipt_row.action_match as receipt_action_match,receipt_row.evidence as receipt_evidence,
  receipt_row.network_id as receipt_network_id,
  receipt_row.ledger_height::text as receipt_ledger_height,receipt_row.block_hash as receipt_block_hash,
  case when debit_row.id is not null then jsonb_build_object(
    'id',debit_row.id,'operationId',debit_row.operation_id,'segmentId',debit_row.segment_id,
    'kind',debit_row.kind,'networkId',debit_row.network_id,'assetId',debit_row.asset_id,
    'decimals',debit_row.asset_decimals,'raw',debit_row.raw_amount::text,
    'txHash',debit_row.tx_hash,'eventIndex',debit_row.event_index,
    'fromAddress',debit_row.from_address,'toAddress',debit_row.to_address,
    'ledgerHeight',debit_row.ledger_height::text,'blockHash',debit_row.block_hash,
    'canonical',debit_row.canonical,'finality',debit_row.finality_status,
    'observerId',debit_row.metadata->>'observerId') || coalesce((
      select jsonb_build_object('originStepId',origin_attempt.step_id,
        'originFingerprint',origin_attempt.canonical_action_fingerprint,
        'originExecutor',origin_attempt.executor_id)
      from funding_operation_step_attempts origin_attempt
      where origin_attempt.id=case
        when debit_row.metadata->>'receiptAttemptId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (debit_row.metadata->>'receiptAttemptId')::uuid else null end
    ), '{"originStepId":null,"originFingerprint":null,"originExecutor":null}'::jsonb)
  else null end as source_debit
from fact_page
join funding_operation_steps action_row on action_row.id=fact_page.step_id
left join funding_operation_step_attempts attempt_row on attempt_row.id=fact_page.attempt_id
  and action_row.segment_id=$2::uuid
left join lateral (
  select * from funding_step_receipt_observations where attempt_id=attempt_row.id limit 1
) receipt_row on true
left join lateral (
  select * from funding_observations
  where network_id=action_row.normalized_action->>'networkId'
    and tx_hash=lower(receipt_row.evidence->>'transactionHash')
    and event_index=receipt_row.evidence->>'sourceDebitEventIndex'
  limit 1
) debit_row on true
order by action_row.ordinal,coalesce(fact_page.attempt_number,0)`;

export type RefundSourceActionCursor = Readonly<{
  stepOrdinal: number;
  attemptNumber: number;
}>;

export function assertRefundSourceActionPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2147483645)
    throw new Error("Refund action facts require a bounded page");
}

export async function loadRefundSourceActionFacts(
  db: Pick<PoolClient, "query">,
  input: {
    candidate: Pick<RefundSourceCandidateRow, "operation_id" | "segment_id">;
    cursor: RefundSourceActionCursor | null;
    limit: number;
  },
): Promise<{
  rows: readonly RefundSourceActionRow[];
  nextCursor: RefundSourceActionCursor | null;
}> {
  assertRefundSourceActionPageLimit(input.limit);
  if (!input.candidate.segment_id)
    throw new Error("Refund source candidate has no route leg");
  if (
    input.cursor &&
    (!Number.isSafeInteger(input.cursor.stepOrdinal) ||
      input.cursor.stepOrdinal < 0 ||
      !Number.isSafeInteger(input.cursor.attemptNumber) ||
      input.cursor.attemptNumber < 0)
  )
    throw new Error("Invalid refund action cursor");
  const rows = (
    await db.query<RefundSourceActionRow>(REFUND_SOURCE_ACTION_FACTS_SQL, [
      input.candidate.operation_id,
      input.candidate.segment_id,
      input.limit + 1,
      input.cursor?.stepOrdinal ?? -1,
      input.cursor?.attemptNumber ?? 0,
    ])
  ).rows;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    rows: page.filter((row) => row.segment_id === input.candidate.segment_id),
    nextCursor:
      rows.length > input.limit && last
        ? { stepOrdinal: last.step_ordinal, attemptNumber: last.attempt_number }
        : null,
  };
}

export type RefundSourceActionExposure =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "incomplete" }>
  | Readonly<{ kind: "possible"; stepIds: readonly string[] }>
  | Readonly<{ kind: "no_live_attempt" }>;

const approvalInterface = new Interface([
  "function approve(address spender,uint256 amount)",
]);

/** Constant-size partial result, not a verdict or allocation authority. A
 * continuation must bind this to the operation facts revision AND candidate
 * identity. Never reuse it after that revision changes. There can be only one
 * deposit step for this route leg, regardless of its number of attempts. */
export type RefundSourceActionFold = Readonly<{
  invalid: boolean;
  depositStepId: string | null;
  possible: boolean;
  /** One physical debit, regardless of repeated receipt reports. A second
   * debit or any unaccounted issued attempt prevents settlement clearance. */
  debit: RefundSourceDebitIdentity | null;
  unaccounted: boolean;
}>;

export const refundSourceDebitIdentitySchema = z
  .object({
    observationId: z.uuid(),
    networkId: z.enum(["evm:8453", "evm:137"]),
    transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
    eventIndex: z.string().regex(/^(0|[1-9]\d*)$/u),
  })
  .strict();
export type RefundSourceDebitIdentity = z.infer<
  typeof refundSourceDebitIdentitySchema
>;
/** Attempt-linked proof only. `none` is NOT absence of other source
 * observations, and `single_debit` is NOT proof of completed settlement. */
export type RefundSourceAccounting =
  | Readonly<{ kind: "unaccounted" | "none" }>
  | Readonly<{ kind: "single_debit"; debit: RefundSourceDebitIdentity }>;

const debitEvidenceSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    segmentId: z.uuid(),
    kind: z.literal("source_debit"),
    networkId: z.enum(["evm:8453", "evm:137"]),
    assetId: z.string(),
    decimals: z.number().int(),
    raw: z.string().regex(/^[1-9]\d*$/u),
    txHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
    eventIndex: z.string().regex(/^(0|[1-9]\d*)$/u),
    fromAddress: z.string(),
    toAddress: z.string(),
    ledgerHeight: z.string().regex(/^\d+$/u),
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/iu),
    canonical: z.literal(true),
    finality: z.literal("finalized"),
    observerId: z.literal("relay_client_receipt_source_debit_v1"),
    originStepId: z.string(),
    originFingerprint: z.string(),
    originExecutor: z.string(),
  })
  .strict();

/** Only called after the immutable action/envelope has passed the common
 * fold checks. The current receipt and persisted debit must describe the same
 * exact physical transfer. A different reporting attempt may reuse that key
 * only when its original allocation is bound to this same step/action. */
function exactCurrentSourceDebit(
  candidate: RefundSourceCandidateRow,
  row: RefundSourceActionRow,
): RefundSourceDebitIdentity | null {
  const parsed = debitEvidenceSchema.safeParse(row.source_debit);
  const evidence = row.receipt_evidence;
  const validation = row.action_validation_result;
  if (!parsed.success || !isRecord(evidence) || !isRecord(validation))
    return null;
  const debit = parsed.data;
  if (
    row.receipt_status !== "finalized" ||
    row.receipt_canonical !== true ||
    row.receipt_action_match !== true ||
    debit.operationId !== candidate.operation_id ||
    debit.segmentId !== candidate.segment_id ||
    debit.networkId !== candidate.network_id ||
    row.receipt_network_id !== debit.networkId ||
    debit.decimals !== candidate.asset_decimals ||
    !sameAccountAddress(debit.networkId, debit.assetId, candidate.asset_id) ||
    debit.raw !== candidate.raw_amount ||
    evidence.attributedSourceRaw !== debit.raw ||
    typeof evidence.transactionHash !== "string" ||
    evidence.transactionHash.toLowerCase() !== debit.txHash ||
    evidence.sourceDebitEventIndex !== debit.eventIndex ||
    typeof validation.expectedSourceAddress !== "string" ||
    !sameAccountAddress(
      debit.networkId,
      debit.fromAddress,
      validation.expectedSourceAddress,
    ) ||
    !sameAccountAddress(
      debit.networkId,
      debit.toAddress,
      RELAY_DEPOSITORY_V2,
    ) ||
    debit.ledgerHeight !== row.receipt_ledger_height ||
    debit.blockHash.toLowerCase() !== row.receipt_block_hash?.toLowerCase() ||
    debit.originStepId !== row.step_id ||
    debit.originFingerprint !== row.action_fingerprint ||
    debit.originExecutor !== row.executor_id
  )
    return null;
  return {
    observationId: debit.id,
    networkId: debit.networkId,
    transactionHash: debit.txHash,
    eventIndex: debit.eventIndex,
  };
}

export const emptyRefundSourceActionFold = (): RefundSourceActionFold => ({
  invalid: false,
  depositStepId: null,
  possible: false,
  debit: null,
  unaccounted: false,
});

/** Fold one bounded page without retaining raw actions/receipts or growing an
 * array with attempt history. Every page must use one checked facts revision;
 * an empty page is not itself proof that the full scan completed. */
export function foldRefundSourceActions(
  candidate: RefundSourceCandidateRow,
  previous: RefundSourceActionFold,
  rows: readonly RefundSourceActionRow[],
): RefundSourceActionFold {
  const invalid: RefundSourceActionFold = {
    invalid: true,
    depositStepId: null,
    possible: false,
    debit: null,
    unaccounted: true,
  };
  if (previous.invalid) return invalid;
  const snapshot = candidate.source_snapshot;
  const source = assetLocationSchema.safeParse(
    isRecord(snapshot) && snapshot.kind === "owned_location"
      ? snapshot.location
      : null,
  );
  const amount = moneySchema.safeParse(candidate.quoted_input);
  const contract = readFundingRefundContract(
    candidate.refund_location_snapshot,
    {
      requestFingerprint: candidate.provider_quote_ref_lookup_hmac,
      lookupKeyVersion: candidate.lookup_key_version,
    },
  );
  if (
    !source.success ||
    !amount.success ||
    !contract?.supported ||
    !candidate.segment_id ||
    candidate.provider_id !== "relay" ||
    candidate.operation_user_id !== candidate.user_id ||
    !readCommittedFundingIdentity({
      currentOwnerUserId: candidate.user_id,
      operationSourceSnapshot: candidate.operation_source_snapshot,
      accountIds: [
        source.data.accountId,
        ...(refundSnapshotAccountIds(candidate.refund_location_snapshot) ?? [
          null,
        ]),
      ],
    }) ||
    typeof source.data.details.address !== "string" ||
    !sameAsset(source.data.asset, amount.data.asset) ||
    !/^[1-9]\d*$/.test(amount.data.raw)
  )
    return invalid;
  const network = source.data.asset.networkId;
  // The same pinned inbound registry owns execution AND evidence support.
  // Inferring USDC from the network would strand a valid Polygon pUSD leg.
  const token = RELAY_HYPERCORE_EVM_STABLE_SOURCE_ASSETS.find((asset) =>
    sameAsset(asset, source.data.asset),
  )?.assetId;
  if (
    !token ||
    source.data.asset.decimals !== 6 ||
    !sameAccountAddress(network, source.data.asset.assetId, token)
  )
    return invalid;
  const owner = source.data.details.address;
  const sourceRaw = BigInt(amount.data.raw);
  const orderId = isRecord(candidate.refund_location_snapshot)
    ? candidate.refund_location_snapshot.relayProtocolOrderId
    : null;
  if (typeof orderId !== "string") return invalid;
  const exactApproval = (call: {
    to: string;
    data: string;
    valueRaw: string;
  }) => {
    if (call.valueRaw !== "0" || !sameAccountAddress(network, call.to, token))
      return false;
    try {
      const decoded = approvalInterface.decodeFunctionData(
        "approve",
        call.data,
      );
      return (
        sameAccountAddress(network, decoded[0], RELAY_DEPOSITORY_V2) &&
        decoded[1] === sourceRaw &&
        approvalInterface
          .encodeFunctionData("approve", [decoded[0], decoded[1]])
          .toLowerCase() === call.data.toLowerCase()
      );
    } catch {
      return false;
    }
  };
  let depositStepId = previous.depositStepId;
  let possible = previous.possible;
  let debit = previous.debit;
  let unaccounted = previous.unaccounted;
  for (const row of rows) {
    if (
      row.operation_id !== candidate.operation_id ||
      row.segment_id !== candidate.segment_id
    )
      return invalid;
    if (
      !row.step_id ||
      row.executor_id !== "wallet_profile_evm_v1" ||
      row.step_kind !== "transaction"
    )
      return invalid;
    const action = normalizedActionSchema.safeParse(row.normalized_action);
    const validation = row.action_validation_result;
    if (
      !action.success ||
      !isRecord(validation) ||
      action.data.networkId !== network ||
      canonicalJsonHash(row.normalized_action) !== row.action_fingerprint ||
      typeof validation.signerAddress !== "string" ||
      !sameAccountAddress(network, validation.signerAddress, owner) ||
      validation.relayNativeDestination !== "hyperliquid:mainnet"
    )
      return invalid;
    if (
      row.attempt_id !== null &&
      (row.attempt_fingerprint !== row.action_fingerprint ||
        row.attempt_executor_id !== row.executor_id)
    )
      return invalid;
    if (validation.relayStepKind === "approve") {
      if (
        action.data.kind !== "evm_transaction" ||
        !action.data.actionId.endsWith(":approve") ||
        validation.relayNativeApproval !== "exact_erc20_approval_v1" ||
        !exactApproval(action.data)
      )
        return invalid;
      continue; // Even a successful approval is not funding sent to Relay.
    }
    if (
      validation.relayStepKind !== "deposit" ||
      !["evm_transaction", "evm_transaction_batch"].includes(
        action.data.kind,
      ) ||
      validation.postconditionEvidenceKind !== "exact_erc20_source_debit_v1" ||
      validation.expectedSourceAssetDecimals !== 6 ||
      validation.expectedSourceRaw !== amount.data.raw ||
      typeof validation.expectedSourceAssetId !== "string" ||
      !sameAccountAddress(network, validation.expectedSourceAssetId, token) ||
      typeof validation.expectedSourceAddress !== "string" ||
      !sameAccountAddress(network, validation.expectedSourceAddress, owner) ||
      typeof validation.expectedSourceRecipient !== "string" ||
      !sameAccountAddress(
        network,
        validation.expectedSourceRecipient,
        RELAY_DEPOSITORY_V2,
      ) ||
      typeof validation.relayProtocolOrderId !== "string" ||
      validation.relayProtocolOrderId.toLowerCase() !== orderId.toLowerCase()
    )
      return invalid;
    const calls =
      action.data.kind === "evm_transaction"
        ? [action.data]
        : action.data.kind === "evm_transaction_batch"
          ? action.data.calls
          : [];
    let deposits = 0;
    let approvals = 0;
    for (const call of calls) {
      if (
        call.actionId.endsWith(":approve") &&
        deposits === 0 &&
        exactApproval(call)
      ) {
        approvals++;
        continue;
      }
      if (!call.actionId.endsWith(":deposit")) return invalid;
      try {
        if (
          validateRelayDepositoryV2Action({
            action: {
              to: call.to,
              data: call.data,
              value: BigInt(call.valueRaw),
            },
            amount: sourceRaw,
            token,
            user: owner,
          }) !== orderId.toLowerCase()
        )
          return invalid;
      } catch {
        return invalid;
      }
      deposits++;
    }
    if (deposits !== 1 || approvals > 1) return invalid;
    if (depositStepId !== null && depositStepId !== row.step_id) return invalid;
    depositStepId = row.step_id;
    if (row.attempt_id === null) continue;
    // Only the server cancellation writer can create this reserved shape.
    // Every earlier issued attempt still participates in this loop.
    if (row.synthetic_cancellation && row.receipt_status === null) continue;
    const embedded = parseEmbeddedFundingSubmission(
      isRecord(row.attempt_costs) ? row.attempt_costs.embeddedSubmission : null,
    );
    if (
      embedded?.phase === "closed" &&
      embedded.requestFingerprint === undefined &&
      embedded.admittedAt === undefined &&
      sameAccountAddress(network, embedded.signer, owner) &&
      ["failed", "cancelled"].includes(row.attempt_outcome ?? "") &&
      row.broadcast_may_have_occurred === false &&
      row.unreferenced_attempt &&
      row.receipt_status === null
    )
      continue;
    const finalFailure =
      row.receipt_status === "failed" &&
      row.receipt_canonical === true &&
      row.receipt_action_match === true &&
      isRecord(row.receipt_evidence) &&
      row.receipt_evidence.failureFinalized === true;
    // A client cancellation/report, expired quote, or cached failed state is
    // not evidence that the already-issued signed transaction never executed.
    if (finalFailure && row.source_debit !== null) unaccounted = true;
    if (!finalFailure) {
      possible = true;
      const currentDebit = exactCurrentSourceDebit(candidate, row);
      if (!currentDebit) unaccounted = true;
      else if (
        debit &&
        canonicalJsonHash(debit) !== canonicalJsonHash(currentDebit)
      )
        unaccounted = true;
      else debit = currentDebit;
    }
  }
  return { invalid: false, depositStepId, possible, debit, unaccounted };
}

export function finishRefundSourceAccounting(
  fold: RefundSourceActionFold,
): RefundSourceAccounting {
  if (fold.invalid || fold.depositStepId === null || fold.unaccounted)
    return { kind: "unaccounted" };
  return fold.debit
    ? { kind: "single_debit", debit: fold.debit }
    : { kind: "none" };
}

export function finishRefundSourceActions(
  fold: RefundSourceActionFold,
  coverage: Readonly<{ complete: boolean }>,
): RefundSourceActionExposure {
  if (!coverage.complete) return { kind: "incomplete" };
  if (fold.invalid || fold.depositStepId === null) return { kind: "invalid" };
  return fold.possible
    ? { kind: "possible", stepIds: [fold.depositStepId] }
    : { kind: "no_live_attempt" };
}

/** A coherent full scan is still not allocation authority. `no_live_attempt`
 * is NOT `external`: source debit and settlement facts must also be checked.
 * Kept as the one-shot interface for existing callers and tests. */
export function classifyRefundSourceActions(
  candidate: RefundSourceCandidateRow,
  rows: readonly RefundSourceActionRow[],
  coverage: Readonly<{ complete: boolean }>,
): RefundSourceActionExposure {
  if (!coverage.complete) return { kind: "incomplete" };
  return finishRefundSourceActions(
    foldRefundSourceActions(candidate, emptyRefundSourceActionFold(), rows),
    coverage,
  );
}
