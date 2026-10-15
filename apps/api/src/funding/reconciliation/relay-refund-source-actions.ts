import type { PoolClient } from "@hunch/infra";
import { Interface } from "ethers";
import { isRecord } from "../../lib/type-guards.js";
import {
  BASE_USDC,
  POLYGON_USDC,
  RELAY_DEPOSITORY_V2,
  validateRelayDepositoryV2Action,
} from "../../funding-providers/relay/rehearsal.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import {
  assetLocationSchema,
  moneySchema,
  normalizedActionSchema,
} from "../domain/schemas.js";
import { readFundingRefundContract } from "../domain/refund-settlement.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { parseEmbeddedFundingSubmission } from "../execution/embedded-funding-submission-contract.js";
import type { RefundSourceCandidateRow } from "./relay-refund-source-candidates.js";
import { fundingSyntheticUnissuedAttemptSql } from "../persistence/funding-unissued-attempt-sql.js";

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
}>;

/** Read ONLY an enumerated envelope candidate. No terminal/status/expiry filter
 * can discard a current attempt or reorg. All attempts, not just latest, count.
 * This one statement gives action+receipt facts one PostgreSQL snapshot. It is
 * not a snapshot of the separate ownership/source/settlement facts. A resumed
 * page skips one exhausted current step, so action_page reserves an extra row
 * beyond the fact sentinel. Attempt range is applied INSIDE the indexed step
 * lookup, never by filtering joined history afterward. Receipt hydration only
 * sees the bounded fact_page. */
export const REFUND_SOURCE_ACTION_FACTS_SQL = `
with action_page as materialized (
  select * from funding_operation_steps
  where operation_id=$1::uuid and segment_id=$2::uuid and ordinal >= $4::integer
  order by ordinal limit ($3 + 1)
), fact_page as materialized (
  select action_row.id as step_id,action_row.ordinal,
    attempt_row.*
  from action_page action_row
  left join lateral (
    select attempt_row.id as attempt_id,attempt_row.attempt_number,
      attempt_row.canonical_action_fingerprint as attempt_fingerprint,
      attempt_row.executor_id as attempt_executor_id,attempt_row.outcome as attempt_outcome,
      attempt_row.broadcast_may_have_occurred,
      attempt_row.actual_costs as attempt_costs,
      (attempt_row.reference_kind is null and attempt_row.receipt_ref_ciphertext is null
        and attempt_row.receipt_ref_lookup_hmac is null and attempt_row.lookup_key_version is null) as unreferenced_attempt,
      ${fundingSyntheticUnissuedAttemptSql("attempt_row")} as synthetic_cancellation
    from funding_operation_step_attempts attempt_row
    where attempt_row.step_id=action_row.id
      and attempt_row.attempt_number > case when action_row.ordinal=$4 then $5::integer else 0 end
    order by attempt_row.attempt_number limit $3
  ) attempt_row on true
  where attempt_row.attempt_id is not null or action_row.ordinal > $4
  order by action_row.ordinal,coalesce(attempt_row.attempt_number,0) limit $3
)
select action_row.operation_id,action_row.segment_id,
  action_row.id as step_id,action_row.step_kind,action_row.executor_id,
  action_row.ordinal as step_ordinal,
  action_row.action_fingerprint,action_row.normalized_action,action_row.action_validation_result,
  fact_page.attempt_id,coalesce(fact_page.attempt_number,0) as attempt_number,
  fact_page.attempt_fingerprint,fact_page.attempt_executor_id,fact_page.attempt_outcome,
  fact_page.broadcast_may_have_occurred,coalesce(fact_page.synthetic_cancellation,false) as synthetic_cancellation,
  fact_page.attempt_costs,coalesce(fact_page.unreferenced_attempt,false) as unreferenced_attempt,
  receipt_row.status as receipt_status,receipt_row.canonical as receipt_canonical,
  receipt_row.action_match as receipt_action_match,receipt_row.evidence as receipt_evidence
from fact_page
join funding_operation_steps action_row on action_row.id=fact_page.step_id
left join lateral (
  select * from funding_step_receipt_observations where attempt_id=fact_page.attempt_id limit 1
) receipt_row on true
order by action_row.ordinal,coalesce(fact_page.attempt_number,0)`;

export type RefundSourceActionCursor = Readonly<{
  stepOrdinal: number;
  attemptNumber: number;
}>;

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
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > 2147483645
  )
    throw new Error("Refund action facts require a bounded page");
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
    rows: page,
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

/** Concatenated pages require one consistent database snapshot; a partial page
 * can never establish absence. Do not persist mutable negative conclusions
 * across retries. A coherent snapshot alone is not allocation authority.
 * `no_live_attempt` is NOT `external`: an exact canonical source debit and
 * current settlement facts still have to be checked. Do not persist this
 * mutable result across source pages. Only supported Base/Polygon USDC6 ->
 * HyperCore client deposit actions are admitted here, never approvals/auth. */
export function classifyRefundSourceActions(
  candidate: RefundSourceCandidateRow,
  rows: readonly RefundSourceActionRow[],
  coverage: Readonly<{ complete: boolean }>,
): RefundSourceActionExposure {
  if (!coverage.complete) return { kind: "incomplete" };
  const invalid: RefundSourceActionExposure = { kind: "invalid" };
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
    source.data.accountId !== candidate.user_id ||
    typeof source.data.details.address !== "string" ||
    !sameAsset(source.data.asset, amount.data.asset) ||
    !/^[1-9]\d*$/.test(amount.data.raw)
  )
    return invalid;
  const network = source.data.asset.networkId;
  const token =
    network === "evm:8453"
      ? BASE_USDC
      : network === "evm:137"
        ? POLYGON_USDC
        : null;
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
  const depositSteps = new Set<string>();
  const possible = new Set<string>();
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
    depositSteps.add(row.step_id);
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
    if (!finalFailure) possible.add(row.step_id);
  }
  if (depositSteps.size !== 1) return invalid;
  return possible.size
    ? { kind: "possible", stepIds: [...possible].sort() }
    : { kind: "no_live_attempt" };
}
