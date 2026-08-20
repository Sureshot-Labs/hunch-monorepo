import type { Pool } from "@hunch/infra";

import { runTelegramRouterContinuationCommitter } from "./telegram-router-continuation-committer.js";

/**
 * Finance-worker entrypoint for the one exact continuation which starts after
 * a Relay route has durably delivered Polygon pUSD to its controller wallet.
 * The committer owns all planning/persistence; this file deliberately has no
 * Telegram presentation, account-value, or API-trading dependency.
 */
export function runTelegramRouterContinuation(
  pool: Pool,
  input: Readonly<{
    limit: number;
    subjectLookupHmacKey: string;
    subjectLookupKeyVersion: number;
    inspectRouterProfile: (
      input: Readonly<{
        walletAddress: string;
        walletId: string;
        profileId: string;
      }>,
    ) => Promise<"valid" | "invalid" | "unavailable">;
    tradeIntentId?: string;
  }>,
) {
  return runTelegramRouterContinuationCommitter(pool, input);
}
