import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  decryptCredentialsString,
  encryptCredentialsString,
  getCredentialsEncryptionKey,
} from "../lib/credentials-encryption.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const SESSION_LAST_ACCESSED_THROTTLE_MS = 5 * 60 * 1000;

export type AdminRole = "sadmin" | "admin" | "viewer" | "analyst";
export type AdminStatus = "invited" | "enrolled" | "active" | "disabled";
export type AdminPermission =
  | "admin:manage"
  | "analytics:read"
  | "users:read"
  | "users:write"
  | "finance:read"
  | "finance:write"
  | "intel:read"
  | "intel:write"
  | "rewards:read"
  | "rewards:write";

const ALL_ADMIN_PERMISSIONS = [
  "admin:manage",
  "analytics:read",
  "users:read",
  "users:write",
  "finance:read",
  "finance:write",
  "intel:read",
  "intel:write",
  "rewards:read",
  "rewards:write",
] as const satisfies readonly AdminPermission[];

const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  sadmin: ALL_ADMIN_PERMISSIONS,
  admin: ALL_ADMIN_PERMISSIONS.filter(
    (permission) => permission !== "admin:manage",
  ),
  viewer: [
    "analytics:read",
    "users:read",
    "finance:read",
    "intel:read",
    "rewards:read",
  ],
  // Analyst is intentionally a panel-login role only for now. It can
  // authenticate through /admin-auth/me so the admin frontend can unlock
  // external analytics surfaces, but it should not read internal Hunch admin
  // data unless a future backend route grants a narrower permission.
  analyst: [],
};

const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  analyst: 0,
  viewer: 1,
  admin: 2,
  sadmin: 3,
};

export type AdminAccount = {
  id: string;
  email: string;
  status: AdminStatus;
  role: AdminRole | null;
  createdAt: Date;
  updatedAt: Date;
  invitedAt: Date;
  enrolledAt: Date | null;
  activatedAt: Date | null;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
};

export type AdminSession = {
  id: string;
  adminId: string;
  csrfToken: string;
  expiresAt: Date;
  createdAt: Date;
  lastAccessedAt: Date;
};

export type AdminActor = {
  kind: "admin_account" | "legacy_user";
  id: string;
  email?: string;
  role?: AdminRole;
};

export type AdminAuthErrorCode =
  | "admin_auth_disabled"
  | "admin_not_found"
  | "admin_already_active"
  | "admin_not_enrolled"
  | "admin_pending_activation"
  | "admin_disabled"
  | "admin_self_action_forbidden"
  | "admin_last_sadmin_forbidden"
  | "admin_invalid_role"
  | "invalid_email"
  | "invalid_credentials"
  | "invalid_enrollment_token"
  | "expired_enrollment_token"
  | "used_enrollment_token"
  | "weak_password"
  | "invalid_totp"
  | "totp_replay"
  | "admin_session_expired"
  | "admin_csrf_invalid"
  | "admin_access_required"
  | "sadmin_access_required"
  | "admin_permission_required";

export class AdminAuthError extends Error {
  readonly code: AdminAuthErrorCode;
  readonly statusCode: number;

  constructor(code: AdminAuthErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function adminAuthErrorMessage(code: AdminAuthErrorCode): string {
  switch (code) {
    case "admin_disabled":
      return "Admin account is disabled";
    case "admin_not_enrolled":
      return "Admin account is not enrolled";
    case "admin_pending_activation":
      return "Admin account is pending activation";
    case "admin_self_action_forbidden":
      return "Admins cannot perform this action on their own account";
    case "admin_last_sadmin_forbidden":
      return "Cannot remove the last active sadmin";
    case "admin_permission_required":
      return "Admin permission required";
    case "invalid_credentials":
      return "Invalid email, password, or TOTP code";
    case "invalid_totp":
      return "Invalid TOTP code";
    case "totp_replay":
      return "TOTP code was already used";
    default:
      return code;
  }
}

type Queryable = Pick<typeof pool, "query"> | Pick<PoolClient, "query">;

type AdminAccountRow = {
  id: string;
  email: string;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  last_totp_counter: string | number | null;
  status: AdminStatus;
  role: AdminRole | null;
  created_at: Date;
  updated_at: Date;
  invited_at: Date;
  enrolled_at: Date | null;
  activated_at: Date | null;
  disabled_at: Date | null;
  last_login_at: Date | null;
};

type AdminSessionRow = {
  session_id: string;
  admin_id: string;
  csrf_token: string;
  expires_at: Date;
  session_created_at: Date;
  last_accessed_at: Date;
  email: string;
  status: AdminStatus;
  role: AdminRole | null;
  account_created_at: Date;
  updated_at: Date;
  invited_at: Date;
  enrolled_at: Date | null;
  activated_at: Date | null;
  disabled_at: Date | null;
  last_login_at: Date | null;
};

export type AdminAuditActor = {
  actorAdminId?: string | null;
  actorEmail?: string | null;
  actorRole?: AdminRole | null;
};

type EnrollmentTokenRow = {
  token_id: string;
  admin_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  email: string;
  status: AdminStatus;
  totp_secret_enc: string | null;
};

export type AdminSessionAuthResult =
  | {
      ok: true;
      admin: AdminAccount;
      session: AdminSession;
      actor: AdminActor;
    }
  | {
      ok: false;
      error: AdminAuthErrorCode;
      statusCode: number;
      message: string;
    };

function isAdminRole(value: string | null | undefined): value is AdminRole {
  return (
    value === "sadmin" ||
    value === "admin" ||
    value === "viewer" ||
    value === "analyst"
  );
}

function isMissingTableError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function toAdminAccount(row: AdminAccountRow | AdminSessionRow): AdminAccount {
  return {
    id: "admin_id" in row ? row.admin_id : row.id,
    email: row.email,
    status: row.status,
    role: row.role,
    createdAt:
      "account_created_at" in row ? row.account_created_at : row.created_at,
    updatedAt: row.updated_at,
    invitedAt: row.invited_at,
    enrolledAt: row.enrolled_at,
    activatedAt: row.activated_at,
    disabledAt: row.disabled_at,
    lastLoginAt: row.last_login_at,
  };
}

function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AdminAuthError("invalid_email", "Invalid admin email", 400);
  }
  return email;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeCompareString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

let adminAuthAttemptActorColumnsAvailable: boolean | null = null;

async function adminAuthAttemptActorColumnsEnabled(
  db: Queryable,
): Promise<boolean> {
  if (adminAuthAttemptActorColumnsAvailable != null) {
    return adminAuthAttemptActorColumnsAvailable;
  }
  const { rows } = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from pg_attribute
        where attrelid = to_regclass('admin_auth_attempts')
          and attname = 'actor_admin_id'
          and not attisdropped
      ) as exists
    `,
  );
  adminAuthAttemptActorColumnsAvailable = Boolean(rows[0]?.exists);
  return adminAuthAttemptActorColumnsAvailable;
}

function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/[=\s-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of normalized) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return encodeBase32(crypto.randomBytes(20));
}

export function buildTotpUri(args: {
  email: string;
  secret: string;
  issuer?: string;
}): string {
  const issuer = args.issuer?.trim() || env.adminTotpIssuer;
  const label = `${issuer}:${args.email}`;
  const params = new URLSearchParams({
    secret: args.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotpCode(args: {
  secret: string;
  code: string;
  nowMs?: number;
  minCounterExclusive?: number | null;
}): { ok: true; counter: number } | { ok: false; replay: boolean } {
  const code = args.code.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, replay: false };

  const secret = decodeBase32(args.secret);
  const currentCounter = Math.floor(
    (args.nowMs ?? Date.now()) / 1000 / TOTP_PERIOD_SEC,
  );
  const minCounterExclusive = args.minCounterExclusive ?? null;
  let sawReplayCandidate = false;

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0) continue;
    if (hotp(secret, counter) !== code) continue;
    if (minCounterExclusive != null && counter <= minCounterExclusive) {
      sawReplayCandidate = true;
      continue;
    }
    return { ok: true, counter };
  }

  return { ok: false, replay: sawReplayCandidate };
}

function validatePasswordStrength(password: string): void {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new AdminAuthError(
      "weak_password",
      "Password must be 12-256 characters and include at least one letter and one number",
      400,
    );
  }
}

function scryptKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  validatePasswordStrength(password);
  const salt = crypto.randomBytes(16);
  const hash = await scryptKey(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    "v1",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [kind, version, nRaw, rRaw, pRaw, saltB64, hashB64, ...rest] =
    encoded.split("$");
  if (
    rest.length ||
    kind !== "scrypt" ||
    version !== "v1" ||
    !saltB64 ||
    !hashB64
  ) {
    return false;
  }

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  try {
    const actual = await scryptKey(password, salt, expected.length, {
      N: n,
      r,
      p,
    });

    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function recordAttempt(
  args: {
    adminId?: string | null;
    email?: string | null;
    attemptType: string;
    success: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
    errorCode?: string | null;
    db?: Queryable;
  } & AdminAuditActor,
): Promise<void> {
  const db = args.db ?? pool;
  try {
    const actorProvided = Boolean(
      args.actorAdminId || args.actorEmail || args.actorRole,
    );
    const includeActor =
      actorProvided && (await adminAuthAttemptActorColumnsEnabled(db));
    if (includeActor) {
      await db.query(
        `
          insert into admin_auth_attempts (
            admin_id,
            email,
            attempt_type,
            success,
            ip_address,
            user_agent,
            error_code,
            actor_admin_id,
            actor_email,
            actor_role
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          args.adminId ?? null,
          args.email ?? null,
          args.attemptType,
          args.success,
          args.ipAddress ?? null,
          args.userAgent ?? null,
          args.errorCode ?? null,
          args.actorAdminId ?? null,
          args.actorEmail ?? null,
          args.actorRole ?? null,
        ],
      );
      return;
    }

    await db.query(
      `
        insert into admin_auth_attempts (
          admin_id,
          email,
          attempt_type,
          success,
          ip_address,
          user_agent,
          error_code
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        args.adminId ?? null,
        args.email ?? null,
        args.attemptType,
        args.success,
        args.ipAddress ?? null,
        args.userAgent ?? null,
        args.errorCode ?? null,
      ],
    );
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

async function fetchAdminByEmail(
  emailInput: string,
  db: Queryable = pool,
): Promise<AdminAccountRow | null> {
  const email = normalizeEmail(emailInput);
  const { rows } = await db.query<AdminAccountRow>(
    `
      select
        id,
        email,
        password_hash,
        totp_secret_enc,
        totp_enabled,
        last_totp_counter,
        status,
        role,
        created_at,
        updated_at,
        invited_at,
        enrolled_at,
        activated_at,
        disabled_at,
        last_login_at
      from admin_accounts
      where lower(email) = lower($1)
      limit 1
    `,
    [email],
  );
  return rows[0] ?? null;
}

async function fetchAdminById(
  adminId: string,
  db: Queryable = pool,
): Promise<AdminAccountRow | null> {
  const { rows } = await db.query<AdminAccountRow>(
    `
      select
        id,
        email,
        password_hash,
        totp_secret_enc,
        totp_enabled,
        last_totp_counter,
        status,
        role,
        created_at,
        updated_at,
        invited_at,
        enrolled_at,
        activated_at,
        disabled_at,
        last_login_at
      from admin_accounts
      where id = $1
      limit 1
    `,
    [adminId],
  );
  return rows[0] ?? null;
}

async function countActiveSadminsExcluding(
  adminId: string,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `
      select count(*)::text as count
      from admin_accounts
      where status = 'active'
        and role = 'sadmin'
        and id <> $1
    `,
    [adminId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function issueEnrollmentToken(
  adminId: string,
  db: Queryable,
): Promise<{ token: string; expiresAt: Date }> {
  await db.query(
    `
      update admin_enrollment_tokens
      set used_at = now()
      where admin_id = $1
        and used_at is null
    `,
    [adminId],
  );

  const token = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + env.adminEnrollmentTtlMs);
  await db.query(
    `
      insert into admin_enrollment_tokens (admin_id, token_hash, expires_at)
      values ($1, $2, $3)
    `,
    [adminId, hashToken(token), expiresAt],
  );

  return { token, expiresAt };
}

function buildEnrollmentUrl(token: string): string {
  const base = env.adminAppBaseUrl.replace(/\/+$/, "");
  return `${base}/enroll?token=${encodeURIComponent(token)}`;
}

async function loadEnrollmentToken(
  token: string,
  db: Queryable,
  lock = false,
): Promise<EnrollmentTokenRow> {
  const { rows } = await db.query<EnrollmentTokenRow>(
    `
      select
        t.id as token_id,
        t.admin_id,
        t.token_hash,
        t.expires_at,
        t.used_at,
        a.email,
        a.status,
        a.totp_secret_enc
      from admin_enrollment_tokens t
      join admin_accounts a on a.id = t.admin_id
      where t.token_hash = $1
      limit 1
      ${lock ? "for update of t, a" : ""}
    `,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) {
    throw new AdminAuthError(
      "invalid_enrollment_token",
      "Invalid enrollment token",
      401,
    );
  }
  if (row.used_at) {
    throw new AdminAuthError(
      "used_enrollment_token",
      "Enrollment token is used",
      410,
    );
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AdminAuthError(
      "expired_enrollment_token",
      "Enrollment token is expired",
      410,
    );
  }
  if (row.status === "disabled") {
    throw new AdminAuthError(
      "admin_disabled",
      "Admin account is disabled",
      403,
    );
  }
  if (row.status !== "invited") {
    throw new AdminAuthError(
      "used_enrollment_token",
      "Admin enrollment is already completed",
      410,
    );
  }

  return row;
}

function decryptTotpSecret(encrypted: string): string {
  return decryptCredentialsString(encrypted, getCredentialsEncryptionKey());
}

function encryptTotpSecret(secret: string): string {
  return encryptCredentialsString(secret, getCredentialsEncryptionKey());
}

async function revokeAdminSessions(
  adminId: string,
  db: Queryable,
): Promise<number> {
  const { rowCount } = await db.query(
    `
      update admin_sessions
      set revoked_at = now()
      where admin_id = $1
        and revoked_at is null
    `,
    [adminId],
  );
  return rowCount ?? 0;
}

export class AdminAuthService {
  static async inviteAdmin(
    emailInput: string,
    actor?: AdminAuditActor,
  ): Promise<{
    admin: AdminAccount;
    token: string;
    enrollmentUrl: string;
    expiresAt: Date;
  }> {
    const email = normalizeEmail(emailInput);
    const client = await pool.connect();
    try {
      await client.query("begin");

      let row = await fetchAdminByEmail(email, client);
      if (row?.status === "active") {
        throw new AdminAuthError(
          "admin_already_active",
          "Admin account is already active; use rotate-link to reset enrollment",
          409,
        );
      }

      if (!row) {
        const inserted = await client.query<AdminAccountRow>(
          `
            insert into admin_accounts (email, status, role, invited_at)
            values ($1, 'invited', null, now())
            returning
              id,
              email,
              password_hash,
              totp_secret_enc,
              totp_enabled,
              last_totp_counter,
              status,
              role,
              created_at,
              updated_at,
              invited_at,
              enrolled_at,
              activated_at,
              disabled_at,
              last_login_at
          `,
          [email],
        );
        row = inserted.rows[0];
      } else {
        const updated = await client.query<AdminAccountRow>(
          `
            update admin_accounts
            set
              status = 'invited',
              role = null,
              password_hash = null,
              totp_secret_enc = null,
              totp_enabled = false,
              last_totp_counter = null,
              invited_at = now(),
              enrolled_at = null,
              activated_at = null,
              disabled_at = null,
              password_changed_at = null,
              totp_confirmed_at = null
            where id = $1
            returning
              id,
              email,
              password_hash,
              totp_secret_enc,
              totp_enabled,
              last_totp_counter,
              status,
              role,
              created_at,
              updated_at,
              invited_at,
              enrolled_at,
              activated_at,
              disabled_at,
              last_login_at
          `,
          [row.id],
        );
        row = updated.rows[0];
        await revokeAdminSessions(row.id, client);
      }

      const issued = await issueEnrollmentToken(row.id, client);
      await recordAttempt({
        db: client,
        adminId: row.id,
        email,
        attemptType: "invite",
        success: true,
        ...actor,
      });
      await client.query("commit");

      return {
        admin: toAdminAccount(row),
        token: issued.token,
        enrollmentUrl: buildEnrollmentUrl(issued.token),
        expiresAt: issued.expiresAt,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async rotateEnrollmentLink(emailInput: string): Promise<{
    admin: AdminAccount;
    token: string;
    enrollmentUrl: string;
    expiresAt: Date;
  }> {
    const email = normalizeEmail(emailInput);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await fetchAdminByEmail(email, client);
      if (!row)
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);

      const updated = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set
            status = 'invited',
            role = null,
            password_hash = null,
            totp_secret_enc = null,
            totp_enabled = false,
            last_totp_counter = null,
            invited_at = now(),
            enrolled_at = null,
            activated_at = null,
            disabled_at = null,
            password_changed_at = null,
            totp_confirmed_at = null
          where id = $1
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
            disabled_at,
            last_login_at
        `,
        [row.id],
      );
      await revokeAdminSessions(row.id, client);
      const issued = await issueEnrollmentToken(row.id, client);
      await recordAttempt({
        db: client,
        adminId: row.id,
        email,
        attemptType: "rotate_link",
        success: true,
      });
      await client.query("commit");

      return {
        admin: toAdminAccount(updated.rows[0]),
        token: issued.token,
        enrollmentUrl: buildEnrollmentUrl(issued.token),
        expiresAt: issued.expiresAt,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async startEnrollment(token: string): Promise<{
    email: string;
    otpauthUri: string;
    manualSecret: string;
    expiresAt: Date;
  }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await loadEnrollmentToken(token, client, true);
      const secret = generateTotpSecret();
      await client.query(
        `
          update admin_accounts
          set
            totp_secret_enc = $2,
            totp_enabled = false,
            last_totp_counter = null
          where id = $1
        `,
        [row.admin_id, encryptTotpSecret(secret)],
      );
      await recordAttempt({
        db: client,
        adminId: row.admin_id,
        email: row.email,
        attemptType: "enroll_start",
        success: true,
      });
      await client.query("commit");
      return {
        email: row.email,
        manualSecret: secret,
        otpauthUri: buildTotpUri({ email: row.email, secret }),
        expiresAt: row.expires_at,
      };
    } catch (error) {
      await client.query("rollback");
      if (error instanceof AdminAuthError) {
        await recordAttempt({
          attemptType: "enroll_start",
          success: false,
          errorCode: error.code,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  static async completeEnrollment(args: {
    token: string;
    password: string;
    totpCode: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ admin: AdminAccount }> {
    validatePasswordStrength(args.password);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = await loadEnrollmentToken(args.token, client, true);
      if (!row.totp_secret_enc) {
        throw new AdminAuthError(
          "invalid_totp",
          "Start enrollment before confirming TOTP",
          400,
        );
      }

      const secret = decryptTotpSecret(row.totp_secret_enc);
      const totp = verifyTotpCode({ secret, code: args.totpCode });
      if (!totp.ok) {
        throw new AdminAuthError("invalid_totp", "Invalid TOTP code", 401);
      }

      const passwordHash = await hashAdminPassword(args.password);
      const { rows } = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set
            password_hash = $2,
            totp_enabled = true,
            last_totp_counter = $3,
            status = 'enrolled',
            role = null,
            enrolled_at = now(),
            password_changed_at = now(),
            totp_confirmed_at = now()
          where id = $1
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
              disabled_at,
              last_login_at
        `,
        [row.admin_id, passwordHash, totp.counter],
      );
      await client.query(
        `update admin_enrollment_tokens set used_at = now() where token_hash = $1`,
        [row.token_hash],
      );
      await recordAttempt({
        db: client,
        adminId: row.admin_id,
        email: row.email,
        attemptType: "enroll_complete",
        success: true,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      });
      await client.query("commit");
      return { admin: toAdminAccount(rows[0]) };
    } catch (error) {
      await client.query("rollback");
      if (error instanceof AdminAuthError) {
        await recordAttempt({
          attemptType: "enroll_complete",
          success: false,
          ipAddress: args.ipAddress,
          userAgent: args.userAgent,
          errorCode: error.code,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  static async activateAdmin(
    emailInput: string,
    role: AdminRole,
  ): Promise<AdminAccount> {
    if (!isAdminRole(role)) {
      throw new AdminAuthError("admin_invalid_role", "Invalid admin role", 400);
    }
    const email = normalizeEmail(emailInput);
    const { rows } = await pool.query<AdminAccountRow>(
      `
        update admin_accounts
        set
          status = 'active',
          role = $2,
          activated_at = now(),
          disabled_at = null
        where lower(email) = lower($1)
          and status = 'enrolled'
          and password_hash is not null
          and totp_secret_enc is not null
          and totp_enabled = true
        returning
          id,
          email,
          password_hash,
          totp_secret_enc,
          totp_enabled,
          last_totp_counter,
          status,
          role,
          created_at,
          updated_at,
          invited_at,
          enrolled_at,
          activated_at,
          disabled_at,
          last_login_at
      `,
      [email, role],
    );
    if (!rows.length) {
      throw new AdminAuthError(
        "admin_not_enrolled",
        "Admin must complete enrollment before activation",
        400,
      );
    }
    await recordAttempt({
      adminId: rows[0].id,
      email,
      attemptType: "activate",
      success: true,
    });
    return toAdminAccount(rows[0]);
  }

  static async disableAdmin(emailInput: string): Promise<AdminAccount> {
    const email = normalizeEmail(emailInput);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set
            status = 'disabled',
            role = null,
            disabled_at = now()
          where lower(email) = lower($1)
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
            disabled_at,
            last_login_at
        `,
        [email],
      );
      if (!rows.length) {
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);
      }
      await revokeAdminSessions(rows[0].id, client);
      await recordAttempt({
        db: client,
        adminId: rows[0].id,
        email,
        attemptType: "disable",
        success: true,
      });
      await client.query("commit");
      return toAdminAccount(rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async listAdmins(): Promise<AdminAccount[]> {
    const { rows } = await pool.query<AdminAccountRow>(
      `
        select
          id,
          email,
          password_hash,
          totp_secret_enc,
          totp_enabled,
          last_totp_counter,
          status,
          role,
          created_at,
          updated_at,
          invited_at,
          enrolled_at,
          activated_at,
          disabled_at,
          last_login_at
        from admin_accounts
        order by created_at desc
      `,
    );
    return rows.map(toAdminAccount);
  }

  static async activateAdminById(
    adminId: string,
    role: AdminRole,
    actor?: AdminAuditActor,
  ): Promise<AdminAccount> {
    if (!isAdminRole(role)) {
      throw new AdminAuthError("admin_invalid_role", "Invalid admin role", 400);
    }
    const { rows } = await pool.query<AdminAccountRow>(
      `
        update admin_accounts
        set
          status = 'active',
          role = $2,
          activated_at = now(),
          disabled_at = null
        where id = $1
          and status = 'enrolled'
          and password_hash is not null
          and totp_secret_enc is not null
          and totp_enabled = true
        returning
          id,
          email,
          password_hash,
          totp_secret_enc,
          totp_enabled,
          last_totp_counter,
          status,
          role,
          created_at,
          updated_at,
          invited_at,
          enrolled_at,
          activated_at,
          disabled_at,
          last_login_at
      `,
      [adminId, role],
    );
    if (!rows.length) {
      const existing = await fetchAdminById(adminId);
      if (!existing) {
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);
      }
      throw new AdminAuthError(
        "admin_not_enrolled",
        "Admin must complete enrollment before activation",
        400,
      );
    }
    await recordAttempt({
      adminId: rows[0].id,
      email: rows[0].email,
      attemptType: "activate",
      success: true,
      ...actor,
    });
    return toAdminAccount(rows[0]);
  }

  static async setAdminRoleById(args: {
    actorAdminId: string;
    targetAdminId: string;
    role: AdminRole;
  }): Promise<AdminAccount> {
    if (!isAdminRole(args.role)) {
      throw new AdminAuthError("admin_invalid_role", "Invalid admin role", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "lock table admin_accounts in share row exclusive mode",
      );
      const target = await fetchAdminById(args.targetAdminId, client);
      if (!target) {
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);
      }
      const actor = await fetchAdminById(args.actorAdminId, client);
      if (target.status !== "active") {
        throw new AdminAuthError(
          "admin_pending_activation",
          "Admin account must be active before changing role",
          400,
        );
      }
      const otherActiveSadminCount = await countActiveSadminsExcluding(
        target.id,
        client,
      );
      const lockout = resolveAdminManagementLockout({
        actorAdminId: args.actorAdminId,
        targetAdminId: target.id,
        targetStatus: target.status,
        targetRole: target.role,
        action: "set_role",
        nextRole: args.role,
        otherActiveSadminCount,
      });
      if (lockout) {
        throw new AdminAuthError(lockout, adminAuthErrorMessage(lockout), 400);
      }

      const { rows } = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set role = $2
          where id = $1
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
            disabled_at,
            last_login_at
        `,
        [target.id, args.role],
      );
      await recordAttempt({
        db: client,
        adminId: target.id,
        email: target.email,
        actorAdminId: actor?.id ?? args.actorAdminId,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        attemptType: "set_role",
        success: true,
      });
      await client.query("commit");
      return toAdminAccount(rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async disableAdminById(args: {
    actorAdminId: string;
    targetAdminId: string;
  }): Promise<AdminAccount> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "lock table admin_accounts in share row exclusive mode",
      );
      const target = await fetchAdminById(args.targetAdminId, client);
      if (!target) {
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);
      }
      const actor = await fetchAdminById(args.actorAdminId, client);
      const otherActiveSadminCount = await countActiveSadminsExcluding(
        target.id,
        client,
      );
      const lockout = resolveAdminManagementLockout({
        actorAdminId: args.actorAdminId,
        targetAdminId: target.id,
        targetStatus: target.status,
        targetRole: target.role,
        action: "disable",
        otherActiveSadminCount,
      });
      if (lockout) {
        throw new AdminAuthError(lockout, adminAuthErrorMessage(lockout), 400);
      }

      const { rows } = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set
            status = 'disabled',
            role = null,
            disabled_at = now()
          where id = $1
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
            disabled_at,
            last_login_at
        `,
        [target.id],
      );
      await revokeAdminSessions(target.id, client);
      await recordAttempt({
        db: client,
        adminId: target.id,
        email: target.email,
        actorAdminId: actor?.id ?? args.actorAdminId,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        attemptType: "disable",
        success: true,
      });
      await client.query("commit");
      return toAdminAccount(rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async rotateEnrollmentLinkById(args: {
    actorAdminId: string;
    targetAdminId: string;
  }): Promise<{
    admin: AdminAccount;
    token: string;
    enrollmentUrl: string;
    expiresAt: Date;
  }> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "lock table admin_accounts in share row exclusive mode",
      );
      const row = await fetchAdminById(args.targetAdminId, client);
      if (!row) {
        throw new AdminAuthError("admin_not_found", "Admin not found", 404);
      }
      const actor = await fetchAdminById(args.actorAdminId, client);
      const otherActiveSadminCount = await countActiveSadminsExcluding(
        row.id,
        client,
      );
      const lockout = resolveAdminManagementLockout({
        actorAdminId: args.actorAdminId,
        targetAdminId: row.id,
        targetStatus: row.status,
        targetRole: row.role,
        action: "rotate_link",
        otherActiveSadminCount,
      });
      if (lockout) {
        throw new AdminAuthError(lockout, adminAuthErrorMessage(lockout), 400);
      }

      const updated = await client.query<AdminAccountRow>(
        `
          update admin_accounts
          set
            status = 'invited',
            role = null,
            password_hash = null,
            totp_secret_enc = null,
            totp_enabled = false,
            last_totp_counter = null,
            invited_at = now(),
            enrolled_at = null,
            activated_at = null,
            disabled_at = null,
            password_changed_at = null,
            totp_confirmed_at = null
          where id = $1
          returning
            id,
            email,
            password_hash,
            totp_secret_enc,
            totp_enabled,
            last_totp_counter,
            status,
            role,
            created_at,
            updated_at,
            invited_at,
            enrolled_at,
            activated_at,
            disabled_at,
            last_login_at
        `,
        [row.id],
      );
      await revokeAdminSessions(row.id, client);
      const issued = await issueEnrollmentToken(row.id, client);
      await recordAttempt({
        db: client,
        adminId: row.id,
        email: row.email,
        actorAdminId: actor?.id ?? args.actorAdminId,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        attemptType: "rotate_link",
        success: true,
      });
      await client.query("commit");

      return {
        admin: toAdminAccount(updated.rows[0]),
        token: issued.token,
        enrollmentUrl: buildEnrollmentUrl(issued.token),
        expiresAt: issued.expiresAt,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async revokeSessionsById(
    adminId: string,
    actor?: AdminAuditActor,
  ): Promise<number> {
    const row = await fetchAdminById(adminId);
    if (!row)
      throw new AdminAuthError("admin_not_found", "Admin not found", 404);
    const revoked = await revokeAdminSessions(row.id, pool);
    await recordAttempt({
      adminId: row.id,
      email: row.email,
      attemptType: "revoke_sessions",
      success: true,
      ...actor,
    });
    return revoked;
  }

  static async revokeSessionsByEmail(emailInput: string): Promise<number> {
    const row = await fetchAdminByEmail(emailInput);
    if (!row)
      throw new AdminAuthError("admin_not_found", "Admin not found", 404);
    const revoked = await revokeAdminSessions(row.id, pool);
    await recordAttempt({
      adminId: row.id,
      email: row.email,
      attemptType: "revoke_sessions",
      success: true,
    });
    return revoked;
  }

  static async login(args: {
    email: string;
    password: string;
    totpCode: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{
    admin: AdminAccount;
    session: AdminSession & { token: string };
  }> {
    const email = normalizeEmail(args.email);
    const row = await fetchAdminByEmail(email);
    if (!row) {
      await recordAttempt({
        email,
        attemptType: "login",
        success: false,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        errorCode: "invalid_credentials",
      });
      throw new AdminAuthError(
        "invalid_credentials",
        "Invalid email, password, or TOTP code",
        401,
      );
    }

    const fail = async (
      code: AdminAuthErrorCode,
      statusCode = 401,
    ): Promise<never> => {
      await recordAttempt({
        adminId: row.id,
        email,
        attemptType: "login",
        success: false,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        errorCode: code,
      });
      throw new AdminAuthError(code, adminAuthErrorMessage(code), statusCode);
    };

    const passwordHash = row.password_hash;
    const totpSecretEnc = row.totp_secret_enc;
    if (!passwordHash || !totpSecretEnc || !row.totp_enabled) {
      await fail("invalid_credentials", 401);
      throw new Error("unreachable");
    }

    const passwordOk = await verifyAdminPassword(args.password, passwordHash);
    if (!passwordOk) await fail("invalid_credentials", 401);

    const lastCounter =
      row.last_totp_counter == null ? null : Number(row.last_totp_counter);
    const totp = verifyTotpCode({
      secret: decryptTotpSecret(totpSecretEnc),
      code: args.totpCode,
      minCounterExclusive: Number.isFinite(lastCounter) ? lastCounter : null,
    });
    if (!totp.ok) {
      await fail(totp.replay ? "totp_replay" : "invalid_totp", 401);
      throw new Error("unreachable");
    }
    const totpCounter = totp.counter;

    if (row.status === "disabled") await fail("admin_disabled", 403);
    if (row.status === "invited") await fail("admin_not_enrolled", 403);
    if (row.status === "enrolled") await fail("admin_pending_activation", 403);
    if (!isAdminRole(row.role)) await fail("admin_pending_activation", 403);

    const token = generateOpaqueToken(32);
    const csrfToken = generateOpaqueToken(32);
    const expiresAt = new Date(Date.now() + env.adminSessionTtlMs);
    const sessionTokenHash = hashToken(token);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const counterUpdate = await client.query(
        `
          update admin_accounts
          set
            last_totp_counter = $2,
            last_login_at = now()
          where id = $1
            and (last_totp_counter is null or last_totp_counter < $2)
        `,
        [row.id, totpCounter],
      );
      if ((counterUpdate.rowCount ?? 0) !== 1) {
        await recordAttempt({
          db: client,
          adminId: row.id,
          email,
          attemptType: "login",
          success: false,
          ipAddress: args.ipAddress,
          userAgent: args.userAgent,
          errorCode: "totp_replay",
        });
        throw new AdminAuthError(
          "totp_replay",
          "TOTP code was already used",
          401,
        );
      }

      const { rows } = await client.query<{
        id: string;
        admin_id: string;
        csrf_token: string;
        expires_at: Date;
        created_at: Date;
        last_accessed_at: Date;
      }>(
        `
          insert into admin_sessions (
            admin_id,
            session_token_hash,
            csrf_token,
            ip_address,
            user_agent,
            expires_at
          )
          values ($1, $2, $3, $4, $5, $6)
          returning id, admin_id, csrf_token, expires_at, created_at, last_accessed_at
        `,
        [
          row.id,
          sessionTokenHash,
          csrfToken,
          args.ipAddress ?? null,
          args.userAgent ?? null,
          expiresAt,
        ],
      );
      await recordAttempt({
        db: client,
        adminId: row.id,
        email,
        attemptType: "login",
        success: true,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      });
      await client.query("commit");

      return {
        admin: {
          ...toAdminAccount(row),
          lastLoginAt: new Date(),
        },
        session: {
          id: rows[0].id,
          adminId: rows[0].admin_id,
          csrfToken: rows[0].csrf_token,
          expiresAt: rows[0].expires_at,
          createdAt: rows[0].created_at,
          lastAccessedAt: rows[0].last_accessed_at,
          token,
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  static async validateSession(token: string): Promise<{
    admin: AdminAccount;
    session: AdminSession;
    actor: AdminActor;
  } | null> {
    if (!env.adminAuthEnabled) return null;
    try {
      const { rows } = await pool.query<AdminSessionRow>(
        `
          select
            s.id as session_id,
            s.admin_id,
            s.csrf_token,
            s.expires_at,
            s.created_at as session_created_at,
            s.last_accessed_at,
            a.email,
            a.status,
            a.role,
            a.created_at as account_created_at,
            a.updated_at,
            a.invited_at,
            a.enrolled_at,
            a.activated_at,
            a.disabled_at,
            a.last_login_at
          from admin_sessions s
          join admin_accounts a on a.id = s.admin_id
          where s.session_token_hash = $1
            and s.revoked_at is null
            and s.expires_at > now()
            and a.status = 'active'
            and a.role in ('sadmin', 'admin', 'viewer', 'analyst')
          limit 1
        `,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row || !isAdminRole(row.role)) return null;

      if (
        row.last_accessed_at.getTime() <=
        Date.now() - SESSION_LAST_ACCESSED_THROTTLE_MS
      ) {
        await pool.query(
          `update admin_sessions set last_accessed_at = now() where id = $1`,
          [row.session_id],
        );
      }

      const admin = toAdminAccount(row);
      const session: AdminSession = {
        id: row.session_id,
        adminId: row.admin_id,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
        createdAt: row.session_created_at,
        lastAccessedAt: row.last_accessed_at,
      };
      const actor: AdminActor = {
        kind: "admin_account",
        id: row.admin_id,
        email: row.email,
        role: row.role,
      };
      return { admin, session, actor };
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  }

  static async revokeSession(token: string): Promise<void> {
    await pool.query(
      `
        update admin_sessions
        set revoked_at = now()
        where session_token_hash = $1
          and revoked_at is null
      `,
      [hashToken(token)],
    );
  }

  static async revokeAllSessions(adminId: string): Promise<number> {
    return revokeAdminSessions(adminId, pool);
  }
}

function readHeaderValue(
  headers: FastifyRequest["headers"],
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

export function readAdminBearerToken(request: FastifyRequest): string | null {
  const authHeader = readHeaderValue(request.headers, "authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length ? token : null;
}

function requiresCsrf(method: string): boolean {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return false;
    default:
      return true;
  }
}

export function adminRoleAllowed(
  actual: AdminRole,
  minimum: AdminRole,
): boolean {
  return ADMIN_ROLE_RANK[actual] >= ADMIN_ROLE_RANK[minimum];
}

export function adminHasPermission(
  role: AdminRole,
  permission: AdminPermission,
): boolean {
  return ADMIN_ROLE_PERMISSIONS[role].includes(permission);
}

function adminHasAllPermissions(
  role: AdminRole,
  permissions: readonly AdminPermission[] | undefined,
): boolean {
  if (!permissions?.length) return true;
  return permissions.every((permission) =>
    adminHasPermission(role, permission),
  );
}

export function resolveAdminManagementLockout(args: {
  actorAdminId: string;
  targetAdminId: string;
  targetStatus: AdminStatus;
  targetRole: AdminRole | null;
  action: "disable" | "set_role" | "rotate_link";
  nextRole?: AdminRole;
  otherActiveSadminCount: number;
}): AdminAuthErrorCode | null {
  const isSelf = args.actorAdminId === args.targetAdminId;
  if (isSelf && (args.action === "disable" || args.action === "rotate_link")) {
    return "admin_self_action_forbidden";
  }
  if (isSelf && args.action === "set_role" && args.nextRole !== "sadmin") {
    return "admin_self_action_forbidden";
  }

  const removesSadmin =
    args.targetStatus === "active" &&
    args.targetRole === "sadmin" &&
    (args.action === "disable" ||
      args.action === "rotate_link" ||
      (args.action === "set_role" && args.nextRole !== "sadmin"));
  if (removesSadmin && args.otherActiveSadminCount === 0) {
    return "admin_last_sadmin_forbidden";
  }

  return null;
}

export async function attachAdminSessionToRequest(
  request: FastifyRequest,
  options: {
    minRole?: AdminRole;
    requiredPermissions?: AdminPermission[];
    requireCsrf?: boolean;
  } = {},
): Promise<AdminSessionAuthResult> {
  const token = readAdminBearerToken(request);
  if (!token) {
    return {
      ok: false,
      error: "admin_access_required",
      statusCode: 401,
      message: "Admin session required",
    };
  }

  const result = await AdminAuthService.validateSession(token);
  if (!result) {
    return {
      ok: false,
      error: "admin_session_expired",
      statusCode: 401,
      message: "Invalid or expired admin session",
    };
  }

  if (
    options.minRole &&
    (!result.actor.role ||
      !adminRoleAllowed(result.actor.role, options.minRole))
  ) {
    const error =
      options.minRole === "sadmin"
        ? "sadmin_access_required"
        : "admin_permission_required";
    return {
      ok: false,
      error,
      statusCode: 403,
      message:
        options.minRole === "sadmin"
          ? "Sadmin access required"
          : "Admin permission required",
    };
  }

  if (
    options.requiredPermissions?.length &&
    (!result.actor.role ||
      !adminHasAllPermissions(result.actor.role, options.requiredPermissions))
  ) {
    return {
      ok: false,
      error: "admin_permission_required",
      statusCode: 403,
      message: "Admin permission required",
    };
  }

  if (options.requireCsrf ?? requiresCsrf(request.method)) {
    const csrfHeader = readHeaderValue(request.headers, "x-csrf-token");
    if (
      !csrfHeader ||
      !safeCompareString(csrfHeader, result.session.csrfToken)
    ) {
      return {
        ok: false,
        error: "admin_csrf_invalid",
        statusCode: 403,
        message: "Invalid admin CSRF token",
      };
    }
  }

  request.adminAccount = result.admin;
  request.adminSession = result.session;
  request.adminActor = result.actor;
  return { ok: true, ...result };
}

export function createAdminSessionMiddleware(
  options: {
    minRole?: AdminRole;
    requiredPermissions?: AdminPermission[];
  } = {},
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await attachAdminSessionToRequest(request, {
      minRole: options.minRole,
      requiredPermissions: options.requiredPermissions,
    });
    if (result.ok) return;
    reply.code(result.statusCode);
    return reply.send({ error: result.error, message: result.message });
  };
}
