export const SHARED_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const SHARED_RATE_LIMIT_BASE_BACKOFF_MS = 2_000;
export const SHARED_RATE_LIMIT_MAX_BACKOFF_MS = 30_000;
export const SHARED_RATE_LIMIT_JITTER_MS = 500;

type SharedRateLimitBackoffOptions = {
  label: string;
  logPrefix: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SharedRateLimitBackoff {
  private consecutiveRateLimits = 0;
  private nextAllowedAtMs = 0;
  private lastLoggedUntilMs = 0;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterMs: number;
  private readonly label: string;
  private readonly logPrefix: string;

  constructor(options: SharedRateLimitBackoffOptions) {
    this.label = options.label;
    this.logPrefix = options.logPrefix;
    this.baseBackoffMs =
      options.baseBackoffMs ?? SHARED_RATE_LIMIT_BASE_BACKOFF_MS;
    this.maxBackoffMs =
      options.maxBackoffMs ?? SHARED_RATE_LIMIT_MAX_BACKOFF_MS;
    this.jitterMs = options.jitterMs ?? SHARED_RATE_LIMIT_JITTER_MS;
  }

  async wait(): Promise<void> {
    const waitMs = Math.ceil(this.nextAllowedAtMs - Date.now());
    if (waitMs <= 0) return;
    const jitterMs =
      this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    await sleep(waitMs + jitterMs);
  }

  noteRateLimit(): void {
    this.consecutiveRateLimits += 1;
    const backoffMs = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.max(0, this.consecutiveRateLimits - 1),
    );
    const blockedUntilMs = Date.now() + backoffMs;
    if (blockedUntilMs <= this.nextAllowedAtMs) return;

    this.nextAllowedAtMs = blockedUntilMs;
    if (blockedUntilMs - this.lastLoggedUntilMs < 1_000) return;

    this.lastLoggedUntilMs = blockedUntilMs;
    console.warn(`${this.logPrefix} ${this.label} rate limited`, {
      backoffMs,
      until: new Date(blockedUntilMs).toISOString(),
    });
  }

  noteSuccess(): void {
    this.consecutiveRateLimits = 0;
  }
}
