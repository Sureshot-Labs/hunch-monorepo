import type { PoolClient } from "@hunch/infra";
import { z } from "zod";
import { RELAY_REQUEST_TRANSACTION_LIMIT } from "../../funding-providers/relay/request-evidence.js";
import {
  EXACT_REFUND_OBSERVER_ID,
  fundingRefundReceiptMatchesContract,
  fundingRefundReceiptSetComplete,
  readFundingRefundReceiptIdentity,
  type FundingRefundContract,
} from "../domain/refund-settlement.js";
import {
  listFundingCurrentRefundReceiptPage,
  readFundingRefundCompletionProof,
} from "../persistence/funding-operation-repository.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";

const memberSchema = z
  .object({
    id: z.uuid(),
    raw: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .max(78),
  })
  .strict();
export const refundCompletionProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchecked") }).strict(),
  z
    .object({
      kind: z.literal("reading"),
      cursor: z
        .object({
          networkId: z.string().min(1),
          transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
          eventIndex: z.string().min(1),
        })
        .strict(),
      refundLocationId: z.string().min(1),
      members: z
        .array(memberSchema)
        .min(1)
        .max(RELAY_REQUEST_TRANSACTION_LIMIT),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pending"),
      reason: z.enum([
        "no_current_receipts",
        "invalid_receipt",
        "manifest_exceeded",
        "proof_missing",
        "proof_conflict",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete_refund_set"),
      anchorObservationId: z.uuid(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      receiptCount: z
        .number()
        .int()
        .min(1)
        .max(RELAY_REQUEST_TRANSACTION_LIMIT),
    })
    .strict(),
]);
export type RefundCompletionProgress = z.infer<
  typeof refundCompletionProgressSchema
>;

/** One caller-budgeted page at the action result's SAME facts revision. Only
 * the provider's existing max-size manifest is retained, never lifetime audit
 * JSON. Completion here proves the CURRENT canonical refund set, not absence
 * of unresolved observations or a final external-deposit verdict. */
export async function readRefundCompletionPage(
  db: Pick<PoolClient, "query">,
  input: {
    operationId: string;
    segmentId: string;
    contract: FundingRefundContract;
    progress: RefundCompletionProgress;
    limit: number;
  },
): Promise<RefundCompletionProgress> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 2147483645
  )
    throw new Error("Refund completion requires a bounded page");
  const { contract, progress } = input;
  if (progress.kind !== "unchecked" && progress.kind !== "reading")
    return progress;
  const pending = (
    reason: Extract<RefundCompletionProgress, { kind: "pending" }>["reason"],
  ): RefundCompletionProgress => ({ kind: "pending", reason });
  if (!contract.supported || !contract.requestBinding)
    return pending("invalid_receipt");
  const members = progress.kind === "reading" ? [...progress.members] : [];
  const ids = new Set(members.map((member) => member.id));
  if (ids.size !== members.length) return pending("invalid_receipt");
  let refundLocationId =
    progress.kind === "reading" ? progress.refundLocationId : null;
  const page = await listFundingCurrentRefundReceiptPage(db, {
    operationId: input.operationId,
    segmentId: input.segmentId,
    cursor: progress.kind === "reading" ? progress.cursor : null,
    limit: Math.min(
      input.limit,
      RELAY_REQUEST_TRANSACTION_LIMIT + 1 - members.length,
    ),
  });
  for (const row of page.rows) {
    const identity = readFundingRefundReceiptIdentity(
      row.metadata.relayRefundReceipt,
    );
    const native = row.networkId === "hyperliquid:mainnet";
    const dex = row.metadata.nativeDestinationDex;
    if (
      row.operationId !== input.operationId ||
      row.segmentId !== input.segmentId ||
      row.kind !== "refund_credit" ||
      !row.canonical ||
      row.finalityStatus !== "finalized" ||
      row.metadata.observerId !== EXACT_REFUND_OBSERVER_ID ||
      !/^0x[0-9a-f]{64}$/u.test(row.txHash) ||
      !/^0x[0-9a-f]{40}$/iu.test(row.fromAddress ?? "") ||
      (native
        ? row.eventIndex !== "hypercore:send:destination_credit" ||
          row.ledgerHeight !== null ||
          row.blockHash !== null ||
          (dex !== "spot" && dex !== "")
        : !row.networkId.startsWith("evm:") ||
          !/^\d+$/u.test(row.eventIndex) ||
          !/^\d+$/u.test(row.ledgerHeight ?? "") ||
          !/^0x[0-9a-f]{64}$/iu.test(row.blockHash ?? "") ||
          (dex !== null && dex !== undefined)) ||
      !identity ||
      ids.has(row.id) ||
      !memberSchema.safeParse({ id: row.id, raw: row.rawAmount }).success ||
      !fundingRefundReceiptMatchesContract(contract, {
        observationId: row.id,
        money: {
          asset: {
            networkId: row.networkId,
            assetId: row.assetId,
            decimals: row.assetDecimals,
          },
          raw: row.rawAmount,
        },
        destinationAddress: row.toAddress,
        nativeDestinationDex: native ? (dex as "spot" | "") : null,
        identity,
        completionProofs: [],
      }) ||
      (refundLocationId !== null &&
        identity.refundLocationId !== refundLocationId)
    )
      return pending("invalid_receipt");
    refundLocationId = identity.refundLocationId;
    ids.add(row.id);
    members.push({ id: row.id, raw: row.rawAmount });
  }
  if (
    members.length > RELAY_REQUEST_TRANSACTION_LIMIT ||
    (page.nextCursor && members.length === RELAY_REQUEST_TRANSACTION_LIMIT)
  )
    return pending("manifest_exceeded");
  if (!members.length || !refundLocationId)
    return pending("no_current_receipts");
  if (page.nextCursor)
    return {
      kind: "reading",
      cursor: page.nextCursor,
      refundLocationId,
      members,
    };
  const target = contract.locations.find(
    (location) => location.locationId === refundLocationId,
  );
  if (!target) return pending("invalid_receipt");
  const observationIds = [...ids].sort();
  const anchorObservationId = observationIds[0];
  const identity = {
    version: 1 as const,
    ...contract.requestBinding,
    refundLocationId,
  };
  const proof = {
    ...identity,
    expectedReturned: {
      asset: target.asset,
      raw: members
        .reduce((sum, member) => sum + BigInt(member.raw), 0n)
        .toString(),
    },
    observationIds,
  };
  const fingerprint = canonicalJsonHash(proof);
  const stored = await readFundingRefundCompletionProof(db, {
    operationId: input.operationId,
    segmentId: input.segmentId,
    observationId: anchorObservationId,
    fingerprint,
    observerId: EXACT_REFUND_OBSERVER_ID,
  });
  if (stored === null) return pending("proof_missing");
  if (
    !canonicalJsonEqual(stored, proof) ||
    !fundingRefundReceiptSetComplete(
      contract,
      members.map((member) => ({
        observationId: member.id,
        money: { asset: target.asset, raw: member.raw },
        destinationAddress: target.address,
        nativeDestinationDex: target.nativeDex,
        identity,
        completionProofs: member.id === anchorObservationId ? [proof] : [],
      })),
    )
  )
    return pending("proof_conflict");
  return {
    kind: "complete_refund_set",
    anchorObservationId,
    fingerprint,
    receiptCount: members.length,
  };
}
