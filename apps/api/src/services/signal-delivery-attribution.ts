import crypto from "node:crypto";

const SIGNAL_DELIVERY_REF_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSignalDeliveryRef(): string {
  return crypto.randomUUID();
}

export function isSignalDeliveryRef(value: string | null | undefined): boolean {
  return SIGNAL_DELIVERY_REF_RE.test(value?.trim() ?? "");
}
