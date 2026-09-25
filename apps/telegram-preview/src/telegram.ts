import type { Telegram } from "./types.js";

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${code}: ${description}`);
  }
}

export class TelegramClient implements Telegram {
  constructor(
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let body: string | FormData = JSON.stringify(payload);
    if (method === "sendPhoto") {
      const photo = payload.photo as { base64: string; filename: string };
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (key === "photo" || value === undefined) continue;
        form.set(
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      form.set(
        "photo",
        new Blob([Buffer.from(photo.base64, "base64")], { type: "image/png" }),
        photo.filename,
      );
      body = form;
    }
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          ...(typeof body === "string"
            ? { headers: { "content-type": "application/json" } }
            : {}),
          body,
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(40_000)]),
        },
      );
    } catch {
      // Never print fetch's error/cause: it may contain the token-bearing URL.
      throw new Error(
        `Telegram ${method}: connection failed or request aborted.`,
      );
    }
    const result = (await response.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!result.ok) {
      throw new TelegramError(
        result.error_code ?? response.status,
        (result.description ?? "Request failed").replaceAll(
          this.token,
          "[redacted]",
        ),
        result.parameters?.retry_after,
      );
    }
    return result.result;
  }
}
