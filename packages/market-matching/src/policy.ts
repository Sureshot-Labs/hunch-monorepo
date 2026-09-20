import { fetchActiveRuntimePolicy, type RuntimePolicyQuery } from "@hunch/db";
import {
  marketMatchingPolicySchema,
  type MarketMatchingPolicy,
} from "@hunch/shared";
import {
  hash,
  POLICY_VERSION,
  PROMPT_VERSION,
  EXPECTED_MODEL,
} from "./contracts.js";

export {
  DEFAULT_MARKET_MATCHING_POLICY,
  marketMatchingPolicySchema,
  type MarketMatchingPolicy,
} from "@hunch/shared";

export async function readMatchingPolicy(
  db: RuntimePolicyQuery,
): Promise<MarketMatchingPolicy> {
  const row = await fetchActiveRuntimePolicy(db, "market_matching");
  const parsed = marketMatchingPolicySchema.safeParse(row ? row.payload : {});
  if (!parsed.success) throw new Error("invalid_market_matching_policy");
  return parsed.data;
}

export type MatchingConsumer =
  | "alternatives"
  | "events"
  | "clusters"
  | "telegram"
  | "signals"
  | "similar"
  | "agents";

/** Environment switches can stop an enabled feature, never bypass a disabled policy. */
export async function enabledConsumer(
  db: RuntimePolicyQuery,
  name: MatchingConsumer,
): Promise<boolean> {
  if (process.env[`MATCHING_${name.toUpperCase()}_ENABLED`] === "false")
    return false;
  return (await readMatchingPolicy(db))[`${name}Enabled`];
}

/** Only decision-affecting settings invalidate evidence; budget/queue edits do not rebill pairs. */
export function approvalRevision(p: MarketMatchingPolicy): string {
  return hash([
    POLICY_VERSION,
    PROMPT_VERSION,
    EXPECTED_MODEL,
    p.eventProbability,
    p.eventConfidence,
    p.contractProbability,
    p.contractConfidence,
  ]);
}

export function matchingWorkerEnabled(p: MarketMatchingPolicy): boolean {
  return p.workerEnabled && process.env.MATCHING_WORKER_ENABLED !== "false";
}
