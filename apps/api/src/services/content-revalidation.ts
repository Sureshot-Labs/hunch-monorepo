import { createHmac } from "node:crypto";

import { getContentServiceRuntime } from "../content-service-runtime.js";

export type ContentRevalidationEvent =
  | "article_updated"
  | "article_published"
  | "article_unpublished"
  | "article_archived";

export type ContentRevalidationPayload = {
  event: ContentRevalidationEvent;
  articleId: string;
  versionId: string | null;
  slug: string;
  previousSlug: string | null;
  occurredAt: string;
};

export function isContentRevalidationConfigured(): boolean {
  const config = getContentServiceRuntime();
  return Boolean(config.revalidateUrl && config.revalidateSecret);
}

export type ContentRevalidationResult =
  | { attempted: false; ok: true }
  | { attempted: true; ok: true; status: number }
  | { attempted: true; ok: false; status: number | null; error: string };

function signature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}

export async function notifyContentRevalidation(
  payload: ContentRevalidationPayload,
): Promise<ContentRevalidationResult> {
  const config = getContentServiceRuntime();
  if (!config.revalidateUrl || !config.revalidateSecret) {
    return { attempted: false, ok: true };
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  try {
    const response = await fetch(config.revalidateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-hunch-content-signature": signature(
          config.revalidateSecret,
          timestamp,
          body,
        ),
        "x-hunch-content-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(config.revalidateTimeoutMs),
    });
    if (response.ok) {
      return { attempted: true, ok: true, status: response.status };
    }
    return {
      attempted: true,
      ok: false,
      status: response.status,
      error: `Revalidation endpoint returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "Revalidation failed",
    };
  }
}

export function signContentRevalidationForTests(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return signature(secret, timestamp, body);
}
