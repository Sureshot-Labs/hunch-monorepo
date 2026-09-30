import { isRecord } from "../lib/type-guards.js";
import {
  buildLimitlessWalletRequestAuthInputs,
  type LimitlessAuthContext,
} from "./limitless-auth.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";

/** Reject missing/malformed snapshots rather than treating them as zero. */
export function isLimitlessPortfolioSnapshot(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (!isRecord(payload)) return false;
  const roots = [payload, payload.data];
  return roots.some(
    (root) =>
      Array.isArray(root) ||
      (isRecord(root) &&
        ["clob", "amm", "positions", "clobPositions", "clob_positions"].some(
          (key) => Array.isArray(root[key]),
        )),
  );
}

export async function fetchLimitlessWalletPortfolio(input: {
  walletAddress: string;
  authContext: LimitlessAuthContext | null;
}): Promise<unknown> {
  let authInputs: ReturnType<
    typeof buildLimitlessWalletRequestAuthInputs
  > | null = null;
  if (input.authContext) {
    try {
      authInputs = buildLimitlessWalletRequestAuthInputs(
        input.authContext,
        input.walletAddress,
      );
    } catch {
      // Public fallback is still bound to this exact wallet, not the partner.
    }
  }
  let result = authInputs
    ? await limitlessRequest({
        method: "GET",
        requestPath: "/portfolio/positions",
        ...authInputs,
      })
    : null;
  if (
    !result ||
    (!result.ok && (result.status === 401 || result.status === 403))
  ) {
    result = await limitlessRequest({
      method: "GET",
      requestPath: `/portfolio/${encodeURIComponent(input.walletAddress)}/positions`,
      auth: "none",
    });
  }
  if (!result.ok) {
    throw new Error(
      extractLimitlessMessage(result.payload) ??
        "Limitless positions are temporarily unavailable.",
    );
  }
  if (!isLimitlessPortfolioSnapshot(result.payload)) {
    throw new Error("Limitless returned an incomplete portfolio snapshot.");
  }
  return result.payload;
}
