import {
  hip4Identity,
  isHip4CanaryId,
  parseHip4Coin,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import type { Pool } from "pg";
import { readHip4Markets } from "./hip4-repository.js";

export function hip4StreamTokensAllowed(
  tokens: string[],
  policy: Hip4ReadPolicy,
  indexedOutcomes: number[] = [],
): boolean {
  const canary = tokens.filter(isHip4CanaryId);
  if (!canary.length) return true;
  if (!policy.enabled || !policy.liveEnabled) return false;
  const allowed = new Set(
    (policy.catalogMode === "all"
      ? indexedOutcomes
      : policy.outcomeAllowlist
    ).flatMap((outcome) =>
      hip4Identity(policy.environment, outcome).sides.map(
        (side) => side.tokenId,
      ),
    ),
  );
  return canary.every((token) => allowed.has(token));
}

export async function hip4KnownStreamTokensAllowed(
  db: Pick<Pool, "query">,
  tokens: string[],
  policy: Hip4ReadPolicy,
) {
  if (policy.catalogMode !== "all" || !policy.enabled || !policy.liveEnabled)
    return hip4StreamTokensAllowed(tokens, policy);
  let outcomes: number[];
  try {
    outcomes = [
      ...new Set(
        tokens.filter(isHip4CanaryId).map((token) => {
          const parts = token.split(":");
          if (parts.length !== 3 || parts[1] !== policy.environment)
            throw new Error("wrong_identity");
          return parseHip4Coin(`#${parts[2]}`).outcome;
        }),
      ),
    ];
  } catch {
    return false;
  }
  const indexed = await readHip4Markets(
    db,
    policy.environment,
    outcomes,
    -1,
    outcomes.length,
  );
  return hip4StreamTokensAllowed(
    tokens,
    policy,
    indexed.map((market) => market.outcome),
  );
}
