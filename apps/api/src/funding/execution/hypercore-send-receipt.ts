import { z } from "zod";
import type { Pool } from "@hunch/infra";
import type { RelayClient } from "../../funding-providers/relay/client.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { verifyRelayHypercoreRequest } from "../../funding-providers/relay/hypercore-request-evidence.js";
import type { HypercoreTransferEvidence } from "../../funding-providers/relay/hypercore-transfer-evidence.js";
import { createHip4AccountClient } from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import {
  HYPERCORE_MAINNET_USDC,
  isHypercoreMainnetUsdc,
} from "../domain/hypercore-identity.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  FundingStepReceiptEvidence,
  FundingStepReceiptTarget,
} from "../persistence/funding-step-receipt-repository.js";
import { nativeFundingPreparationInTransaction } from "./hypercore-auth-attempt.js";
import { nativeFundingActionReference } from "./hypercore-signed-request.js";
import type { RelayHypercorePairBinding } from "../../funding-providers/relay/hypercore-actions.js";
import { readHypercoreLedgerSeconds } from "../../funding-providers/relay/hypercore-ledger-observer.js";

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const nativeProof = z
  .object({
    networkId: z.literal("hyperliquid:mainnet"),
    asset: z
      .object({
        networkId: z.literal("hyperliquid:mainnet"),
        assetId: z.literal(HYPERCORE_MAINNET_USDC.assetId),
        decimals: z.literal(8),
      })
      .strict(),
    owner: address,
    direction: z.literal("debit"),
    transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceAddress: address,
    destinationAddress: address,
    sourceDex: z.enum(["spot", ""]),
    destinationDex: z.enum(["spot", ""]),
    rawAmount: z.string().regex(/^[1-9]\d*$/),
    ledgerTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    providerBlock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** A legitimate transfer by this owner is not necessarily THIS funding send. */
export function boundNativeSourceProof(
  binding: RelayHypercorePairBinding,
  value: unknown,
): HypercoreTransferEvidence | null {
  const parsed = nativeProof.safeParse(value);
  if (!parsed.success) return null;
  const { evidenceFingerprint, ...fact } = parsed.data;
  return isHypercoreMainnetUsdc(fact.asset) &&
    fact.owner === binding.owner.toLowerCase() &&
    fact.sourceAddress === binding.owner.toLowerCase() &&
    fact.destinationAddress === binding.depository.toLowerCase() &&
    fact.sourceDex === binding.sourceDex &&
    fact.destinationDex === binding.destinationDex &&
    fact.nonce === binding.nonce &&
    fact.rawAmount === binding.sourceRaw &&
    evidenceFingerprint === canonicalJsonHash(fact)
    ? parsed.data
    : null;
}

export function pendingNativeSourceReceipt(
  reason: string,
): FundingStepReceiptEvidence {
  return {
    status: "pending",
    actionMatch: null,
    ledgerHeight: null,
    blockHash: null,
    // In the common receipt schema this means "not reorged", not confirmed.
    // Pending + actionMatch:null cannot allocate money or release a hold.
    canonical: true,
    failureCode: null,
    evidence: { nativeSourcePending: reason },
  };
}

export const NATIVE_SEND_PROVIDER_REQUEST_SQL = `select request_ref_ciphertext,request_ref_lookup_hmac,lookup_key_version
  from funding_provider_requests where segment_id=$1 and request_kind='initial' order by first_seen_at,id limit 2`;

/** Read-only inspector inside the existing receipt driver. No resend, no new
 * jobs and no wall-clock guess for a transaction hash. Disabled creation still
 * drains exact committed requests through the same provider/resource budget. */
export async function inspectNativeFundingSend(
  pool: Pool,
  relay: Pick<RelayClient, "status" | "requestEvidence">,
  codec: RelayReferenceCodec,
  target: FundingStepReceiptTarget,
  reference: string,
  fetcher?: typeof fetch,
): Promise<FundingStepReceiptEvidence> {
  try {
    const { pair } = await nativeFundingPreparationInTransaction(
      pool,
      target.operationId,
      target.stepId,
    );
    if (
      pair.send.id !== target.stepId ||
      pair.send.segment_id !== target.segmentId ||
      canonicalJsonHash(target.action) !== pair.send.action_fingerprint ||
      target.networkId !== "hyperliquid:mainnet" ||
      reference !== nativeFundingActionReference(pair.validated)
    )
      return pendingNativeSourceReceipt("action_binding_mismatch");
    const rows = await pool.query<{
      request_ref_ciphertext: string | null;
      request_ref_lookup_hmac: string;
      lookup_key_version: number;
    }>(NATIVE_SEND_PROVIDER_REQUEST_SQL, [pair.send.segment_id]);
    const stored = rows.rows[0];
    if (
      rows.rows.length !== 1 ||
      !stored?.request_ref_ciphertext ||
      stored.lookup_key_version !== codec.keyVersion
    )
      return pendingNativeSourceReceipt("provider_reference_unavailable");
    const requestId = codec.decrypt(stored.request_ref_ciphertext);
    const payload = pair.send.normalized_action.payload as Record<
      string,
      unknown
    >;
    if (
      codec.fingerprint(requestId) !== stored.request_ref_lookup_hmac ||
      canonicalJsonHash({ provider: "relay", requestId }) !==
        payload.requestFingerprint
    )
      return pendingNativeSourceReceipt("provider_reference_mismatch");
    const [status, request] = await Promise.all([
      relay.status(requestId),
      relay.requestEvidence(requestId),
    ]);
    if (!request) return pendingNativeSourceReceipt("provider_request_pending");
    const expected = {
      requestId,
      asset: HYPERCORE_MAINNET_USDC,
      owner: pair.validated.binding.owner,
      direction: "debit" as const,
      dex: pair.validated.binding.sourceDex,
    };
    const preliminary = verifyRelayHypercoreRequest({
      expected,
      request,
      status,
      ledger: [],
    });
    if (
      preliminary.kind === "unverified" &&
      preliminary.reason !== "native_ledger_missing"
    )
      return pendingNativeSourceReceipt(preliminary.reason);
    const transactions = (request.data.inTxs ?? []).filter(
      (row) => row.chainId === 1337,
    );
    // Exactly one SendAsset was admitted, not a bundle or nearest-size match.
    const hashes = new Set(transactions.map((row) => row.txHash.toLowerCase()));
    if (hashes.size !== 1)
      return pendingNativeSourceReceipt("native_source_transaction_ambiguous");
    const { policy: configured } = await readHip4Policy(pool, "accountRead");
    const policy = { ...configured, environment: "mainnet" as const };
    const accountRead = createHip4AccountClient(
      policy,
      (weight) =>
        admitHip4Request(
          pool,
          "mainnet",
          weight,
          policy.requestWeightPerMinute,
        ),
      fetcher,
    );
    const priorSecond =
      target.previousReceipt?.evidence.nativeLedgerAfterSecond;
    const { ledger, afterSecond, pendingReason } =
      await readHypercoreLedgerSeconds({
        seconds: transactions.map((row) => row.timestamp),
        afterSecond:
          typeof priorSecond === "number" && Number.isSafeInteger(priorSecond)
            ? priorSecond
            : undefined,
        read: (startTime, endTime) =>
          accountRead({
            type: "userNonFundingLedgerUpdates",
            user: expected.owner,
            startTime,
            endTime,
          }),
        complete: (rows) =>
          verifyRelayHypercoreRequest({
            expected,
            request,
            status,
            ledger: rows,
          }).kind === "verified",
      });
    const result = verifyRelayHypercoreRequest({
      expected,
      request,
      status,
      ledger,
    });
    if (result.kind !== "verified" || result.transfers.length !== 1) {
      const pending = pendingNativeSourceReceipt(
        result.kind === "verified"
          ? "native_source_transaction_ambiguous"
          : (pendingReason ?? result.reason),
      );
      return {
        ...pending,
        evidence: {
          ...pending.evidence,
          ...(afterSecond === undefined
            ? {}
            : { nativeLedgerAfterSecond: afterSecond }),
        },
      };
    }
    const proof = boundNativeSourceProof(
      pair.validated.binding,
      result.transfers[0],
    );
    if (!proof)
      return pendingNativeSourceReceipt("native_source_action_mismatch");
    return {
      status: "finalized",
      actionMatch: true,
      ledgerHeight: null,
      blockHash: null,
      canonical: true,
      failureCode: null,
      evidence: {
        transactionHash: proof.transactionHash,
        handoffEventIndex: "hypercore:send:source_debit",
        nativeSourceProof: { ...proof },
      },
    };
  } catch {
    return pendingNativeSourceReceipt("native_source_evidence_unavailable");
  }
}
