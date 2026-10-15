import { fetchActiveRuntimePolicy } from "@hunch/db";
import type { Pool } from "@hunch/infra";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  hip4TradingPolicySchema,
  hip4CancelPolicySchema,
  hip4MarketQuotePolicySchema,
} from "../services/hip4-trading-policy.js";

/** Uncached, fail-explicit financial policy. Unlike the admin's diagnostic
 * fallback, invalid active overrides and unavailable storage must not silently
 * lower a product threshold to defaults. No override really means defaults.
 * Replay needs no new policy. Cancellation reads only its authorization fields,
 * so an invalid BUY threshold cannot strand an existing order. */
async function readTradingPolicyRow(db: Pick<Pool, "query">) {
  let row;
  try {
    row = await fetchActiveRuntimePolicy(db, "hip4_trading", new Date(), {
      missingTable: "error",
    });
  } catch {
    throw new Error("hip4_trading_policy_unavailable");
  }
  return row;
}
export async function readHip4TradingPolicy(db: Pick<Pool, "query">) {
  const row = await readTradingPolicyRow(db);
  const parsed = hip4TradingPolicySchema.safeParse(row ? row.payload : {});
  if (!parsed.success) throw new Error("hip4_trading_policy_invalid");
  return {
    ...parsed.data,
    revision: `hip4-trading-v1-${canonicalJsonHash({ id: row?.id ?? null, policy: parsed.data })}`,
  };
}

export async function readHip4CancelPolicy(db: Pick<Pool, "query">) {
  const row = await readTradingPolicyRow(db);
  const parsed = hip4CancelPolicySchema.safeParse(row ? row.payload : {});
  if (!parsed.success) throw new Error("hip4_cancel_policy_invalid");
  return {
    ...parsed.data,
    revision: `hip4-cancel-v1-${canonicalJsonHash({ id: row?.id ?? null, policy: parsed.data })}`,
  };
}

/** SELL quotes must not depend on the BUY floor or cancel-signature settings. */
export async function readHip4MarketQuotePolicy(db: Pick<Pool, "query">) {
  const row = await readTradingPolicyRow(db);
  const parsed = hip4MarketQuotePolicySchema.safeParse(row ? row.payload : {});
  if (!parsed.success) throw new Error("hip4_market_quote_policy_invalid");
  return parsed.data;
}
