// A read-only reference lookup can run on every interactive worker pass after
// this short visibility delay. It never calls the provider's submit endpoint.
export const DELEGATED_PROVIDER_LOOKUP_DELAY_MS = 1_000;
// An ambiguous provider request may already have been accepted externally.
// Only an exact-idempotency replay uses this conservative lease.
export const DELEGATED_PROVIDER_REPLAY_MS = 5 * 60_000;
// A started attempt has not crossed the durable broadcast boundary and can be
// retried more quickly after its pre-broadcast checks run again.
export const DELEGATED_UNBROADCAST_RETRY_MS = 15_000;
