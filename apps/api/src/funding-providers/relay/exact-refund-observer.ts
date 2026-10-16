import type { Pool } from "@hunch/infra";
import type { AssetRef } from "../../funding/domain/types.js";
import { isHypercoreMainnetUsdc } from "../../funding/domain/hypercore-identity.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";
import { observeRelayErc20DestinationReceipts } from "../../funding/reconciliation/relay-destination-receipts.js";
import {
  withFundingEvidenceReadBudget,
  FundingEvidenceBudgetExpiredError,
} from "../../funding/reconciliation/funding-evidence-budget.js";
import { isRecord } from "../../lib/type-guards.js";
import {
  createHip4AccountClient,
  Hip4ReadError,
} from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import { RelayClientError, type RelayClient } from "./client.js";
import { readHypercoreLedgerSeconds } from "./hypercore-ledger-observer.js";
import {
  selectRelayRefundReceiptPlan,
  type RelayRefundExpectation,
} from "./refund-evidence.js";
import type { RelayStatusResponse } from "./schemas.js";

type EvmRead = Readonly<{
  asset: AssetRef;
  destinationAddress: string;
  transactionHashes: readonly string[];
  now: Date;
  deadlineMs?: number;
}>;

/** Read-only provider adapter. The common writer independently revalidates
 * every returned fact against the immutable operation before allocating it. */
export async function readRelayExactRefundEvidence(
  input: {
    expected: RelayRefundExpectation;
    status: RelayStatusResponse;
    now: Date;
    ledgerAfterSecond?: number;
    deadlineMs?: number;
  },
  dependencies: {
    requestEvidence: RelayClient["requestEvidence"];
    readNativeLedger: (
      owner: string,
      startTime: number,
      endTime: number,
    ) => Promise<unknown>;
    readEvm: (
      input: EvmRead,
    ) => Promise<readonly OwnedRouteCanonicalDestinationEvent[]>;
  },
) {
  const pending = (reason: string) => ({ kind: "pending" as const, reason });
  try {
    const expired = () =>
      input.deadlineMs !== undefined && Date.now() >= input.deadlineMs;
    if (expired()) return pending("refund_work_deadline");
    const request =
      input.deadlineMs === undefined
        ? await dependencies.requestEvidence(input.expected.requestId)
        : await dependencies.requestEvidence(input.expected.requestId, {
            deadlineMs: input.deadlineMs,
          });
    if (!request) return pending("refund_request_pending");
    const selected = selectRelayRefundReceiptPlan({
      expected: input.expected,
      request,
      status: input.status,
    });
    if (selected.kind !== "selected") return pending(selected.reason);
    const plan = selected.plan;
    const owner = String(plan.target.details.address);
    if (isHypercoreMainnetUsdc(plan.target.asset)) {
      const read = await readHypercoreLedgerSeconds({
        seconds: plan.ledgerSeconds,
        afterSecond: input.ledgerAfterSecond,
        deadlineMs: input.deadlineMs,
        read: (start, end) => dependencies.readNativeLedger(owner, start, end),
      });
      return {
        kind: "observed" as const,
        request,
        nativeLedger: read.ledger,
        evmEvents: [],
        reason: read.pendingReason,
        ...(read.afterSecond === undefined
          ? {}
          : { ledgerAfterSecond: read.afterSecond }),
      };
    }
    const evmEvents: OwnedRouteCanonicalDestinationEvent[] = [];
    let reason: string | null = null;
    // A failed sibling RPC must not discard another exact finalized receipt.
    // Reuse the common reader, one protocol-bound reference at a time (the
    // Requests schema bounds the manifest); never scan a wallet's transfers.
    for (const hash of plan.transactionHashes) {
      if (expired()) {
        reason = "refund_work_deadline";
        break;
      }
      try {
        evmEvents.push(
          ...(await dependencies.readEvm({
            asset: plan.target.asset,
            destinationAddress: owner,
            transactionHashes: [hash],
            now: input.now,
            ...(input.deadlineMs === undefined
              ? {}
              : { deadlineMs: input.deadlineMs }),
          })),
        );
      } catch {
        reason = "refund_evm_receipt_transport_error";
      }
    }
    return {
      kind: "observed" as const,
      request,
      evmEvents,
      nativeLedger: [],
      reason,
    };
  } catch (error) {
    return pending(
      error instanceof RelayClientError
        ? `refund_relay_${error.code}`
        : "refund_receipt_configuration_or_transport_error",
    );
  }
}

/** Use the existing RPC clients and shared HIP account-read budget. Frozen
 * transfers drain even when creation/discovery is disabled; a browser testnet
 * toggle cannot redirect a mainnet refund. No signing or submit is reachable. */
export async function observeRelayExactRefundEvidence(
  pool: Pool,
  relay: Pick<RelayClient, "requestEvidence">,
  input: Parameters<typeof readRelayExactRefundEvidence>[0],
  fetcher: typeof fetch = fetch,
) {
  let nativePolicy:
    | Awaited<ReturnType<typeof readHip4Policy>>["policy"]
    | undefined;
  const readDb = async <T>(read: (db: Pick<Pool, "query">) => Promise<T>) => {
    try {
      return input.deadlineMs === undefined
        ? await read(pool)
        : await withFundingEvidenceReadBudget(pool, input.deadlineMs, read);
    } catch (error) {
      // A denied exact second was not inspected. Preserve the last completed
      // native cursor, just as the existing IP-budget denial does; treating a
      // deadline as invalid data would advance past an unread second forever.
      if (
        input.deadlineMs !== undefined &&
        (error instanceof FundingEvidenceBudgetExpiredError ||
          (isRecord(error) && ["57014", "55P03"].includes(String(error.code))))
      )
        throw new Hip4ReadError("budget_exhausted");
      throw error;
    }
  };
  return readRelayExactRefundEvidence(input, {
    requestEvidence: (id, options) => relay.requestEvidence(id, options),
    readEvm: observeRelayErc20DestinationReceipts,
    readNativeLedger: async (owner, startTime, endTime) => {
      if (!nativePolicy) {
        const { policy: configured } = await readDb((db) =>
          readHip4Policy(db, "accountRead"),
        );
        nativePolicy = { ...configured, environment: "mainnet" as const };
      }
      const policy = nativePolicy;
      const nativeRead = createHip4AccountClient(
        policy,
        (weight) =>
          readDb((db) =>
            admitHip4Request(
              db,
              "mainnet",
              weight,
              policy.requestWeightPerMinute,
            ),
          ),
        fetcher,
        input.deadlineMs === undefined
          ? undefined
          : { deadlineMs: input.deadlineMs },
      );
      return nativeRead({
        type: "userNonFundingLedgerUpdates",
        user: owner,
        startTime,
        endTime,
      });
    },
  });
}
