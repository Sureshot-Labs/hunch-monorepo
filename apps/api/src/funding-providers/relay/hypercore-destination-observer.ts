import type { Pool } from "pg";
import { isHypercoreMainnetUsdc } from "../../funding/domain/hypercore-identity.js";
import type { RelayDestinationReceiptRead } from "../../funding/reconciliation/relay-destination-receipts.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../funding/reconciliation/owned-route-destination-observer.js";
import { createHip4AccountClient } from "../../services/hip4-client.js";
import {
  admitHip4Request,
  readHip4Policy,
} from "../../services/hip4-repository.js";
import { RelayClient, RelayClientError } from "./client.js";
import { verifyRelayHypercoreRequest } from "./hypercore-request-evidence.js";
import { hypercoreDestinationEvent } from "./hypercore-transfer-evidence.js";
import { readHypercoreLedgerSeconds } from "./hypercore-ledger-observer.js";

/** Adapter inside the existing funding reconciliation worker. Only a frozen
 * operation's exact destination may reach it; never scans wallet history or
 * enables new operations. Financial drain keeps observing committed transfers
 * when creation/discovery are disabled; resource budgets remain in force. */
export async function observeRelayHypercoreDestinationReceipts(
  pool: Pool,
  relay: Pick<RelayClient, "requestEvidence">,
  input: RelayDestinationReceiptRead,
  fetcher: typeof fetch = fetch,
): Promise<{
  events: readonly OwnedRouteCanonicalDestinationEvent[];
  pendingReason: string | null;
  ledgerAfterSecond?: number;
}> {
  const pending = (pendingReason: string) => ({ events: [], pendingReason });
  if (!input.native || !isHypercoreMainnetUsdc(input.asset))
    return pending("native_destination_unsupported");
  const known = new Set(
    input.native.knownTransactionHashes.map((value) => value.toLowerCase()),
  );
  if (
    input.transactionHashes.length &&
    input.transactionHashes.every((hash) => known.has(hash.toLowerCase()))
  )
    return { events: [], pendingReason: null };
  try {
    const request = await relay.requestEvidence(input.native.requestId);
    if (!request) return pending("native_request_pending");
    const expected = {
      requestId: input.native.requestId,
      asset: input.asset,
      owner: input.destinationAddress,
      direction: "credit" as const,
      dex: input.native.dex,
    };
    const preliminary = verifyRelayHypercoreRequest({
      expected,
      request,
      status: input.native.status,
      ledger: [],
    });
    if (
      preliminary.kind === "unverified" &&
      preliminary.reason !== "native_ledger_missing"
    )
      return pending(preliminary.reason);
    // Mainnet comes from the frozen native asset identity, not the mutable
    // read-only browser environment. A testnet UI toggle cannot retarget money.
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
    const references = new Set(
      input.transactionHashes.map((hash) => hash.toLowerCase()),
    );
    const transactions = (request.data.outTxs ?? []).filter(
      (row) => row.chainId === 1337 && references.has(row.txHash.toLowerCase()),
    );
    if (
      transactions.length &&
      transactions.every((row) => known.has(row.txHash.toLowerCase()))
    )
      return { events: [], pendingReason: null };
    const seconds = [
      ...new Set(
        transactions
          .filter((row) => !known.has(row.txHash.toLowerCase()))
          .map((row) => row.timestamp),
      ),
    ].sort((left, right) => left - right);
    const {
      ledger,
      afterSecond: ledgerAfterSecond,
      pendingReason: readError,
    } = await readHypercoreLedgerSeconds({
      seconds,
      afterSecond: input.native.ledgerAfterSecond,
      read: (startTime, endTime) =>
        accountRead({
          type: "userNonFundingLedgerUpdates",
          user: input.destinationAddress,
          startTime,
          endTime,
        }),
    });
    const result = verifyRelayHypercoreRequest({
      expected,
      request,
      status: input.native.status,
      ledger,
    });
    if (result.kind === "unverified")
      return {
        ...pending(readError ?? result.reason),
        ...(ledgerAfterSecond === undefined ? {} : { ledgerAfterSecond }),
      };
    const covered = new Set([
      ...known,
      ...result.transfers.map((row) => row.transactionHash),
    ]);
    const complete = transactions.every((row) =>
      covered.has(row.txHash.toLowerCase()),
    );
    return {
      events: result.transfers.map((row) =>
        hypercoreDestinationEvent(row, input.now),
      ),
      ...(ledgerAfterSecond === undefined ? {} : { ledgerAfterSecond }),
      pendingReason: complete
        ? null
        : (readError ??
          (result.kind === "partial"
            ? result.reason
            : "native_receipt_pending")),
    };
  } catch (error) {
    return pending(
      error instanceof RelayClientError
        ? `native_relay_${error.code}`
        : "native_receipt_configuration_or_transport_error",
    );
  }
}
