import { isHip4CanaryId, type Hip4ReadPolicy } from "@hunch/shared";

export type Hip4StreamTickContext = Readonly<{
  revision: string;
  policy: Pick<Hip4ReadPolicy, "enabled" | "liveEnabled" | "bookMaxAgeMs">;
}>;

/** Redis is a delivery cache, not policy authority. Apply the handshake's
 * effective policy to BOTH cached and pubsub ticks, without a DB read per tick.
 * The stream's ordinary policy timer closes it when that policy changes.
 * Legacy venue payloads retain their existing forwarding behavior. */
export function hip4StreamTickAllowed(
  payload: unknown,
  context: Hip4StreamTickContext | undefined,
  requestedTokens: ReadonlySet<string>,
  now = Date.now(),
  cachedToken?: string,
): boolean {
  const tick =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const token = typeof tick?.token_id === "string" ? tick.token_id : null;
  const hipCachedToken = cachedToken && isHip4CanaryId(cachedToken);
  if (!hipCachedToken && (!token || !isHip4CanaryId(token))) return true;
  if (
    !tick ||
    !token ||
    (hipCachedToken && token !== cachedToken) ||
    !requestedTokens.has(token) ||
    !context?.policy.enabled ||
    !context.policy.liveEnabled ||
    tick.policy_revision !== context.revision ||
    typeof tick.ts !== "number" ||
    !Number.isSafeInteger(tick.ts) ||
    tick.ts <= 0 ||
    tick.ts > now ||
    typeof tick.valid_until !== "string"
  )
    return false;
  const deadline = Date.parse(tick.valid_until);
  if (
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline > tick.ts + context.policy.bookMaxAgeMs ||
    now - tick.ts >= context.policy.bookMaxAgeMs
  )
    return false;
  const bid = tick.best_bid;
  const ask = tick.best_ask;
  return (
    [bid, ask].every(
      (price) =>
        price === null ||
        (typeof price === "number" &&
          Number.isFinite(price) &&
          price >= 0 &&
          price <= 1),
    ) &&
    (bid === null || ask === null || (bid as number) <= (ask as number))
  );
}
