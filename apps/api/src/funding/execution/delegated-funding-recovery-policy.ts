export const DELEGATED_PROVIDER_RECOVERY_MS = 5 * 60_000;
// A started attempt has not crossed the durable broadcast boundary. Recover it
// quickly; the five-minute lease is reserved for an ambiguous provider request
// that may already have been accepted externally.
export const DELEGATED_NONBROADCAST_RECOVERY_MS = 15_000;
export const DELEGATED_PROVIDER_EVIDENCE_RECOVERY_MS = 15_000;
export const DELEGATED_PROVIDER_EVIDENCE_RECOVERY_CLAIM_KEY =
  "providerEvidenceRecoveryClaimedAt";
