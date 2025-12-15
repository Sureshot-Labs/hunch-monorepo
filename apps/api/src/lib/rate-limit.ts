// Simple in-memory rate limiter (process-local).
// NOTE: This does not work across multiple API instances; intended for dev/single-node use.

const rateLimiters = new Map<string, { count: number; resetTime: number }>();

export async function checkRateLimit(
  key: string,
  maxRequests: number = 10,
  windowMs: number = 60_000,
): Promise<boolean> {
  const now = Date.now();
  const limiter = rateLimiters.get(key);

  if (!limiter || now > limiter.resetTime) {
    rateLimiters.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (limiter.count >= maxRequests) {
    return false;
  }

  limiter.count += 1;
  return true;
}
