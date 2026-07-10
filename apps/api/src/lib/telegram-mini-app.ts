import crypto from "node:crypto";

export type TelegramInitDataValidationErrorCode =
  | "empty_init_data"
  | "oversized_init_data"
  | "missing_hash"
  | "invalid_hash"
  | "missing_auth_date"
  | "invalid_auth_date"
  | "stale_auth_date"
  | "future_auth_date"
  | "missing_user"
  | "malformed_user"
  | "missing_user_id";

export type TelegramMiniAppUser = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  photoUrl?: string | null;
};

export type TelegramMiniAppContext = {
  authDate: Date;
  startParam?: string | null;
  user: TelegramMiniAppUser;
};

export type TelegramInitDataValidationOptions = {
  botToken: string;
  initDataMaxAgeSeconds: number;
  maxPayloadBytes?: number;
  now?: Date;
};

type UnknownRecord = Record<string, unknown>;

const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/i;
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;

export class TelegramInitDataValidationError extends Error {
  readonly code: TelegramInitDataValidationErrorCode;

  constructor(code: TelegramInitDataValidationErrorCode) {
    super(code);
    this.code = code;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  record: UnknownRecord,
  key: string,
  maxLength: number,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function normalizeTelegramStartParam(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || !START_PARAM_RE.test(trimmed)) return null;
  if (/^ref_[A-Za-z0-9]{3,32}$/.test(trimmed)) return trimmed;
  if (/^event_[A-Za-z0-9_-]{1,120}$/.test(trimmed)) return trimmed;
  if (/^e_[A-Za-z0-9_-]{1,510}$/.test(trimmed)) return trimmed;
  if (/^m_[A-Za-z0-9_-]{1,510}$/.test(trimmed)) return trimmed;
  if (/^b_[A-Za-z0-9_-]{1,510}$/.test(trimmed)) return trimmed;
  if (/^wt_[A-Za-z0-9_-]{1,509}$/.test(trimmed)) return trimmed;
  if (/^w_[a-z0-9-]{1,16}_[A-Za-z0-9]{3,64}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function buildDataCheckString(params: URLSearchParams): {
  dataCheckString: string;
  hash: string | null;
  hashCount: number;
} {
  const pairs: string[] = [];
  let hash: string | null = null;
  let hashCount = 0;

  for (const [key, value] of params.entries()) {
    if (key === "hash") {
      hash = value;
      hashCount += 1;
      continue;
    }
    pairs.push(`${key}=${value}`);
  }

  pairs.sort((left, right) => left.localeCompare(right));
  return {
    dataCheckString: pairs.join("\n"),
    hash,
    hashCount,
  };
}

function verifyTelegramHash(input: {
  botToken: string;
  dataCheckString: string;
  hash: string;
}): boolean {
  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(input.botToken)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(input.dataCheckString)
    .digest("hex");

  const expected = Buffer.from(expectedHash, "hex");
  const received = Buffer.from(input.hash, "hex");
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function parseAuthDate(
  params: URLSearchParams,
  options: TelegramInitDataValidationOptions,
): Date {
  const raw = params.get("auth_date");
  if (!raw) throw new TelegramInitDataValidationError("missing_auth_date");
  if (!/^\d+$/.test(raw)) {
    throw new TelegramInitDataValidationError("invalid_auth_date");
  }

  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new TelegramInitDataValidationError("invalid_auth_date");
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const authDateMs = seconds * 1_000;
  const maxAgeMs = Math.max(1, options.initDataMaxAgeSeconds) * 1_000;
  if (authDateMs > nowMs + 60_000) {
    throw new TelegramInitDataValidationError("future_auth_date");
  }
  if (nowMs - authDateMs > maxAgeMs) {
    throw new TelegramInitDataValidationError("stale_auth_date");
  }
  return new Date(authDateMs);
}

function parseTelegramUser(params: URLSearchParams): TelegramMiniAppUser {
  const userRaw = params.get("user");
  if (!userRaw) throw new TelegramInitDataValidationError("missing_user");

  let user: unknown;
  try {
    user = JSON.parse(userRaw) as unknown;
  } catch {
    throw new TelegramInitDataValidationError("malformed_user");
  }

  if (!isRecord(user)) {
    throw new TelegramInitDataValidationError("malformed_user");
  }

  const rawId = user.id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0
      ? String(rawId)
      : typeof rawId === "string" && /^\d+$/.test(rawId)
        ? rawId
        : null;
  if (!id) throw new TelegramInitDataValidationError("missing_user_id");

  return {
    id,
    firstName: readOptionalString(user, "first_name", 256),
    lastName: readOptionalString(user, "last_name", 256),
    username: readOptionalString(user, "username", 256),
    photoUrl: readOptionalString(user, "photo_url", 2_048),
  };
}

export function validateTelegramInitData(
  initDataRaw: string,
  options: TelegramInitDataValidationOptions,
): TelegramMiniAppContext {
  const trimmed = initDataRaw.trim();
  if (!trimmed) throw new TelegramInitDataValidationError("empty_init_data");

  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (Buffer.byteLength(trimmed, "utf8") > maxPayloadBytes) {
    throw new TelegramInitDataValidationError("oversized_init_data");
  }

  const params = new URLSearchParams(trimmed);
  const { dataCheckString, hash, hashCount } = buildDataCheckString(params);
  if (!hash || hashCount !== 1) {
    throw new TelegramInitDataValidationError("missing_hash");
  }
  if (!HASH_RE.test(hash)) {
    throw new TelegramInitDataValidationError("invalid_hash");
  }
  if (
    !verifyTelegramHash({
      botToken: options.botToken,
      dataCheckString,
      hash,
    })
  ) {
    throw new TelegramInitDataValidationError("invalid_hash");
  }

  return {
    authDate: parseAuthDate(params, options),
    startParam: normalizeTelegramStartParam(params.get("start_param")),
    user: parseTelegramUser(params),
  };
}
