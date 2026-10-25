import { isSocialTextAllowed } from "./social-content-filter.js";

/** Check the complete text before truncation, including payloads queued by older releases. */
export function safeNativePushText(title: string, body: string) {
  return {
    title: [...(isSocialTextAllowed(title) ? title : "New Hunch")]
      .slice(0, 100)
      .join(""),
    body: [
      ...(isSocialTextAllowed(body) ? body : "Open Hunch to view this update."),
    ]
      .slice(0, 240)
      .join(""),
  };
}

export function safeNativePushPayload(payload: Record<string, unknown>): Record<
  string,
  unknown
> & {
  aps: { alert: { title: string; body: string } };
} {
  const aps = payload.aps as Record<string, unknown> | undefined;
  const alert = aps?.alert as Record<string, unknown> | undefined;
  return {
    ...payload,
    aps: {
      ...aps,
      alert: safeNativePushText(
        typeof alert?.title === "string" ? alert.title : "New Hunch",
        typeof alert?.body === "string"
          ? alert.body
          : "Open Hunch to view this update.",
      ),
    },
  };
}
