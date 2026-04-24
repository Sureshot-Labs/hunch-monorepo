export type BridgeOrderStatus =
  | "created"
  | "submitted"
  | "fulfilled"
  | "failed"
  | "expired"
  | "refunded";

export type BridgeNotificationStatus = "completed" | "failed" | "refunded";

function compactStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalizeBridgeOrderStatus(
  value: string | null | undefined,
  fallback: BridgeOrderStatus = "submitted",
): BridgeOrderStatus {
  if (!value) return fallback;
  const compact = compactStatus(value);
  if (!compact) return fallback;

  if (compact === "created" || compact === "none") return "created";
  if (
    compact === "submitted" ||
    compact === "pending" ||
    compact === "processing" ||
    compact === "inprogress" ||
    compact === "queued" ||
    compact === "slowfillrequested" ||
    compact === "canceling" ||
    compact === "cancelling" ||
    compact === "ordercancelled" ||
    compact === "sentordercancel"
  ) {
    return "submitted";
  }
  if (
    compact === "fulfilled" ||
    compact === "filled" ||
    compact === "completed" ||
    compact === "success" ||
    compact === "confirmed" ||
    compact === "sentunlock" ||
    compact === "claimedunlock"
  ) {
    return "fulfilled";
  }
  if (
    compact === "refunded" ||
    compact === "canceled" ||
    compact === "cancelled" ||
    compact === "claimedordercancel"
  ) {
    return "refunded";
  }
  if (
    compact === "failed" ||
    compact === "reverted" ||
    compact === "error"
  ) {
    return "failed";
  }
  if (compact === "expired") return "expired";

  return fallback;
}

export function isTerminalBridgeOrderStatus(
  value: string | null | undefined,
): boolean {
  const normalized = canonicalizeBridgeOrderStatus(value, "submitted");
  return (
    normalized === "fulfilled" ||
    normalized === "failed" ||
    normalized === "expired" ||
    normalized === "refunded"
  );
}

export function getBridgeNotificationStatus(
  value: string | null | undefined,
): BridgeNotificationStatus | null {
  if (!value) return null;
  const normalized = canonicalizeBridgeOrderStatus(value, "submitted");
  if (normalized === "fulfilled") return "completed";
  if (normalized === "refunded") return "refunded";
  if (normalized === "failed" || normalized === "expired") return "failed";
  return null;
}
