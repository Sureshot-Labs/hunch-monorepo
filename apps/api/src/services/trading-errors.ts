import type {
  TradingError,
  TradingErrorCode,
  TradingVenue,
} from "./trading-types.js";

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode;
  readonly statusCode: number;
  readonly venue: TradingVenue | null;
  readonly raw: unknown;

  constructor(input: {
    code: TradingErrorCode;
    message: string;
    statusCode?: number;
    venue?: TradingVenue | null;
    raw?: unknown;
  }) {
    super(input.message);
    this.name = "TradingServiceError";
    this.code = input.code;
    this.statusCode = input.statusCode ?? 400;
    this.venue = input.venue ?? null;
    this.raw = input.raw;
  }

  toTradingError(): TradingError {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      venue: this.venue,
      raw: this.raw,
    };
  }
}

export function buildTradingError(input: {
  code: TradingErrorCode;
  message: string;
  statusCode?: number;
  venue?: TradingVenue | null;
  raw?: unknown;
}): TradingError {
  return {
    code: input.code,
    message: input.message,
    statusCode: input.statusCode ?? 400,
    venue: input.venue ?? null,
    raw: input.raw,
  };
}

export function normalizeTradingError(
  error: unknown,
  fallback?: { venue?: TradingVenue | null; message?: string },
): TradingError {
  if (error instanceof TradingServiceError) return error.toTradingError();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code =
      typeof record.code === "string" && record.code.trim()
        ? record.code
        : "trade_submission_failed";
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : (fallback?.message ?? "Trading request failed");
    const statusCode =
      typeof record.statusCode === "number" &&
      Number.isFinite(record.statusCode)
        ? record.statusCode
        : typeof record.status === "number" && Number.isFinite(record.status)
          ? record.status
          : 500;
    return {
      code,
      message,
      statusCode,
      venue: fallback?.venue ?? null,
      raw: error,
    };
  }
  return {
    code: "trade_submission_failed",
    message: fallback?.message ?? "Trading request failed",
    statusCode: 500,
    venue: fallback?.venue ?? null,
    raw: error,
  };
}

export function unsupportedTradingCapability(input: {
  capability: string;
  venue: TradingVenue;
}): TradingServiceError {
  return new TradingServiceError({
    code: "unsupported_capability",
    message: `${input.venue} does not support ${input.capability} through this trading adapter`,
    statusCode: 501,
    venue: input.venue,
  });
}
