import type { JournalMcpConfig } from "./config.js";

const MAX_API_RESPONSE_BYTES = 4_000_000;
const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
};

type SafeApiErrorBody = {
  error?: string;
  message?: string;
  details?: {
    currentRevision?: number;
    currentContentHash?: string;
  };
};

export class JournalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: SafeApiErrorBody,
  ) {
    super(body.message ?? body.error ?? `Journal API returned HTTP ${status}`);
    this.name = "JournalApiError";
  }
}

function safeErrorBody(value: unknown): SafeApiErrorBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const details =
    record.details &&
    typeof record.details === "object" &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record.error === "string"
      ? { error: record.error.slice(0, 160) }
      : {}),
    ...(typeof record.message === "string"
      ? { message: record.message.slice(0, 500) }
      : {}),
    ...(details
      ? {
          details: {
            ...(typeof details.currentRevision === "number"
              ? { currentRevision: details.currentRevision }
              : {}),
            ...(typeof details.currentContentHash === "string"
              ? { currentContentHash: details.currentContentHash.slice(0, 128) }
              : {}),
          },
        }
      : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("Journal API response exceeds the local safety limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_API_RESPONSE_BYTES) {
    throw new Error("Journal API response exceeds the local safety limit");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Journal API returned an invalid JSON response");
  }
}

export class JournalApiClient {
  constructor(private readonly config: JournalMcpConfig) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    pathname: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!pathname.startsWith("/service/journal/")) {
      throw new Error("Refusing to call a non-Journal service path");
    }
    const url = new URL(pathname, this.config.apiOrigin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          accept: "application/json",
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.idempotencyKey
            ? { "idempotency-key": options.idempotencyKey }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
      const value = await readJson(response);
      if (!response.ok)
        throw new JournalApiError(response.status, safeErrorBody(value));
      return value as T;
    } catch (error) {
      if (error instanceof JournalApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Journal API request timed out");
      }
      throw new Error("Journal API request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async uploadPresigned(
    urlValue: string,
    headersValue: Record<string, unknown>,
    bytes: Buffer,
  ): Promise<void> {
    const url = new URL(urlValue);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw new Error("Upload target must use HTTPS outside localhost");
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(headersValue)) {
      const normalized = name.toLowerCase();
      if (
        normalized !== "content-type" &&
        normalized !== "x-amz-checksum-sha256"
      ) {
        throw new Error("Upload intent contains an unexpected header");
      }
      if (typeof value !== "string" || value.length > 1_024) {
        throw new Error("Upload intent contains an invalid header");
      }
      headers.set(normalized, value);
    }
    if (!headers.has("content-type") || !headers.has("x-amz-checksum-sha256")) {
      throw new Error("Upload intent is missing required headers");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "PUT",
        redirect: "error",
        signal: controller.signal,
        headers,
        body: Uint8Array.from(bytes),
      });
      if (!response.ok) throw new Error("Object storage rejected the upload");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Image upload timed out");
      }
      throw new Error("Image upload failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
