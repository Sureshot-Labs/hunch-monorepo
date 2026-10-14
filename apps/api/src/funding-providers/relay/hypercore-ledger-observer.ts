import { z } from "zod";
import { Hip4ReadError } from "../../services/hip4-client.js";

const ledgerPage = z.array(z.unknown()).max(2000); // Native info response ceiling.

/** Exact Requests-v3 seconds, not a wallet-history scan. Both funding source
 * and destination use the same budgeted reader and persisted rotation cursor.
 * Repeated provider observations may corroborate one hash at different times. */
export async function readHypercoreLedgerSeconds(input: {
  seconds: readonly number[];
  afterSecond?: number;
  read: (startTime: number, endTime: number) => Promise<unknown>;
  complete?: (ledger: readonly unknown[]) => boolean;
}) {
  const seconds = [...new Set(input.seconds)].sort(
    (left, right) => left - right,
  );
  const after = input.afterSecond;
  const next =
    after === undefined ? 0 : seconds.findIndex((second) => second > after);
  const start = next < 0 ? 0 : next;
  const ordered = [...seconds.slice(start), ...seconds.slice(0, start)];
  const ledger: unknown[] = [];
  let afterSecond: number | undefined;
  let pendingReason: string | null = null;
  for (const second of ordered) {
    const startTime = second * 1000;
    if (
      !Number.isSafeInteger(second) ||
      second < 0 ||
      !Number.isSafeInteger(startTime + 999)
    ) {
      pendingReason = "native_timestamp_invalid";
      continue;
    }
    try {
      ledger.push(
        ...ledgerPage.parse(await input.read(startTime, startTime + 999)),
      );
      afterSecond = second;
      if (input.complete?.(ledger)) break;
    } catch (error) {
      pendingReason =
        error instanceof Hip4ReadError
          ? `native_ledger_${error.reason}`
          : "native_ledger_invalid";
      if (error instanceof Hip4ReadError && error.reason === "budget_exhausted")
        break;
      afterSecond = second;
    }
  }
  return { ledger, afterSecond, pendingReason };
}
