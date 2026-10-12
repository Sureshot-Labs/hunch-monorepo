import {
  hip4Identity,
  isHip4CanaryId,
  type Hip4ReadPolicy,
} from "@hunch/shared";

export function hip4StreamTokensAllowed(
  tokens: string[],
  policy: Hip4ReadPolicy,
): boolean {
  const canary = tokens.filter(isHip4CanaryId);
  if (!canary.length) return true;
  if (!policy.enabled || !policy.liveEnabled) return false;
  const allowed = new Set(
    policy.outcomeAllowlist.flatMap((outcome) =>
      hip4Identity(policy.environment, outcome).sides.map(
        (side) => side.tokenId,
      ),
    ),
  );
  return canary.every((token) => allowed.has(token));
}
